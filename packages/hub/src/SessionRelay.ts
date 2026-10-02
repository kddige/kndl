// The Session relay: what the Hub does with the messages of Runners, web clients and mods once
// their channel is open (issue #8).
//
// - Every Session has an event log (SessionLog.ts). Turn events from the mod are appended to it,
//   with what the Hub sees itself: SessionStateChanged and TurnStopRequested. A web client that
//   joins a Session gets its history, then each new entry, live.
// - Presence: the Participants with a web connection that has joined the Session, sent in full to
//   those connections and to the Session's mod whenever it changes.
// - The Prompt queue (PromptQueue.ts): prompts wait in order, and the head is delivered to the
//   mod when the Session is idle, one at a time. A prompt the mod reports as PromptFailed is
//   dropped, and its sender gets a CommandFailed, rather than put back to fail again.
// - The Session lifecycle (#12; archiving is #18):
//   - CreateSession starts a Session on a Runner, Active.
//   - Sleep: an Active Session with no Turn running, no prompt queued and no Participant present
//     for `HubConfig.sleepAfter` (or put to sleep by hand with SleepSession) is stopped: the Hub
//     sends StopSession `Sleep`, and records it Asleep when the Runner reports SessionStopped.
//   - Wake: a prompt to an Asleep Session (or WakeSession) wakes it. The Hub records it Active and
//     sends StartSession with `resume`, the Claude Code session id from the mod's last hello. The
//     prompt waits in the queue until the new mod says hello.
//   - A start that fails, or a Claude Code that exits on its own, leaves the Session Asleep, with
//     the reason in the logged SessionStateChanged. Prompts queued stay queued and are not retried
//     on their own: the next prompt or WakeSession tries again.
//   - Frozen: while its Runner is offline. Prompts queue up. When the Runner is back the Session is
//     Active if its Claude Code is still running in tmux, otherwise Asleep, and woken if prompts
//     are waiting.
// - The terminal mirror: frames from the Runner to the web clients watching, keystrokes back.
//
// Every change runs under one lock, so a joining client's history and the live entries after it
// neither overlap nor leave a gap, and the queue's one-delivery-at-a-time rule holds. Messages to
// peers are queued on each connection without waiting (see Channels.ts), so a slow peer holds up
// no one else.

import {
  CommandFailed,
  DeliverPrompt,
  type HubToRunner,
  HubToWeb,
  type ModEvent,
  type ModHello,
  type Participant,
  type ParticipantId,
  PresenceChanged,
  PromptId,
  PromptQueueChanged,
  QueuedPrompt,
  type RequestId,
  RequestTerminalSnapshot,
  type RunnerHello,
  type RunnerId,
  type RunnerLogin,
  type RunnerToHub,
  type SessionEvent,
  SessionEventLogged,
  SessionId,
  type SessionState,
  SessionStateChanged,
  type SessionSummary,
  StartSession,
  StopSession,
  StopTurn,
  TurnStopRequested,
  type WebToHub,
} from "@claude-hub/protocol"
import { Clock, Context, Duration, Effect, Layer, Option, type Scope, Semaphore } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { HubConfig } from "./HubConfig.ts"
import { ModOutbox } from "./ModOutbox.ts"
import { ModTokens } from "./ModTokens.ts"
import { PromptQueue } from "./PromptQueue.ts"
import { Runners } from "./Runners.ts"
import type { RunnerIdentity } from "./RunnerTokens.ts"
import { SessionLog } from "./SessionLog.ts"
import { Sessions } from "./Sessions.ts"
import { randomId } from "./Tokens.ts"

/** A connection to a peer, as its channel gives it: sending never waits. */
export interface Peer<Out> {
  readonly send: (message: Out) => void
  /** Closes the connection with a WebSocket close code, after what was sent before. */
  readonly close: (code: number, reason: string) => void
}

/** Handles one message from a connected peer. */
export type Receive<In> = (message: In) => Effect.Effect<void>

/** Close codes the relay closes connections with. */
export const RelayCloseCode = {
  /** The Runner connected again, and its newer connection replaces this one. */
  Replaced: 4409,
} as const

/** Who or what moved a Session to another state, as its SessionStateChanged records. */
interface Why {
  readonly by?: Participant
  readonly message?: string
}

/** How often the Hub looks for idle Sessions to put to sleep: a tenth of the wait, 10 ms to 30 s. */
export const idleCheckInterval = (sleepAfter: Duration.Duration) =>
  Duration.millis(Math.min(Math.max(Duration.toMillis(sleepAfter) / 10, 10), 30_000))

/** The work branch a new Session commits to. */
export const workBranchFor = (sessionId: SessionId) => `claude/${sessionId}`

export class SessionRelay extends Context.Service<
  SessionRelay,
  {
    /**
     * A web client, once welcomed: sends it the Runner and Session lists, and keeps them
     * current until the scope closes, which takes it out of every Session it joined.
     */
    readonly connectWeb: (
      you: Participant,
      peer: Peer<HubToWeb>,
    ) => Effect.Effect<Receive<WebToHub>, never, Scope.Scope>
    /**
     * A Runner, once welcomed: its Sessions it says are running go Active. When the scope
     * closes, its Sessions go Frozen.
     */
    readonly connectRunner: (
      runner: RunnerIdentity,
      hello: RunnerHello,
      peer: Peer<HubToRunner>,
    ) => Effect.Effect<Receive<RunnerToHub>, never, Scope.Scope>
    /** The Session's mod said hello. */
    readonly modHello: (sessionId: SessionId, hello: ModHello) => Effect.Effect<void, SqlError>
    /** The Session's mod reported Turn events and failed deliveries, oldest first. */
    readonly modEvents: (
      sessionId: SessionId,
      events: ReadonlyArray<ModEvent>,
    ) => Effect.Effect<void, SqlError>
  }
>()("@claude-hub/hub/SessionRelay") {
  static readonly layer = Layer.effect(
    SessionRelay,
    Effect.gen(function* () {
      const sessions = yield* Sessions
      const log = yield* SessionLog
      const prompts = yield* PromptQueue
      const runners = yield* Runners
      const modTokens = yield* ModTokens
      const outbox = yield* ModOutbox
      const config = yield* HubConfig
      const layerScope = yield* Effect.scope
      const lock = yield* Semaphore.make(1)
      const serialized = lock.withPermits(1)

      interface WebClient {
        readonly you: Participant
        readonly peer: Peer<HubToWeb>
        /** The Sessions this connection has joined. */
        readonly joined: Set<SessionId>
        /** The Sessions whose terminal this connection watches. */
        readonly terminals: Set<SessionId>
      }
      interface OnlineRunner {
        readonly id: RunnerId
        readonly name: string
        readonly login: RunnerLogin
        readonly peer: Peer<HubToRunner>
      }

      const webClients = new Set<WebClient>()
      const onlineRunners = new Map<RunnerId, OnlineRunner>()
      /**
       * The prompt each Session's mod has been sent and not yet started a Turn with or failed.
       * In memory only: after a Hub restart the head of the queue is delivered again (see
       * README.md).
       */
      const inFlight = new Map<SessionId, PromptId>()
      /**
       * Sessions whose Claude Code was started or woken and whose new mod hasn't said hello yet.
       * Prompts wait for that hello.
       */
      const starting = new Set<SessionId>()
      /** Sessions the Hub asked their Runner to stop for sleep, with why, until SessionStopped. */
      const stopping = new Map<SessionId, Why>()
      /** When each Session was last seen busy: an event logged, its queue or presence changing. */
      const lastBusy = new Map<SessionId, number>()

      const markBusy = (sessionId: SessionId) =>
        Effect.map(Clock.currentTimeMillis, (now) => void lastBusy.set(sessionId, now))

      // ── Sending ──────────────────────────────────────────────────────────

      const toWeb = (message: HubToWeb, to: (client: WebClient) => boolean = () => true) => {
        for (const client of webClients) if (to(client)) client.peer.send(message)
      }
      const toJoined = (sessionId: SessionId, message: HubToWeb) =>
        toWeb(message, (client) => client.joined.has(sessionId))

      const runnerList = Effect.map(runners.list, (known) =>
        HubToWeb.cases.RunnerList.make({
          runners: known.map((runner) => ({ ...runner, isOnline: onlineRunners.has(runner.id) })),
        }),
      )

      const sessionUpdated = Effect.fn("SessionRelay.sessionUpdated")(function* (id: SessionId) {
        const session = yield* sessions.get(id)
        if (Option.isSome(session)) {
          toWeb(HubToWeb.cases.SessionUpdated.make({ session: session.value }))
        }
      })

      const logEvent = Effect.fn("SessionRelay.logEvent")(function* (
        sessionId: SessionId,
        event: SessionEvent,
      ) {
        const entry = yield* log.append(sessionId, event)
        toJoined(sessionId, SessionEventLogged.make({ sessionId, entry }))
        yield* markBusy(sessionId)
      })

      /** Moves the Session to `state`, if it isn't there, logging why. */
      const changeState = Effect.fn("SessionRelay.changeState")(function* (
        session: SessionSummary,
        state: SessionState,
        why: Why,
      ) {
        if (session.state === state) return
        yield* sessions.setState(session.id, state)
        yield* logEvent(session.id, SessionStateChanged.make({ state, ...why }))
        yield* sessionUpdated(session.id)
      })

      const queueChanged = Effect.fn("SessionRelay.queueChanged")(function* (sessionId: SessionId) {
        const queue = yield* prompts.list(sessionId)
        toJoined(sessionId, PromptQueueChanged.make({ sessionId, queue }))
        yield* markBusy(sessionId)
      })

      /** The Participants who have joined the Session, each once, in the order they connected. */
      const presenceOf = (sessionId: SessionId): ReadonlyArray<Participant> => {
        const present = new Map<ParticipantId, Participant>()
        for (const client of webClients) {
          if (client.joined.has(sessionId) && !present.has(client.you.id)) {
            present.set(client.you.id, client.you)
          }
        }
        return [...present.values()]
      }

      /** Tells the Session's mod who is present, if Claude Code may be running to hear it. */
      const presenceToMod = Effect.fn("SessionRelay.presenceToMod")(function* (
        sessionId: SessionId,
      ) {
        const session = yield* sessions.get(sessionId)
        if (Option.isNone(session) || session.value.state !== "Active") return
        yield* outbox.enqueue(
          sessionId,
          PresenceChanged.make({ sessionId, participants: presenceOf(sessionId) }),
        )
      })

      /** Announces the Session's presence if it differs from `before`. */
      const presenceChanged = Effect.fn("SessionRelay.presenceChanged")(function* (
        sessionId: SessionId,
        before: ReadonlyArray<Participant>,
      ) {
        const after = presenceOf(sessionId)
        const same = before.length === after.length && before.every((p, i) => p.id === after[i]?.id)
        if (same) return false
        toJoined(sessionId, PresenceChanged.make({ sessionId, participants: after }))
        yield* markBusy(sessionId)
        yield* presenceToMod(sessionId)
        return true
      })

      // ── The Prompt queue ─────────────────────────────────────────────────

      /**
       * Sends the head of the Session's Prompt queue to its mod, if the Session is Active and
       * idle, its mod has said hello, it isn't going to sleep, and no other prompt is out for
       * delivery. An Asleep Session is woken instead (see `wake`).
       */
      const deliverNext = Effect.fn("SessionRelay.deliverNext")(function* (sessionId: SessionId) {
        if (inFlight.has(sessionId) || starting.has(sessionId) || stopping.has(sessionId)) return
        const session = yield* sessions.get(sessionId)
        if (Option.isNone(session)) return
        if (session.value.state !== "Active" || session.value.currentTurn !== null) return
        const [head] = yield* prompts.list(sessionId)
        if (head === undefined) return
        inFlight.set(sessionId, head.id)
        yield* outbox.enqueue(
          sessionId,
          DeliverPrompt.make({
            sessionId,
            promptId: head.id,
            text: head.text,
            sender: head.sender,
          }),
        )
      })

      /**
       * The Session's Claude Code is no longer running: no Turn is, and nothing is in flight. It
       * is Asleep, whether it was put to sleep, exited on its own or failed to start.
       */
      const claudeGone = Effect.fn("SessionRelay.claudeGone")(function* (
        session: SessionSummary,
        why: Why,
      ) {
        inFlight.delete(session.id)
        starting.delete(session.id)
        stopping.delete(session.id)
        // Commands the mod didn't collect are stale: a new Claude Code starts with a new mod.
        yield* outbox.clear(session.id)
        if (session.currentTurn !== null) yield* sessions.setCurrentTurn(session.id, null)
        if (session.state === "Archived") return
        if (session.state === "Asleep") return yield* sessionUpdated(session.id)
        yield* changeState(session, "Asleep", why)
      })

      /**
       * Wakes an Asleep Session on its online Runner: records it Active and starts its Claude
       * Code again, resuming the conversation its mod last said hello from, on the same
       * Workspace and Sandbox volumes. Queued prompts are delivered once the new mod says hello.
       */
      const wake = Effect.fn("SessionRelay.wake")(function* (session: SessionSummary, why: Why) {
        const runner = onlineRunners.get(session.runnerId)
        if (runner === undefined || session.state !== "Asleep") return
        const resume = yield* sessions.claudeSessionId(session.id)
        const modToken = yield* modTokens.issue({ sessionId: session.id, runnerId: runner.id })
        starting.add(session.id)
        yield* changeState(session, "Active", {
          ...why,
          message: Option.isSome(resume)
            ? `Woken on ${runner.name}`
            : `Woken on ${runner.name}, with a new conversation: Claude Code's last one is unknown`,
        })
        runner.peer.send(
          StartSession.make({
            sessionId: session.id,
            repo: session.repo,
            baseBranch: session.baseBranch,
            workBranch: session.workBranch,
            modToken,
            ...(Option.isSome(resume) ? { resume: resume.value } : {}),
          }),
        )
      })

      /** Wakes the Session if it is Asleep with prompts waiting, as ones queued while Frozen. */
      const wakeIfWaiting = Effect.fn("SessionRelay.wakeIfWaiting")(function* (
        sessionId: SessionId,
      ) {
        const session = yield* sessions.get(sessionId)
        if (Option.isNone(session) || session.value.state !== "Asleep") return
        if ((yield* prompts.list(sessionId)).length === 0) return
        yield* wake(session.value, { message: "Woken for the prompts waiting in its queue" })
      })

      /**
       * Asks the Session's Runner to stop its Claude Code and Sandbox, keeping the Workspace and
       * the Sandbox's volumes. It stays Active, taking no deliveries, until SessionStopped.
       */
      const putToSleep = Effect.fn("SessionRelay.putToSleep")(function* (
        session: SessionSummary,
        why: Why,
      ) {
        const runner = onlineRunners.get(session.runnerId)
        if (runner === undefined || stopping.has(session.id)) return
        stopping.set(session.id, why)
        yield* Effect.logInfo(`Putting Session ${session.id} to sleep: ${why.message ?? ""}`)
        runner.peer.send(StopSession.make({ sessionId: session.id, reason: "Sleep" }))
      })

      /** Whether the Session is Active with nothing going on and no one there. */
      const isIdle = Effect.fn("SessionRelay.isIdle")(function* (session: SessionSummary) {
        if (session.state !== "Active" || session.currentTurn !== null) return false
        if (!onlineRunners.has(session.runnerId)) return false
        if (stopping.has(session.id) || inFlight.has(session.id)) return false
        if (presenceOf(session.id).length > 0) return false
        return (yield* prompts.list(session.id)).length === 0
      })

      /** Puts to sleep every Session that has been idle for `sleepAfter`. */
      const sleepIdle = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const sleepAfter = Duration.toMillis(config.sleepAfter)
        for (const session of yield* sessions.list) {
          if (!(yield* isIdle(session))) {
            lastBusy.set(session.id, now)
            continue
          }
          const since = lastBusy.get(session.id)
          if (since === undefined) lastBusy.set(session.id, now)
          else if (now - since >= sleepAfter) {
            yield* putToSleep(session, {
              message: `Idle for ${Duration.format(config.sleepAfter)}`,
            })
          }
        }
      }).pipe(Effect.withSpan("SessionRelay.sleepIdle"))

      // ── The web channel ──────────────────────────────────────────────────

      const receiveWeb = (client: WebClient): Receive<WebToHub> => {
        const { you, peer } = client
        const refuse = (
          message: WebToHub,
          why: string,
          about: { readonly sessionId?: SessionId; readonly requestId?: RequestId },
        ) => peer.send(CommandFailed.make({ command: message._tag, message: why, ...about }))

        /** The Session a command names, or none, having refused the command. */
        const sessionFor = Effect.fn(function* (message: WebToHub & { sessionId: SessionId }) {
          const session = yield* sessions.get(message.sessionId)
          if (Option.isNone(session)) {
            refuse(message, "There is no such Session.", { sessionId: message.sessionId })
          }
          return session
        })

        /** The online Runner a Session runs on, or none, having refused the command. */
        const runnerFor = Effect.fn(function* (message: WebToHub & { sessionId: SessionId }) {
          const session = yield* sessionFor(message)
          if (Option.isNone(session)) return Option.none<OnlineRunner>()
          const runner = Option.fromNullishOr(onlineRunners.get(session.value.runnerId))
          if (Option.isNone(runner)) {
            refuse(message, "The Session's Runner is offline.", { sessionId: message.sessionId })
          }
          return runner
        })

        const handle = Effect.fn("SessionRelay.receiveWeb")(function* (message: WebToHub) {
          switch (message._tag) {
            case "WebHello":
              return

            case "CreateSession": {
              const { requestId } = message
              const runner =
                message.runnerId === undefined
                  ? onlineRunners.values().next().value
                  : onlineRunners.get(message.runnerId)
              if (runner === undefined) {
                return refuse(
                  message,
                  message.runnerId === undefined
                    ? "No Runner is online."
                    : `Runner ${message.runnerId} is not online.`,
                  { requestId },
                )
              }
              // TODO(#7 follow-up): check that the person has access to the Repo, and that the
              // base branch exists, once the GitHub App can tell.
              const id = SessionId.make(randomId())
              const session = yield* sessions.create({
                id,
                repo: message.repo,
                baseBranch: message.baseBranch,
                workBranch: workBranchFor(id),
                state: "Active",
                runnerId: runner.id,
                runnerLogin: runner.login,
                creatorId: you.id,
                createdAt: yield* Clock.currentTimeMillis,
              })
              const modToken = yield* modTokens.issue({ sessionId: id, runnerId: runner.id })
              starting.add(id)
              yield* logEvent(
                id,
                SessionStateChanged.make({
                  state: "Active",
                  by: you,
                  message: `Started on ${runner.name} from ${message.baseBranch}`,
                }),
              )
              runner.peer.send(
                StartSession.make({
                  sessionId: id,
                  repo: session.repo,
                  baseBranch: session.baseBranch,
                  workBranch: session.workBranch,
                  modToken,
                }),
              )
              peer.send(HubToWeb.cases.SessionCreated.make({ requestId, session }))
              toWeb(HubToWeb.cases.SessionUpdated.make({ session }))
              return
            }

            case "JoinSession": {
              const { sessionId } = message
              const session = yield* sessionFor(message)
              if (Option.isNone(session)) return
              const entries = yield* log.history(sessionId, message.afterSeq)
              peer.send(HubToWeb.cases.SessionHistory.make({ sessionId, entries }))
              const before = presenceOf(sessionId)
              client.joined.add(sessionId)
              peer.send(
                PromptQueueChanged.make({ sessionId, queue: yield* prompts.list(sessionId) }),
              )
              if (!(yield* presenceChanged(sessionId, before))) {
                peer.send(PresenceChanged.make({ sessionId, participants: before }))
              }
              return
            }

            case "LeaveSession": {
              const before = presenceOf(message.sessionId)
              client.joined.delete(message.sessionId)
              yield* presenceChanged(message.sessionId, before)
              return
            }

            case "SendPrompt": {
              const { sessionId } = message
              const session = yield* sessionFor(message)
              if (Option.isNone(session)) return
              // A Frozen Session's prompts wait in the queue for its Runner to return.
              if (session.value.state === "Archived") {
                return refuse(message, "The Session is archived.", { sessionId })
              }
              yield* prompts.add(
                sessionId,
                QueuedPrompt.make({
                  id: PromptId.make(randomId()),
                  text: message.text,
                  sender: you,
                  queuedAt: yield* Clock.currentTimeMillis,
                }),
              )
              yield* queueChanged(sessionId)
              if (session.value.state === "Asleep") {
                yield* wake(session.value, { by: you })
              } else {
                yield* deliverNext(sessionId)
              }
              return
            }

            case "SleepSession": {
              const { sessionId } = message
              const session = yield* sessionFor(message)
              if (Option.isNone(session)) return
              if (stopping.has(sessionId)) return
              if (session.value.state !== "Active") {
                return refuse(
                  message,
                  `Only an Active Session can be put to sleep; this one is ${session.value.state}.`,
                  { sessionId },
                )
              }
              if (session.value.currentTurn !== null) {
                return refuse(message, "A Turn is running: stop it first.", { sessionId })
              }
              if (inFlight.has(sessionId) || (yield* prompts.list(sessionId)).length > 0) {
                return refuse(message, "Prompts are waiting in the Session's queue.", {
                  sessionId,
                })
              }
              return yield* putToSleep(session.value, { by: you, message: "Put to sleep" })
            }

            case "WakeSession": {
              const { sessionId } = message
              const session = yield* sessionFor(message)
              if (Option.isNone(session)) return
              switch (session.value.state) {
                case "Asleep":
                  return yield* wake(session.value, { by: you })
                case "Active":
                  if (stopping.has(sessionId)) {
                    return refuse(
                      message,
                      "The Session is still going to sleep; wake it once it is Asleep.",
                      { sessionId },
                    )
                  }
                  return
                case "Frozen":
                  return refuse(
                    message,
                    "The Session is Frozen: its Runner is offline. It wakes when the Runner returns, if prompts are waiting.",
                    { sessionId },
                  )
                case "Archived":
                  return refuse(message, "The Session is archived.", { sessionId })
              }
              return
            }

            case "CancelPrompt": {
              const { sessionId, promptId } = message
              if (inFlight.get(sessionId) === promptId) {
                return refuse(message, "The prompt was already delivered to Claude Code.", {
                  sessionId,
                })
              }
              const removed = yield* prompts.remove(sessionId, promptId)
              if (Option.isNone(removed)) {
                return refuse(message, "The prompt is not in the Prompt queue.", { sessionId })
              }
              yield* queueChanged(sessionId)
              return
            }

            case "StopTurn": {
              const { sessionId } = message
              const session = yield* sessionFor(message)
              if (Option.isNone(session)) return
              yield* logEvent(sessionId, TurnStopRequested.make({ by: you }))
              yield* outbox.enqueue(sessionId, StopTurn.make({ sessionId }))
              return
            }

            case "OpenTerminal": {
              const runner = yield* runnerFor(message)
              if (Option.isNone(runner)) return
              client.terminals.add(message.sessionId)
              runner.value.peer.send(RequestTerminalSnapshot.make({ sessionId: message.sessionId }))
              return
            }

            case "CloseTerminal":
              client.terminals.delete(message.sessionId)
              return

            case "TerminalInput":
            case "TerminalResize": {
              const runner = yield* runnerFor(message)
              if (Option.isSome(runner)) runner.value.peer.send(message)
              return
            }
          }
        })

        return (message) =>
          serialized(handle(message)).pipe(
            Effect.catchTag("SqlError", (error) =>
              Effect.logError("A web command failed", error).pipe(
                Effect.andThen(
                  Effect.sync(() =>
                    refuse(message, "The Hub could not do that; try again.", {
                      ...("sessionId" in message ? { sessionId: message.sessionId } : {}),
                      ...("requestId" in message ? { requestId: message.requestId } : {}),
                    }),
                  ),
                ),
              ),
            ),
          )
      }

      const connectWeb = (you: Participant, peer: Peer<HubToWeb>) =>
        Effect.gen(function* () {
          const client: WebClient = { you, peer, joined: new Set(), terminals: new Set() }
          yield* serialized(
            Effect.gen(function* () {
              webClients.add(client)
              peer.send(yield* runnerList)
              // TODO(#7 follow-up): only the Sessions of Repos the person has access to.
              // TODO(#18): leave Archived Sessions out, or mark them.
              peer.send(HubToWeb.cases.SessionList.make({ sessions: yield* sessions.list }))
            }),
          ).pipe(Effect.orDie)
          yield* Effect.addFinalizer(() =>
            serialized(
              Effect.gen(function* () {
                const joined = [...client.joined]
                const before = new Map(joined.map((id) => [id, presenceOf(id)] as const))
                webClients.delete(client)
                for (const id of joined) yield* presenceChanged(id, before.get(id) ?? [])
              }),
            ).pipe(Effect.catchCause(Effect.logError)),
          )
          return receiveWeb(client)
        })

      // ── The Runner channel ───────────────────────────────────────────────

      const receiveRunner = (runner: OnlineRunner): Receive<RunnerToHub> => {
        /** The Session a message names, if it is one of this Runner's. */
        const ownSession = Effect.fn(function* (sessionId: SessionId) {
          const session = yield* sessions.get(sessionId)
          if (Option.isSome(session) && session.value.runnerId === runner.id) return session
          yield* Effect.logWarning(
            `Runner ${runner.name} spoke of a Session not its own`,
            sessionId,
          )
          return Option.none<SessionSummary>()
        })

        const handle = Effect.fn("SessionRelay.receiveRunner")(function* (message: RunnerToHub) {
          if (message._tag === "RunnerHello") return
          const session = yield* ownSession(message.sessionId)
          if (Option.isNone(session)) return
          switch (message._tag) {
            case "SessionStarted":
              yield* changeState(session.value, "Active", {
                message: `Claude Code started on ${runner.name}`,
              })
              yield* deliverNext(message.sessionId)
              return
            case "SessionStartFailed":
              // Asleep, with why in its history; queued prompts wait for the next wake.
              return yield* claudeGone(session.value, {
                message: `Claude Code could not start on ${runner.name}: ${message.message}`,
              })
            case "SessionStopped": {
              const asked = stopping.get(message.sessionId)
              yield* claudeGone(
                session.value,
                asked ?? {
                  message:
                    message.reason === "Requested"
                      ? "Claude Code stopped"
                      : `Claude Code exited${message.exitCode === undefined ? "" : ` with code ${message.exitCode}`}`,
                },
              )
              // A prompt sent while it was going to sleep wakes it again.
              if (asked !== undefined) yield* wakeIfWaiting(message.sessionId)
              return
            }
            case "SandboxStateReport":
              if (message.state === "Failed") {
                return yield* claudeGone(session.value, {
                  message: `The Sandbox failed${message.message === undefined ? "" : `: ${message.message}`}`,
                })
              }
              // The Hub follows Claude Code, which stops before its Sandbox and starts after it:
              // the other Sandbox states are for the Runner's log.
              return yield* Effect.logDebug(`Sandbox of ${message.sessionId}: ${message.state}`)
            case "TerminalFrame":
              return toWeb(message, (client) => client.terminals.has(message.sessionId))
          }
        })

        return (message) =>
          serialized(handle(message)).pipe(
            Effect.catchTag("SqlError", (error) =>
              Effect.logError(`A message from Runner ${runner.name} failed`, error),
            ),
          )
      }

      const connectRunner = (
        identity: RunnerIdentity,
        hello: RunnerHello,
        peer: Peer<HubToRunner>,
      ) =>
        Effect.gen(function* () {
          const runner: OnlineRunner = {
            id: identity.runnerId,
            name: identity.name,
            login: hello.login,
            peer,
          }
          yield* serialized(
            Effect.gen(function* () {
              onlineRunners
                .get(runner.id)
                ?.peer.close(RelayCloseCode.Replaced, "Replaced by a newer connection")
              onlineRunners.set(runner.id, runner)
              yield* runners.recordLogin(runner.id, runner.login)
              toWeb(yield* runnerList)
              const running = new Set(hello.sessions)
              for (const session of yield* sessions.listByRunner(runner.id)) {
                if (session.state === "Archived") continue
                if (running.has(session.id)) {
                  yield* changeState(session, "Active", { message: `${runner.name} is back` })
                  yield* deliverNext(session.id)
                } else {
                  if (session.state !== "Asleep") {
                    yield* claudeGone(session, {
                      message: `${runner.name} is back; Claude Code is not running there`,
                    })
                  }
                  // Prompts queued while it was Frozen wake it.
                  yield* wakeIfWaiting(session.id)
                }
              }
            }),
          ).pipe(Effect.orDie)
          yield* Effect.addFinalizer(() =>
            serialized(
              Effect.gen(function* () {
                if (onlineRunners.get(runner.id) !== runner) return
                onlineRunners.delete(runner.id)
                for (const session of yield* sessions.listByRunner(runner.id)) {
                  // A stop it was asked for is settled by what it says when it is back.
                  stopping.delete(session.id)
                  if (session.state === "Active" || session.state === "Asleep") {
                    yield* changeState(session, "Frozen", {
                      message: `${runner.name} went offline`,
                    })
                  }
                }
                toWeb(yield* runnerList)
              }),
            ).pipe(Effect.catchCause(Effect.logError)),
          )
          return receiveRunner(runner)
        })

      // ── The mod channel ──────────────────────────────────────────────────

      const modHello = Effect.fn("SessionRelay.modHello")(function* (
        sessionId: SessionId,
        hello: ModHello,
      ) {
        const session = yield* sessions.get(sessionId)
        if (Option.isNone(session)) return
        yield* sessions.setClaudeSessionId(sessionId, hello.claudeSessionId)
        starting.delete(sessionId)
        yield* presenceToMod(sessionId)
        yield* deliverNext(sessionId)
      }, serialized)

      const modEvent = Effect.fn("SessionRelay.modEvent")(function* (
        sessionId: SessionId,
        event: ModEvent,
      ) {
        if (event._tag === "PromptFailed") {
          // The prompt is dropped, and its sender told: put back, it would most likely fail
          // again at once, and hold up the rest of the queue.
          if (inFlight.get(sessionId) === event.promptId) inFlight.delete(sessionId)
          const failed = yield* prompts.remove(sessionId, event.promptId)
          if (Option.isNone(failed)) return
          toWeb(
            CommandFailed.make({
              command: "SendPrompt",
              sessionId,
              message: `Your prompt could not be delivered to Claude Code: ${event.message}`,
            }),
            (client) => client.you.id === failed.value.sender.id,
          )
          return yield* queueChanged(sessionId)
        }

        yield* logEvent(sessionId, event)
        if (event._tag === "TurnStarted") {
          yield* sessions.setCurrentTurn(sessionId, event.turnId)
          if (event.promptId !== undefined) {
            if (inFlight.get(sessionId) === event.promptId) inFlight.delete(sessionId)
            const started = yield* prompts.remove(sessionId, event.promptId)
            if (Option.isSome(started)) yield* queueChanged(sessionId)
          }
          yield* sessionUpdated(sessionId)
        } else if (event._tag === "TurnEnded" && event.agentId === undefined) {
          yield* sessions.setCurrentTurn(sessionId, null)
          yield* sessionUpdated(sessionId)
        }
      })

      const modEvents = Effect.fn("SessionRelay.modEvents")(function* (
        sessionId: SessionId,
        events: ReadonlyArray<ModEvent>,
      ) {
        const session = yield* sessions.get(sessionId)
        if (Option.isNone(session)) {
          return yield* Effect.logWarning("Events from the mod of an unknown Session", sessionId)
        }
        for (const event of events) yield* modEvent(sessionId, event)
        yield* deliverNext(sessionId)
      }, serialized)

      // ── Start-up ─────────────────────────────────────────────────────────

      // No Runner is connected to a Hub that just started, so every Session waits Frozen for
      // its Runner to say hello.
      for (const session of yield* sessions.list) {
        if (session.state === "Active" || session.state === "Asleep") {
          yield* changeState(session, "Frozen", {
            message: "The Hub restarted; waiting for the Runner to reconnect",
          })
        }
      }

      yield* Effect.sleep(idleCheckInterval(config.sleepAfter)).pipe(
        Effect.andThen(serialized(sleepIdle)),
        Effect.catchCause((cause) => Effect.logError("Could not check for idle Sessions", cause)),
        Effect.forever,
        Effect.forkIn(layerScope),
      )

      return SessionRelay.of({ connectWeb, connectRunner, modHello, modEvents })
    }),
  )
}
