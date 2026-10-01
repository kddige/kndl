import { Schema } from "effect"
import { ClaudeSessionId, PromptId, SessionId } from "./Ids.ts"
import { Participant, PresenceChanged, StopTurn } from "./Session.ts"
import { TurnEvent } from "./Turn.ts"
import { CurrentProtocolVersion, HandshakeRejected } from "./Version.ts"

// The mod ↔ Hub channel. One connection per Session: the mod authenticates with the Session's
// mod token (issue #7), sends a ModHello, and waits for a ModWelcome or a HandshakeRejected.
//
// The mod runs in Claude Code's mod runtime, which may not run Effect (spike #4). Until #4
// answers, the mod imports the *types* only (`import type { ModToHub } from
// "@claude-hub/protocol"`) and does no runtime validation of its own; the Hub validates
// everything the mod sends. `ModToHubEncoded` and `HubToModEncoded` are the plain JSON shapes,
// without brands, for building and reading messages without the schemas.

// ── mod to Hub ─────────────────────────────────────────────────────────────

/** The mod's first message on every connection, once Claude Code's session has started. */
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

// ── Hub to mod ─────────────────────────────────────────────────────────────

/** The Hub accepted the mod's hello. */
export const ModWelcome = Schema.TaggedStruct("ModWelcome", {
  protocolVersion: CurrentProtocolVersion,
})
export type ModWelcome = typeof ModWelcome.Type

/**
 * The next prompt from the Prompt queue, sent when the Session is idle. The mod submits it with
 * the sender's name, and reports the Turn it starts with this `promptId`.
 */
export const DeliverPrompt = Schema.TaggedStruct("DeliverPrompt", {
  sessionId: SessionId,
  promptId: PromptId,
  text: Schema.NonEmptyString,
  sender: Participant,
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
