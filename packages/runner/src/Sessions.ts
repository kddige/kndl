import { randomUUID } from "node:crypto"
import type {
  ClaudeCredential,
  Harness,
  HubToRunner,
  MeasureSessionDisks,
  RelaunchSession,
  RunTestBuild,
  SessionDiskSize,
  SessionId,
  StartSession,
  StopSession,
  TerminalSize,
} from "@kndl/protocol"
import { RunnerToHub } from "@kndl/protocol"
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
import { ClaudeSessionIdPattern } from "./ClaudeConfig.ts"
import { ClaudeTokenVariable } from "./ClaudeEnvironment.ts"
import { claudeLaunch } from "./ClaudeLaunch.ts"
import { HarnessVariable, harnessEnvironment, ModEnvironment } from "./HarnessEnvironment.ts"
import { HubClaudeCredential, retryingTimeouts } from "./HubClaudeCredential.ts"
import { HubGit } from "./HubGit.ts"
import { HubLink } from "./HubLink.ts"
import { HubVariables } from "./HubVariables.ts"
import { OpenPorts } from "./OpenPorts.ts"
import { PiBundle } from "./PiBundle.ts"
import { piLaunch, PiSessionIdPattern } from "./PiLaunch.ts"
import { ModRelay } from "./relay/ModRelay.ts"
import { RunnerConfig } from "./RunnerConfig.ts"
import { Sandboxes, type SandboxStarted } from "./Sandbox.ts"
import { workspaceGuestPath } from "./sandbox/SessionLayout.ts"
import { copySessionMod } from "./SessionMod.ts"
import { isSafeSessionId, type SessionDirectories, sessionDirectories } from "./SessionNames.ts"
import { type Pane, Tmux } from "./Tmux.ts"
import { Workspaces } from "./Workspace.ts"

/** The terminal size a Session starts with, until a viewer resizes it. */
export const InitialTerminalSize: TerminalSize = { cols: 120, rows: 40 }

/** How long a stopped Claude Code gets to exit after SIGTERM before its tmux session is killed. */
export const StopGracePeriod = Duration.seconds(10)

/**
 * The Sessions running on this Runner: each one its Harness, Claude Code or pi, in a tmux session
 * in its Sandbox (ADR 0013, ADR 0029), whose terminal is streamed to the Hub.
 */
export class Sessions extends Context.Service<
  Sessions,
  {
    /**
     * Takes back the Sessions an earlier Runner left running, as after a restart (#157). Each
     * one whose Claude Code still runs in its Sandbox keeps running, its terminal streamed again.
     * The Session token its Claude Code holds, read back from it, is held for it alone at the
     * mod relay until the Hub gives it a new mod token (ModTokenReissued). Any other Sandbox left
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
    /**
     * Sends a `Snapshot` frame of every running Session, and its Open ports, as after
     * reconnecting.
     */
    readonly snapshotAll: Effect.Effect<void>
  }
>()("@kndl/runner/Sessions") {}

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

/** The Harness's name, as a Session's history and the Runner's log say it. */
const harnessName = (harness: Harness) => (harness === "Pi" ? "pi" : "Claude Code")

/** What a Harness's launch takes from the Session's start or relaunch, when it says so. */
const settingOf = (request: StartSession | RelaunchSession) => ({
  ...(request.model === undefined ? {} : { model: request.model }),
  ...(request.thinkingLevel === undefined ? {} : { thinkingLevel: request.thinkingLevel }),
  ...(request.mcpServers === undefined ? {} : { mcpServers: request.mcpServers }),
})

/** `text` with every occurrence of each of `values` masked, character for character. */
export function withoutValues(text: string, values: ReadonlyArray<string> = []): string {
  return values.reduce(
    (masked, value) => (value === "" ? masked : masked.replaceAll(value, "*".repeat(value.length))),
    text,
  )
}

export const SessionsLive = Layer.effect(
  Sessions,
  Effect.gen(function* () {
    const config = yield* RunnerConfig
    const tmux = yield* Tmux
    const workspaces = yield* Workspaces
    const sandboxes = yield* Sandboxes
    const hub = yield* HubLink
    const hubGit = yield* HubGit
    const hubVariables = yield* HubVariables
    const hubClaudeCredential = yield* HubClaudeCredential
    const relay = yield* ModRelay
    const ports = yield* OpenPorts
    const piBundle = yield* PiBundle
    const layerScope = yield* Effect.scope

    const running = new Map<SessionId, Running>()
    /**
     * The Session token and the setup token each Session's Claude Code was started with, kept out
     * of what it printed before it exited.
     */
    const launchSecrets = new Map<SessionId, ReadonlyArray<string>>()
    /** What each started Session's Sandbox runs: its Environment version and Claude Code. */
    const sandboxStarts = new Map<SessionId, SandboxStarted>()
    /**
     * What each started Session runs now (ADR 0029), for a relaunch to start it again, or to switch
     * it to the other (ADR 0030).
     */
    const harnesses = new Map<SessionId, Harness>()
    /** Sessions kept running across a restart, whose Session token waits for a mod token. */
    const held = new Set<SessionId>()
    const locks = new Map<SessionId, Semaphore.Semaphore>()

    /**
     * Gives the Session a Session token for the mod relay, standing for its mod token. Its mod and
     * Claude Code's MCP traffic hold the token in place of the mod token.
     */
    const admit = (sessionId: SessionId, modToken: string) =>
      relay.admit({ sessionId, modToken: Redacted.make(modToken) })

    /** Revokes the Session's Session token, held or live, as it stops. */
    const forget = (sessionId: SessionId) => {
      launchSecrets.delete(sessionId)
      held.delete(sessionId)
      return relay.revoke(sessionId)
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
     * snapshot. When Claude Code exits on its own, reports it and cleans up. Watches its
     * Sandbox's Open ports too, until it stops (ADR 0016).
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
        yield* ports.watch(sessionId)
      })

    // What Claude Code printed before it exited is read from its dead pane, which tmux keeps
    // (`remain-on-exit`), before the tmux session is killed: otherwise why it exited is lost (#105).
    const exitedOnItsOwn = (sessionId: SessionId, exitCode: number | undefined) =>
      serialized(sessionId)(
        Effect.gen(function* () {
          const output = withoutValues(
            yield* tmux.lastOutput(sessionId),
            launchSecrets.get(sessionId),
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
          yield* ports.unwatch(sessionId)
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
     * (#105). One that isn't a Claude Code session id, which Claude Code can't have had, starts
     * new with an id of its own, which the mod's hello gives the Hub. The Session's history still
     * shows the old conversation, so a note there says Claude Code doesn't remember it (#191).
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
        const isClaudeId = ClaudeSessionIdPattern.test(id)
        if (isClaudeId && (yield* sandboxes.hasTranscript(request.sessionId, directories, id)))
          return { _tag: "Resume", id } as const
        yield* Effect.logWarning(
          isClaudeId
            ? `Session ${request.sessionId}: Claude Code has no transcript of conversation ${id}, ` +
                "so it starts a new one with that id instead of resuming it"
            : `Session ${request.sessionId}: conversation ${id} isn't Claude Code's, ` +
                "so it starts a new one instead of resuming it",
        )
        yield* hub.send(
          RunnerToHub.cases.SandboxNote.make({
            sessionId: request.sessionId,
            message: isClaudeId
              ? "Claude Code couldn't resume its conversation, which it has no transcript of, so " +
                "it started a new one: it doesn't remember what was said above."
              : "Claude Code couldn't resume a conversation it didn't have, so it started a new " +
                "one: it doesn't remember what was said above.",
          }),
        )
        return { _tag: "New", id: isClaudeId ? id : randomUUID() } as const
      })

    /**
     * The conversation to start pi with: a new one, or the one the Hub asks to resume. Either goes
     * to pi's `--session-id`, which resumes pi's session of that id, kept on the Session's volume,
     * or starts one with that id when pi has none, so there is nothing to check first. One pi
     * would refuse as a session id, which it can't have had, starts new with an id of its own, and
     * a note in the Session says pi doesn't remember it.
     */
    const piConversationFor = (request: StartSession | RelaunchSession) =>
      Effect.gen(function* () {
        if (request.resume === undefined) return randomUUID()
        if (PiSessionIdPattern.test(request.resume)) return request.resume
        yield* Effect.logWarning(
          `Session ${request.sessionId}: conversation ${request.resume} isn't pi's, so it starts a new one instead of resuming it`,
        )
        yield* hub.send(
          RunnerToHub.cases.SandboxNote.make({
            sessionId: request.sessionId,
            message:
              "pi couldn't resume a conversation it didn't have, so it started a new one: it " +
              "doesn't remember what was said above.",
          }),
        )
        return randomUUID()
      })

    /**
     * Starts the Session's Harness in a new tmux session in its running Sandbox, and watches it,
     * Claude Code (ADR 0013) and pi (ADR 0029) alike. It holds a new Session token, and its
     * Creator's setup token when it has one, both given to it alone, never set on the Sandbox
     * (HarnessEnvironment.ts), and loads a new copy of the Runner's mod, which nothing changes while
     * it runs (#159), and which adds the MCP servers of its Installations (ADR 0020). `command`
     * says how the Harness runs from that copy: its command line, and the environment the Sandbox
     * and the launch give it.
     */
    const launch =
      <E>(
        request: StartSession | RelaunchSession,
        credential: ClaudeCredential | undefined,
        command: (
          mod: string,
          directories: SessionDirectories,
          sandbox: SandboxStarted,
        ) => Effect.Effect<
          { readonly argv: ReadonlyArray<string>; readonly env: Readonly<Record<string, string>> },
          E
        >,
      ) =>
      (directories: SessionDirectories, sandbox: SandboxStarted) =>
        Effect.gen(function* () {
          const { sessionId } = request
          const mod = yield* copySessionMod(config.modDir, directories, request.mcpServers)
          const { argv, env } = yield* command(mod, directories, sandbox)
          const sessionToken = yield* admit(sessionId, request.modToken)
          launchSecrets.set(sessionId, [
            Redacted.value(sessionToken),
            ...(credential === undefined ? [] : [Redacted.value(credential.token)]),
          ])
          const environment = harnessEnvironment({
            base: env,
            relayUrl: relay.guestUrl,
            sessionToken,
            ...(credential === undefined ? {} : { credential }),
          })
          yield* tmux.launch({
            sessionId,
            cwd: workspaceGuestPath,
            argv,
            env: environment.env,
            unset: environment.unset,
            size: InitialTerminalSize,
          })
          yield* watch(sessionId)
        })

    /**
     * Readies the Session's Harness to start, before its Sandbox does, and gives what starts it
     * there ({@link launch}). Claude Code needs its Creator's setup token (ADR 0026): a refusal
     * fails the start. pi needs the Runner's pi bundle, and takes the setup token if the Hub gives
     * it, for its Claude bridge: without it, Claude's Models aren't there, but pi runs. A Hub that
     * was only slow to answer is asked again, so it doesn't cost pi Claude's Models.
     */
    const launcherFor = (request: StartSession | RelaunchSession, harness: Harness) =>
      Effect.gen(function* () {
        const { sessionId } = request
        if (harness === "ClaudeCode") {
          const credential = yield* hubClaudeCredential.fetch(sessionId)
          return launch(request, credential, (mod, directories, sandbox) =>
            Effect.map(conversationFor(request, directories), (conversation) => {
              const started = claudeLaunch({
                claudePath: sandbox.claude.path,
                sessionId,
                mod,
                conversation,
                ...settingOf(request),
              })
              return { argv: started.argv, env: { ...sandbox.claude.env, ...started.env } }
            }),
          )
        }
        const pi = yield* piBundle.ready
        if (pi === undefined)
          return yield* Effect.fail(
            new Error("This Runner doesn't run pi Sessions: its log says why."),
          )
        const credential = yield* retryingTimeouts(hubClaudeCredential.fetch(sessionId)).pipe(
          Effect.map((given): ClaudeCredential | undefined => given),
          Effect.catch((error) =>
            Effect.as(
              Effect.logInfo(
                `Session ${sessionId}: pi runs without Claude's Models, as the Hub gave no Claude credential: ${error.message}`,
              ),
              undefined,
            ),
          ),
        )
        return launch(request, credential, (mod, _directories, sandbox) =>
          Effect.map(piConversationFor(request), (conversationId) => {
            const started = piLaunch({
              nodePath: sandbox.pi.node,
              cliPath: pi.cli,
              sessionId,
              mod,
              conversationId,
              ...settingOf(request),
              ...(credential === undefined ? {} : { claudePath: sandbox.claude.path }),
            })
            return { argv: started.argv, env: { ...sandbox.pi.env, ...started.env } }
          }),
        )
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
          const harness = request.harness ?? "ClaudeCode"
          harnesses.set(sessionId, harness)
          const launched = yield* Effect.gen(function* () {
            // Its Creator's setup token first (ADR 0026), and pi's bundle for a pi Session:
            // without them, the Session can't run, and its Sandbox isn't started for nothing.
            const starts = yield* launcherFor(request, harness)
            const directories = yield* workspaces.prepare(request)
            // The Sandbox (#9) is created and started around the Workspace before the Harness,
            // from the Repo's Environment if it has one (ADR 0009).
            const sandbox = yield* sandboxes.start(sessionId, directories, {
              repo: request.repo,
              ...(request.environment === undefined ? {} : { environment: request.environment }),
              ...(request.gitIdentity === undefined ? {} : { gitIdentity: request.gitIdentity }),
              ...(harness === "Pi" ? { harness } : {}),
            })
            sandboxStarts.set(sessionId, sandbox)
            yield* starts(directories, sandbox)
          }).pipe(Effect.exit)

          if (Exit.isSuccess(launched)) {
            yield* Effect.logInfo(`Session ${sessionId} started`)
            return yield* started(sessionId)
          }
          const reason = message(launched.cause)
          yield* forget(sessionId)
          yield* Effect.logWarning(`Session ${sessionId} failed to start: ${reason}`)
          yield* tmux.kill(sessionId)
          yield* ports.unwatch(sessionId)
          yield* sandboxes.stop(sessionId, "Sleep")
          yield* hub.send(RunnerToHub.cases.SessionStartFailed.make({ sessionId, message: reason }))
        }),
      )

    /**
     * Starts a running Session's Claude Code again with the model and thinking level the Hub sends
     * (#128), resuming its conversation: Claude Code exits as on a stop and starts in a new tmux
     * session, while its Sandbox stays as it is, on its Creator's setup token fetched again. The
     * Hub sends it only while no Turn runs. A Claude Code that won't start again, as when the Hub
     * refuses the setup token, leaves the Session as a failed start does, asleep.
     *
     * A pi Session's pi starts again the same way. The Hub switches a pi Session's model in pi
     * itself, while it runs, but a relaunch still works.
     *
     * A relaunch onto the other Harness switches the Session's (ADR 0030): the one stops as above,
     * and the other starts in the same Sandbox, readied for it first as its start would have, on
     * the conversation the Hub names, or a new one. Absent, the Harness is Claude Code.
     */
    const relaunch = (request: RelaunchSession) =>
      serialized(request.sessionId)(
        Effect.gen(function* () {
          const { sessionId } = request
          const session = running.get(sessionId)
          const sandbox = sandboxStarts.get(sessionId)
          const was = harnesses.get(sessionId) ?? "ClaudeCode"
          const harness = request.harness ?? "ClaudeCode"
          if (session === undefined || sandbox === undefined) {
            return yield* hub.send(
              RunnerToHub.cases.SessionStartFailed.make({
                sessionId,
                message: `${harnessName(was)} was not running to restart with the new model`,
              }),
            )
          }
          session.stopping = true
          yield* session.pane.terminate
          yield* Deferred.await(session.exited).pipe(Effect.timeoutOption(StopGracePeriod))
          yield* tmux.kill(sessionId)
          yield* forget(sessionId)
          const launched = yield* Effect.gen(function* () {
            const starts = yield* launcherFor(request, harness)
            if (harness !== was) {
              yield* sandboxes.readyFor(sessionId, harness, sandbox)
              harnesses.set(sessionId, harness)
            }
            yield* starts(sessionDirectories(config.sessionsRoot, sessionId), sandbox)
          }).pipe(Effect.exit)

          if (Exit.isSuccess(launched)) {
            const model = [
              request.model ?? "default model",
              request.thinkingLevel ?? "default thinking level",
            ]
            yield* Effect.logInfo(
              harness === was
                ? `Session ${sessionId} restarted on ${model.join(", ")}`
                : `Session ${sessionId} switched from ${harnessName(was)} to ${harnessName(harness)}, on ${model.join(", ")}`,
            )
            return yield* started(sessionId)
          }
          const reason = message(launched.cause)
          yield* forget(sessionId)
          yield* Effect.logWarning(`Session ${sessionId} failed to restart: ${reason}`)
          yield* tmux.kill(sessionId)
          yield* ports.unwatch(sessionId)
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
          yield* ports.unwatch(sessionId)
          // Archiving destroys the Sandbox and its volumes and keeps the Workspace, for a restore;
          // purging removes the Workspace later.
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
     * Measures the disk the Sessions take (#352), a few at a time since walking a Workspace reads
     * a lot of disk: each one's directory and its Sandbox volumes, as allocated. A Session whose id
     * can't name a directory, or that couldn't be measured, is left without a size, not guessed.
     */
    const measureDisks = (request: MeasureSessionDisks) =>
      Effect.forEach(
        request.sessionIds,
        (sessionId): Effect.Effect<SessionDiskSize> => {
          if (!isSafeSessionId(sessionId)) return Effect.succeed({ sessionId })
          return Effect.all([workspaces.usage(sessionId), sandboxes.diskUsage(sessionId)]).pipe(
            Effect.map(([directory, volumes]): SessionDiskSize => ({
              sessionId,
              bytes: directory + volumes,
            })),
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `Could not measure the disk Session ${sessionId} takes: ${message(cause)}`,
              ).pipe(Effect.as({ sessionId })),
            ),
          )
        },
        { concurrency: 4 },
      ).pipe(
        Effect.flatMap((sizes) =>
          hub.send(
            RunnerToHub.cases.SessionDisksMeasured.make({ requestId: request.requestId, sizes }),
          ),
        ),
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
          yield* ports.unwatch(sessionId)
          yield* sandboxes.purge(sessionId)
          yield* workspaces.remove(sessionId)
          yield* Effect.logInfo(`Session ${sessionId} purged`)
          yield* hub.send(RunnerToHub.cases.SessionPurged.make({ sessionId }))
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`Session ${sessionId} was not purged: ${message(cause)}`),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            locks.delete(sessionId)
            harnesses.delete(sessionId)
          }),
        ),
      )

    // Its Session token is read back from Claude Code's environment, where the launch put it for
    // the mod (ModEnvironment.modToken). It lets only this Session in, so a guest that changed it
    // gains nothing. Anything missing, and the Session sleeps, as its Sandbox is stopped. Claude
    // Code runs on with the setup token it was started with, read back too only to keep it out
    // of what it prints as it exits. Which Harness runs is read back the same way, as a Session may
    // have switched since it started (ADR 0030): each launch says so (HarnessVariable), but a Claude
    // Code started before pi, which doesn't.
    const adopt = Effect.gen(function* () {
      yield* tmux.retireHostServer
      const kept: Array<SessionId> = []
      for (const sessionId of yield* sandboxes.running) {
        if (!isSafeSessionId(sessionId)) continue
        const token = yield* tmux.variable(sessionId, ModEnvironment.modToken)
        if (token === undefined || !(yield* relay.hold(sessionId, token))) {
          yield* Effect.logInfo(
            `Session ${sessionId}: its Harness is no longer running, so it sleeps`,
          )
          continue
        }
        const setupToken = yield* tmux.variable(sessionId, ClaudeTokenVariable)
        launchSecrets.set(sessionId, setupToken === undefined ? [token] : [token, setupToken])
        const harness: Harness =
          (yield* tmux.variable(sessionId, HarnessVariable)) === "Pi" ? "Pi" : "ClaudeCode"
        harnesses.set(sessionId, harness)
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
        yield* Effect.logInfo(
          `Session ${sessionId}: ${harnessName(harness)} kept running across the restart`,
        )
      }
      yield* sandboxes.reconcile(kept)
    })

    /**
     * Lets a Session kept running across a restart in again, now the Hub has given it a new mod
     * token: the relay takes its held Session token back, standing for the new mod token, and its
     * Sandbox is taken back, so Claude Code can start again in it with a new model. Its Claude
     * Code still has its setup token, so none is fetched.
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
        case "MeasureSessionDisks":
          return background(measureDisks(incoming))
        case "TerminalInput":
          return running.get(incoming.sessionId)?.pane.input(incoming.data) ?? Effect.void
        case "TerminalResize":
          return running.get(incoming.sessionId)?.pane.resize(incoming.size) ?? Effect.void
        case "RequestTerminalSnapshot":
          return running.get(incoming.sessionId)?.pane.snapshot ?? Effect.void
        case "GitReply":
          return hubGit.receive(incoming)
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
        case "OpenTunnel":
          // The connection hands these to the Updater, and tunnels to Tunnels.ts.
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
      ).pipe(Effect.andThen(ports.resendAll)),
    })
  }),
)
