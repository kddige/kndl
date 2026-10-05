import { Schema } from "effect"
import { ClaudeSessionId, ModCommandSeq, PromptId, SessionId } from "./Ids.ts"
import { FromSession, Participant, PresenceChanged, StopTurn } from "./Session.ts"
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
// "@claude-hub/protocol"`) and does no runtime validation of its own; the Hub validates
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
})
export type ModHello = typeof ModHello.Type

/** A {@link DeliverPrompt} could not be submitted to Claude Code, so it never started a Turn. */
export const PromptFailed = Schema.TaggedStruct("PromptFailed", {
  promptId: PromptId,
  message: Schema.String,
})
export type PromptFailed = typeof PromptFailed.Type

/** Every message the mod sends the Hub: its hello, Turn events, and failed deliveries. */
export const ModToHub = Schema.Union([ModHello, TurnEvent, PromptFailed]).pipe(
  Schema.toTaggedUnion("_tag"),
)
export type ModToHub = typeof ModToHub.Type
export type ModToHubEncoded = typeof ModToHub.Encoded

/** What the mod reports after its hello: Turn events and failed deliveries. */
export const ModEvent = Schema.Union([TurnEvent, PromptFailed]).pipe(Schema.toTaggedUnion("_tag"))
export type ModEvent = typeof ModEvent.Type

/** The body of `POST /mod/events`: the mod's events since its last post, oldest first. */
export const ModEvents = Schema.Struct({ messages: Schema.Array(ModEvent) })
export type ModEvents = typeof ModEvents.Type
export type ModEventsEncoded = typeof ModEvents.Encoded

// ── Hub to mod ─────────────────────────────────────────────────────────────

/** The Hub accepted the mod's hello. */
export const ModWelcome = Schema.TaggedStruct("ModWelcome", {
  protocolVersion: CurrentProtocolVersion,
})
export type ModWelcome = typeof ModWelcome.Type

/**
 * The next prompt from the Prompt queue, sent when the Session is idle. The mod submits it with
 * the sender's name, or as it is when another Session sent it (the Hub wrote it for the model),
 * and reports the Turn it starts with this `promptId`.
 */
export const DeliverPrompt = Schema.TaggedStruct("DeliverPrompt", {
  sessionId: SessionId,
  promptId: PromptId,
  text: Schema.NonEmptyString,
  sender: Participant,
  /** Present when another Session sent it: the Turn it starts is reported as from that Session. */
  fromSession: Schema.optionalKey(FromSession),
})
export type DeliverPrompt = typeof DeliverPrompt.Type

/** Every message the Hub sends the mod. `PresenceChanged` feeds the Participants band. */
export const HubToMod = Schema.Union([
  ModWelcome,
  HandshakeRejected,
  DeliverPrompt,
  StopTurn,
  PresenceChanged,
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
export const ModCommand = Schema.Union([DeliverPrompt, StopTurn, PresenceChanged]).pipe(
  Schema.toTaggedUnion("_tag"),
)
export type ModCommand = typeof ModCommand.Type

/** The longest the Hub holds `GET /mod/commands` open before answering with no commands. */
export const MaxCommandWaitMs = 25_000

/** A whole number of at least zero, sent as a query parameter. */
const NaturalFromString = Schema.FiniteFromString.pipe(Schema.decodeTo(Schema.Natural))

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
