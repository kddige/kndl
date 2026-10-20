import { Schema } from "effect"
import { AttachmentIds, PromptAttachments, textOrAttachments } from "./Attachment.ts"
import { AgentId, PromptId, RequestId, SessionId, ThreadId, TurnId } from "./Ids.ts"
import { ModelName, ThinkingLevel } from "./Model.ts"
import { ProviderModel } from "./Provider.ts"
import { Participant } from "./Session.ts"

// What the durable agent adds to a Session (docs/design/durable-harness.md): threads, the Plan,
// compaction and running cost. A thread is a conversation forked off the main loop at one of its
// Turns, which runs beside the main loop and every other thread; anyone posts into it. Its Turn
// events carry its `threadId`.

/** The most characters a thread's title has: the start of its first prompt. */
export const MaxThreadTitleLength = 120

/** A thread's title, from its first prompt: its first line, clipped. */
export const threadTitleFrom = (text: string): string => {
  const line = text.trim().split("\n", 1)[0]?.trim() ?? ""
  if (line === "") return "Thread"
  return line.length > MaxThreadTitleLength ? `${line.slice(0, MaxThreadTitleLength - 1)}…` : line
}

// ── The Plan ──────────────────────────────────────────────────────────────

/** Where one step of the Plan is. */
export const PlanStepStatus = Schema.Literals(["pending", "in_progress", "done"])
export type PlanStepStatus = typeof PlanStepStatus.Type

export const PlanStep = Schema.Struct({
  text: Schema.String,
  status: PlanStepStatus,
})
export type PlanStep = typeof PlanStep.Type

/**
 * The agent's Plan for a conversation: a checklist it keeps with its `update_plan` tool, in a
 * Pi Durable document. A thread starts with the Plan the main loop had where it was forked.
 */
export const Plan = Schema.Struct({
  steps: Schema.Array(PlanStep),
  /** What changed, or why, as the agent said; absent when it said nothing. */
  explanation: Schema.optionalKey(Schema.String),
})
export type Plan = typeof Plan.Type

// ── Events, mod to Hub, logged ────────────────────────────────────────────

/**
 * A Participant started a thread (web StartThread): the Hub logs it at once, and sends the mod a
 * StartThread. Its first prompt follows as a {@link ThreadPromptSent}.
 */
export const ThreadStarted = Schema.TaggedStruct("ThreadStarted", {
  threadId: ThreadId,
  anchorTurnId: TurnId,
  title: Schema.NonEmptyString,
  startedBy: Participant,
  /**
   * The model it runs on: the Session's own when the thread was started without one, since a
   * fork keeps the model its parent had at the fork and doesn't follow the Session's later.
   */
  model: ModelName,
  thinkingLevel: Schema.optionalKey(ThinkingLevel),
})
export type ThreadStarted = typeof ThreadStarted.Type

/**
 * A Participant posted into a thread (web StartThread or PromptThread). The Hub logs it at once,
 * so everyone sees it as sent; the agent's TurnStarted or PromptSteered with the same `promptId`
 * shows where it was read.
 */
export const ThreadPromptSent = Schema.TaggedStruct("ThreadPromptSent", {
  threadId: ThreadId,
  promptId: PromptId,
  /**
   * The web command it came from, so its sender matches this to the reply it is showing as
   * sending. The Hub redacts `text` before logging it, so the text can't be matched.
   */
  requestId: Schema.optionalKey(RequestId),
  sender: Participant,
  /** As typed; empty for a prompt of attachments alone. */
  text: Schema.String,
  attachments: Schema.optionalKey(PromptAttachments),
}).check(textOrAttachments)
export type ThreadPromptSent = typeof ThreadPromptSent.Type

/**
 * The agent couldn't take a prompt posted into a thread, such as the first of a thread it
 * couldn't fork: it is not sent after all, for everyone. When the thread's first prompt failed,
 * the thread is gone too, since the agent never made it, and later replies are refused.
 */
export const ThreadPromptFailed = Schema.TaggedStruct("ThreadPromptFailed", {
  threadId: ThreadId,
  promptId: PromptId,
  /** Why, as the agent said, redacted. */
  message: Schema.String,
  /** Present when the thread was dropped with its first prompt. */
  threadDropped: Schema.optionalKey(Schema.Literal(true)),
})
export type ThreadPromptFailed = typeof ThreadPromptFailed.Type

/** A Participant switched a thread's model (web SetThreadModel), from its next request on. */
export const ThreadModelChanged = Schema.TaggedStruct("ThreadModelChanged", {
  threadId: ThreadId,
  by: Participant,
  model: ModelName,
  thinkingLevel: Schema.optionalKey(ThinkingLevel),
})
export type ThreadModelChanged = typeof ThreadModelChanged.Type

/** Why a compaction started: near the context's limit, after the Provider refused it as too long, or by hand. */
export const CompactionReason = Schema.Literals(["threshold", "overflow", "manual"])
export type CompactionReason = typeof CompactionReason.Type

/**
 * The agent started summarizing a conversation's older messages, so it keeps fitting its model's
 * context. It works on meanwhile; the summary takes their place at the next Turn's step.
 */
export const CompactionStarted = Schema.TaggedStruct("CompactionStarted", {
  threadId: Schema.optionalKey(ThreadId),
  agentId: Schema.optionalKey(AgentId),
  reason: CompactionReason,
  /** Who asked for it, for a manual one from the web. */
  by: Schema.optionalKey(Participant),
})
export type CompactionStarted = typeof CompactionStarted.Type

/** A compaction ended: the summary was placed, there was nothing to compact, or it failed. */
export const CompactionEnded = Schema.TaggedStruct("CompactionEnded", {
  threadId: Schema.optionalKey(ThreadId),
  agentId: Schema.optionalKey(AgentId),
  outcome: Schema.Literals(["compacted", "skipped", "failed"]),
  /** The summary the model reads from now on, clipped. */
  summary: Schema.optionalKey(Schema.String),
  /** Why it failed. */
  error: Schema.optionalKey(Schema.String),
})
export type CompactionEnded = typeof CompactionEnded.Type

/** The agent changed a conversation's Plan. */
export const PlanChanged = Schema.TaggedStruct("PlanChanged", {
  threadId: Schema.optionalKey(ThreadId),
  agentId: Schema.optionalKey(AgentId),
  plan: Plan,
})
export type PlanChanged = typeof PlanChanged.Type

/** What a conversation has spent so far, every model it ran on summed: Pi Durable's `pi.usage`. */
export const ConversationUsage = Schema.Struct({
  input: Schema.Natural,
  output: Schema.Natural,
  cacheRead: Schema.Natural,
  cacheWrite: Schema.Natural,
  /** In US dollars, as pi-ai prices it. */
  cost: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type ConversationUsage = typeof ConversationUsage.Type

/**
 * A conversation's running total changed: the main loop's (no ids), a thread's, or a subagent's.
 * The agent sends it once a Turn ends, not on every request.
 */
export const UsageChanged = Schema.TaggedStruct("UsageChanged", {
  threadId: Schema.optionalKey(ThreadId),
  agentId: Schema.optionalKey(AgentId),
  usage: ConversationUsage,
})
export type UsageChanged = typeof UsageChanged.Type

// ── Commands, Hub to mod ──────────────────────────────────────────────────

/**
 * Fork the main loop at the answer of `anchorTurnId` into a new thread, and start a Turn in it
 * with this prompt (submitted with `promptId` as its request id, so it runs once). A Turn that
 * hasn't answered yet is forked at its newest entry.
 */
export const StartThread = Schema.TaggedStruct("StartThread", {
  sessionId: SessionId,
  threadId: ThreadId,
  anchorTurnId: TurnId,
  promptId: PromptId,
  text: Schema.String,
  sender: Participant,
  attachments: Schema.optionalKey(PromptAttachments),
  /** The thread's own model: the Hub always resolves one, the Session's when none was asked for. */
  model: ModelName,
  thinkingLevel: Schema.optionalKey(ThinkingLevel),
}).check(textOrAttachments)
export type StartThread = typeof StartThread.Type

/**
 * A prompt for a thread: it starts a Turn when the thread is idle, and steers its running Turn
 * when it isn't. Submitted with `promptId` as its request id, so it runs once however often it is
 * delivered.
 */
export const DeliverThreadPrompt = Schema.TaggedStruct("DeliverThreadPrompt", {
  sessionId: SessionId,
  threadId: ThreadId,
  promptId: PromptId,
  text: Schema.String,
  sender: Participant,
  attachments: Schema.optionalKey(PromptAttachments),
}).check(textOrAttachments)
export type DeliverThreadPrompt = typeof DeliverThreadPrompt.Type

/** Web to Hub, then Hub to mod: stop the Turn running in a thread. Any Participant may. */
export const StopThread = Schema.TaggedStruct("StopThread", {
  sessionId: SessionId,
  threadId: ThreadId,
})
export type StopThread = typeof StopThread.Type

/** Run a thread's next requests on this model and thinking level. */
export const SwitchThreadModel = Schema.TaggedStruct("SwitchThreadModel", {
  sessionId: SessionId,
  threadId: ThreadId,
  model: ModelName,
  thinkingLevel: Schema.optionalKey(ThinkingLevel),
})
export type SwitchThreadModel = typeof SwitchThreadModel.Type

/** Summarize the older messages of the main loop, or of a thread, now, with these instructions. */
export const Compact = Schema.TaggedStruct("Compact", {
  sessionId: SessionId,
  threadId: Schema.optionalKey(ThreadId),
  instructions: Schema.optionalKey(Schema.String),
  sender: Participant,
})
export type Compact = typeof Compact.Type

// ── Web to Hub ────────────────────────────────────────────────────────────

/**
 * Start a thread off one of the main loop's Turns, with its first prompt. Any Participant may; an
 * Asleep Session is woken first. The Hub mints its id, logs ThreadStarted and ThreadPromptSent,
 * and answers with a ThreadCreated, or a CommandFailed, both with its `requestId`. A `model` is
 * one of the Session's Models; absent, the thread starts on the Session's current Model and
 * thinking level, and keeps them: it doesn't follow the Session's later switches.
 */
export const CreateThread = Schema.TaggedStruct("CreateThread", {
  requestId: RequestId,
  sessionId: SessionId,
  anchorTurnId: TurnId,
  text: Schema.String,
  attachments: Schema.optionalKey(AttachmentIds),
  model: Schema.optionalKey(ModelName),
  thinkingLevel: Schema.optionalKey(ThinkingLevel),
}).check(textOrAttachments)
export type CreateThread = typeof CreateThread.Type

/**
 * Post into a thread. Any Participant may; an Asleep Session is woken first. A refusal is a
 * CommandFailed with its `requestId`, and the ThreadPromptSent the Hub logs for it carries it, so
 * the sender can tell which of its replies each is for.
 */
export const PromptThread = Schema.TaggedStruct("PromptThread", {
  requestId: RequestId,
  sessionId: SessionId,
  threadId: ThreadId,
  text: Schema.String,
  attachments: Schema.optionalKey(AttachmentIds),
}).check(textOrAttachments)
export type PromptThread = typeof PromptThread.Type

/** Switch a thread's model. Any Participant may. */
export const SetThreadModel = Schema.TaggedStruct("SetThreadModel", {
  sessionId: SessionId,
  threadId: ThreadId,
  model: ModelName,
  thinkingLevel: Schema.optionalKey(ThinkingLevel),
})
export type SetThreadModel = typeof SetThreadModel.Type

/** Compact the main loop, or a thread, now. Any Participant may, while the Session is Active. */
export const CompactConversation = Schema.TaggedStruct("CompactConversation", {
  sessionId: SessionId,
  threadId: Schema.optionalKey(ThreadId),
  instructions: Schema.optionalKey(Schema.String),
})
export type CompactConversation = typeof CompactConversation.Type

// ── Hub to web ────────────────────────────────────────────────────────────

/** The answer to a CreateThread, to its sender: the thread to open. */
export const ThreadCreated = Schema.TaggedStruct("ThreadCreated", {
  /** The CreateThread this answers. */
  requestId: RequestId,
  sessionId: SessionId,
  threadId: ThreadId,
})
export type ThreadCreated = typeof ThreadCreated.Type

/**
 * The Models a Session can run on, its Creator's (ADR 0026: a Session spends its Creator's
 * accounts), sent to everyone who joins it, so anyone can switch it, or start a thread on another.
 */
export const SessionModels = Schema.TaggedStruct("SessionModels", {
  sessionId: SessionId,
  models: Schema.Array(ProviderModel),
})
export type SessionModels = typeof SessionModels.Type

/** Every thread and compaction command from the web, grouped as one member of WebToHub. */
export const ThreadCommand = Schema.Union([
  CreateThread,
  PromptThread,
  StopThread,
  SetThreadModel,
  CompactConversation,
]).pipe(Schema.toTaggedUnion("_tag"))
export type ThreadCommand = typeof ThreadCommand.Type

/** What the Hub sends the web of threads and a Session's Models, grouped as one member of HubToWeb. */
export const ThreadMessage = Schema.Union([ThreadCreated, SessionModels]).pipe(
  Schema.toTaggedUnion("_tag"),
)
export type ThreadMessage = typeof ThreadMessage.Type
