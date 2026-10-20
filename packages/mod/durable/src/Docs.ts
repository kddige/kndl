// What the durable agent keeps of its own in Pi Durable's storage, beside the transcript: its
// documents, changed in the same atomic commits as the entries they describe, so a restart finds
// them as they were. Kinds are persisted names (`kndl.*`): never rename one.
//
// - `kndl.session` (Session): the conversation id the agent says hello with.
// - `kndl.turns` (each conversation): the Turns the agent reported, and the entries they began and
//   ended with, so a thread can fork at a Turn's answer and a restart knows which run it reported.
// - `kndl.threads` (Session): each thread's conversation.
// - `kndl.compactions` (Session): the Compact requests handled, so one the Hub sends again isn't run again.
// - `kndl.agents` (Session): each subagent's conversation and what the web knows of it.
// - `kndl.questions` (Session): the Open questions, so an answer that comes across a restart lands.
// - `kndl.plan` (each conversation, rewindable): the Plan; a fork starts with it as of its fork.

import type { JsonValue } from "@earendil-works/chord"
import { defineDoc } from "@earendil-works/pi-durable"
import type { ConversationId, EntryId, SubmissionId, TaskId } from "@earendil-works/pi-durable"

/** A Participant as the Hub sends it, kept as JSON. */
export type SenderJson = { readonly id: string; readonly login: string; readonly name: string }

/** The Session's identity, as the Hub knows it. */
export const SessionDoc = defineDoc<{ conversationId: string }>({
  kind: "kndl.session",
  version: 1,
  scope: "session",
  initial: () => ({ conversationId: "" }),
})

/** One Turn the agent reported: its first input's entry, and its answer once it has one. */
export type TurnRecord = {
  /** The entry its prompt was placed as. */
  entry?: EntryId
  /** The answer of its last run, once it answered. */
  answer?: EntryId
  /** The newest entry it wrote, for a Turn that ended without an answer. */
  last?: EntryId
}

export type TurnsState = {
  /** By kndl TurnId. */
  turns: Record<string, TurnRecord>
  /**
   * The run reported as a Turn and not yet ended, by its first input: a restart that finds that
   * run still going reports it Resumed, under a new Turn of its own (`turnIds` grows by one).
   */
  current?: { input: SubmissionId; turnIds: string[] }
}

/**
 * The Turns of one conversation. A fork starts with none: a thread's Turns are its own, and the
 * main loop's stay the main loop's to anchor threads on.
 */
export const TurnsDoc = defineDoc<TurnsState>({
  kind: "kndl.turns",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ turns: {} }),
})

export type ThreadRecord = {
  conversationId: ConversationId
  anchorTurnId: string
  title: string
}

/** The Session's threads, by ThreadId. */
export const ThreadsDoc = defineDoc<{ threads: Record<string, ThreadRecord> }>({
  kind: "kndl.threads",
  version: 1,
  scope: "session",
  initial: () => ({ threads: {} }),
})

/** How many handled Compact requests are kept: the Hub sends one again only until it is polled past. */
export const HandledCompactionsKept = 200

/** The Compact commands handled, oldest first, by the Hub's `requestId`. */
export const CompactionsDoc = defineDoc<{ handled: string[] }>({
  kind: "kndl.compactions",
  version: 1,
  scope: "session",
  initial: () => ({ handled: [] }),
})

export type AgentRecord = {
  conversationId: ConversationId
  /** The conversation that started it, whose follow-ups its results are. */
  parentConversationId: ConversationId
  /** The background task that owns its conversation. */
  anchorTaskId: TaskId
  description: string
  /** `<provider>/<id>`. */
  model: string
  /** Whether the Hub knows it: one started outside a Turn never is. */
  reported: boolean
  /** Running from a run's start to its end, kept across a restart. */
  status: "Running" | "Done" | "Stopped" | "Interrupted"
  /** Answers already given to the parent: several messages can end in one answer. */
  delivered: EntryId[]
  /** Its message tasks under way. */
  pending: TaskId[]
  /** Message tasks whose result goes to no one: a stop by the model, which returns it itself. */
  quiet: TaskId[]
  /** The message task each tool call made, so a call a restart cut off makes it once. */
  calls: Record<string, TaskId>
}

/** The Session's subagents, by AgentId. */
export const AgentsDoc = defineDoc<{ agents: Record<string, AgentRecord> }>({
  kind: "kndl.agents",
  version: 1,
  scope: "session",
  initial: () => ({ agents: {} }),
})

export type QuestionRecord = {
  conversationId: ConversationId
  turnId: string
  questions: JsonValue
  async: boolean
  /** How it closed, once it has; retained so a replayed call reads the same answer. */
  closed?: { outcome: JsonValue; by?: SenderJson }
  /** The accepted async answer's input was durably admitted (otherwise recovered on restart). */
  answerSubmitted?: boolean
}

/** Open questions and closed receipts, by the call that asked them. */
export const QuestionsDoc = defineDoc<{ open: Record<string, QuestionRecord> }>({
  kind: "kndl.questions",
  version: 1,
  scope: "session",
  initial: () => ({ open: {} }),
})

export type PlanState = {
  steps: Array<{ text: string; status: "pending" | "in_progress" | "done" }>
  explanation?: string
}

/** A conversation's Plan. Rewindable, so a thread starts with the Plan as of its fork. */
export const PlanDoc = defineDoc<PlanState>({
  kind: "kndl.plan",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ steps: [] }),
})
