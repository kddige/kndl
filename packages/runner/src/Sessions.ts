import { randomUUID } from "node:crypto"
import type {
  ClaudeCredential,
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
  Option,
  Redacted,
  Scope,
  Semaphore,
  Stream,
} from "effect"
import { ClaudeTokenVariable } from "./ClaudeEnvironment.ts"
import { durableLaunch } from "./DurableLaunch.ts"
import { harnessEnvironment, ModEnvironment } from "./HarnessEnvironment.ts"
import { HubClaudeCredential, retryingTimeouts } from "./HubClaudeCredential.ts"
import { HubGit } from "./HubGit.ts"
import { HubLink } from "./HubLink.ts"
import { HubVariables } from "./HubVariables.ts"
import { OpenPorts } from "./OpenPorts.ts"
import { PiBundle, type PiReady } from "./PiBundle.ts"
import { ModRelay } from "./relay/ModRelay.ts"
import { RunnerConfig } from "./RunnerConfig.ts"
import { Sandboxes, type SandboxStarted } from "./Sandbox.ts"
import { workspaceGuestPath } from "./sandbox/SessionLayout.ts"
import { copySessionMod } from "./SessionMod.ts"
import { isSafeSessionId, type SessionDirectories, sessionDirectories } from "./SessionNames.ts"
import { type Agent, type Terminal, Tmux } from "./Tmux.ts"
import { Workspaces } from "./Workspace.ts"

/** The terminal size a Session starts with, until a viewer resizes it. */
export const InitialTerminalSize: TerminalSize = { cols: 120, rows: 40 }

/**
 * How long a stopped agent gets to exit after SIGTERM before its tmux session is killed. The
 * agent gives up its own shutdown sooner (agent.ts), so it is gone when this is over.
 */
export const StopGracePeriod = Duration.seconds(10)

/** How long a terminal whose tmux session is gone waits before it is made again. */
const TerminalReturnDelay = Duration.seconds(1)

/**
 * The Sessions running on this Runner: each one its durable agent (docs/design/durable-harness.md)
 * and its terminal, a shell, each in a tmux session in its Sandbox (ADR 0013), the terminal
 * streamed to the Hub. Every Session runs the agent, whatever Harness the Hub names: to the Hub,
 * it is pi.
 */
export class Sessions extends Context.Service<
  Sessions,
  {
    /**
     * Takes back the Sessions an earlier Runner left running, as after a restart (#157). Each
     * one whose agent still runs in its Sandbox keeps running, its terminal streamed again.
     * The Session token its agent holds, read back from it, is held for it alone at the
     * mod relay until the Hub gives it a new mod token (ModTokenReissued). Any other Sandbox left
     * running is stopped: the Hub has its Session Asleep once the Runner says hello without it.
     * Run once, at startup, before the hello.
     */
    readonly adopt: Effect.Effect<void>
    /** The Sessions whose agent is running, for {@link RunnerHello}. */
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

/** One run of a Session's agent: from its launch until it exits. */
interface AgentRun {
  readonly agent: Agent
  /** Set when the Hub asked it to stop, so its exit is reported as `Requested`, or not at all. */
  stopping: boolean
  /** Completes with the exit code once the agent has exited, or its tmux session is gone. */
  readonly exited: Deferred.Deferred<number | undefined>
}

interface Running {
  /** Its current terminal: another one after its tmux session was lost and made again. */
  terminal: Terminal
  /** Holds the terminal's and the agent's control clients, until the Session stops. */
  readonly scope: Scope.Closeable
  /** Its agent, once it is watched: another run after each relaunch. */
  agent: AgentRun | undefined
}

const message = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.message : String(error)
}

/** What the agent's launch takes from the Session's start or relaunch, when it says so. */
const settingOf = (request: StartSession | RelaunchSession) => ({
  ...(request.model === undefined ? {} : { model: request.model }),
  ...(request.thinkingLevel === undefined ? {} : { thinkingLevel: request.thinkingLevel }),
  ...(request.mcpServers === undefined ? {} : { mcpServers: request.mcpServers }),
})

/**
 * The conversation the Hub knows the Session's by: the one it asks to resume, or a new one. The
 * agent resumes from its storage either way; it only says it in its hello.
 */
const conversationFor = (request: StartSession | RelaunchSession) => request.resume ?? randomUUID()

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
     * The Session token, and the setup token when it had one, each Session's agent was started
     * with, kept out of what it printed before it exited.
     */
    const launchSecrets = new Map<SessionId, ReadonlyArray<string>>()
    /**
     * What each started Session's Sandbox runs, as its start or, after a restart, `keep` said: its
     * Environment version, and where Claude Code and Node.js are, for a relaunch.
     */
    const sandboxStarts = new Map<SessionId, SandboxStarted>()
    /** Sessions kept running across a restart, whose Session token waits for a mod token. */
    const held = new Set<SessionId>()
    const locks = new Map<SessionId, Semaphore.Semaphore>()

    /**
     * Gives the Session a Session token for the mod relay, standing for its mod token. Its agent
     * and its MCP traffic hold the token in place of the mod token.
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

    /** Forgets the Session's terminal and agent, closing their control clients. */
    const release = (sessionId: SessionId) =>
      Effect.suspend(() => {
        const session = running.get(sessionId)
        running.delete(sessionId)
        return session === undefined ? Effect.void : Scope.close(session.scope, Exit.void)
      })

    /**
     * Takes the Session down: forgets its control clients, revokes its tokens, kills its tmux
     * sessions, stops watching its ports, and last, `sandbox`. The order is this: its control
     * clients go first, so killing the tmux sessions isn't taken for the terminal being lost (and
     * made again); its tokens go before its agent is killed, so it reaches the Hub no more as it
     * dies; and the Sandbox goes last, as killing the tmux sessions runs in it.
     */
    const teardown = <E>(sessionId: SessionId, sandbox: Effect.Effect<void, E>) =>
      Effect.gen(function* () {
        yield* release(sessionId)
        yield* forget(sessionId)
        yield* tmux.kill(sessionId)
        yield* ports.unwatch(sessionId)
        yield* sandbox
      })

    /**
     * Watches the Session's agent, as it starts or starts again. When it exits on its own, reports
     * it and cleans up.
     */
    const watchAgent = (sessionId: SessionId, session: Running) =>
      Effect.gen(function* () {
        const scope = yield* Scope.fork(session.scope)
        const agent = yield* tmux.attachAgent(sessionId).pipe(
          Scope.provide(scope),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        )
        const run: AgentRun = {
          agent,
          stopping: false,
          exited: yield* Deferred.make<number | undefined>(),
        }
        session.agent = run
        yield* agent.exited.pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              const exitCode = Exit.isSuccess(exit) ? exit.value : undefined
              yield* Scope.close(scope, Exit.void)
              yield* Deferred.succeed(run.exited, exitCode)
              if (run.stopping) return
              // Interrupted means the Runner is shutting down: the agent runs on, and is taken
              // back when the Runner comes back (adopt).
              if (Exit.hasInterrupts(exit)) {
                if (running.get(sessionId) === session) yield* release(sessionId)
                return
              }
              yield* background(exitedOnItsOwn(sessionId, session, run, exitCode))
            }),
          ),
          Effect.forkIn(layerScope),
        )
      })

    /**
     * Attaches to the Session's terminal in `scope`, making its tmux session first if it is gone:
     * after someone killed it from inside, or in a Sandbox whose terminal was lost with the
     * Runner's restart. Its environment is the Sandbox's when this Runner started it; one it took
     * back has none until it is told, and its shell starts with the Sandbox's own.
     */
    const attachTerminal = (sessionId: SessionId, scope: Scope.Scope) =>
      tmux.attachTerminal(sessionId).pipe(
        Effect.catch(() =>
          tmux
            .launchTerminal({
              sessionId,
              cwd: workspaceGuestPath,
              env: sandboxStarts.get(sessionId)?.pi.env ?? {},
              size: InitialTerminalSize,
            })
            .pipe(Effect.flatMap(() => tmux.attachTerminal(sessionId))),
        ),
        Scope.provide(scope),
      )

    /**
     * Streams the Session's terminal to the Hub while it is the Session's current one. Should its
     * tmux session end while the Session runs, the terminal is attached again, after a second so a
     * terminal that cannot stay up is not made in a tight loop, and drawn to the Hub as a snapshot.
     */
    const streamTerminal = (
      sessionId: SessionId,
      session: Running,
      terminal: Terminal,
    ): Effect.Effect<void> =>
      terminal.events.pipe(
        Stream.runForEach((event) =>
          hub.send(
            RunnerToHub.cases.TerminalFrame.make({
              sessionId,
              kind: event._tag,
              data: event.data,
              size: event.size,
            }),
          ),
        ),
        Effect.andThen(
          Effect.gen(function* () {
            while (running.get(sessionId) === session) {
              yield* Effect.logWarning(
                `Session ${sessionId}: its terminal is gone, so it comes back`,
              )
              yield* Effect.sleep(TerminalReturnDelay)
              if (running.get(sessionId) !== session) return
              const attached = yield* Scope.fork(session.scope).pipe(
                Effect.flatMap((scope) =>
                  attachTerminal(sessionId, scope).pipe(
                    Effect.onError(() => Scope.close(scope, Exit.void)),
                  ),
                ),
                Effect.exit,
              )
              if (Exit.isFailure(attached)) {
                yield* Effect.logWarning(
                  `Session ${sessionId}: could not bring its terminal back: ${message(attached.cause)}`,
                )
                continue
              }
              session.terminal = attached.value
              yield* attached.value.snapshot
              return yield* streamTerminal(sessionId, session, attached.value)
            }
          }),
        ),
      )

    /**
     * Attaches to the Session's terminal and its agent, streams the terminal to the Hub, starting
     * with a snapshot, and watches the agent. Watches its Sandbox's Open ports too, until it stops
     * (ADR 0016).
     */
    const watch = (sessionId: SessionId) =>
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const terminal = yield* attachTerminal(sessionId, scope).pipe(
          Effect.onError(() => Scope.close(scope, Exit.void)),
        )
        const session: Running = { terminal, scope, agent: undefined }
        running.set(sessionId, session)
        yield* streamTerminal(sessionId, session, terminal).pipe(Effect.forkIn(scope))
        yield* terminal.snapshot
        yield* watchAgent(sessionId, session).pipe(Effect.onError(() => release(sessionId)))
        yield* ports.watch(sessionId)
      })

    /**
     * Stops the Session's agent, if it runs: SIGTERM, which has it close its storage, then up to
     * {@link StopGracePeriod} for it to exit. Its exit code, when it exited in time and tmux knows
     * it. Its tmux session is left, for the caller to kill.
     */
    const stopAgent = (session: Running | undefined) =>
      Effect.gen(function* () {
        const run = session?.agent
        if (run === undefined) return undefined
        run.stopping = true
        yield* run.agent.terminate
        const exited = yield* Deferred.await(run.exited).pipe(Effect.timeoutOption(StopGracePeriod))
        return Option.getOrUndefined(exited)
      })

    // What the agent printed before it exited is read from its dead pane, which tmux keeps
    // (`remain-on-exit`), before its tmux session is killed: otherwise why it exited is lost
    // (#105). The agent writes its own log too, on the Session's volume.
    const exitedOnItsOwn = (
      sessionId: SessionId,
      session: Running,
      run: AgentRun,
      exitCode: number | undefined,
    ) =>
      serialized(sessionId)(
        Effect.gen(function* () {
          // A stop or relaunch may already have queued behind the start that watched this run.
          // Keep the Session until cleanup holds its lock, and leave a newer agent alone.
          if (run.stopping || running.get(sessionId) !== session || session.agent !== run) return
          const output = withoutValues(
            yield* tmux.lastOutput(sessionId),
            launchSecrets.get(sessionId),
          )
          const exited = `Session ${sessionId}: its agent exited with ${exitCode ?? "unknown status"}`
          const log = exitCode === 0 ? Effect.logInfo : Effect.logWarning
          // Only the Hub knows the Environment's Sensitive values, so the output itself goes to the
          // Hub, which redacts it, and never into the Runner's log file.
          const lines = output === "" ? 0 : output.split("\n").length
          yield* log(
            lines === 0
              ? exited
              : `${exited}; its last ${lines} line(s) of output are on the Session's page`,
          )
          yield* teardown(sessionId, sandboxes.stop(sessionId, "Sleep"))
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
     * Starts the Session's durable agent in a new tmux session in its running Sandbox. It holds a
     * new Session token, and its Creator's setup token when it has one, both given to it alone,
     * never set on the Sandbox or its terminal (HarnessEnvironment.ts), and runs a new copy of the
     * Runner's mod, which nothing changes while it runs (#159).
     */
    const launchAgent =
      (request: StartSession | RelaunchSession, pi: PiReady, credential?: ClaudeCredential) =>
      (directories: SessionDirectories, sandbox: SandboxStarted) =>
        Effect.gen(function* () {
          const { sessionId } = request
          const mod = yield* copySessionMod(config.modDir, directories, pi.nodeModules)
          const { argv, env } = durableLaunch({
            nodePath: sandbox.pi.node,
            sessionId,
            mod,
            conversationId: conversationFor(request),
            ...settingOf(request),
            ...(credential === undefined ? {} : { claudePath: sandbox.claude.path }),
          })
          const sessionToken = yield* admit(sessionId, request.modToken)
          launchSecrets.set(sessionId, [
            Redacted.value(sessionToken),
            ...(credential === undefined ? [] : [Redacted.value(credential.token)]),
          ])
          const environment = harnessEnvironment({
            base: { ...sandbox.pi.env, ...env },
            relayUrl: relay.guestUrl,
            sessionToken,
            ...(credential === undefined ? {} : { credential }),
          })
          yield* tmux.launchAgent({
            sessionId,
            cwd: workspaceGuestPath,
            argv,
            env: environment.env,
            unset: environment.unset,
          })
        })

    /**
     * Readies the Session's agent to start, before its Sandbox does, and gives what starts it
     * there ({@link launchAgent}). It needs the Runner's pi bundle, and takes its Creator's setup
     * token if the Hub gives it, for its Claude bridge: without it, Claude's Models aren't there,
     * but the agent runs. A Hub that was only slow to answer is asked again, so it doesn't cost
     * the agent Claude's Models.
     */
    const launcherFor = (request: StartSession | RelaunchSession) =>
      Effect.gen(function* () {
        const { sessionId } = request
        const pi = yield* piBundle.ready
        if (pi === undefined)
          return yield* Effect.fail(new Error("This Runner can't run Sessions: its log says why."))
        const credential = yield* retryingTimeouts(hubClaudeCredential.fetch(sessionId)).pipe(
          Effect.map((given): ClaudeCredential | undefined => given),
          Effect.catch((error) =>
            Effect.as(
              Effect.logInfo(
                `Session ${sessionId}: its agent runs without Claude's Models, as the Hub gave no Claude credential: ${error.message}`,
              ),
              undefined,
            ),
          ),
        )
        return launchAgent(request, pi, credential)
      })

    /** Tells the Hub the Session's agent started, with the Environment version it runs. */
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
          // Whatever is left of an earlier run, such as a tmux session whose agent exited.
          yield* tmux.kill(sessionId)
          const launched = yield* Effect.gen(function* () {
            // The pi bundle, and its Creator's setup token if any, first: without the bundle, the
            // Session can't run, and its Sandbox isn't started for nothing.
            const starts = yield* launcherFor(request)
            const directories = yield* workspaces.prepare(request)
            // The Sandbox (#9) is created and started around the Workspace before the agent,
            // from the Repo's Environment if it has one (ADR 0009).
            const sandbox = yield* sandboxes.start(sessionId, directories, {
              repo: request.repo,
              ...(request.environment === undefined ? {} : { environment: request.environment }),
              ...(request.gitIdentity === undefined ? {} : { gitIdentity: request.gitIdentity }),
            })
            sandboxStarts.set(sessionId, sandbox)
            yield* starts(directories, sandbox)
            yield* tmux.launchTerminal({
              sessionId,
              cwd: workspaceGuestPath,
              env: sandbox.pi.env,
              size: InitialTerminalSize,
            })
            yield* watch(sessionId)
          }).pipe(Effect.exit)

          if (Exit.isSuccess(launched)) {
            yield* Effect.logInfo(`Session ${sessionId} started`)
            return yield* started(sessionId)
          }
          const reason = message(launched.cause)
          yield* Effect.logWarning(`Session ${sessionId} failed to start: ${reason}`)
          yield* teardown(sessionId, sandboxes.stop(sessionId, "Sleep"))
          yield* hub.send(RunnerToHub.cases.SessionStartFailed.make({ sessionId, message: reason }))
        }),
      )

    /**
     * Starts a running Session's agent again, with the model and thinking level the Hub sends
     * (#128), which it reads as it starts: the agent stops as on a stop and starts in a new tmux
     * session, resuming from its storage, while its Sandbox and its terminal stay as they are, on
     * its Creator's setup token fetched again. An agent that won't start again leaves the Session
     * as a failed start does, asleep. Whatever Harness the Hub names, the agent runs.
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
                message: "The agent was not running to restart with the new model",
              }),
            )
          }
          yield* stopAgent(session)
          yield* tmux.killAgent(sessionId)
          yield* forget(sessionId)
          const launched = yield* Effect.gen(function* () {
            const starts = yield* launcherFor(request)
            yield* starts(sessionDirectories(config.sessionsRoot, sessionId), sandbox)
            yield* watchAgent(sessionId, session)
          }).pipe(Effect.exit)

          if (Exit.isSuccess(launched)) {
            const model = [
              request.model ?? "default model",
              request.thinkingLevel ?? "default thinking level",
            ]
            yield* Effect.logInfo(`Session ${sessionId} restarted on ${model.join(", ")}`)
            return yield* started(sessionId)
          }
          const reason = message(launched.cause)
          yield* Effect.logWarning(`Session ${sessionId} failed to restart: ${reason}`)
          yield* teardown(sessionId, sandboxes.stop(sessionId, "Sleep"))
          yield* hub.send(RunnerToHub.cases.SessionStartFailed.make({ sessionId, message: reason }))
        }),
      )

    const stop = (request: StopSession) =>
      serialized(request.sessionId)(
        Effect.gen(function* () {
          const { sessionId } = request
          const exitCode = yield* stopAgent(running.get(sessionId))
          // Archiving destroys the Sandbox and its volumes and keeps the Workspace, for a restore;
          // purging removes the Workspace later.
          yield* teardown(sessionId, sandboxes.stop(sessionId, request.reason))
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
     * Deletes everything of a purged Session: stops its agent if it is somehow running, then
     * destroys its Sandbox and volumes, and removes its directory and Claude Code's state for it.
     * Says SessionPurged only once all of it is gone; the Hub asks again on the next connection
     * otherwise.
     */
    const purge = (sessionId: SessionId) =>
      serialized(sessionId)(
        Effect.gen(function* () {
          yield* stopAgent(running.get(sessionId))
          yield* teardown(sessionId, sandboxes.purge(sessionId))
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

    // Its Session token is read back from its agent's environment, where the launch put it
    // (ModEnvironment.modToken). It lets only this Session in, so a guest that changed it gains
    // nothing. Anything missing, and the Session sleeps, as its Sandbox is stopped: so does one
    // that ran a Harness from before the durable agent, in a single tmux session, which has no
    // agent's to read; the Hub wakes it on the agent. The agent runs on with the setup token it
    // was started with, read back too only to keep it out of what it prints as it exits. A missing
    // terminal doesn't put it to sleep: the agent runs on, so its terminal is made again.
    const adopt = Effect.gen(function* () {
      yield* tmux.retireHostServer
      const kept: Array<SessionId> = []
      for (const sessionId of yield* sandboxes.running) {
        if (!isSafeSessionId(sessionId)) continue
        const token = yield* tmux.variable(sessionId, ModEnvironment.modToken)
        if (token === undefined || !(yield* relay.hold(sessionId, token))) {
          yield* Effect.logInfo(
            `Session ${sessionId}: its agent is no longer running, or ran a Harness from before the durable agent, so it sleeps`,
          )
          continue
        }
        const setupToken = yield* tmux.variable(sessionId, ClaudeTokenVariable)
        launchSecrets.set(sessionId, setupToken === undefined ? [token] : [token, setupToken])
        held.add(sessionId)
        const watched = yield* watch(sessionId).pipe(Effect.exit)
        if (Exit.isFailure(watched)) {
          yield* forget(sessionId)
          yield* Effect.logWarning(
            `Session ${sessionId}: could not attach to its terminal or agent, so it sleeps: ${message(watched.cause)}`,
          )
          continue
        }
        kept.push(sessionId)
        yield* Effect.logInfo(`Session ${sessionId}: its agent kept running across the restart`)
      }
      yield* sandboxes.reconcile(kept)
    })

    /**
     * Lets a Session kept running across a restart in again, now the Hub has given it a new mod
     * token: the relay takes its held Session token back, standing for the new mod token, and its
     * Sandbox is taken back, so its agent can start again in it with a new model. Its agent still
     * has its setup token, so none is fetched.
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
                  `Session ${sessionId}: could not take back its Sandbox, so its agent can't restart until it sleeps: ${error.message}`,
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
          return running.get(incoming.sessionId)?.terminal.input(incoming.data) ?? Effect.void
        case "TerminalResize":
          return running.get(incoming.sessionId)?.terminal.resize(incoming.size) ?? Effect.void
        case "RequestTerminalSnapshot":
          return running.get(incoming.sessionId)?.terminal.snapshot ?? Effect.void
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
        Effect.forEach(running.values(), (session) => session.terminal.snapshot, {
          discard: true,
        }),
      ).pipe(Effect.andThen(ports.resendAll)),
    })
  }),
)
