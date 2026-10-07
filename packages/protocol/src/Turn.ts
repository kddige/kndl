import { Schema } from "effect"
import { AgentId, PromptId, ToolCallId, TurnId } from "./Ids.ts"
import {
  AgentStatus,
  BranchName,
  FromSession,
  Participant,
  Question,
  QuestionOutcome,
} from "./Session.ts"

// Turn events: what happens in a Turn, as the mod reports it to the Hub. The Hub appends each to
// the Session's event log and relays it to web clients unchanged.
//
// Events from a subagent (ADR 0014) carry its `agentId`; events from the main loop have none. A
// subagent's TextDelta, ToolCallStarted, ToolCallEnded and TurnEnded have its own run's `turnId`,
// new each time it runs or is resumed, never its parent's: they belong together by `agentId`.

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
  /**
   * Claude Code's note that a background subagent finished or was stopped (its
   * `<task-notification>`), which starts a Turn on the main loop.
   */
  Schema.TaggedStruct("FromAgent", { agentId: AgentId }),
  /** Another Session, before ADR 0014: history only. */
  FromSession,
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

/**
 * A Participant steered a queued prompt into the Turn running on the main loop (#195, ADR 0018):
 * the mod added it to the Turn's conversation, with the sender's name, as Claude Code adds a prompt
 * typed while it works. It starts no Turn, and the Turn's sender stays who it was. Claude reads it
 * at the Turn's next step ({@link SteeredPromptRead}).
 */
export const PromptSteered = Schema.TaggedStruct("PromptSteered", {
  turnId: TurnId,
  /** The Prompt queue entry it came from. */
  promptId: PromptId,
  /** The prompt as its sender wrote it. */
  text: Schema.NonEmptyString,
  sender: Participant,
})
export type PromptSteered = typeof PromptSteered.Type

/**
 * Claude read a steered prompt: the Turn's first step after it joined. A Turn that ends with none
 * leaves it unread in the conversation, and Claude reads it with the next prompt.
 */
export const SteeredPromptRead = Schema.TaggedStruct("SteeredPromptRead", {
  turnId: TurnId,
  promptId: PromptId,
})
export type SteeredPromptRead = typeof SteeredPromptRead.Type

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

/**
 * The main loop started a subagent with its Agent tool (ADR 0014). Only agents started that way
 * are reported: Claude Code's own, such as its progress summaries, never are.
 */
export const AgentStarted = Schema.TaggedStruct("AgentStarted", {
  /** The main loop's Turn that started it. */
  turnId: TurnId,
  agentId: AgentId,
  /** The Agent call that started it. */
  toolCallId: ToolCallId,
  /** Its subagent type, such as `general-purpose`. */
  agentType: Schema.String,
  /** What it is for, as the Agent call described it. */
  description: Schema.String,
  /** The model it runs, as Claude Code names it. */
  model: Schema.String,
  /** Whether it runs in the background, past the Turn that started it. */
  background: Schema.Boolean,
})
export type AgentStarted = typeof AgentStarted.Type

/** The git worktree a subagent works in, given `isolation: "worktree"`. */
export const AgentWorktree = Schema.Struct({
  /** Its path in the Sandbox, under `/workspace/.claude/worktrees/`. */
  path: Schema.NonEmptyString,
  branch: BranchName,
})
export type AgentWorktree = typeof AgentWorktree.Type

/**
 * A subagent's status changed: Running when it starts or resumes, Done when it finishes, Stopped
 * by TaskStop. The Hub reports Interrupted when its Session's Claude Code stops with it Running.
 */
export const AgentStatusChanged = Schema.TaggedStruct("AgentStatusChanged", {
  agentId: AgentId,
  status: AgentStatus,
  /** Present once it has a worktree. */
  worktree: Schema.optionalKey(AgentWorktree),
})
export type AgentStatusChanged = typeof AgentStatusChanged.Type

/**
 * Claude asked a question with AskUserQuestion on the main loop (#193): the Session's Open
 * question until a QuestionClosed for the same call. Claude Code shows its dialog at the terminal
 * meanwhile, and the first answer, there or from the web UI, is the one Claude reads. A subagent's
 * questions are answered at the terminal only, and not reported.
 */
export const QuestionAsked = Schema.TaggedStruct("QuestionAsked", {
  turnId: TurnId,
  toolCallId: ToolCallId,
  questions: Schema.Array(Question),
})
export type QuestionAsked = typeof QuestionAsked.Type

/**
 * The Open question closed: answered, replied to or dismissed, or Cancelled. The mod reports it
 * when an answer settles it; the Hub when its Turn or its Claude Code ended with it open.
 */
export const QuestionClosed = Schema.TaggedStruct("QuestionClosed", {
  turnId: TurnId,
  toolCallId: ToolCallId,
  outcome: QuestionOutcome,
  /** The Participant who answered from the web UI; absent when it was at the terminal, or none. */
  by: Schema.optionalKey(Participant),
})
export type QuestionClosed = typeof QuestionClosed.Type

/** Every Turn event. New kinds of event are added here as members. */
export const TurnEvent = Schema.Union([
  TurnStarted,
  TextDelta,
  ToolCallStarted,
  ToolCallEnded,
  TurnEnded,
  AgentStarted,
  AgentStatusChanged,
  QuestionAsked,
  QuestionClosed,
  PromptSteered,
  SteeredPromptRead,
]).pipe(Schema.toTaggedUnion("_tag"))
export type TurnEvent = typeof TurnEvent.Type

/**
 * What a closed question says (#193), as "Bob answered: date-fns" or "Someone at the terminal
 * dismissed the question"; with `first`, as told to someone whose answer came after it.
 */
export const questionClosedText = (
  closed: { readonly outcome: QuestionOutcome; readonly by?: Participant | undefined },
  first = false,
): string => {
  const who = closed.by?.name ?? "Someone at the terminal"
  const then = first ? " first" : ""
  const { outcome } = closed
  switch (outcome._tag) {
    case "Answered": {
      const answers = Object.entries(outcome.answers)
      if (answers.length === 0) return `${who} skipped the questions${then}`
      const what = answers
        .map(([question, answer]) => (answers.length === 1 ? answer : `${question} ${answer}`))
        .join("; ")
      return `${who} answered${then}: ${what}`
    }
    case "Replied":
      return `${who} replied${then}: “${outcome.text}”`
    case "Dismissed":
      return `${who} dismissed the question${then}`
    case "Cancelled":
      return first ? "The question was cancelled first" : "The question was cancelled"
  }
}
