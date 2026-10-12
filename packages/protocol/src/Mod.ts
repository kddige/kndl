import { Schema } from "effect"
import { AttachmentMediaType, PromptAttachments, textOrAttachments } from "./Attachment.ts"
import {
  AgentId,
  AttachmentId,
  ClaudeSessionId,
  ModCommandSeq,
  ParticipantId,
  PromptId,
  SessionId,
  ToolCallId,
} from "./Ids.ts"
import { Participant, PresenceChanged, QuestionAnswer, StopAgent, StopTurn } from "./Session.ts"
import { TurnEvent } from "./Turn.ts"
import { CurrentProtocolVersion, HandshakeRejected } from "./Version.ts"

// The mod ↔ Hub channel, over plain HTTP: Claude Code's mod runtime has `fetch`, with request
// headers, but no WebSockets and no streaming. Every request carries the Session's mod token as
// `Authorization: Bearer` (issue #7).
//
// - `POST /mod/hello`, body ModHello: answered with a ModHelloReply (200 for ModWelcome, 400 for
//   HandshakeRejected), or 403 if the token is for another Session.
// - `POST /mod/events`, body ModEvents: answered with 204.
// - `GET /mod/commands?after=<seq>&waitMs=<ms>`: a long poll, answered with ModCommands as soon
//   as the Session's outbox holds a command numbered above `after`, or with none after `waitMs`
//   (at most MaxCommandWaitMs). The mod passes the seq of the last command it handled, so a
//   command is neither lost nor run twice when a poll fails.
//
// Both answer 409 when the Hub hasn't heard this Session's hello since it started: the mod then
// says hello again and polls from `after=0`, since the Hub's numbering started over too.
//
// The mod runs in Claude Code's mod runtime, which may not run Effect (spike #4). Until #4
// answers, the mod imports the *types* only (`import type { ModToHub } from
// "@kndl/protocol"`) and does no runtime validation of its own; the Hub validates
// everything the mod sends. `ModToHubEncoded` and `HubToModEncoded` are the plain JSON shapes,
// without brands, for building and reading messages without the schemas.

// ── mod to Hub ─────────────────────────────────────────────────────────────

/**
 * The mod's first message, once Claude Code's session has started, and again whenever the Hub
 * answers 409.
 */
export const ModHello = Schema.TaggedStruct("ModHello", {
  protocolVersion: CurrentProtocolVersion,
  sessionId: SessionId,
  /** Claude Code's own session id, for `claude --resume` when the Session wakes. */
  claudeSessionId: ClaudeSessionId,
  /** The model Claude Code runs, as it names it. */
  model: Schema.NonEmptyString,
  /**
   * It takes a {@link DeliverIntoTurn} (#195). A mod from before doesn't say so, and the Hub
   * refuses to steer a prompt to it.
   */
  steers: Schema.optionalKey(Schema.Literal(true)),
  /**
   * It marks the files a {@link DeliverIntoTurn}, {@link DeliverAgentMessage} or a reply's
   * {@link DeliverAnswer} carries (#278). A mod from before doesn't say so, and the Hub refuses to
   * send it files those ways.
   */
  attaches: Schema.optionalKey(Schema.Literal(true)),
})
export type ModHello = typeof ModHello.Type

/**
 * A {@link DeliverPrompt} could not be submitted to Claude Code, so it never started a Turn; or a
 * {@link DeliverIntoTurn} could not join the running Turn, as when that Turn had ended.
 */
export const PromptFailed = Schema.TaggedStruct("PromptFailed", {
  promptId: PromptId,
  message: Schema.String,
})
export type PromptFailed = typeof PromptFailed.Type

/**
 * A {@link DeliverPrompt} for a prompt the mod gave Claude Code already (#323), so it didn't again:
 * the Hub delivers the head of the queue again when it doesn't know it was delivered, as after it
 * restarted, or when the mod never reported the Turn it started. The Hub takes it out of the queue.
 * Sent only to a Hub whose {@link ModWelcome} says it takes it.
 */
export const PromptAlreadySubmitted = Schema.TaggedStruct("PromptAlreadySubmitted", {
  promptId: PromptId,
})
export type PromptAlreadySubmitted = typeof PromptAlreadySubmitted.Type

/**
 * A {@link DeliverAgentMessage} or {@link StopAgent} failed, as when the agent is unknown to
 * Claude Code: named by the web command it came from, with who sent the message, if anyone did.
 */
export const AgentCommandFailed = Schema.TaggedStruct("AgentCommandFailed", {
  agentId: AgentId,
  command: Schema.Literals(["MessageAgent", "StopAgent"]),
  senderId: Schema.optionalKey(ParticipantId),
  message: Schema.String,
})
export type AgentCommandFailed = typeof AgentCommandFailed.Type

/**
 * A {@link DeliverAnswer} came too late (#193): the question had closed, answered first at the
 * terminal or by another Participant, or cancelled. The sender is told so.
 */
export const AnswerFailed = Schema.TaggedStruct("AnswerFailed", {
  toolCallId: ToolCallId,
  senderId: ParticipantId,
  message: Schema.String,
})
export type AnswerFailed = typeof AnswerFailed.Type

/** Every message the mod sends the Hub: its hello, Turn events, and failed commands. */
export const ModToHub = Schema.Union([
  ModHello,
  TurnEvent,
  PromptFailed,
  PromptAlreadySubmitted,
  AgentCommandFailed,
  AnswerFailed,
]).pipe(Schema.toTaggedUnion("_tag"))
export type ModToHub = typeof ModToHub.Type
export type ModToHubEncoded = typeof ModToHub.Encoded

/** What the mod reports after its hello: Turn events and failed commands. */
export const ModEvent = Schema.Union([
  TurnEvent,
  PromptFailed,
  PromptAlreadySubmitted,
  AgentCommandFailed,
  AnswerFailed,
]).pipe(Schema.toTaggedUnion("_tag"))
export type ModEvent = typeof ModEvent.Type

/** The body of `POST /mod/events`: the mod's events since its last post, oldest first. */
export const ModEvents = Schema.Struct({ messages: Schema.Array(ModEvent) })
export type ModEvents = typeof ModEvents.Type
export type ModEventsEncoded = typeof ModEvents.Encoded

// ── Hub to mod ─────────────────────────────────────────────────────────────

/** The Hub accepted the mod's hello. */
export const ModWelcome = Schema.TaggedStruct("ModWelcome", {
  protocolVersion: CurrentProtocolVersion,
  /**
   * It takes a {@link PromptAlreadySubmitted} (#323). A Hub from before doesn't say so, and would
   * refuse the post it came in, with the events beside it.
   */
  alreadySubmitted: Schema.optionalKey(Schema.Literal(true)),
})
export type ModWelcome = typeof ModWelcome.Type

/**
 * The next prompt from the Prompt queue, sent when the Session is idle. The mod submits it with
 * the sender's name and a marker for each attachment (#276), and reports the Turn it starts with
 * this `promptId`.
 */
export const DeliverPrompt = Schema.TaggedStruct("DeliverPrompt", {
  sessionId: SessionId,
  promptId: PromptId,
  /** As typed; empty for a prompt of attachments alone. */
  text: Schema.String,
  sender: Participant,
  attachments: Schema.optionalKey(PromptAttachments),
}).check(textOrAttachments)
export type DeliverPrompt = typeof DeliverPrompt.Type

/**
 * A prompt from the Prompt queue a Participant steered (web SteerPrompt, #195), sent while a Turn
 * runs, and only to a mod whose hello says it `steers`. The mod adds it to the running Turn with
 * the sender's name, as Claude Code adds a prompt typed while it works, and reports PromptSteered;
 * or PromptFailed, when no Turn runs to take it. Its files (#278) are marked in the row it adds,
 * and Claude opens them by the markers alone.
 */
export const DeliverIntoTurn = Schema.TaggedStruct("DeliverIntoTurn", {
  sessionId: SessionId,
  promptId: PromptId,
  /** As typed; empty for a prompt of attachments alone. */
  text: Schema.String,
  sender: Participant,
  attachments: Schema.optionalKey(PromptAttachments),
}).check(textOrAttachments)
export type DeliverIntoTurn = typeof DeliverIntoTurn.Type

/**
 * A Participant's message to one of the Session's subagents (web MessageAgent, ADR 0014). The mod
 * sends it with the sender's name and a marker for each file (#278), as a prompt; a running agent
 * reads it at its next tool call, and one that has stopped resumes with it.
 */
export const DeliverAgentMessage = Schema.TaggedStruct("DeliverAgentMessage", {
  sessionId: SessionId,
  agentId: AgentId,
  /** As typed; empty for a message of attachments alone. */
  text: Schema.String,
  sender: Participant,
  attachments: Schema.optionalKey(PromptAttachments),
}).check(textOrAttachments)
export type DeliverAgentMessage = typeof DeliverAgentMessage.Type

/**
 * A Participant's answer to the Session's Open question (web AnswerQuestion, #193), which the Hub
 * sends only for a question the mod reported asked. The mod answers the AskUserQuestion call with
 * it, closing Claude Code's dialog, unless the call was answered first; then it reports
 * {@link AnswerFailed}.
 */
export const DeliverAnswer = Schema.TaggedStruct("DeliverAnswer", {
  sessionId: SessionId,
  toolCallId: ToolCallId,
  answer: QuestionAnswer,
  sender: Participant,
})
export type DeliverAnswer = typeof DeliverAnswer.Type

/**
 * The most bytes of an attachment one {@link ModAttachment} carries: base64 of it is 3.2 MB, under
 * the 4 MiB the mod runtime's fetch reads of a body (Claude Code 2.1.296), which a 5 MB image's
 * would be over. A multiple of 3, so the parts' base64 joins into the whole file's.
 */
export const MaxModAttachmentPartBytes = 2_400_000

/**
 * The answer to `GET /mod/attachments/<id>?offset=<n>` (#276): a part of one of the Session's
 * attachments, from byte `offset` (0 by default), which the mod's tool hands Claude whole. Base64,
 * as Claude reads it: the mod runtime's fetch reads text only.
 */
export const ModAttachment = Schema.Struct({
  id: AttachmentId,
  name: Schema.NonEmptyString,
  mediaType: AttachmentMediaType,
  /** At most {@link MaxModAttachmentPartBytes} of the file, base64. */
  data: Schema.String,
  /** Where the next part starts; absent on the last. */
  next: Schema.optionalKey(Schema.Natural),
})
export type ModAttachment = typeof ModAttachment.Type
export type ModAttachmentEncoded = typeof ModAttachment.Encoded

/** Every message the Hub sends the mod. `PresenceChanged` feeds the Participants band. */
export const HubToMod = Schema.Union([
  ModWelcome,
  HandshakeRejected,
  DeliverPrompt,
  DeliverIntoTurn,
  StopTurn,
  DeliverAgentMessage,
  StopAgent,
  PresenceChanged,
  DeliverAnswer,
]).pipe(Schema.toTaggedUnion("_tag"))
export type HubToMod = typeof HubToMod.Type
export type HubToModEncoded = typeof HubToMod.Encoded

/** The answer to `POST /mod/hello`. */
export const ModHelloReply = Schema.Union([ModWelcome, HandshakeRejected]).pipe(
  Schema.toTaggedUnion("_tag"),
)
export type ModHelloReply = typeof ModHelloReply.Type
export type ModHelloReplyEncoded = typeof ModHelloReply.Encoded

/** What the Hub queues for a Session's mod, which the mod collects from `GET /mod/commands`. */
export const ModCommand = Schema.Union([
  DeliverPrompt,
  DeliverIntoTurn,
  StopTurn,
  DeliverAgentMessage,
  StopAgent,
  PresenceChanged,
  DeliverAnswer,
]).pipe(Schema.toTaggedUnion("_tag"))
export type ModCommand = typeof ModCommand.Type

/** The longest the Hub holds `GET /mod/commands` open before answering with no commands. */
export const MaxCommandWaitMs = 25_000

/** A whole number of at least zero, sent as a query parameter. */
const NaturalFromString = Schema.FiniteFromString.pipe(Schema.decodeTo(Schema.Natural))

/** The query of `GET /mod/attachments/<id>`: the byte its part starts at, 0 by default. */
export const ModAttachmentQuery = Schema.Struct({ offset: Schema.optionalKey(NaturalFromString) })
export type ModAttachmentQueryEncoded = typeof ModAttachmentQuery.Encoded

/** The query of `GET /mod/commands`. Both default to 0: everything queued, without waiting. */
export const ModCommandsQuery = Schema.Struct({
  /** The seq of the last command the mod handled; 0 before the first. */
  after: Schema.optionalKey(NaturalFromString.pipe(Schema.decodeTo(ModCommandSeq))),
  /** How long to wait for a command, in milliseconds. Above MaxCommandWaitMs waits that long. */
  waitMs: Schema.optionalKey(NaturalFromString),
})
export type ModCommandsQuery = typeof ModCommandsQuery.Type
export type ModCommandsQueryEncoded = typeof ModCommandsQuery.Encoded

/** A command in a Session's outbox, numbered 1, 2, ... in the order the Hub queued it. */
export const QueuedModCommand = Schema.Struct({ seq: ModCommandSeq, message: ModCommand })
export type QueuedModCommand = typeof QueuedModCommand.Type

/** The answer to `GET /mod/commands`: the commands after `after`, oldest first; maybe none. */
export const ModCommands = Schema.Struct({ messages: Schema.Array(QueuedModCommand) })
export type ModCommands = typeof ModCommands.Type
export type ModCommandsEncoded = typeof ModCommands.Encoded
