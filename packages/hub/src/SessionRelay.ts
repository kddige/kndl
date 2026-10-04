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
//   - Restart (RestartSession, ADR 0009): an Active Session with no Turn running is put to sleep
//     and woken as soon as it is Asleep, so its Sandbox is recreated from the Repo's latest
//     Environment version. An Asleep one is just woken.
//   - A start that fails, or a Claude Code that exits on its own, leaves the Session Asleep, with
//     the reason in the logged SessionStateChanged. Prompts queued stay queued and are not retried
//     on their own: the next prompt or WakeSession tries again.
//   - A Session whose Environment has, or links, a variable that needs a value (#57) doesn't
//     start: CreateSession is refused, and a wake leaves it Asleep, its prompts queued, with a
//     SessionStateChanged naming the variables. Starting without them would be confusing.
//   - Frozen: while its Runner is offline. Prompts queue up. When the Runner is back the Session is
//     Active if its Claude Code is still running in tmux, otherwise Asleep, and woken if prompts
//     are waiting.
//   - Archive (#18, ADR 0003): any Participant can delete a Session, which archives it at once.
//     The Hub records it Archived, with who did it and when, and sends StopSession `Archive`: the
//     Runner pushes the WIP ref, then destroys the Sandbox and its volumes, keeping the Workspace.
//     A Runner that is offline is sent it when it is back. An Archived Session takes no prompts
//     and opens no terminal; its history stays readable.
//   - Restore: any Participant can bring an Archived Session back until it is purged. It comes
//     back Asleep (Frozen while its Runner is offline), and its next prompt wakes it on a fresh
//     Sandbox around the kept Workspace.
//   - Purge: `HubConfig.archiveRetention` after it was archived, a periodic sweep deletes the
//     Session, its log and its queue, and sends the Runner PurgeSession to delete its directory,
//     Claude Code's state and any volumes left. A Runner that is offline is sent it when it is
//     back, again on every connection until it answers SessionPurged.
// - The terminal mirror: frames from the Runner to the web clients watching, keystrokes back.
// - Git (ADR 0010): the Runner's GitRequests are answered by SessionGit, off the lock, since
//   they may wait on GitHub. When a Turn ends the Runner is told, to push the WIP ref.
// - Environments (#47, ADR 0009): StartSession carries the Repo's Environment as last applied,
//   and the Runner reports the version it started the Session on. Environment commands, Test
//   builds and variable fetches are handled by EnvironmentRelay.ts.
// - Redaction (#48, Redaction.ts): the Sensitive values of a Session's Repo, and the Sandbox
//   tokens of its Sessions (#73), are masked in every event before it is logged, and in terminal
//   frames before they are relayed. Claude's text
//   (TextDelta) and terminal Output are streams: text that could start a value is held back
//   until the next event or frame, or `holdMillis` at most.
// - Repo access (#52, ADR 0003, RepoAccess.ts): a web client is sent only the Sessions of Repos
//   its person has access to, and every command about a Session, or creating one, is checked
//   first, off the lock, since it may wait on GitHub. A Session the person has no access to is
//   refused as if there were no such Session. Each connection keeps what it knows of its person's
//   access to each Repo; a Session in a Repo it doesn't know yet is held back until it is asked.
//   Every `HubConfig.repoAccessTtl` the Repos of everyone connected are checked again, so a
//   person who lost access is taken out of the Repo's Sessions (and their presence) within about
//   twice that, or at their next command once their cached answer expires, whichever is first.
//   When GitHub can't say, a person keeps what they had.
//
// Every change runs under one lock, so a joining client's history and the live entries after it
// neither overlap nor leave a gap, and the queue's one-delivery-at-a-time rule holds. Messages to
// peers are queued on each connection without waiting (see Channels.ts), so a slow peer holds up
// no one else.

import {
  CommandFailed,
  DeliverPrompt,
  type EnvironmentVersion,
  GitReply,
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
  type TerminalFrame,
  type TextDelta,
  SessionId,
  SessionRemoved,
  type SessionRestart,
  SessionStartLogged,
  type SessionState,
  SessionStateChanged,
  type SessionSummary,
  SessionTurnEnded,
  StartSession,
  StopSession,
  StopTurn,
  PurgeSession,
  TurnStopRequested,
  type WebToHub,
  WipNotPushed,
  SandboxNoted,
} from "@claude-hub/protocol"
import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  type Scope,
  Semaphore,
} from "effect"
import type { SqlError } from "effect/sql/SqlError"
import {
  type EnvironmentWebClient,
  isEnvironmentCommand,
  makeEnvironmentRelay,
} from "./EnvironmentRelay.ts"
import { cantStartText, Environments } from "./Environments.ts"
import { HubConfig } from "./HubConfig.ts"
import { ModOutbox } from "./ModOutbox.ts"
import { ModTokens } from "./ModTokens.ts"
import { PromptQueue } from "./PromptQueue.ts"
import {
  everything,
  holdMillis,
  type Needles,
  needlesOf,
  redactEvent,
  redactText,
  StreamRedactor,
} from "./Redaction.ts"
import { RepoAccess } from "./RepoAccess.ts"
import { Runners } from "./Runners.ts"
import type { RunnerIdentity } from "./RunnerTokens.ts"
import { SessionGit } from "./SessionGit.ts"
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

/** A StartSession its Runner hasn't answered yet (#70). */
interface StartUnderWay {
  readonly since: number
  /** The Environment version it was sent, if the Repo has an Environment. */
  readonly environmentVersion: EnvironmentVersion | undefined
  /**
   * What its terminal printed before Claude Code's terminal was up, redacted: the Environment's
   * build and start script. Its last `startLogLimit` characters.
   */
  log: string
  /** Whether the Runner has sent a Snapshot of Claude Code's terminal: output after it is Claude's. */
  attached: boolean
}

/** How much of a start's output the Hub keeps for clients that join while it runs. */
export const startLogLimit = 64 * 1024

/** How often the Hub looks for idle Sessions to put to sleep: a tenth of the wait, 10 ms to 30 s. */
export const idleCheckInterval = (sleepAfter: Duration.Duration) =>
  Duration.millis(Math.min(Math.max(Duration.toMillis(sleepAfter) / 10, 10), 30_000))

/** How often the Hub looks for Archived Sessions to purge: a tenth of the retention, 10 ms to 1 h. */
export const purgeCheckInterval = (retention: Duration.Duration) =>
  Duration.millis(Math.min(Math.max(Duration.toMillis(retention) / 10, 10), 3_600_000))

/** How many Repo access checks the Hub has GitHub answer at once. */
const accessCheckConcurrency = 8

/** What Repo access says of a web command (see `authorize`). */
interface AccessVerdict {
  /** What GitHub said of the person's access to the Repo the command is about. */
  readonly learned?: { readonly repo: string; readonly allowed: boolean }
  /** Why the command is refused, if it is. */
  readonly refusal?: string
}

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
      const sessionGit = yield* SessionGit
      const environments = yield* Environments
      const access = yield* RepoAccess
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
        /**
         * Whether its person has access to each Repo, as last asked (ADR 0003). It is sent the
         * Sessions of a Repo only once this says so.
         */
        readonly repos: Map<string, boolean>
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
      /**
       * Sessions being restarted (RestartSession), with who asked: put to sleep, and woken again
       * once their Runner says they stopped.
       */
      const restarting = new Map<SessionId, Participant>()
      /**
       * Sessions whose StartSession the Runner hasn't answered yet, with the output of their
       * build and start script so far: the web shows them starting (#70).
       */
      const starts = new Map<SessionId, StartUnderWay>()
      /**
       * Restarts under way, shown to the web: from the RestartSession until the Session has
       * started again, or failed to. `restarting` is only the part before it is Asleep.
       */
      const restarts = new Map<SessionId, SessionRestart>()
      /**
       * Archived Sessions whose Runner was asked to stop them for good, until SessionStopped. The
       * stop is recorded done only then, so a Runner that drops off first is asked again.
       */
      const archiving = new Set<SessionId>()
      /** When each Session was last seen busy: an event logged, its queue or presence changing. */
      const lastBusy = new Map<SessionId, number>()

      const markBusy = (sessionId: SessionId) =>
        Effect.map(Clock.currentTimeMillis, (now) => void lastBusy.set(sessionId, now))

      // ── Sending ──────────────────────────────────────────────────────────

      /** StartSession's Environment: the Repo's as last applied, if it has one. */
      const sessionEnvironment = Effect.fn("SessionRelay.sessionEnvironment")(function* (
        repo: string,
      ) {
        const environment = yield* environments.forSession(repo)
        return Option.isSome(environment) ? { environment: environment.value } : {}
      })

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

      /** The Session as the web sees it: what is stored, and whether it is starting or restarting. */
      const forWeb = (session: SessionSummary): SessionSummary => {
        const start = starts.get(session.id)
        const restart = restarts.get(session.id)
        if (start === undefined && restart === undefined) return session
        return {
          ...session,
          ...(start !== undefined && {
            starting: {
              since: start.since,
              ...(start.environmentVersion !== undefined && {
                environmentVersion: start.environmentVersion,
              }),
            },
          }),
          ...(restart !== undefined && { restarting: restart }),
        }
      }

      /**
       * Sends the Session to every client whose person has access to its Repo, and asks for those
       * who aren't known yet (see `learnAccess`).
       */
      const sessionToWeb = Effect.fn("SessionRelay.sessionToWeb")(function* (
        session: SessionSummary,
      ) {
        const message = HubToWeb.cases.SessionUpdated.make({ session: forWeb(session) })
        for (const client of webClients) {
          const known = client.repos.get(session.repo)
          if (known === true) client.peer.send(message)
          else if (known === undefined) yield* learnAccess(client.you, session.repo)
        }
      })

      const sessionUpdated = Effect.fn("SessionRelay.sessionUpdated")(function* (id: SessionId) {
        const session = yield* sessions.get(id)
        if (Option.isSome(session)) yield* sessionToWeb(session.value)
      })

      /** Records that the Hub sent the Session a StartSession, before the state change says so. */
      const startSent = Effect.fn("SessionRelay.startSent")(function* (
        sessionId: SessionId,
        environment: { readonly environment?: { readonly version: EnvironmentVersion } },
      ) {
        starts.set(sessionId, {
          since: yield* Clock.currentTimeMillis,
          environmentVersion: environment.environment?.version,
          log: "",
          attached: false,
        })
      })

      // ── Redaction (#48) ──────────────────────────────────────────────────

      /**
       * What to redact from each Repo's Sessions, until its Sensitive values or the Sandbox tokens
       * of its Sessions change.
       */
      const needlesByRepo = new Map<string, Needles>()

      /**
       * Each Session's Sandbox tokens (#73): the current one and the one before it, which a
       * process may still hold. In memory only; a Runner asks for a fresh one when it reconnects.
       */
      const sandboxTokens = new Map<
        SessionId,
        { readonly repo: string; readonly tokens: ReadonlyArray<string> }
      >()

      /** Redacts the Session's new Sandbox token from now on, with the one before it. */
      const sandboxTokenMinted = (session: SessionSummary, token: string) => {
        const before = sandboxTokens.get(session.id)?.tokens ?? []
        sandboxTokens.set(session.id, { repo: session.repo, tokens: [...before.slice(-1), token] })
        needlesByRepo.delete(session.repo)
      }

      const tokensOfRepo = (repo: string) =>
        [...sandboxTokens.values()].flatMap((known) => (known.repo === repo ? known.tokens : []))

      const needlesFor = Effect.fn("SessionRelay.needlesFor")(function* (repo: string) {
        const known = needlesByRepo.get(repo)
        if (known !== undefined) return known
        const values = yield* environments.sensitiveValues(repo).pipe(
          Effect.map(Option.some),
          Effect.catchTag("EnvironmentRefused", (error) =>
            Effect.logError(
              `Could not read the Sensitive values of ${repo}: masking everything its Sessions print`,
              error,
            ).pipe(Effect.as(Option.none())),
          ),
        )
        // Values that can't be read are tried again next time.
        if (Option.isNone(values)) return everything
        const needles = needlesOf([...values.value.map(Redacted.value), ...tokensOfRepo(repo)])
        needlesByRepo.set(repo, needles)
        return needles
      })

      const needlesForSession = Effect.fn("SessionRelay.needlesForSession")(function* (
        sessionId: SessionId,
      ) {
        const session = yield* sessions.get(sessionId)
        return Option.isSome(session) ? yield* needlesFor(session.value.repo) : everything
      })

      /** Runs `effect` under the lock once `holdMillis` have passed. */
      const afterHold = (effect: Effect.Effect<void, SqlError>) =>
        Effect.sleep(Duration.millis(holdMillis)).pipe(
          Effect.andThen(serialized(effect)),
          Effect.catchCause((cause) => Effect.logError("Could not let held text go", cause)),
          Effect.forkIn(layerScope),
          Effect.asVoid,
        )

      /** Claude's text of a Turn's loop, as it streams. */
      interface TextStream {
        readonly turnId: TextDelta["turnId"]
        readonly agentId: TextDelta["agentId"]
        readonly redactor: StreamRedactor
        flushing: boolean
      }
      /** Each Session's text streams, by Turn and subagent, until the Turn ends. */
      const textStreams = new Map<SessionId, Map<string, TextStream>>()

      /** Each Session's terminal Output, and the last frame's size, for held text let go. */
      const terminalStreams = new Map<
        SessionId,
        { readonly redactor: StreamRedactor; size: TerminalFrame["size"]; flushing: boolean }
      >()

      const append = Effect.fn("SessionRelay.append")(function* (
        sessionId: SessionId,
        event: SessionEvent,
      ) {
        const entry = yield* log.append(sessionId, event)
        toJoined(sessionId, SessionEventLogged.make({ sessionId, entry }))
        yield* markBusy(sessionId)
      })

      /** Logs the text a stream holds back. */
      const letTextGo = Effect.fn("SessionRelay.letTextGo")(function* (
        sessionId: SessionId,
        stream: TextStream,
      ) {
        const text = stream.redactor.flush()
        if (text === "") return
        yield* append(sessionId, {
          _tag: "TextDelta",
          turnId: stream.turnId,
          ...(stream.agentId !== undefined && { agentId: stream.agentId }),
          text,
        })
      })

      /** Logs a TextDelta as far as it can be, redacted, holding back what could start a value. */
      const textDelta = Effect.fn("SessionRelay.textDelta")(function* (
        sessionId: SessionId,
        needles: Needles,
        event: TextDelta,
      ) {
        let streams = textStreams.get(sessionId)
        if (streams === undefined) {
          streams = new Map()
          textStreams.set(sessionId, streams)
        }
        const key = `${event.turnId}/${event.agentId ?? ""}`
        let stream = streams.get(key)
        if (stream === undefined) {
          stream = {
            turnId: event.turnId,
            agentId: event.agentId,
            redactor: new StreamRedactor(needles),
            flushing: false,
          }
          streams.set(key, stream)
        }
        stream.redactor.needles = needles
        const text = stream.redactor.push(event.text)
        if (text !== "") yield* append(sessionId, { ...event, text })
        if (!stream.redactor.holding || stream.flushing) return
        const held = stream
        held.flushing = true
        yield* afterHold(
          Effect.suspend(() => {
            held.flushing = false
            return letTextGo(sessionId, held)
          }),
        )
      })

      /**
       * Appends an event to the Session's log, redacted, and sends it to those who joined. Text
       * held back from Claude's text streams is logged first.
       */
      const logEvent = Effect.fn("SessionRelay.logEvent")(function* (
        sessionId: SessionId,
        event: SessionEvent,
      ) {
        const needles = yield* needlesForSession(sessionId)
        if (event._tag === "TextDelta") return yield* textDelta(sessionId, needles, event)
        const streams = textStreams.get(sessionId)
        if (streams !== undefined) {
          for (const stream of streams.values()) yield* letTextGo(sessionId, stream)
          if (event._tag === "TurnEnded") {
            if (event.agentId === undefined) textStreams.delete(sessionId)
            else streams.delete(`${event.turnId}/${event.agentId}`)
          }
        }
        yield* append(sessionId, redactEvent(needles, event))
      })

      /** Sends a terminal frame, redacted, to those watching. */
      const terminalFrame = Effect.fn("SessionRelay.terminalFrame")(function* (
        repo: string,
        frame: TerminalFrame,
      ) {
        const { sessionId } = frame
        const needles = yield* needlesFor(repo)
        const send = (data: string, size: TerminalFrame["size"]) => {
          toWeb({ ...frame, size, data }, (client) => client.terminals.has(sessionId))
          // Before Claude Code's terminal is up, the output is the start's: the Environment's
          // build and start script. A terminal shows nothing until a Snapshot, so the web shows
          // it from here instead (#70).
          const start = starts.get(sessionId)
          if (start === undefined || start.attached || data === "") return
          start.log = (start.log + data).slice(-startLogLimit)
          toJoined(sessionId, SessionStartLogged.make({ sessionId, since: start.since, data }))
        }
        let stream = terminalStreams.get(sessionId)
        if (stream === undefined) {
          stream = { redactor: new StreamRedactor(needles), size: frame.size, flushing: false }
          terminalStreams.set(sessionId, stream)
        }
        stream.redactor.needles = needles
        stream.size = frame.size
        if (frame.kind === "Snapshot") {
          const start = starts.get(sessionId)
          if (start !== undefined) start.attached = true
          // The whole screen, held Output included.
          stream.redactor.reset()
          return send(redactText(needles, frame.data), frame.size)
        }
        const data = stream.redactor.push(frame.data)
        if (data !== "") send(data, frame.size)
        if (!stream.redactor.holding || stream.flushing) return
        const held = stream
        held.flushing = true
        yield* afterHold(
          Effect.sync(() => {
            held.flushing = false
            const rest = held.redactor.flush()
            if (rest !== "") send(rest, held.size)
          }),
        )
      })

      /** Moves the Session to `state`, if it isn't there, logging why. */
      const environmentRelay = yield* makeEnvironmentRelay({
        onlineRunner: (id) => onlineRunners.get(id),
        toWeb: (message, to: (client: EnvironmentWebClient) => boolean) => toWeb(message, to),
        repoSessionsUpdated: Effect.fn("SessionRelay.repoSessionsUpdated")(function* (repo) {
          for (const session of yield* sessions.list) {
            if (session.repo === repo) yield* sessionToWeb(session)
          }
        }),
        sensitiveValuesChanged: (repo) => {
          if (repo === undefined) needlesByRepo.clear()
          else needlesByRepo.delete(repo)
        },
        afterHold,
      })

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

      // ── Repo access (#52, ADR 0003) ──────────────────────────────────────

      /**
       * Records what GitHub said of the person's access to the Repo on each of their connections.
       * A connection that gains it is sent the Repo's Sessions. One that loses it is taken out of
       * them, joined or watching, with presence updated, and told they are gone.
       */
      const accessKnown = Effect.fn("SessionRelay.accessKnown")(function* (
        who: Participant,
        repo: string,
        allowed: boolean,
      ) {
        const changed = [...webClients].filter(
          (client) => client.you.id === who.id && client.repos.get(repo) !== allowed,
        )
        if (changed.length === 0) return
        const ofRepo = (yield* sessions.list).filter((session) => session.repo === repo)
        for (const client of changed) {
          const before = client.repos.get(repo)
          client.repos.set(repo, allowed)
          if (allowed) {
            for (const session of ofRepo) {
              client.peer.send(HubToWeb.cases.SessionUpdated.make({ session: forWeb(session) }))
            }
            continue
          }
          if (before !== true) continue
          yield* Effect.logInfo(`${who.login} no longer has access to ${repo}: out of its Sessions`)
          for (const session of ofRepo) {
            client.terminals.delete(session.id)
            if (client.joined.has(session.id)) {
              const presence = presenceOf(session.id)
              client.joined.delete(session.id)
              yield* presenceChanged(session.id, presence)
            }
            client.peer.send(SessionRemoved.make({ sessionId: session.id }))
          }
        }
      })

      /** Asks GitHub, once at a time, for a person's access to a Repo none of their connections knows. */
      const learning = new Set<string>()
      const learnAccess = Effect.fn("SessionRelay.learnAccess")(function* (
        who: Participant,
        repo: string,
      ) {
        const key = `${who.id}\n${repo}`
        if (learning.has(key)) return
        learning.add(key)
        yield* access.check(who, repo).pipe(
          Effect.flatMap((allowed) => serialized(accessKnown(who, repo, allowed))),
          // Asked again at the next recheck.
          Effect.catchTag("RepoAccessUnknown", (error) => Effect.logWarning(error.message)),
          Effect.catchCause((cause) => Effect.logError("Could not check Repo access", cause)),
          Effect.ensuring(Effect.sync(() => learning.delete(key))),
          Effect.forkIn(layerScope),
        )
      })

      /**
       * Checks everyone connected against every Repo with Sessions again, as the cache lets it:
       * a person who lost access is taken out of the Repo's Sessions. Off the lock but for the
       * changes, since it may wait on GitHub. When GitHub can't say, a person keeps what they had.
       */
      const recheckAccess = Effect.gen(function* () {
        const repos = new Set((yield* sessions.list).map((session) => session.repo))
        const people = new Map([...webClients].map((client) => [client.you.id, client.you]))
        const failures: Array<string> = []
        const answers = yield* Effect.forEach(
          [...people.values()].flatMap((who) => [...repos].map((repo) => ({ who, repo }))),
          ({ who, repo }) =>
            access.check(who, repo).pipe(
              Effect.map((allowed) => ({ who, repo, allowed })),
              Effect.catchTag("RepoAccessUnknown", (error) =>
                Effect.sync(() => void failures.push(error.message)),
              ),
            ),
          { concurrency: accessCheckConcurrency },
        )
        if (failures.length > 0) {
          yield* Effect.logWarning(
            `Repo access rechecks failed (${failures.length}); those people keep what they had`,
            failures[0],
          )
        }
        yield* serialized(
          Effect.forEach(answers, (answer) =>
            answer === undefined
              ? Effect.void
              : accessKnown(answer.who, answer.repo, answer.allowed),
          ),
        )
      }).pipe(Effect.withSpan("SessionRelay.recheckAccess"))

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
        /** It went to sleep for a restart, and is about to be woken: the restart goes on. */
        restartGoesOn = false,
      ) {
        inFlight.delete(session.id)
        starting.delete(session.id)
        starts.delete(session.id)
        stopping.delete(session.id)
        restarting.delete(session.id)
        if (!restartGoesOn) restarts.delete(session.id)
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
        // A restored Session still being stopped for its archive wakes once it is stopped.
        if (runner === undefined || session.state !== "Asleep" || archiving.has(session.id)) return
        const needed = yield* environments.valuesNeeded(session.repo)
        if (needed.length > 0) {
          restarts.delete(session.id)
          yield* logEvent(
            session.id,
            SessionStateChanged.make({
              state: "Asleep",
              ...why,
              message: `Claude Code could not start: ${cantStartText(session.repo, needed)}`,
              valuesNeeded: needed.map((variable) => variable.name),
            }),
          )
          return yield* sessionUpdated(session.id)
        }
        const resume = yield* sessions.claudeSessionId(session.id)
        const environment = yield* sessionEnvironment(session.repo)
        const modToken = yield* modTokens.issue({ sessionId: session.id, runnerId: runner.id })
        starting.add(session.id)
        yield* startSent(session.id, environment)
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
            ...environment,
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
        // A start can take minutes to build its Environment: it isn't idle until it's over.
        if (starts.has(session.id)) return false
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

      // ── Archive, restore and purge ───────────────────────────────────────

      /** Asks the Runner to stop the Archived Session for good: push its WIP ref, destroy its Sandbox. */
      const stopForArchive = (runner: OnlineRunner, sessionId: SessionId) => {
        archiving.add(sessionId)
        runner.peer.send(StopSession.make({ sessionId, reason: "Archive" }))
      }

      /**
       * Archives the Session now: nothing more is delivered to it, its terminal closes, and its
       * Runner is asked to stop it for good. Its history and Prompt queue are kept for a restore.
       */
      const archive = Effect.fn("SessionRelay.archive")(function* (
        session: SessionSummary,
        by: Participant,
      ) {
        const at = yield* Clock.currentTimeMillis
        inFlight.delete(session.id)
        starting.delete(session.id)
        starts.delete(session.id)
        stopping.delete(session.id)
        restarting.delete(session.id)
        restarts.delete(session.id)
        yield* outbox.clear(session.id)
        // Its Claude Code is being stopped for good: its mod has nothing more to say.
        yield* modTokens.revoke(session.id)
        for (const client of webClients) client.terminals.delete(session.id)
        yield* sessions.archive(session.id, {
          by: by.id,
          at,
          purgeAt: at + Duration.toMillis(config.archiveRetention),
        })
        yield* logEvent(session.id, SessionStateChanged.make({ state: "Archived", by }))
        yield* sessionUpdated(session.id)
        const runner = onlineRunners.get(session.runnerId)
        if (runner !== undefined) stopForArchive(runner, session.id)
      })

      /** Brings an Archived Session back Asleep, or Frozen while its Runner is offline. */
      const restore = Effect.fn("SessionRelay.restore")(function* (
        session: SessionSummary,
        by: Participant,
      ) {
        const state = onlineRunners.has(session.runnerId) ? "Asleep" : "Frozen"
        yield* sessions.restore(session.id, state)
        yield* logEvent(
          session.id,
          SessionStateChanged.make({ state, by, message: "Restored from the archive" }),
        )
        // It stays Asleep even with prompts queued from before: the next prompt or a wake wakes it.
        yield* sessionUpdated(session.id)
      })

      /** Purges every Archived Session past its retention. */
      const purgeDue = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        for (const session of yield* sessions.dueForPurge(now)) {
          yield* Effect.logInfo(`Purging Session ${session.id}, archived past its retention`)
          yield* sessions.purge(session, now)
          archiving.delete(session.id)
          lastBusy.delete(session.id)
          sandboxTokens.delete(session.id)
          yield* outbox.clear(session.id)
          for (const client of webClients) {
            client.joined.delete(session.id)
            client.terminals.delete(session.id)
          }
          toWeb(
            SessionRemoved.make({ sessionId: session.id }),
            (client) => client.repos.get(session.repo) === true,
          )
          onlineRunners
            .get(session.runnerId)
            ?.peer.send(PurgeSession.make({ sessionId: session.id }))
        }
      }).pipe(Effect.withSpan("SessionRelay.purgeDue"))

      // ── The web channel ──────────────────────────────────────────────────

      const receiveWeb = (client: WebClient): Receive<WebToHub> => {
        const { you, peer } = client
        const refuse = (
          message: WebToHub,
          why: string,
          about: { readonly sessionId?: SessionId; readonly requestId?: RequestId } = {
            ...("sessionId" in message ? { sessionId: message.sessionId } : {}),
            ...("requestId" in message ? { requestId: message.requestId } : {}),
          },
        ) => peer.send(CommandFailed.make({ command: message._tag, message: why, ...about }))

        /**
         * What Repo access says of a command (ADR 0003), asked off the lock: what GitHub said, to
         * record under it, and why the command is refused, if it is. A Session in a Repo the
         * person has no access to is refused as if there were no such Session. Leaving a Session
         * or closing its terminal needs no access, nor do Environment commands: there are no
         * roles yet (ADR 0009).
         */
        const authorize = Effect.fn("SessionRelay.authorize")(function* (
          message: WebToHub,
        ): Effect.fn.Return<AccessVerdict, SqlError> {
          if (isEnvironmentCommand(message)) return {}
          let repo: string
          let refusal: string
          switch (message._tag) {
            case "WebHello":
            case "LeaveSession":
            case "CloseTerminal":
              return {}
            case "CreateSession":
              repo = message.repo
              refusal = `You have no access to ${repo} on GitHub, or the GitHub App isn't installed on it.`
              break
            default: {
              const session = yield* sessions.get(message.sessionId)
              // Refused as no such Session, under the lock.
              if (Option.isNone(session)) return {}
              repo = session.value.repo
              refusal = "There is no such Session."
            }
          }
          const checked = yield* access.check(you, repo).pipe(
            Effect.map((allowed) => ({ allowed })),
            Effect.catchTag("RepoAccessUnknown", (error) =>
              Effect.succeed({ unknown: error.message }),
            ),
          )
          if ("allowed" in checked) {
            return {
              learned: { repo, allowed: checked.allowed },
              ...(!checked.allowed && { refusal }),
            }
          }
          // When GitHub can't say, the person keeps what they had.
          if (client.repos.get(repo) === true) return {}
          yield* Effect.logWarning(checked.unknown)
          return {
            refusal:
              message._tag === "CreateSession"
                ? checked.unknown
                : "Could not check your access on GitHub; try again.",
          }
        })

        /** The Session a command names, or none, having refused the command. */
        const sessionFor = Effect.fn(function* (message: WebToHub & { sessionId: SessionId }) {
          const session = yield* sessions.get(message.sessionId)
          if (Option.isNone(session)) {
            refuse(message, "There is no such Session.", { sessionId: message.sessionId })
          }
          return session
        })

        const handle = Effect.fn("SessionRelay.receiveWeb")(function* (message: WebToHub) {
          if (isEnvironmentCommand(message))
            return yield* environmentRelay.receiveWeb(client, message)
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
              // Repo access was checked before the lock was taken.
              // TODO: check that the base branch exists, once the GitHub App can tell.
              const missing = yield* environmentRelay.missingEnvironment(message.repo)
              if (missing !== undefined) return refuse(message, missing, { requestId })
              const needed = yield* environments.valuesNeeded(message.repo)
              if (needed.length > 0) {
                return refuse(message, cantStartText(message.repo, needed), { requestId })
              }
              const environment = yield* sessionEnvironment(message.repo)
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
              yield* startSent(id, environment)
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
                  ...environment,
                }),
              )
              peer.send(HubToWeb.cases.SessionCreated.make({ requestId, session: forWeb(session) }))
              return yield* sessionToWeb(session)
            }

            case "JoinSession": {
              const { sessionId } = message
              const session = yield* sessionFor(message)
              if (Option.isNone(session)) return
              const entries = yield* log.history(sessionId, message.afterSeq)
              peer.send(HubToWeb.cases.SessionHistory.make({ sessionId, entries }))
              const start = starts.get(sessionId)
              if (start !== undefined && start.log !== "") {
                peer.send(
                  SessionStartLogged.make({
                    sessionId,
                    since: start.since,
                    data: start.log,
                    replace: true,
                  }),
                )
              }
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
                return refuse(message, "The Session is archived: restore it to send prompts.", {
                  sessionId,
                })
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
              if (starts.has(sessionId)) {
                return refuse(
                  message,
                  "The Session is still starting; put it to sleep once it has started.",
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

            case "RestartSession": {
              // Recreates the Sandbox from the Repo's latest Environment version (ADR 0009).
              const { sessionId } = message
              const session = yield* sessionFor(message)
              if (Option.isNone(session)) return
              if (restarts.has(sessionId)) {
                return refuse(message, "The Session is already restarting.", { sessionId })
              }
              switch (session.value.state) {
                case "Asleep": {
                  // Set first, so the woken Session shows it is restarting.
                  restarts.set(sessionId, { by: you, since: yield* Clock.currentTimeMillis })
                  yield* wake(session.value, { by: you })
                  if (!starts.has(sessionId)) restarts.delete(sessionId)
                  return
                }
                case "Active":
                  if (starts.has(sessionId)) {
                    // Its Sandbox is being made from the version it was sent: restarting now
                    // would only start it again behind this start.
                    return refuse(
                      message,
                      "The Session is still starting; restart it once it has started.",
                      { sessionId },
                    )
                  }
                  if (stopping.has(sessionId)) {
                    return refuse(
                      message,
                      "The Session is going to sleep; wake it once it is Asleep.",
                      { sessionId },
                    )
                  }
                  if (session.value.currentTurn !== null || inFlight.has(sessionId)) {
                    return refuse(message, "A Turn is running: stop it first, then restart.", {
                      sessionId,
                    })
                  }
                  if (!onlineRunners.has(session.value.runnerId)) {
                    return refuse(message, "The Session's Runner is offline.", { sessionId })
                  }
                  restarting.set(sessionId, you)
                  restarts.set(sessionId, { by: you, since: yield* Clock.currentTimeMillis })
                  yield* putToSleep(session.value, {
                    by: you,
                    message: "Restarting for the Environment's latest version",
                  })
                  // Nothing in the log says so until it is Asleep: the summary does.
                  return yield* sessionUpdated(sessionId)
                case "Frozen":
                  return refuse(
                    message,
                    "The Session is Frozen: its Runner is offline. Restart it once the Runner returns.",
                    { sessionId },
                  )
                case "Archived":
                  return refuse(message, "The Session is archived.", { sessionId })
              }
              return
            }

            case "ArchiveSession": {
              // Anyone with access to the Session's Repo may (ADR 0003).
              const { sessionId } = message
              const session = yield* sessionFor(message)
              if (Option.isNone(session)) return
              if (session.value.state === "Archived") {
                return refuse(message, "The Session is already archived.", { sessionId })
              }
              return yield* archive(session.value, you)
            }

            case "RestoreSession": {
              const { sessionId } = message
              const session = yield* sessionFor(message)
              if (Option.isNone(session)) return
              const archived = session.value.archived
              if (session.value.state !== "Archived" || archived === undefined) {
                return refuse(message, "The Session is not archived.", { sessionId })
              }
              if ((yield* Clock.currentTimeMillis) >= archived.purgeAt) {
                return refuse(message, "The Session is past restoring: it is being purged.", {
                  sessionId,
                })
              }
              return yield* restore(session.value, you)
            }

            case "CancelPrompt": {
              const { sessionId, promptId } = message
              if (Option.isNone(yield* sessionFor(message))) return
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
              if (session.value.state === "Archived") {
                return refuse(message, "The Session is archived: no Turn is running.", {
                  sessionId,
                })
              }
              yield* logEvent(sessionId, TurnStopRequested.make({ by: you }))
              yield* outbox.enqueue(sessionId, StopTurn.make({ sessionId }))
              return
            }

            case "OpenTerminal": {
              // Watching needs no running terminal: frames come once there is one, starting
              // with the snapshot the Runner sends when it attaches to a started Session, or
              // re-attaches after it reconnects.
              const session = yield* sessionFor(message)
              if (Option.isNone(session)) return
              if (session.value.state === "Archived") {
                return refuse(message, "The Session is archived: it has no terminal to open.", {
                  sessionId: message.sessionId,
                })
              }
              client.terminals.add(message.sessionId)
              const runner = onlineRunners.get(session.value.runnerId)
              if (session.value.state === "Active" && runner !== undefined) {
                runner.peer.send(RequestTerminalSnapshot.make({ sessionId: message.sessionId }))
              }
              return
            }

            case "CloseTerminal":
              client.terminals.delete(message.sessionId)
              return

            case "TerminalInput":
            case "TerminalResize": {
              // Keystrokes reach only a running Claude Code, from someone watching its terminal.
              const { sessionId } = message
              const session = yield* sessionFor(message)
              if (Option.isNone(session)) return
              if (!client.terminals.has(sessionId)) {
                return refuse(message, "Open the Session's terminal first.", { sessionId })
              }
              const runner = onlineRunners.get(session.value.runnerId)
              if (session.value.state !== "Active" || runner === undefined) {
                return refuse(
                  message,
                  `The Session is ${session.value.state}: its terminal isn't running.`,
                  { sessionId },
                )
              }
              runner.peer.send(message)
              return
            }
          }
        })

        return (message) =>
          authorize(message).pipe(
            Effect.flatMap((verdict) =>
              serialized(
                Effect.gen(function* () {
                  const { learned, refusal } = verdict
                  if (learned !== undefined) yield* accessKnown(you, learned.repo, learned.allowed)
                  if (refusal !== undefined) return refuse(message, refusal)
                  return yield* handle(message)
                }),
              ),
            ),
            Effect.catchTag("SqlError", (error) =>
              Effect.logError("A web command failed", error).pipe(
                Effect.andThen(
                  Effect.sync(() => refuse(message, "The Hub could not do that; try again.")),
                ),
              ),
            ),
          )
      }

      const connectWeb = (you: Participant, peer: Peer<HubToWeb>) =>
        Effect.gen(function* () {
          const client: WebClient = {
            you,
            peer,
            joined: new Set(),
            terminals: new Set(),
            repos: new Map(),
          }
          yield* Effect.gen(function* () {
            // Off the lock, since it may wait on GitHub. A Repo GitHub can't say about now is
            // asked about again at the next recheck.
            const asked = new Set((yield* sessions.list).map((session) => session.repo))
            yield* Effect.forEach(
              asked,
              (repo) =>
                access.check(you, repo).pipe(
                  Effect.map((allowed) => void client.repos.set(repo, allowed)),
                  Effect.catchTag("RepoAccessUnknown", (error) => Effect.logWarning(error.message)),
                ),
              { concurrency: accessCheckConcurrency, discard: true },
            )
            yield* serialized(
              Effect.gen(function* () {
                webClients.add(client)
                peer.send(yield* runnerList)
                // Only the Sessions of Repos the person has access to. Archived Sessions are
                // listed too, with who archived them, for the Archived screen; the web UI leaves
                // them out of its Session list.
                const listed: Array<SessionSummary> = []
                for (const session of yield* sessions.list) {
                  if (client.repos.get(session.repo) === true) listed.push(forWeb(session))
                  // A Repo whose first Session was created meanwhile.
                  else if (!asked.has(session.repo)) yield* learnAccess(you, session.repo)
                }
                peer.send(HubToWeb.cases.SessionList.make({ sessions: listed }))
              }),
            )
          }).pipe(Effect.orDie)
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
          if (
            message._tag === "FetchVariables" ||
            message._tag === "TestBuildLog" ||
            message._tag === "TestBuildFinished"
          ) {
            return yield* environmentRelay.receiveRunner(runner, message)
          }
          if (message._tag === "SessionPurged") {
            // The Session is gone from the Hub by now; only the note to purge it is left.
            if (!(yield* sessions.purgeDone(message.sessionId, runner.id))) {
              yield* Effect.logWarning(
                `Runner ${runner.name} purged a Session the Hub wasn't purging`,
                message.sessionId,
              )
            }
            return
          }
          const session = yield* ownSession(message.sessionId)
          if (Option.isNone(session)) return
          switch (message._tag) {
            case "SessionStarted":
              // A start that raced an archive: the StopSession that follows settles it.
              if (session.value.state === "Archived" || archiving.has(message.sessionId)) return
              starts.delete(message.sessionId)
              restarts.delete(message.sessionId)
              yield* sessions.setEnvironmentVersion(
                message.sessionId,
                message.environmentVersion ?? null,
              )
              yield* changeState(session.value, "Active", {
                message: `Claude Code started on ${runner.name}`,
              })
              if (session.value.state === "Active") yield* sessionUpdated(message.sessionId)
              yield* deliverNext(message.sessionId)
              return
            case "SessionStartFailed":
              // Asleep, with why in its history; queued prompts wait for the next wake.
              return yield* claudeGone(session.value, {
                message: `Claude Code could not start on ${runner.name}: ${message.message}`,
              })
            case "SessionStopped": {
              if (archiving.delete(message.sessionId)) {
                if (session.value.state === "Archived") {
                  // Stopped for good: its Sandbox is destroyed.
                  yield* sessions.setArchiveStopped(message.sessionId)
                  return yield* claudeGone(session.value, {})
                }
                // Restored meanwhile: Asleep on a destroyed Sandbox, and woken if prompts wait.
                yield* claudeGone(session.value, {})
                return yield* wakeIfWaiting(message.sessionId)
              }
              const asked = stopping.get(message.sessionId)
              const restartBy = asked === undefined ? undefined : restarting.get(message.sessionId)
              yield* claudeGone(
                session.value,
                asked ?? {
                  message:
                    message.reason === "Requested"
                      ? "Claude Code stopped"
                      : `Claude Code exited${message.exitCode === undefined ? "" : ` with code ${message.exitCode}`}`,
                },
                restartBy !== undefined,
              )
              if (restartBy !== undefined) {
                const stopped = yield* sessions.get(message.sessionId)
                if (Option.isSome(stopped)) yield* wake(stopped.value, { by: restartBy })
                // Not woken after all, as for an archive meanwhile: the restart is over.
                if (!starts.has(message.sessionId) && restarts.delete(message.sessionId)) {
                  yield* sessionUpdated(message.sessionId)
                }
                return
              }
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
              return yield* terminalFrame(session.value.repo, message)
            case "GitRequest":
              // Answered off the lock: it may wait on GitHub.
              yield* sessionGit.answer(session.value, message.ask).pipe(
                Effect.flatMap((answer) =>
                  Effect.sync(() => {
                    // Redacted before the Sandbox has it.
                    if (answer._tag === "SandboxToken") {
                      sandboxTokenMinted(session.value, Redacted.value(answer.token))
                    }
                    runner.peer.send(GitReply.make({ requestId: message.requestId, answer }))
                  }),
                ),
                Effect.forkIn(layerScope),
              )
              return
            case "WipPushFailed":
              yield* Effect.logWarning(
                `Runner ${runner.name} could not push the WIP ref of ${message.sessionId}: ${message.message}`,
              )
              return yield* logEvent(
                message.sessionId,
                WipNotPushed.make({ message: message.message }),
              )
            case "SandboxNote":
              return yield* logEvent(
                message.sessionId,
                SandboxNoted.make({ message: message.message }),
              )
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
              // Sessions purged while it was away, and archived ones it hasn't stopped yet.
              for (const sessionId of yield* sessions.pendingPurges(runner.id)) {
                peer.send(PurgeSession.make({ sessionId }))
              }
              const unstopped = new Set(yield* sessions.unstoppedArchives(runner.id))
              for (const session of yield* sessions.listByRunner(runner.id)) {
                if (session.state === "Archived") {
                  if (unstopped.has(session.id) || running.has(session.id)) {
                    stopForArchive(runner, session.id)
                  }
                  continue
                }
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
                yield* environmentRelay.runnerGone(runner)
                for (const session of yield* sessions.listByRunner(runner.id)) {
                  // A stop it was asked for is settled by what it says when it is back.
                  stopping.delete(session.id)
                  restarting.delete(session.id)
                  archiving.delete(session.id)
                  // A start under way is settled by what it says when it is back, too.
                  starts.delete(session.id)
                  restarts.delete(session.id)
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
          yield* turnEnded(sessionId)
        }
      })

      /** Tells the Session's Runner its Turn ended, so it pushes the WIP ref if anything changed. */
      const turnEnded = Effect.fn("SessionRelay.turnEnded")(function* (sessionId: SessionId) {
        const session = yield* sessions.get(sessionId)
        if (Option.isNone(session)) return
        onlineRunners.get(session.value.runnerId)?.peer.send(SessionTurnEnded.make({ sessionId }))
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

      yield* Effect.sleep(purgeCheckInterval(config.archiveRetention)).pipe(
        Effect.andThen(serialized(purgeDue)),
        Effect.catchCause((cause) => Effect.logError("Could not purge Archived Sessions", cause)),
        Effect.forever,
        Effect.forkIn(layerScope),
      )

      // As often as answers expire: access lost is noticed within twice that (see the top).
      yield* Effect.sleep(config.repoAccessTtl).pipe(
        Effect.andThen(recheckAccess),
        Effect.catchCause((cause) => Effect.logError("Could not recheck Repo access", cause)),
        Effect.forever,
        Effect.forkIn(layerScope),
      )

      return SessionRelay.of({ connectWeb, connectRunner, modHello, modEvents })
    }),
  )
}
