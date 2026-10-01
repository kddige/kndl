import { Schema } from "effect"
import { AgentId, PromptId, ToolCallId, TurnId } from "./Ids.ts"
import { Participant } from "./Session.ts"

// Turn events: what happens in a Turn, as the mod reports it to the Hub. The Hub appends each to
// the Session's event log and relays it to web clients unchanged.
//
// Events from a subagent carry its `agentId`; events from the main loop have none.

/**
 * The longest tool input or output summary, in characters. The mod clips to this (the prototype
 * appended "… (N more chars)"); the full text stays in Claude Code's transcript.
 */
export const MaxToolSummaryLength = 4_000

const ToolSummary = Schema.String.check(Schema.isMaxLength(MaxToolSummaryLength))

/** Who sent the prompt a Turn starts with. */
export const PromptSender = Schema.Union([
  /** A Participant, through the web UI's Prompt queue. */
  Schema.TaggedStruct("FromParticipant", { participant: Participant }),
  /** Typed at the Session's terminal, so the person is unknown. */
  Schema.TaggedStruct("FromTerminal", {}),
]).pipe(Schema.toTaggedUnion("_tag"))
export type PromptSender = typeof PromptSender.Type

/** A Turn began on the main loop. Subagent loops have no start of their own. */
export const TurnStarted = Schema.TaggedStruct("TurnStarted", {
  turnId: TurnId,
  /** The prompt as the model reads it; "" for a Turn that continues without one. */
  text: Schema.String,
  sender: PromptSender,
  /** The Prompt queue entry this Turn answers, when it came from the queue. */
  promptId: Schema.optionalKey(PromptId),
})
export type TurnStarted = typeof TurnStarted.Type

/** A piece of the text Claude is streaming. Consecutive pieces may be merged before sending. */
export const TextDelta = Schema.TaggedStruct("TextDelta", {
  turnId: TurnId,
  agentId: Schema.optionalKey(AgentId),
  text: Schema.NonEmptyString,
})
export type TextDelta = typeof TextDelta.Type

/** Claude called a tool. */
export const ToolCallStarted = Schema.TaggedStruct("ToolCallStarted", {
  turnId: TurnId,
  agentId: Schema.optionalKey(AgentId),
  toolCallId: ToolCallId,
  /** The tool's name as the model sees it, such as `Bash`. */
  tool: Schema.NonEmptyString,
  /** The tool's input as JSON, clipped to {@link MaxToolSummaryLength}. */
  input: ToolSummary,
})
export type ToolCallStarted = typeof ToolCallStarted.Type

/**
 * How a tool call ended: it ran, it ran and reported an error, or it was denied without running
 * (as the mod's deny-by-default list does).
 */
export const ToolCallOutcome = Schema.Literals(["Succeeded", "Failed", "Denied"])
export type ToolCallOutcome = typeof ToolCallOutcome.Type

/** A tool call finished. */
export const ToolCallEnded = Schema.TaggedStruct("ToolCallEnded", {
  turnId: TurnId,
  agentId: Schema.optionalKey(AgentId),
  toolCallId: ToolCallId,
  tool: Schema.NonEmptyString,
  outcome: ToolCallOutcome,
  /** The result the model reads, or the deny reason, clipped to {@link MaxToolSummaryLength}. */
  output: ToolSummary,
})
export type ToolCallEnded = typeof ToolCallEnded.Type

/**
 * Why a Turn ended (Claude Code's `turn.complete` reason): the model answered, someone stopped
 * it, the model refused, or an API error ended it.
 */
export const TurnEndReason = Schema.Literals(["Answered", "Stopped", "Refused", "Failed"])
export type TurnEndReason = typeof TurnEndReason.Type

/** The tokens a Turn's model requests used, summed, and the model of the last. */
export const TurnUsage = Schema.Struct({
  model: Schema.NonEmptyString,
  inputTokens: Schema.Natural,
  outputTokens: Schema.Natural,
  cacheReadInputTokens: Schema.Natural,
  cacheCreationInputTokens: Schema.Natural,
})
export type TurnUsage = typeof TurnUsage.Type

/**
 * A Turn ended. Without an `agentId` this ends the Turn on the main loop, and the Session is idle
 * again; with one, only that subagent's loop ended.
 */
export const TurnEnded = Schema.TaggedStruct("TurnEnded", {
  turnId: TurnId,
  agentId: Schema.optionalKey(AgentId),
  reason: TurnEndReason,
  durationMs: Schema.Natural,
  /** Absent when no request counted, such as on an early stop or an API error. */
  usage: Schema.optionalKey(TurnUsage),
})
export type TurnEnded = typeof TurnEnded.Type

/** Every Turn event. New kinds of event are added here as members. */
export const TurnEvent = Schema.Union([
  TurnStarted,
  TextDelta,
  ToolCallStarted,
  ToolCallEnded,
  TurnEnded,
]).pipe(Schema.toTaggedUnion("_tag"))
export type TurnEvent = typeof TurnEvent.Type
