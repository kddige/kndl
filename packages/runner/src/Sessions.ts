import { randomUUID } from "node:crypto"
import type {
  HubToRunner,
  RelaunchSession,
  RunTestBuild,
  SessionId,
  StartSession,
  StopSession,
  TerminalSize,
} from "@claude-hub/protocol"
import { RunnerToHub } from "@claude-hub/protocol"
import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Redacted,
  Scope,
  Semaphore,
  Stream,
} from "effect"
import { claudeLaunch, ModEnvironment } from "./ClaudeLaunch.ts"
import { HubClaudeCredential } from "./HubClaudeCredential.ts"
import { HubGit } from "./HubGit.ts"
import { HubLink } from "./HubLink.ts"
import { HubVariables } from "./HubVariables.ts"
import { CredentialProxy } from "./proxy/CredentialProxy.ts"
import { RunnerConfig } from "./RunnerConfig.ts"
import { Sandboxes, type SandboxStarted } from "./Sandbox.ts"
import { workspaceGuestPath } from "./sandbox/SessionLayout.ts"
import { isSafeSessionId, type SessionDirectories, sessionDirectories } from "./SessionNames.ts"
import { type Pane, Tmux } from "./Tmux.ts"
import { Workspaces } from "./Workspace.ts"
import { WorkspaceGit } from "./WorkspaceGit.ts"

/** The terminal size a Session starts with, until a viewer resizes it. */
export const InitialTerminalSize: TerminalSize = { cols: 120, rows: 40 }

/** How long a stopped Claude Code gets to exit after SIGTERM before its tmux session is killed. */
export const StopGracePeriod = Duration.seconds(10)

/**
 * The Sessions running on this Runner: each one Claude Code in a tmux session in its Sandbox
 * (ADR 0013), whose terminal is streamed to the Hub.
 */
export class Sessions extends Context.Service<
  Sessions,
  {
    /**
     * Takes back the Sessions an earlier Runner left running, as after a restart (#157). Each
     * one whose Claude Code still runs in its Sandbox keeps running, its terminal streamed again.
     * The Session token its Claude Code holds, read back from it, is held for it alone at the
     * proxy until the Hub gives it a new mod token (ModTokenReissued). Any other Sandbox left
     * running is stopped: the Hub has its Session Asleep once the Runner says hello without it.
     * Run once, at startup, before the hello.
     */
    readonly adopt: Effect.Effect<void>
    /** The Sessions whose Claude Code is running, for {@link RunnerHello}. */
    readonly running: Effect.Effect<ReadonlyArray<SessionId>>
    /** Those kept running across a restart, waiting for a new mod token, for the hello. */
    readonly withoutModToken: Effect.Effect<ReadonlyArray<SessionId>>
    /** Acts on a message from the Hub. Starting and stopping go on in the background. */
    readonly handle: (message: HubToRunner) => Effect.Effect<void>
    /** Sends a `Snapshot` frame of every running Session, as after reconnecting. */
    readonly snapshotAll: Effect.Effect<void>
    /**
     * How the Runner's own Claude credential is shown, for {@link RunnerHello}; undefined when it
     * has none.
     */
    readonly ownClaudeAccount: Effect.Effect<string | undefined>
  }
>()("@claude-hub/runner/Sessions") {}

interface Running {
  readonly pane: Pane
  /** Set when the Hub asked the Session to stop, so its exit is reported as `Requested`. */
  stopping: boolean
  /** Completes with the exit code once Claude Code has exited, or its tmux session is gone. */
  readonly exited: Deferred.Deferred<number | undefined>
}

const message = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.message : String(error)
}

/** `text` with every occurrence of `value` masked, character for character. */
export function withoutValue(text: string, value: string | undefined): string {
  return value === undefined || value === ""
    ? text
    : text.replaceAll(value, "*".repeat(value.length))
}

export const SessionsLive = Layer.effect(
  Sessions,
  Effect.gen(function* () {
    const config = yield* RunnerConfig
    const tmux = yield* Tmux
    const workspaces = yield* Workspaces
    const sandboxes = yield* Sandboxes
    const hub = yield* HubLink
    const git = yield* WorkspaceGit
    const hubGit = yield* HubGit
    const hubVariables = yield* HubVariables
    const hubClaudeCredential = yield* HubClaudeCredential
    const proxy = yield* CredentialProxy
    const layerScope = yield* Effect.scope

    const running = new Map<SessionId, Running>()
    /**
     * The Session token each Session's Claude Code was started with, kept out of what it printed
     * before it exited.
     */
    const sessionTokens = new Map<SessionId, string>()
    /** What each started Session's Sandbox runs: its Environment version and Claude Code. */
    const sandboxStarts = new Map<SessionId, SandboxStarted>()
    /** Sessions kept running across a restart, whose Session token waits for a mod token. */
    const held = new Set<SessionId>()
    const locks = new Map<SessionId, Semaphore.Semaphore>()

    /**
     * Gives the Session a Session token for the credential proxy, standing for its mod token and
     * its Creator's Claude credential, fetched from the Hub as it starts or wakes (ADR 0015) and
     * kept in memory only. Without one, or when the Hub can't be asked, the proxy uses the
     * Runner's own. Its Claude Code holds the token in place of the mod token and any Claude
     * credential (ADR 0013).
     */
    const admit = (sessionId: SessionId, modToken: string) =>
      Effect.gen(function* () {
        const credential = yield* hubClaudeCredential
          .fetch(sessionId)
          .pipe(
            Effect.catch((error) =>
              Effect.as(
                Effect.logWarning(
                  `Session ${sessionId} runs on this Runner's Claude credential: ${error.message}`,
                ),
                undefined,
              ),
            ),
          )
        const pass = yield* proxy.admit({
          sessionId,
          modToken: Redacted.make(modToken),
          ...(credential !== undefined && { credential }),
        })
        sessionTokens.set(sessionId, Redacted.value(pass.token))
        return pass
      })

    /** Revokes the Session's Session token, held or live, as it stops. */
    const forget = (sessionId: SessionId) => {
      sessionTokens.delete(sessionId)
      held.delete(sessionId)
      return proxy.revoke(sessionId)
    }

    /** Starting and stopping one Session happen one at a time. */
    const serialized =
      (sessionId: SessionId) =>
      <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> => {
        let lock = locks.get(sessionId)
        if (lock === undefined) {
          lock = Semaphore.makeUnsafe(1)
          locks.set(sessionId, lock)
        }
        return lock.withPermit(effect)
      }

    const background = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.catchCause((cause) => Effect.logError("Session task failed", cause)),
        Effect.forkIn(layerScope),
        Effect.asVoid,
      )

    /**
     * Attaches to the Session's tmux session, streams its terminal to the Hub, and starts with a
     * snapshot. When Claude Code exits on its own, reports it and cleans up.
     */
    const watch = (sessionId: SessionId) =>
      Effect.gen(function* () {
        const paneScope = yield* Scope.make()
        const pane = yield* tmux.attach(sessionId).pipe(
          Scope.provide(paneScope),
          Effect.onError(() => Scope.close(paneScope, Exit.void)),
        )
        const exited = yield* Deferred.make<number | undefined>()
        const session: Running = { pane, stopping: false, exited }
        running.set(sessionId, session)

        let exitCode: number | undefined
        yield* pane.events.pipe(
          Stream.runForEach((event) => {
            if (event._tag === "Exited") {
              exitCode = event.exitCode
              return Effect.void
            }
            return hub.send(
              RunnerToHub.cases.TerminalFrame.make({
                sessionId,
                kind: event._tag,
                data: event.data,
                size: event.size,
              }),
            )
          }),
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              running.delete(sessionId)
              yield* Scope.close(paneScope, Exit.void)
              yield* Deferred.succeed(exited, exitCode)
              // Interrupted means the Runner is shutting down: Claude Code runs on, and is taken
              // back when the Runner comes back (adopt).
              if (Exit.hasInterrupts(exit) || session.stopping) return
              yield* background(exitedOnItsOwn(sessionId, exitCode))
            }),
          ),
          Effect.forkIn(layerScope),
        )
        yield* pane.snapshot
      })

    // What Claude Code printed before it exited is read from its dead pane, which tmux keeps
    // (`remain-on-exit`), before the tmux session is killed: otherwise why it exited is lost (#105).
    const exitedOnItsOwn = (sessionId: SessionId, exitCode: number | undefined) =>
      serialized(sessionId)(
        Effect.gen(function* () {
          const output = withoutValue(
            yield* tmux.lastOutput(sessionId),
            sessionTokens.get(sessionId),
          )
          yield* forget(sessionId)
          const exited = `Session ${sessionId} exited with ${exitCode ?? "unknown status"}`
          const log = exitCode === 0 ? Effect.logInfo : Effect.logWarning
          // Only the Hub knows the Environment's Sensitive values, so the output itself goes to the
          // Hub, which redacts it, and never into the Runner's log file.
          const lines = output === "" ? 0 : output.split("\n").length
          yield* log(
            lines === 0
              ? exited
              : `${exited}; its last ${lines} line(s) of output are on the Session's page`,
          )
          yield* tmux.kill(sessionId)
          yield* git.pushWip(sessionId, sessionDirectories(config.sessionsRoot, sessionId), "Sleep")
          yield* sandboxes.stop(sessionId, "Sleep")
          yield* hub.send(
            RunnerToHub.cases.SessionStopped.make({
              sessionId,
              reason: "Exited",
              ...(exitCode === undefined ? {} : { exitCode }),
              ...(output === "" ? {} : { output }),
            }),
          )
        }),
      )

    /**
     * The conversation to start Claude Code with: a new one, or the one the Hub asks to resume.
     * One Claude Code never wrote a transcript of, as when it exited before it got that far,
     * can't be resumed: it starts new instead, with the same id, so the Hub's id stays right
     * (#105).
     */
    const conversationFor = (
      request: StartSession | RelaunchSession,
      directories: SessionDirectories,
    ) =>
      Effect.gen(function* () {
        if (request.resume === undefined) {
          return { _tag: "New", id: randomUUID() } as const
        }
        const id = request.resume
        if (yield* sandboxes.hasTranscript(request.sessionId, directories, id))
          return { _tag: "Resume", id } as const
        yield* Effect.logInfo(
          `Session ${request.sessionId}: Claude Code has no transcript of conversation ${id}, ` +
            "so it starts a new one with that id instead of resuming it",
        )
        return { _tag: "New", id } as const
      })

    /**
     * Starts the Session's Claude Code in a new tmux session in its running Sandbox, and watches
     * it. It holds a new Session token, given to it alone, never set on the Sandbox.
     */
    const launchClaude = (
      request: StartSession | RelaunchSession,
      directories: SessionDirectories,
      sandbox: SandboxStarted,
    ) =>
      Effect.gen(function* () {
        const { sessionId } = request
        const launch = claudeLaunch({
          claudePath: sandbox.claude.path,
          sessionId,
          conversation: yield* conversationFor(request, directories),
          ...(request.model === undefined ? {} : { model: request.model }),
          ...(request.effort === undefined ? {} : { effort: request.effort }),
        })
        const pass = yield* admit(sessionId, request.modToken)
        yield* tmux.launch({
          sessionId,
          cwd: workspaceGuestPath,
          argv: launch.argv,
          env: { ...sandbox.claude.env, ...launch.env, ...pass.env },
          size: InitialTerminalSize,
        })
        yield* watch(sessionId)
      })

    /** Tells the Hub the Session's Claude Code started, with the Environment version it runs. */
    const started = (sessionId: SessionId) => {
      const environmentVersion = sandboxStarts.get(sessionId)?.environmentVersion
      return hub.send(
        RunnerToHub.cases.SessionStarted.make({
          sessionId,
          ...(environmentVersion === undefined ? {} : { environmentVersion }),
        }),
      )
    }

    const start = (request: StartSession) =>
      serialized(request.sessionId)(
        Effect.gen(function* () {
          const { sessionId } = request
          if (running.has(sessionId)) return yield* started(sessionId)
          // Whatever is left of an earlier run, such as a tmux session whose process exited.
          yield* tmux.kill(sessionId)
          const launched = yield* Effect.gen(function* () {
            const directories = yield* workspaces.prepare(request)
            // The Sandbox (#9) is created and started around the Workspace before Claude Code,
            // from the Repo's Environment if it has one (ADR 0009).
            const sandbox = yield* sandboxes.start(sessionId, directories, {
              repo: request.repo,
              ...(request.environment === undefined ? {} : { environment: request.environment }),
              ...(request.gitIdentity === undefined ? {} : { gitIdentity: request.gitIdentity }),
            })
            sandboxStarts.set(sessionId, sandbox)
            yield* launchClaude(request, directories, sandbox)
          }).pipe(Effect.exit)

          if (Exit.isSuccess(launched)) {
            yield* Effect.logInfo(`Session ${sessionId} started`)
            return yield* started(sessionId)
          }
          const reason = message(launched.cause)
          yield* forget(sessionId)
          yield* Effect.logWarning(`Session ${sessionId} failed to start: ${reason}`)
          yield* tmux.kill(sessionId)
          yield* sandboxes.stop(sessionId, "Sleep")
          yield* hub.send(RunnerToHub.cases.SessionStartFailed.make({ sessionId, message: reason }))
        }),
      )

    /**
     * Starts a running Session's Claude Code again with the model and effort the Hub sends (#128),
     * resuming its conversation: Claude Code exits as on a stop and starts in a new tmux session,
     * while its Sandbox stays as it is. The Hub sends it only while
     * no Turn runs. A Claude Code that won't start again leaves the Session as a failed start does,
     * asleep.
     */
    const relaunch = (request: RelaunchSession) =>
      serialized(request.sessionId)(
        Effect.gen(function* () {
          const { sessionId } = request
          const session = running.get(sessionId)
          const sandbox = sandboxStarts.get(sessionId)
          if (session === undefined || sandbox === undefined) {
            return yield* hub.send(
              RunnerToHub.cases.SessionStartFailed.make({
                sessionId,
                message: "Claude Code was not running to restart with the new model",
              }),
            )
          }
          session.stopping = true
          yield* session.pane.terminate
          yield* Deferred.await(session.exited).pipe(Effect.timeoutOption(StopGracePeriod))
          yield* tmux.kill(sessionId)
          yield* forget(sessionId)
          const launched = yield* launchClaude(
            request,
            sessionDirectories(config.sessionsRoot, sessionId),
            sandbox,
          ).pipe(Effect.exit)

          if (Exit.isSuccess(launched)) {
            const model = [request.model ?? "default model", request.effort ?? "default effort"]
            yield* Effect.logInfo(`Session ${sessionId} restarted on ${model.join(", ")}`)
            return yield* started(sessionId)
          }
          const reason = message(launched.cause)
          yield* forget(sessionId)
          yield* Effect.logWarning(`Session ${sessionId} failed to restart: ${reason}`)
          yield* tmux.kill(sessionId)
          yield* git.pushWip(sessionId, sessionDirectories(config.sessionsRoot, sessionId), "Sleep")
          yield* sandboxes.stop(sessionId, "Sleep")
          yield* hub.send(RunnerToHub.cases.SessionStartFailed.make({ sessionId, message: reason }))
        }),
      )

    const stop = (request: StopSession) =>
      serialized(request.sessionId)(
        Effect.gen(function* () {
          const { sessionId } = request
          const session = running.get(sessionId)
          let exitCode: number | undefined
          if (session !== undefined) {
            session.stopping = true
            yield* session.pane.terminate
            const exited = yield* Deferred.await(session.exited).pipe(
              Effect.timeoutOption(StopGracePeriod),
            )
            if (exited._tag === "Some") exitCode = exited.value
          }
          yield* forget(sessionId)
          yield* tmux.kill(sessionId)
          // The Workspace's last state goes to its WIP ref before the Session sleeps, and before
          // it is archived: the archive hook. Archiving destroys the Sandbox and its volumes and
          // keeps the Workspace, for a restore; purging removes the Workspace later.
          yield* git.pushWip(
            sessionId,
            sessionDirectories(config.sessionsRoot, sessionId),
            request.reason === "Archive" ? "Archive" : "Sleep",
          )
          yield* sandboxes.stop(sessionId, request.reason)
          yield* Effect.logInfo(`Session ${sessionId} stopped (${request.reason})`)
          yield* hub.send(
            RunnerToHub.cases.SessionStopped.make({
              sessionId,
              reason: "Requested",
              ...(exitCode === undefined ? {} : { exitCode }),
            }),
          )
        }),
      )

    /**
     * Deletes everything of a purged Session: stops Claude Code if it is somehow running, then
     * destroys its Sandbox and volumes, and removes its directory and Claude Code's state for it.
     * Says SessionPurged only once all of it is gone; the Hub asks again on the next connection
     * otherwise.
     */
    const purge = (sessionId: SessionId) =>
      serialized(sessionId)(
        Effect.gen(function* () {
          const session = running.get(sessionId)
          if (session !== undefined) {
            session.stopping = true
            yield* session.pane.terminate
            yield* Deferred.await(session.exited).pipe(Effect.timeoutOption(StopGracePeriod))
          }
          yield* tmux.kill(sessionId)
          yield* forget(sessionId)
          yield* sandboxes.purge(sessionId)
          yield* workspaces.remove(sessionId)
          yield* Effect.logInfo(`Session ${sessionId} purged`)
          yield* hub.send(RunnerToHub.cases.SessionPurged.make({ sessionId }))
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`Session ${sessionId} was not purged: ${message(cause)}`),
        ),
        Effect.ensuring(Effect.sync(() => locks.delete(sessionId))),
      )

    // Its Session token is read back from Claude Code's environment, where the launch put it for
    // the mod (ModEnvironment.modToken). It lets only this Session in, so a guest that changed it
    // gains nothing. Anything missing, and the Session sleeps, as its Sandbox is stopped.
    const adopt = Effect.gen(function* () {
      yield* tmux.retireHostServer
      const kept: Array<SessionId> = []
      for (const sessionId of yield* sandboxes.running) {
        if (!isSafeSessionId(sessionId)) continue
        const token = yield* tmux.variable(sessionId, ModEnvironment.modToken)
        if (token === undefined || !(yield* proxy.hold(sessionId, token))) {
          yield* Effect.logInfo(
            `Session ${sessionId}: Claude Code is no longer running, so it sleeps`,
          )
          continue
        }
        sessionTokens.set(sessionId, token)
        held.add(sessionId)
        const watched = yield* watch(sessionId).pipe(Effect.exit)
        if (Exit.isFailure(watched)) {
          yield* forget(sessionId)
          yield* Effect.logWarning(
            `Session ${sessionId}: could not attach to its terminal, so it sleeps: ${message(watched.cause)}`,
          )
          continue
        }
        kept.push(sessionId)
        yield* Effect.logInfo(`Session ${sessionId}: Claude Code kept running across the restart`)
      }
      yield* sandboxes.reconcile(kept)
    })

    /**
     * Lets a Session kept running across a restart in again, now the Hub has given it a new mod
     * token: the proxy takes its held Session token back, standing for the new mod token and its
     * Creator's Claude credential, and its Sandbox is taken back, so Claude Code can start again
     * in it with a new model.
     */
    const readmit = (sessionId: SessionId, modToken: string) =>
      serialized(sessionId)(
        Effect.gen(function* () {
          if (!held.has(sessionId)) {
            return yield* Effect.logWarning(
              `Ignored a new mod token for Session ${sessionId}, which wasn't waiting for one`,
            )
          }
          yield* admit(sessionId, modToken)
          held.delete(sessionId)
          const sandbox = yield* sandboxes
            .keep(sessionId, sessionDirectories(config.sessionsRoot, sessionId))
            .pipe(
              Effect.tapError((error) =>
                Effect.logWarning(
                  `Session ${sessionId}: could not take back its Sandbox, so it can't change model until it sleeps: ${error.message}`,
                ),
              ),
              Effect.option,
            )
          if (sandbox._tag === "Some") sandboxStarts.set(sessionId, sandbox.value)
          yield* Effect.logInfo(`Session ${sessionId} is back on a new mod token`)
        }),
      )

    /** Runs a Test build, streaming its output to the Hub, and reports how it ended. */
    const testBuild = (request: RunTestBuild) => {
      const { testBuildId } = request
      return sandboxes
        .testBuild(request, (data) =>
          hub.send(RunnerToHub.cases.TestBuildLog.make({ testBuildId, data })),
        )
        .pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            hub.send(
              RunnerToHub.cases.TestBuildFinished.make(
                Exit.isSuccess(exit)
                  ? { testBuildId, result: "Passed" }
                  : { testBuildId, result: "Failed", message: message(exit.cause) },
              ),
            ),
          ),
        )
    }

    const handle = (incoming: HubToRunner): Effect.Effect<void> => {
      switch (incoming._tag) {
        case "StartSession":
          if (!isSafeSessionId(incoming.sessionId)) {
            return hub.send(
              RunnerToHub.cases.SessionStartFailed.make({
                sessionId: incoming.sessionId,
                message: "The Session id is not one the Runner can name a directory after",
              }),
            )
          }
          return background(start(incoming))
        case "RelaunchSession":
          if (!isSafeSessionId(incoming.sessionId)) {
            return Effect.logWarning(`Ignored a RelaunchSession for ${incoming.sessionId}`)
          }
          return background(relaunch(incoming))
        case "ModTokenReissued":
          return background(readmit(incoming.sessionId, incoming.modToken))
        case "StopSession":
          return background(stop(incoming))
        case "PurgeSession":
          if (!isSafeSessionId(incoming.sessionId)) {
            return Effect.logWarning(`Ignored a PurgeSession for ${incoming.sessionId}`)
          }
          return background(purge(incoming.sessionId))
        case "TerminalInput":
          return running.get(incoming.sessionId)?.pane.input(incoming.data) ?? Effect.void
        case "TerminalResize":
          return running.get(incoming.sessionId)?.pane.resize(incoming.size) ?? Effect.void
        case "RequestTerminalSnapshot":
          return running.get(incoming.sessionId)?.pane.snapshot ?? Effect.void
        case "GitReply":
          return hubGit.receive(incoming)
        case "SessionTurnEnded":
          return running.has(incoming.sessionId)
            ? background(
                git.pushWip(
                  incoming.sessionId,
                  sessionDirectories(config.sessionsRoot, incoming.sessionId),
                  "TurnEnded",
                ),
              )
            : Effect.void
        case "RunTestBuild":
          return background(testBuild(incoming))
        case "VariablesFetched":
        case "VariablesRefused":
          return hubVariables.receive(incoming)
        case "ClaudeCredentialFetched":
        case "ClaudeCredentialRefused":
          return hubClaudeCredential.receive(incoming)
        case "RunnerWelcome":
        case "HandshakeRejected":
          return Effect.logWarning(`Ignored a ${incoming._tag} after the handshake`)
        case "CheckUpdate":
        case "ApplyUpdate":
          // The connection hands these to the Updater.
          return Effect.void
      }
    }

    return Sessions.of({
      adopt,
      running: Effect.sync(() => Array.from(running.keys())),
      withoutModToken: Effect.sync(() => Array.from(held)),
      handle,
      snapshotAll: Effect.suspend(() =>
        Effect.forEach(running.values(), (session) => session.pane.snapshot, { discard: true }),
      ),
      ownClaudeAccount: proxy.runnerAccount,
    })
  }),
)
