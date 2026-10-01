import { Schema } from "effect"

// Branded ids, so a SessionId can't be passed where a RunnerId is expected. On the wire each is
// a plain string (EventSeq a number); the brand exists only in the decoded type.

/** A Session, minted by the Hub. */
export const SessionId = Schema.NonEmptyString.pipe(Schema.brand("SessionId"))
export type SessionId = typeof SessionId.Type

/** A Runner, minted by the Hub when the Runner's token is issued. */
export const RunnerId = Schema.NonEmptyString.pipe(Schema.brand("RunnerId"))
export type RunnerId = typeof RunnerId.Type

/** A person who signs in to the Hub with GitHub, and so can be a Participant. */
export const ParticipantId = Schema.NonEmptyString.pipe(Schema.brand("ParticipantId"))
export type ParticipantId = typeof ParticipantId.Type

/** A Turn, as Claude Code's `turn.start` mints it. */
export const TurnId = Schema.NonEmptyString.pipe(Schema.brand("TurnId"))
export type TurnId = typeof TurnId.Type

/** A prompt in a Session's Prompt queue, minted by the Hub. */
export const PromptId = Schema.NonEmptyString.pipe(Schema.brand("PromptId"))
export type PromptId = typeof PromptId.Type

/** One tool call: Claude Code's `tool_use_id`, or an id the mod mints when there is none. */
export const ToolCallId = Schema.NonEmptyString.pipe(Schema.brand("ToolCallId"))
export type ToolCallId = typeof ToolCallId.Type

/** A subagent's loop inside a Turn, as Claude Code's `agentId`. Absent on the main loop. */
export const AgentId = Schema.NonEmptyString.pipe(Schema.brand("AgentId"))
export type AgentId = typeof AgentId.Type

/** Claude Code's own session id, which `claude --resume` takes to wake an Asleep Session. */
export const ClaudeSessionId = Schema.NonEmptyString.pipe(Schema.brand("ClaudeSessionId"))
export type ClaudeSessionId = typeof ClaudeSessionId.Type

/** Chosen by a web client to match the Hub's answer to its request. */
export const RequestId = Schema.NonEmptyString.pipe(Schema.brand("RequestId"))
export type RequestId = typeof RequestId.Type

/** The position of an entry in a Session's event log: 0, 1, 2, ... in append order. */
export const EventSeq = Schema.Natural.pipe(Schema.brand("EventSeq"))
export type EventSeq = typeof EventSeq.Type
