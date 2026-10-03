import { randomUUID } from "node:crypto"
import type {
  HubToRunner,
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
import { claudeLaunch } from "./ClaudeLaunch.ts"
import { ClaudeTrust } from "./ClaudeTrust.ts"
import { HubGit } from "./HubGit.ts"
import { HubLink } from "./HubLink.ts"
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
    /** Picks up the Sessions still running in tmux, as after a Runner restart. */
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
    const layerScope = yield* Effect.scope

    const running = new Map<SessionId, Running>()
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

    const exitedOnItsOwn = (sessionId: SessionId, exitCode: number | undefined) =>
      serialized(sessionId)(
        Effect.gen(function* () {
          yield* Effect.logInfo(`Session ${sessionId} exited with ${exitCode ?? "unknown status"}`)
          yield* tmux.kill(sessionId)
          yield* git.pushWip(sessionId, sessionDirectories(config.sessionsRoot, sessionId), "Sleep")
          yield* sandboxes.stop(sessionId, "Sleep")
          yield* hub.send(
            RunnerToHub.cases.SessionStopped.make({
              sessionId,
              reason: "Exited",
              ...(exitCode === undefined ? {} : { exitCode }),
            }),
          )
        }),
      )

    const start = (request: StartSession) =>
      serialized(request.sessionId)(
        Effect.gen(function* () {
          const { sessionId } = request
          if (running.has(sessionId)) {
            return yield* hub.send(RunnerToHub.cases.SessionStarted.make({ sessionId }))
          }
          // Whatever is left of an earlier run, such as a tmux session whose process exited.
          yield* tmux.kill(sessionId)
          const launched = yield* Effect.gen(function* () {
            const directories = yield* workspaces.prepare(request)
            // The Sandbox (#9) is created and started around the Workspace before Claude Code.
            yield* sandboxes.start(sessionId, directories)
            const launch = claudeLaunch({
              claudeBin: config.claudeBin,
              modDir: config.modDir,
              hubUrl: config.hubUrl,
              sessionId,
              modToken: request.modToken,
              toolsSocket: directories.toolsSocket,
              conversation:
                request.resume === undefined
                  ? { _tag: "New", id: randomUUID() }
                  : { _tag: "Resume", id: request.resume },
            })
            // Its trust may have been dropped since startup, and the dialog would stop the mod.
            yield* trust.ensure
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
            return yield* hub.send(RunnerToHub.cases.SessionStarted.make({ sessionId }))
          }
          const reason = message(launched.cause)
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

    const adopt = Effect.gen(function* () {
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
              Effect.catchCause((cause) =>
                Effect.logWarning(`Session ${sessionId}: its Sandbox did not come back`, cause),
              ),
            )
      }
      yield* sandboxes.reconcile(running.keys())
    })

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
        case "RunnerWelcome":
        case "HandshakeRejected":
          return Effect.logWarning(`Ignored a ${incoming._tag} after the handshake`)
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
