import { randomUUID } from "node:crypto"
import { lstatSync, mkdirSync } from "node:fs"
import type {
  EnvironmentVersion,
  HubToRunner,
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
  Scope,
  Semaphore,
  Stream,
} from "effect"
import { ClaudeProjectsDir, hasTranscript } from "./ClaudeConfig.ts"
import { claudeLaunch } from "./ClaudeLaunch.ts"
import { ClaudeTrust } from "./ClaudeTrust.ts"
import { HubGit } from "./HubGit.ts"
import { HubLink } from "./HubLink.ts"
import { HubVariables } from "./HubVariables.ts"
import { noRepoFiles, writeRepoFiles } from "./RepoFiles.ts"
import { RunnerConfig } from "./RunnerConfig.ts"
import { Sandboxes } from "./Sandbox.ts"
import { isSafeSessionId, sessionDirectories } from "./SessionNames.ts"
import { type Pane, Tmux } from "./Tmux.ts"
import { Workspaces } from "./Workspace.ts"
import { WorkspaceGit } from "./WorkspaceGit.ts"

/** The terminal size a Session starts with, until a viewer resizes it. */
export const InitialTerminalSize: TerminalSize = { cols: 120, rows: 40 }

/** How long a stopped Claude Code gets to exit after SIGTERM before its tmux session is killed. */
export const StopGracePeriod = Duration.seconds(10)

/**
 * The Sessions running on this Runner: each one Claude Code in its own tmux session, whose
 * terminal is streamed to the Hub.
 */
export class Sessions extends Context.Service<
  Sessions,
  {
    /**
     * Picks up the Sessions still running in tmux, as after a Runner restart, once the tmux
     * server has the Runner's environment. Run once, at startup.
     */
    readonly adopt: Effect.Effect<void>
    /** The Sessions whose Claude Code is running, for {@link RunnerHello}. */
    readonly running: Effect.Effect<ReadonlyArray<SessionId>>
    /** Acts on a message from the Hub. Starting and stopping go on in the background. */
    readonly handle: (message: HubToRunner) => Effect.Effect<void>
    /** Sends a `Snapshot` frame of every running Session, as after reconnecting. */
    readonly snapshotAll: Effect.Effect<void>
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

/**
 * Makes sure the directory Claude Code starts in is there, right before it starts: Claude
 * Code exits at once when its working directory is gone (#105).
 */
const ensureDirectory = (directory: string) =>
  Effect.try({
    try: () => {
      const found = lstatSync(directory, { throwIfNoEntry: false })
      if (found?.isDirectory() === true) return false
      if (found !== undefined) throw new Error("it is not a directory")
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      return true
    },
    catch: (cause) =>
      new Error(
        `${directory}, where Claude Code starts, can't be used: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
  }).pipe(
    Effect.flatMap((made) =>
      made
        ? Effect.logWarning(`${directory}, where Claude Code starts, was missing: made it`)
        : Effect.void,
    ),
  )

export const SessionsLive = Layer.effect(
  Sessions,
  Effect.gen(function* () {
    const config = yield* RunnerConfig
    const tmux = yield* Tmux
    const workspaces = yield* Workspaces
    const sandboxes = yield* Sandboxes
    const hub = yield* HubLink
    const trust = yield* ClaudeTrust
    const git = yield* WorkspaceGit
    const hubGit = yield* HubGit
    const hubVariables = yield* HubVariables
    const projectsDir = yield* ClaudeProjectsDir
    const layerScope = yield* Effect.scope

    const running = new Map<SessionId, Running>()
    /**
     * The mod token each Session's Claude Code was started with, kept out of what it printed
     * before it exited. Not known for a Session re-adopted after a restart.
     */
    const modTokens = new Map<SessionId, string>()
    /** The Environment version each started Session's Sandbox runs. */
    const environmentVersions = new Map<SessionId, EnvironmentVersion>()
    const locks = new Map<SessionId, Semaphore.Semaphore>()

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
              // Interrupted means the Runner is shutting down: Claude Code keeps running in tmux,
              // to be re-adopted when the Runner comes back.
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
          const output = withoutValue(yield* tmux.lastOutput(sessionId), modTokens.get(sessionId))
          modTokens.delete(sessionId)
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
    const conversationFor = (request: StartSession, cwd: string) =>
      Effect.gen(function* () {
        if (request.resume === undefined) {
          return { _tag: "New", id: randomUUID() } as const
        }
        const id = request.resume
        if (hasTranscript(cwd, id, projectsDir) !== false) return { _tag: "Resume", id } as const
        yield* Effect.logInfo(
          `Session ${request.sessionId}: Claude Code has no transcript of conversation ${id} ` +
            `in ${projectsDir}, so it starts a new one with that id instead of resuming it`,
        )
        return { _tag: "New", id } as const
      })

    /**
     * Reads the Repo's skills and CLAUDE.md from the Workspace through the Sandbox, and writes them
     * for Claude Code over what an earlier start wrote, at every start and wake (#125). A Session
     * whose files can't be read starts without them.
     */
    const copyRepoFiles = (sessionId: SessionId, directory: string) =>
      Effect.gen(function* () {
        const files = yield* sandboxes
          .repoFiles(sessionId)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.as(
                Effect.logWarning(
                  `Session ${sessionId}: the Repo's skills and CLAUDE.md were not read`,
                  cause,
                ),
                noRepoFiles,
              ),
            ),
          )
        if (files.skipped.length > 0)
          yield* Effect.logInfo(
            `Session ${sessionId}: left out of the Repo's skills and CLAUDE.md: ${files.skipped.slice(0, 20).join("; ")}`,
          )
        yield* writeRepoFiles(directory, files)
      })

    const start = (request: StartSession) =>
      serialized(request.sessionId)(
        Effect.gen(function* () {
          const { sessionId } = request
          const started = (environmentVersion: EnvironmentVersion | undefined) =>
            hub.send(
              RunnerToHub.cases.SessionStarted.make({
                sessionId,
                ...(environmentVersion === undefined ? {} : { environmentVersion }),
              }),
            )
          if (running.has(sessionId)) return yield* started(environmentVersions.get(sessionId))
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
            if (sandbox.environmentVersion === undefined) environmentVersions.delete(sessionId)
            else environmentVersions.set(sessionId, sandbox.environmentVersion)
            yield* copyRepoFiles(sessionId, directories.repoFiles)
            const launch = claudeLaunch({
              claudeBin: config.claudeBin,
              modDir: config.modDir,
              hubUrl: config.hubUrl,
              sessionId,
              modToken: request.modToken,
              toolsSocket: directories.toolsSocket,
              repoFiles: directories.repoFiles,
              repo: request.repo,
              workBranch: request.workBranch,
              conversation: yield* conversationFor(request, directories.claude),
            })
            // Its trust may have been dropped since startup, and the dialog would stop the mod.
            yield* trust.ensure
            yield* ensureDirectory(directories.claude)
            modTokens.set(sessionId, request.modToken)
            yield* tmux.launch({
              sessionId,
              cwd: directories.claude,
              argv: launch.argv,
              env: launch.env,
              size: InitialTerminalSize,
            })
            yield* watch(sessionId)
          }).pipe(Effect.exit)

          if (Exit.isSuccess(launched)) {
            yield* Effect.logInfo(`Session ${sessionId} started`)
            return yield* started(environmentVersions.get(sessionId))
          }
          const reason = message(launched.cause)
          modTokens.delete(sessionId)
          yield* Effect.logWarning(`Session ${sessionId} failed to start: ${reason}`)
          yield* tmux.kill(sessionId)
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
          modTokens.delete(sessionId)
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

    /**
     * Makes the tmux server on the Runner's socket its own before using it (#105): one left by
     * another process, as a Runner run from a checkout since deleted, keeps that process's `PWD`
     * and `PATH` for every Session it starts.
     */
    const claimServer = tmux.claimServer.pipe(
      Effect.flatMap((claim) => {
        const socket = `the tmux server on socket ${config.tmuxSocket}`
        const changed = claim._tag === "NoServer" ? [] : claim.changed
        const how = changed.length === 0 ? "" : ` (${changed.join("; ")})`
        switch (claim._tag) {
          case "NoServer":
            return Effect.void
          case "Replaced":
            return Effect.logInfo(
              `Stopped ${socket}, which had no sessions, so the next Session starts a fresh one with the Runner's environment${how}`,
            )
          case "Refreshed":
            return changed.length === 0
              ? Effect.void
              : Effect.logWarning(
                  `Kept ${socket}, which has ${claim.sessions} session(s), and set its environment to the Runner's${how}`,
                )
        }
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not check the tmux server's environment", cause),
      ),
    )

    const adopt = Effect.gen(function* () {
      yield* claimServer
      const found = yield* tmux.list.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not list tmux sessions to re-adopt", cause).pipe(Effect.as([])),
        ),
      )
      for (const sessionId of found) {
        if (running.has(sessionId)) continue
        const adopted = yield* watch(sessionId).pipe(
          Effect.tap(() => Effect.logInfo(`Re-adopted Session ${sessionId}`)),
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning(`Could not re-adopt Session ${sessionId}`, cause).pipe(
              Effect.as(false),
            ),
          ),
        )
        // Its Sandbox may have kept running or not; either way its tool bridge must come back.
        if (adopted)
          yield* sandboxes
            .start(sessionId, sessionDirectories(config.sessionsRoot, sessionId))
            .pipe(
              Effect.tap((sandbox) =>
                Effect.sync(() => {
                  if (sandbox.environmentVersion !== undefined)
                    environmentVersions.set(sessionId, sandbox.environmentVersion)
                }),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning(`Session ${sessionId}: its Sandbox did not come back`, cause),
              ),
            )
      }
      yield* sandboxes.reconcile(running.keys())
    })

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
      handle,
      snapshotAll: Effect.suspend(() =>
        Effect.forEach(running.values(), (session) => session.pane.snapshot, { discard: true }),
      ),
    })
  }),
)
