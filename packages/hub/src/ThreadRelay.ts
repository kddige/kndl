// What the Session relay does with threads (docs/design/durable-harness.md): the web's commands to
// start one, post into it, stop its Turn, switch its model and compact a conversation, and the
// durable agent's events about them.
//
// - Threads are conversations forked off the main loop at one of its Turns, which run beside it.
//   Anyone starts one (CreateThread), posts into it (PromptThread), stops its Turn (StopThread),
//   switches its model to one of the Creator's (SetThreadModel), or compacts it or the main loop
//   (CompactConversation); an Asleep Session is woken first, as for a message to a subagent. An
//   agent whose hello said it isn't the durable agent is refused them, saying to restart it.
// - The Hub mints a thread's id, keeps it with the Session (Sessions.ts), whose summary lists it
//   with its own Model, the Session's as it was when none was picked, which it keeps, logs
//   ThreadStarted, ThreadPromptSent and ThreadModelChanged itself, and sends the mod the command.
//   The commands aren't lost to an outbox dropped as the agent stops (ThreadOutbox.ts).
// - A prompt the agent fails is logged as a ThreadPromptFailed, and a thread it could not start
//   is forgotten with it. A thread's Turn events carry its id: its TurnStarted and TurnEnded set
//   it running and idle, never the Session's Turn, and its PromptSteered leaves the Prompt queue
//   alone. A running thread keeps the Session from idling to sleep.
// - The agent stopping ends each running thread's Turn, as it does the main loop's.
//
// It runs under the Session relay's lock, as part of it.

import {
  attachmentsNotSent,
  CommandFailed,
  Compact,
  DeliverThreadPrompt,
  findProviderModel,
  type HubToWeb,
  type ModEvent,
  type Participant,
  PromptId,
  SandboxNoted,
  type SessionEvent,
  type SessionId,
  type SessionLogEntry,
  type SessionSummary,
  StartThread,
  StopThread,
  SwitchThreadModel,
  ThreadCreated,
  ThreadId,
  ThreadModelChanged,
  ThreadPromptFailed,
  ThreadPromptSent,
  ThreadStarted,
  threadTitleFrom,
  type ParticipantId,
  type RequestId,
  type ThreadCommand,
  type TurnEnded,
  type TurnId,
  TurnStopRequested,
  type WebToHub,
} from "@kndl/protocol"
import { Clock, Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { Attachments, carrying } from "./Attachments.ts"
import { type CheckedModel } from "./Harnesses.ts"
import type { LiveSessions } from "./LiveSessions.ts"
import { ModelCatalog } from "./ModelCatalog.ts"
import type { Peer } from "./Peers.ts"
import { type Needles, redactEvent, redactText } from "./Redaction.ts"
import { SessionLog } from "./SessionLog.ts"
import { type ModelSetting, Sessions } from "./Sessions.ts"
import type { ThreadOutbox } from "./ThreadOutbox.ts"
import { randomId } from "./Tokens.ts"

const webTags = [
  "CreateThread",
  "PromptThread",
  "StopThread",
  "SetThreadModel",
  "CompactConversation",
] as const

/** Whether a web command is one about threads or compaction. */
export const isThreadCommand = (message: WebToHub): message is ThreadCommand =>
  (webTags as ReadonlyArray<string>).includes(message._tag)

/** A web connection, as the relay knows it. */
export interface ThreadWebClient {
  readonly you: Participant
  readonly peer: Peer<HubToWeb>
}

/** What the thread relay needs of the Session relay. */
export interface ThreadRelayHost {
  readonly live: LiveSessions
  /** Keeps and sends the durable agent's thread commands. */
  readonly outbox: ThreadOutbox
  readonly toWeb: (message: HubToWeb, to: (client: ThreadWebClient) => boolean) => void
  /** Appends an event to the Session's log, redacted, and sends it to those who joined. */
  readonly logEvent: (sessionId: SessionId, event: SessionEvent) => Effect.Effect<void, SqlError>
  /** Logs the text the Session's streams hold back, as `logEvent` does before any event. */
  readonly letTextGo: (sessionId: SessionId) => Effect.Effect<void, SqlError>
  /** Sends entries already appended to the Session's log to those who joined. */
  readonly broadcast: (
    sessionId: SessionId,
    entries: ReadonlyArray<SessionLogEntry>,
  ) => Effect.Effect<void>
  /** What to redact from the Session's events. */
  readonly needlesFor: (sessionId: SessionId) => Effect.Effect<Needles, SqlError>
  readonly sessionUpdated: (sessionId: SessionId) => Effect.Effect<void, SqlError>
  /** Wakes the Asleep Session for `by`: why it can't, if it can't. */
  readonly wake: (
    session: SessionSummary,
    by: Participant,
  ) => Effect.Effect<string | undefined, SqlError>
  /** A new thread's model and thinking level, checked against the Session's Creator's Models. */
  readonly checkModel: (
    asked: ModelSetting,
    creatorId: ParticipantId,
  ) => Effect.Effect<CheckedModel | string, SqlError>
}

const refuse = (client: ThreadWebClient, message: ThreadCommand, why: string) =>
  client.peer.send(
    CommandFailed.make({
      command: message._tag,
      message: why,
      sessionId: message.sessionId,
      ...("requestId" in message && { requestId: message.requestId }),
    }),
  )

export const makeThreadRelay = Effect.fnUntraced(function* (host: ThreadRelayHost) {
  const { live, outbox } = host
  const sql = yield* SqlClient.SqlClient
  const sessions = yield* Sessions
  const log = yield* SessionLog
  const attachments = yield* Attachments
  const modelCatalog = yield* ModelCatalog

  /**
   * Who last switched each thread's model, by `<sessionId>/<threadId>`, to be told if the agent
   * can't. In memory only: after a Hub restart, a failed switch is only noted in the Session.
   */
  const modelSwitchers = new Map<string, ParticipantId>()

  // ── The web's commands ─────────────────────────────────────────────────

  /**
   * The Session a thread command names, unless it is Archived or its agent doesn't take threads;
   * else none, the command refused.
   */
  const sessionOf = Effect.fn("ThreadRelay.sessionOf")(function* (
    client: ThreadWebClient,
    message: ThreadCommand,
  ) {
    const { sessionId } = message
    const session = yield* sessions.get(sessionId)
    if (Option.isNone(session)) {
      refuse(client, message, "There is no such Session.")
      return session
    }
    if (session.value.state === "Archived") {
      refuse(client, message, "The Session is archived: restore it first.")
      return Option.none<SessionSummary>()
    }
    // A mod from before, of pi or Claude Code, that said hello and runs still.
    const running = session.value.state === "Active" || session.value.state === "Frozen"
    if (running && !live.awaitingHello(sessionId) && live.modDurable(sessionId) === false) {
      refuse(client, message, "This Session's agent doesn't take threads: restart it.")
      return Option.none<SessionSummary>()
    }
    return session
  })

  /** The Session's thread, or none, the command refused. */
  const threadFor = Effect.fn("ThreadRelay.threadFor")(function* (
    client: ThreadWebClient,
    message: ThreadCommand,
    threadId: ThreadId,
  ) {
    const thread = yield* sessions.threadOf(message.sessionId, threadId)
    if (Option.isNone(thread)) {
      refuse(client, message, "The Session has no such thread.")
    }
    return thread
  })

  /**
   * A new thread's own model and thinking level, checked against the Session's Creator's
   * Models: the ones asked for, or, with no model asked for, the Session's as they are now. A
   * fork keeps the model its parent had when it forked and never follows the Session's
   * later switches, so the thread is always given one; or none, the command refused.
   */
  const settingFor = Effect.fn("ThreadRelay.settingFor")(function* (
    client: ThreadWebClient,
    message: Extract<ThreadCommand, { readonly _tag: "CreateThread" }>,
    session: SessionSummary,
  ) {
    // A thinking level alone is for the Session's model. One that goes with another model
    // is what was asked for it: the Session's doesn't carry over.
    const model = message.model ?? session.model
    const thinkingLevel =
      message.model === undefined
        ? (message.thinkingLevel ?? session.thinkingLevel)
        : message.thinkingLevel
    const checked = yield* host.checkModel(
      {
        ...(model !== undefined && { model }),
        ...(thinkingLevel !== undefined && { thinkingLevel }),
      },
      session.creator.id,
    )
    if (typeof checked === "string") {
      refuse(client, message, checked)
      return Option.none<CheckedModel["setting"]>()
    }
    return Option.some(checked.setting)
  })

  /**
   * Wakes the Session for a thread command if it is Asleep, as for a message to a subagent:
   * whether the command goes on; if not, it was refused.
   */
  const wokenFor = Effect.fn("ThreadRelay.wokenFor")(function* (
    client: ThreadWebClient,
    message: ThreadCommand,
    session: SessionSummary,
  ) {
    if (session.state !== "Asleep") return true
    const refused = yield* host.wake(session, client.you)
    if (refused !== undefined) {
      refuse(client, message, refused)
      return false
    }
    if (!live.awaitingHello(message.sessionId)) {
      refuse(client, message, "The Session could not be woken: see its history.")
      return false
    }
    return true
  })

  /**
   * The attachments a prompt names, marked sent by you, so they are kept past the day an unsent
   * one lasts (#280): all of them, if each is one you uploaded to the Session; or none, the
   * command refused.
   */
  const markSentOrRefuse = Effect.fn("ThreadRelay.markSentOrRefuse")(function* (
    client: ThreadWebClient,
    message: Extract<ThreadCommand, { readonly _tag: "CreateThread" | "PromptThread" }>,
  ) {
    const marked = yield* attachments.markSent(
      message.sessionId,
      message.attachments ?? [],
      client.you.id,
      yield* Clock.currentTimeMillis,
    )
    if (Option.isNone(marked)) refuse(client, message, attachmentsNotSent("prompt").refusal)
    return marked
  })

  /**
   * A thread prompt is admitted all at once: its thread (when new), its visible events and
   * its replayable command. Never call logEvent or enqueue the in-memory outbox inside this
   * transaction: neither broadcasts nor live state can roll back. Held text is unrelated to
   * admission and flushed first, as logEvent would do. Only committed entries are broadcast.
   * A crash after commit may miss a broadcast/ThreadCreated, but history and the next agent
   * hello recover the saved prompt; an uncommitted prompt leaves neither history nor command.
   */
  const admitPrompt = Effect.fn("ThreadRelay.admitPrompt")(function* (
    sessionId: SessionId,
    command: StartThread | DeliverThreadPrompt,
    /** The web command it came from, which its ThreadPromptSent carries back to the sender. */
    requestId: RequestId,
  ) {
    const needles = yield* host.needlesFor(sessionId)
    yield* host.letTextGo(sessionId)
    const { threadId, promptId, sender, text, attachments: carried } = command
    const admitted = yield* sql.withTransaction(
      Effect.gen(function* () {
        const events: Array<ThreadStarted | ThreadPromptSent> = []
        if (command._tag === "StartThread") {
          const { anchorTurnId, model, thinkingLevel } = command
          // Redacted before it is kept: the Session's summary lists it to everyone, past what
          // the log's redaction covers. Before it is clipped, so a value isn't cut in two.
          const title = threadTitleFrom(redactText(needles, text))
          yield* sessions.threadStarted(sessionId, {
            id: threadId,
            anchorTurnId,
            title,
            startedBy: sender.id,
            model,
            ...(thinkingLevel !== undefined && { thinkingLevel }),
            createdAt: yield* Clock.currentTimeMillis,
          })
          events.push(
            ThreadStarted.make({
              threadId,
              anchorTurnId,
              title,
              startedBy: sender,
              model,
              ...(thinkingLevel !== undefined && { thinkingLevel }),
            }),
          )
        }
        events.push(
          ThreadPromptSent.make({
            threadId,
            promptId,
            requestId,
            sender,
            text,
            ...carrying(carried ?? []),
          }),
        )
        const entries = []
        for (const event of events)
          entries.push(yield* log.append(sessionId, redactEvent(needles, event)))
        const kept = yield* outbox.keep(sessionId, command)
        return { entries, kept }
      }),
    )
    yield* host.broadcast(sessionId, admitted.entries)
    yield* outbox.send(sessionId, admitted.kept, command)
  })

  const handle = Effect.fn("ThreadRelay.handle")(function* (
    client: ThreadWebClient,
    message: ThreadCommand,
  ) {
    const { you, peer } = client
    switch (message._tag) {
      case "CreateThread": {
        // Anyone who sees the Session may (docs/design/durable-harness.md).
        const { requestId, sessionId, anchorTurnId } = message
        const session = yield* sessionOf(client, message)
        if (Option.isNone(session)) return
        if ((yield* log.mainTurnStartedAt(sessionId, anchorTurnId)) === undefined) {
          return refuse(
            client,
            message,
            "There is no such Turn in the Session to start a thread off.",
          )
        }
        const setting = yield* settingFor(client, message, session.value)
        if (Option.isNone(setting)) return
        if (!(yield* wokenFor(client, message, session.value))) return
        // Marked sent as it is logged, so a thread refused, or a wake, keeps none.
        const sent = yield* markSentOrRefuse(client, message)
        if (Option.isNone(sent)) return
        const threadId = ThreadId.make(`thr_${randomId()}`)
        const promptId = PromptId.make(randomId())
        const prompt = { promptId, sender: you, text: message.text, ...carrying(sent.value) }
        yield* admitPrompt(
          sessionId,
          StartThread.make({
            sessionId,
            threadId,
            anchorTurnId,
            ...prompt,
            ...setting.value,
          }),
          requestId,
        )
        peer.send(ThreadCreated.make({ requestId, sessionId, threadId }))
        return yield* host.sessionUpdated(sessionId)
      }

      case "PromptThread": {
        // Anyone may post into a thread: it steers a Turn running there.
        const { requestId, sessionId, threadId } = message
        const session = yield* sessionOf(client, message)
        if (Option.isNone(session)) return
        if (Option.isNone(yield* threadFor(client, message, threadId))) return
        if (!(yield* wokenFor(client, message, session.value))) return
        const sent = yield* markSentOrRefuse(client, message)
        if (Option.isNone(sent)) return
        const prompt = {
          promptId: PromptId.make(randomId()),
          sender: you,
          text: message.text,
          ...carrying(sent.value),
        }
        return yield* admitPrompt(
          sessionId,
          DeliverThreadPrompt.make({ sessionId, threadId, ...prompt }),
          requestId,
        )
      }

      case "StopThread": {
        const { sessionId, threadId } = message
        const session = yield* sessionOf(client, message)
        if (Option.isNone(session)) return
        const thread = yield* threadFor(client, message, threadId)
        if (Option.isNone(thread)) return
        if (!thread.value.running) return refuse(client, message, "No Turn runs in the thread.")
        yield* host.logEvent(sessionId, TurnStopRequested.make({ by: you, threadId }))
        return yield* outbox.queue(sessionId, StopThread.make({ sessionId, threadId }))
      }

      case "SetThreadModel": {
        // To one of the Session's Creator's Models (ADR 0026), from its next request on. A
        // Session asleep takes it as it wakes.
        const { sessionId, threadId } = message
        const session = yield* sessionOf(client, message)
        if (Option.isNone(session)) return
        const thread = yield* threadFor(client, message, threadId)
        if (Option.isNone(thread)) return
        const checked = yield* host.checkModel(
          {
            model: message.model,
            ...(message.thinkingLevel !== undefined && { thinkingLevel: message.thinkingLevel }),
          },
          session.value.creator.id,
        )
        if (typeof checked === "string") return refuse(client, message, checked)
        const { model, thinkingLevel } = checked.setting
        if (thread.value.model === model && thread.value.thinkingLevel === thinkingLevel) {
          return
        }
        yield* sessions.setThreadModel(sessionId, threadId, checked.setting)
        modelSwitchers.set(`${sessionId}/${threadId}`, you.id)
        const level = thinkingLevel === undefined ? {} : { thinkingLevel }
        yield* host.logEvent(
          sessionId,
          ThreadModelChanged.make({ threadId, by: you, model, ...level }),
        )
        yield* outbox.queue(
          sessionId,
          SwitchThreadModel.make({ sessionId, threadId, model, ...level }),
        )
        return yield* host.sessionUpdated(sessionId)
      }

      case "CompactConversation": {
        // The main loop's, or a thread's. An Asleep Session is woken for it, as for a prompt.
        const { sessionId, threadId, instructions } = message
        const session = yield* sessionOf(client, message)
        if (Option.isNone(session)) return
        if (threadId !== undefined && Option.isNone(yield* threadFor(client, message, threadId))) {
          return
        }
        if (!(yield* wokenFor(client, message, session.value))) return
        return yield* outbox.queue(
          sessionId,
          Compact.make({
            sessionId,
            ...(threadId !== undefined && { threadId }),
            ...(instructions !== undefined && { instructions }),
            sender: you,
          }),
        )
      }
    }
  })

  // ── The agent's events ─────────────────────────────────────────────────

  /**
   * The agent couldn't take a prompt. A thread's is done with, not sent again, and logged as
   * failed, so everyone sees it is not sent, now and after a reload. A thread the agent could not
   * start is gone with its first prompt: it never existed there, and a reply to it would fail
   * alike. Whether it was a thread's; if not, the caller settles it.
   */
  const promptFailed = Effect.fn("ThreadRelay.promptFailed")(function* (
    sessionId: SessionId,
    event: Extract<ModEvent, { readonly _tag: "PromptFailed" }>,
  ) {
    const taken = yield* outbox.promptTaken(sessionId, event.promptId)
    if (Option.isNone(taken)) return false
    const { threadId, sender } = taken.value
    const dropped =
      taken.value._tag === "StartThread" && (yield* sessions.dropThread(sessionId, threadId))
    yield* host.logEvent(
      sessionId,
      ThreadPromptFailed.make({
        threadId,
        promptId: event.promptId,
        message: event.message,
        ...(dropped && { threadDropped: true as const }),
      }),
    )
    if (dropped) {
      // Its sender is in a thread that is no more: told why, as the thread says nothing.
      host.toWeb(
        CommandFailed.make({
          command: "CreateThread",
          sessionId,
          message: redactText(
            yield* host.needlesFor(sessionId),
            `The thread could not be started: ${event.message}`,
          ),
        }),
        (client) => client.you.id === sender.id,
      )
    }
    yield* host.sessionUpdated(sessionId)
    return true
  })

  /**
   * The agent couldn't switch a thread's model: the thread runs on what it ran on, its setting
   * says so again unless it was switched since, and whoever switched it is told, or, if the
   * Hub doesn't know who, the Session's history says so.
   */
  const modelSwitchFailed = Effect.fn("ThreadRelay.modelSwitchFailed")(function* (
    sessionId: SessionId,
    threadId: ThreadId,
    event: Extract<ModEvent, { readonly _tag: "ModelSwitchFailed" }>,
  ) {
    const session = yield* sessions.get(sessionId)
    const thread = yield* sessions.threadOf(sessionId, threadId)
    if (Option.isNone(session) || Option.isNone(thread)) return
    if (thread.value.model === event.asked) {
      const creatorModels = yield* modelCatalog.modelsFor(session.value.creator.id)
      const { thinkingLevel } = thread.value
      // Only a Model of its Creator's is taken as the one it runs on; else the setting stays.
      if (findProviderModel(creatorModels, event.model) !== undefined) {
        yield* sessions.setThreadModel(sessionId, threadId, {
          model: event.model,
          ...(thinkingLevel !== undefined && { thinkingLevel }),
        })
        yield* host.sessionUpdated(sessionId)
      }
    }
    // The title was redacted when it was kept; a thread from before that is redacted now.
    const needles = yield* host.needlesFor(sessionId)
    const message = redactText(
      needles,
      `Couldn't switch the thread “${thread.value.title}” to ${event.asked ?? "another model"}: ${event.message}. It still runs on ${event.model}.`,
    )
    const key = `${sessionId}/${threadId}`
    const switcher = modelSwitchers.get(key)
    modelSwitchers.delete(key)
    if (switcher === undefined) {
      return yield* host.logEvent(sessionId, SandboxNoted.make({ message }))
    }
    host.toWeb(
      CommandFailed.make({ command: "SetThreadModel", sessionId, message }),
      (client) => client.you.id === switcher,
    )
  })

  /**
   * A Turn event the agent reported, once logged, that is a thread's: it starts or ends the
   * thread's Turn, or its prompt reaches the agent, leaving the main loop as it was. Whether it
   * was; if not, the caller settles it.
   */
  const turnEvent = Effect.fn("ThreadRelay.turnEvent")(function* (
    sessionId: SessionId,
    event: ModEvent,
  ) {
    switch (event._tag) {
      case "TurnStarted": {
        // Its prompt has reached the agent.
        if (event.threadId === undefined) return false
        yield* sessions.setThreadTurn(sessionId, event.threadId, {
          turnId: event.turnId,
          startedAt: yield* Clock.currentTimeMillis,
        })
        if (event.promptId !== undefined) yield* outbox.promptTaken(sessionId, event.promptId)
        yield* host.sessionUpdated(sessionId)
        return true
      }
      case "PromptSteered": {
        // A thread's prompt joined its Turn: it has reached the agent.
        if (event.threadId === undefined) return false
        yield* outbox.promptTaken(sessionId, event.promptId)
        return true
      }
      case "TurnEnded": {
        if (event.agentId !== undefined || event.threadId === undefined) return false
        // Only the Turn running there ends it: a late end of an earlier one leaves a later alone.
        if (yield* sessions.threadTurnEnded(sessionId, event.threadId, event.turnId)) {
          yield* host.sessionUpdated(sessionId)
        }
        return true
      }
      default:
        return false
    }
  })

  /**
   * The Session's agent stopped: the Turn each of its threads ran is ended, each logged as
   * `ended` says. Whether any ran; the caller sends the SessionUpdated.
   */
  const endTurns = Effect.fn("ThreadRelay.endTurns")(function* (
    sessionId: SessionId,
    ended: (turnId: TurnId, startedAt: number | undefined, threadId: ThreadId) => TurnEnded,
  ) {
    const turns = yield* sessions.endThreadTurns(sessionId)
    for (const turn of turns) {
      yield* host.logEvent(sessionId, ended(turn.turnId, turn.startedAt, turn.threadId))
    }
    return turns.length > 0
  })

  return {
    receiveWeb: handle,
    promptFailed,
    modelSwitchFailed,
    turnEvent,
    endTurns,
  }
})

export type ThreadRelay = Effect.Success<ReturnType<typeof makeThreadRelay>>
