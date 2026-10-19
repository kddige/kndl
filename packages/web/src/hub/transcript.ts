// Folds a Session's event log into what the chat shows: Turns with their prompt and sender, the
// streamed text merged into blocks, and each tool call's start and end joined. A subagent (ADR
// 0014) is a card at the Agent call that started it: its events are grouped by agentId, whichever
// run they come in, so a background agent keeps filling its card after its Turn ended. A prompt
// steered into a Turn (#195) is shown where Claude read it. State changes between Turns, notes
// about the Sandbox, and a change of model (#128) become notices. So does a queued prompt the Hub
// cancelled (ADR 0026), shown as cancelled. A question Claude asked with AskUserQuestion (#193) is
// a block of its own, in place of its tool call, with how it closed.
//
// The durable agent (docs/design/durable-harness.md) adds threads: each a conversation of its own,
// forked off a main-loop Turn, whose events carry its `threadId` and are folded into its own Turns,
// apart from the main loop's, which they leave running or not as they were. A prompt posted into a
// thread is shown as sent until a Turn starts from it or it is steered into the running one. Each
// conversation also has its Plan, what it has spent, and compactions, which show where they
// happened: in the Turn that ran, or between Turns. A Turn the agent resumed after a restart goes
// on from the one the restart ended.
//
// The fold is incremental: the store folds each batch of entries a joined Session's log grows by
// into the transcript it has, and a whole log is the same fold from an empty transcript. A batch
// costs what it touches, so a Turn streaming in doesn't cost the whole Session's length.

import { withoutAttachmentMarkers } from "@kndl/protocol"
import type {
  AgentId,
  AgentStatus,
  Attachment,
  AgentSummary,
  AgentWorktree,
  EventSeq,
  Participant,
  PromptId,
  PromptSender,
  Question,
  QuestionClosed,
  SessionLogEntry,
  SessionStateChanged,
  ToolCallId,
  ToolCallOutcome,
  TurnEnded,
  TurnId,
  SandboxNoted,
  ModelSwitched,
  PromptCancelled,
  CompactionEnded,
  CompactionReason,
  ConversationUsage,
  ModelName,
  Plan,
  ThinkingLevel,
  ThreadId,
  ThreadModelChanged,
} from "@kndl/protocol"

export interface ToolCallView {
  readonly toolCallId: ToolCallId
  readonly tool: string
  /** The input as JSON, clipped by the mod; "" if only the end was seen. */
  readonly input: string
  /** Absent while the tool runs. */
  readonly outcome?: ToolCallOutcome
  readonly output?: string
}

export type Block =
  | { readonly kind: "text"; readonly key: string; readonly text: string }
  | { readonly kind: "tool"; readonly key: string; readonly call: ToolCallView }
  | { readonly kind: "agent"; readonly key: string; readonly agent: AgentView }
  | { readonly kind: "question"; readonly key: string; readonly question: QuestionView }
  /** A person's message to the agent whose blocks these are. */
  | {
      readonly kind: "message"
      readonly key: string
      readonly sender: Participant
      /** As typed; empty for a message of files alone. */
      readonly text: string
      /** The files it carried (#278). */
      readonly attachments?: ReadonlyArray<Attachment>
    }
  /** A queued prompt steered into the Turn (#195), where Claude read it. */
  | ({ readonly kind: "steered" } & SteeredPrompt)
  /** The agent summarized older messages while the Turn ran, where it started to. */
  | { readonly kind: "compaction"; readonly key: string; readonly compaction: CompactionView }
  /**
   * The agent changed its Plan here, in place of its `update_plan` call: the Plan as it is now,
   * and as it was before, if it had one.
   */
  | {
      readonly kind: "plan"
      readonly key: string
      readonly plan: Plan
      readonly previous?: Plan
    }

/** A queued prompt a person steered into a running Turn (#195), or posted into a busy thread. */
export interface SteeredPrompt {
  readonly key: string
  readonly promptId: PromptId
  readonly sender: Participant
  /** As its sender wrote it; empty for a prompt of files alone. */
  readonly text: string
  /** The files it carried (#278). */
  readonly attachments?: ReadonlyArray<Attachment>
}

/**
 * A prompt posted into a thread that the agent hasn't taken up yet: shown as sent until a Turn
 * starts from it, or it is steered into the running one.
 */
export interface SentPrompt extends SteeredPrompt {
  readonly at: number
}

/** A question Claude asked with AskUserQuestion on the main loop (#193), and how it closed. */
export interface QuestionView {
  readonly toolCallId: ToolCallId
  readonly questions: ReadonlyArray<Question>
  /** How it closed, and who closed it from the web UI; absent while it's open. */
  readonly closed?: Pick<QuestionClosed, "outcome" | "by">
}

/** A summary of a conversation's older messages, from its start to how it ended. */
export interface CompactionView {
  readonly at: number
  readonly reason: CompactionReason
  /** Who asked for it, for one asked for from the web. */
  readonly by?: Participant
  /** How it ended; absent while it runs. */
  readonly end?: Pick<CompactionEnded, "outcome" | "summary" | "error">
}

/** A subagent, as AgentStarted described it, with its status and everything it said and did. */
export interface AgentView {
  readonly agentId: AgentId
  /** Its subagent type, such as `general-purpose`. */
  readonly agentType: string
  readonly description: string
  readonly model: string
  readonly background: boolean
  readonly status: AgentStatus
  readonly worktree?: AgentWorktree
  /** The thread whose Turn started it; absent for the main loop's. */
  readonly threadId?: ThreadId
  /** Its text, tool calls and the messages people sent it, across all its runs. */
  readonly blocks: ReadonlyArray<Block>
  /** Its latest Plan, if it keeps one. */
  readonly plan?: Plan
  /** What it has spent, as the agent last said. */
  readonly usage?: ConversationUsage
}

export interface TurnView {
  readonly turnId: TurnId
  /** The `seq` the Turn started at. */
  readonly seq: EventSeq
  readonly at: number
  readonly sender: PromptSender
  /**
   * For a Turn from an agent, the agent's description. Absent for a task the Session started no
   * agent for, as Claude Code notifies a background command's end the same way.
   */
  readonly agentDescription?: string
  /**
   * The prompt as sent, without the `[Name] ` the Hub prefixes for the model, or the markers of its
   * files.
   */
  readonly prompt: string
  readonly promptId?: PromptId
  /** The files the prompt carried (#276), which the Turn shows. */
  readonly attachments?: ReadonlyArray<Attachment>
  /** The main loop's text and tool calls, with each subagent at its Agent call. */
  readonly blocks: ReadonlyArray<Block>
  /** Who asked to stop this Turn, in order. */
  readonly stopRequests: ReadonlyArray<Participant>
  /**
   * The prompts steered into it that Claude hasn't read yet: it reads them at its next step. One
   * a Turn ends without reading stays in the conversation, and Claude reads it with the next
   * prompt, as Claude Code does.
   */
  readonly unread: ReadonlyArray<SteeredPrompt>
  /** How the Turn ended; null while it runs. */
  readonly end: TurnEnded | null
  /**
   * Whether the agent picked this Turn's run up again after a restart, as the next Turn, `Resumed`
   * (docs/design/durable-harness.md): its end was the restart, not a stop.
   */
  readonly continued?: true
}

/** What happened between Turns, shown as a line of its own. */
export type NoticeEvent = SessionStateChanged | SandboxNoted | ModelSwitched | ThreadModelChanged

export type TranscriptItem =
  | { readonly kind: "turn"; readonly key: string; readonly turn: TurnView }
  | {
      readonly kind: "notice"
      readonly key: string
      readonly at: number
      readonly event: NoticeEvent
    }
  /** A queued prompt the Hub took out of the queue without it running (ADR 0026). */
  | {
      readonly kind: "cancelled"
      readonly key: string
      readonly at: number
      readonly event: PromptCancelled
    }
  /** The agent summarized older messages between Turns. */
  | { readonly kind: "compaction"; readonly key: string; readonly compaction: CompactionView }

/**
 * A thread (docs/design/durable-harness.md): a conversation forked off the main loop at one of
 * its Turns, with Turns of its own, which runs beside the main loop and every other thread.
 */
export interface ThreadView {
  readonly threadId: ThreadId
  /** The start of its first prompt. */
  readonly title: string
  /** The main loop's Turn it forked off, at that Turn's answer. */
  readonly anchorTurnId: TurnId
  readonly startedBy: Participant
  /** When it was started. */
  readonly at: number
  /** The model it runs on, when not the Session's. */
  readonly model?: ModelName
  readonly thinkingLevel?: ThinkingLevel
  /** Its Turns, and what happened between them. */
  readonly items: ReadonlyArray<TranscriptItem>
  /** The prompts posted into it that no Turn took up yet, oldest first. */
  readonly sent: ReadonlyArray<SentPrompt>
  /** Its Turn still running, if any. */
  readonly running: TurnView | undefined
  /** Its latest Plan, if any. */
  readonly plan?: Plan
  /** What it has spent, as the agent last said. */
  readonly usage?: ConversationUsage
  /** Who posted into it, in the order each first did. */
  readonly people: ReadonlyArray<Participant>
  /** How many messages it has: the prompts posted into it, and the answers to them. */
  readonly replies: number
  /** When anything last happened in it. */
  readonly lastAt: number
}

export interface Transcript {
  readonly items: ReadonlyArray<TranscriptItem>
  /** The Session's subagents, by agentId, in the order they started. */
  readonly agents: ReadonlyMap<AgentId, AgentView>
  /** The questions Claude asked (#193), by their AskUserQuestion call. */
  readonly questions: ReadonlyMap<ToolCallId, QuestionView>
  /**
   * The Session's subagents in the order they started, with their status: for a list that needs
   * no more, such as the sidebar's.
   */
  readonly agentList: ReadonlyArray<AgentSummary>
  /** The main loop's Turn still running, if any: its last one without an end. */
  readonly running: TurnView | undefined
  /** The latest change of the Session's state in the log, if any. */
  readonly stateChange: SessionStateChanged | undefined
  /** The Session's threads, by id, in the order they started. */
  readonly threads: ReadonlyMap<ThreadId, ThreadView>
  /** The threads off each main-loop Turn, by the Turn's id, in the order they started. */
  readonly anchored: ReadonlyMap<TurnId, ReadonlyArray<ThreadView>>
  /** The main loop's latest Plan, if any. */
  readonly plan: Plan | undefined
  /** What the main loop has spent, as the agent last said. */
  readonly usage: ConversationUsage | undefined
}

/**
 * A transcript as the store keeps it for a joined Session, with what folding more entries into it
 * needs. {@link foldTranscript} makes the next one; this one never changes.
 */
export interface LiveTranscript extends Transcript {
  readonly fold: TranscriptFold
}

/**
 * Where a list of blocks is: a Turn's, by its place in its conversation's items (the main loop's,
 * or a thread's), or a subagent's.
 */
type Owner = { readonly turn: number; readonly thread?: ThreadId } | { readonly agent: AgentId }

/** A block's place in its list; blocks are only ever added or replaced, so it holds. */
interface Place {
  readonly owner: Owner
  readonly index: number
}

/** Where a compaction is shown: as a block of a Turn or subagent, or as an item of its own. */
type Spot = { readonly place: Place } | { readonly item: number; readonly thread?: ThreadId }

/** A block as folded: a subagent's card names it, and gets its view when the Turn is shown. */
type FoldedBlock =
  | Exclude<Block, { readonly kind: "agent" }>
  | { readonly kind: "agent"; readonly key: string; readonly agentId: AgentId }

interface MutableAgent {
  agentId: AgentId
  agentType: string
  description: string
  model: string
  background: boolean
  status: AgentStatus
  worktree?: AgentWorktree
  threadId?: ThreadId
  blocks: Array<FoldedBlock>
  plan?: Plan
  usage?: ConversationUsage
  /** Whether AgentStarted placed it; its events before that wait in its blocks. */
  placed: boolean
  /** Whose blocks its card is in, once placed. */
  card?: Owner
}

interface MutableTurn {
  turnId: TurnId
  seq: EventSeq
  at: number
  sender: PromptSender
  prompt: string
  promptId?: PromptId
  attachments?: ReadonlyArray<Attachment>
  blocks: Array<FoldedBlock>
  stopRequests: Array<Participant>
  unread: Array<SteeredPrompt>
  end: TurnEnded | null
  continued?: true
}

type FoldedAgent = Readonly<MutableAgent> & { readonly blocks: ReadonlyArray<FoldedBlock> }
type FoldedTurn = Readonly<MutableTurn> & {
  readonly blocks: ReadonlyArray<FoldedBlock>
  readonly stopRequests: ReadonlyArray<Participant>
  readonly unread: ReadonlyArray<SteeredPrompt>
}

/** One conversation's Turns as folded: the main loop's, or a thread's. */
interface ConversationFold {
  /** Its items as shown. */
  readonly items: ReadonlyArray<TranscriptItem>
  /** Each item's Turn as folded, in the items' order; undefined for any other item. */
  readonly turns: ReadonlyArray<FoldedTurn | undefined>
  /** Where each Turn is in the items, by its id: the latest Turn of that id. */
  readonly turnIds: ReadonlyMap<TurnId, number>
  /** The latest Turn's place in the items. */
  readonly latest: number | undefined
  /** Its latest Plan. */
  readonly plan: Plan | undefined
  /** What it has spent. */
  readonly usage: ConversationUsage | undefined
}

const emptyConversation: ConversationFold = {
  items: [],
  turns: [],
  turnIds: new Map(),
  latest: undefined,
  plan: undefined,
  usage: undefined,
}

/** A thread as folded: what ThreadStarted and the prompts posted into it said, and its Turns. */
interface FoldedThread {
  readonly threadId: ThreadId
  readonly title: string
  readonly anchorTurnId: TurnId
  readonly startedBy: Participant
  readonly at: number
  readonly model?: ModelName
  readonly thinkingLevel?: ThinkingLevel
  readonly sent: ReadonlyArray<SentPrompt>
  readonly people: ReadonlyArray<Participant>
  readonly replies: number
  readonly lastAt: number
  readonly conversation: ConversationFold
}

type MutableThread = {
  -readonly [Key in keyof Omit<FoldedThread, "sent" | "people" | "conversation">]: FoldedThread[Key]
} & { sent: Array<SentPrompt>; people: Array<Participant> }

/** What folding more entries into a transcript needs, besides the transcript itself. */
export interface TranscriptFold {
  /** The main loop's Turns. */
  readonly main: ConversationFold
  /** Every thread the log has an event of, in the order first seen. */
  readonly threads: ReadonlyMap<ThreadId, FoldedThread>
  /** Every subagent the log has an event of, placed or not, in the order first seen. */
  readonly agents: ReadonlyMap<AgentId, FoldedAgent>
  /** Where each tool call's block is, so its end finds it, in any loop. */
  readonly tools: ReadonlyMap<ToolCallId, Place>
  /** The Agent calls that started a subagent, and the one each started: its card stands for it. */
  readonly agentCalls: ReadonlyMap<ToolCallId, AgentId>
  /** Where each question's block is: it stands for its AskUserQuestion call. */
  readonly questions: ReadonlyMap<ToolCallId, Place>
  /** The `update_plan` calls a Plan's block took the place of. */
  readonly planCalls: ReadonlySet<ToolCallId>
  /** Where each conversation's compaction still running is, by {@link conversationKey}. */
  readonly compactions: ReadonlyMap<string, Spot>
}

export const emptyTranscript: LiveTranscript = {
  items: [],
  agents: new Map(),
  questions: new Map(),
  agentList: [],
  running: undefined,
  stateChange: undefined,
  threads: new Map(),
  anchored: new Map(),
  plan: undefined,
  usage: undefined,
  fold: {
    main: emptyConversation,
    threads: new Map(),
    agents: new Map(),
    tools: new Map(),
    agentCalls: new Map(),
    questions: new Map(),
    planCalls: new Set(),
    compactions: new Map(),
  },
}

/** The transcript of a whole log: its entries folded into an empty one. */
export function buildTranscript(log: ReadonlyArray<SessionLogEntry>): Transcript {
  const { fold: _, ...transcript } = foldTranscript(emptyTranscript, log)
  return transcript
}

/**
 * Folds entries that follow the transcript's into it, in `seq` order, as the store does with each
 * batch a joined Session's log grows by. Whatever the batches, the result is what
 * {@link buildTranscript} makes of the whole log. Its cost is that of the new entries and the Turns
 * and subagents they touch, not the log's length: every Turn they leave alone, and its blocks, is
 * the same object as before, so a memoized view of it doesn't render again.
 */
export function foldTranscript(
  live: LiveTranscript,
  entries: ReadonlyArray<SessionLogEntry>,
): LiveTranscript {
  if (entries.length === 0) return live
  const folding = new Folding(live)
  for (const entry of entries) folding.add(entry)
  return folding.finish()
}

/** The conversation an event is of: a subagent's, a thread's, or the main loop's. */
function conversationKey(of: { readonly threadId?: ThreadId; readonly agentId?: AgentId }): string {
  if (of.agentId !== undefined) return `agent:${of.agentId}`
  if (of.threadId !== undefined) return `thread:${of.threadId}`
  return "main"
}

/** Whether a tool call is the agent's Plan tool, whose call the Plan's block takes the place of. */
const isPlanTool = (tool: string): boolean => /^update_?plan$/i.test(tool)

/** A map copied on its first change, so the fold it came from stays as it was. */
class CopyOnWrite<K, V> {
  #map: ReadonlyMap<K, V>
  #copied = false
  constructor(map: ReadonlyMap<K, V>) {
    this.#map = map
  }
  get map(): ReadonlyMap<K, V> {
    return this.#map
  }
  get(key: K): V | undefined {
    return this.#map.get(key)
  }
  has(key: K): boolean {
    return this.#map.has(key)
  }
  set(key: K, value: V): void {
    if (!this.#copied) {
      this.#map = new Map(this.#map)
      this.#copied = true
    }
    ;(this.#map as Map<K, V>).set(key, value)
  }
  delete(key: K): void {
    if (!this.#map.has(key)) return
    if (!this.#copied) {
      this.#map = new Map(this.#map)
      this.#copied = true
    }
    ;(this.#map as Map<K, V>).delete(key)
  }
}

/**
 * One conversation's Turns in a batch being folded: the main loop's, or a thread's. A Turn the
 * batch changes is copied once, the first time, and changed in place after that; the rest are
 * shared.
 */
class Conversation {
  readonly from: ConversationFold
  readonly items: Array<TranscriptItem | undefined>
  readonly turns: Array<FoldedTurn | undefined>
  readonly turnIds: CopyOnWrite<TurnId, number>
  latest: number | undefined
  plan: Plan | undefined
  usage: ConversationUsage | undefined
  /** The Turns copied in this batch, which may change in place. */
  readonly own = new Set<number>()
  /** Whether anything but its Turns changed: an item added, its Plan or what it spent. */
  touched = false

  constructor(from: ConversationFold) {
    this.from = from
    this.items = [...from.items]
    this.turns = [...from.turns]
    this.turnIds = new CopyOnWrite(from.turnIds)
    this.latest = from.latest
    this.plan = from.plan
    this.usage = from.usage
  }

  /** The Turn at a place in the items, to change. */
  turn(index: number): MutableTurn {
    const turn = this.turns[index] as FoldedTurn
    if (this.own.has(index)) return turn as MutableTurn
    const own: MutableTurn = {
      ...turn,
      blocks: [...turn.blocks],
      stopRequests: [...turn.stopRequests],
      unread: [...turn.unread],
    }
    this.turns[index] = own
    this.own.add(index)
    return own
  }

  /** The Turn still running, by its place: the latest, while it has no end. */
  get running(): number | undefined {
    const latest = this.latest
    return latest !== undefined && this.turns[latest]?.end === null ? latest : undefined
  }

  startTurn(entry: SessionLogEntry, turn: Omit<MutableTurn, "seq" | "at">): number {
    const index = this.items.length
    this.items.push(undefined)
    this.turns.push({ ...turn, seq: entry.seq, at: entry.at })
    this.own.add(index)
    this.turnIds.set(turn.turnId, index)
    this.latest = index
    return index
  }

  push(item: TranscriptItem): number {
    this.items.push(item)
    this.turns.push(undefined)
    this.touched = true
    return this.items.length - 1
  }

  /** Whether anything in it changed in this batch. */
  get changed(): boolean {
    return this.touched || this.own.size > 0
  }

  /** Its fold, with a view made of each Turn in `changed`. */
  finish(
    changed: ReadonlySet<number>,
    view: (turn: FoldedTurn) => TurnView,
  ): ConversationFold {
    if (!this.changed && changed.size === 0) return this.from
    for (const index of changed) {
      const turn = this.turns[index] as FoldedTurn
      this.items[index] = { kind: "turn", key: `turn-${turn.seq}`, turn: view(turn) }
    }
    return {
      items: this.items as ReadonlyArray<TranscriptItem>,
      turns: this.turns,
      turnIds: this.turnIds.map,
      latest: this.latest,
      plan: this.plan,
      usage: this.usage,
    }
  }
}

/**
 * One batch of entries being folded into a transcript. A Turn, thread or subagent the batch
 * changes is copied once, the first time, and changed in place after that; the rest are shared.
 * `finish` makes views of what changed, and of the Turns and subagents whose cards show what
 * changed.
 */
class Folding {
  readonly #from: LiveTranscript
  readonly #main: Conversation
  readonly #threads: CopyOnWrite<ThreadId, FoldedThread>
  readonly #agents: CopyOnWrite<AgentId, FoldedAgent>
  readonly #tools: CopyOnWrite<ToolCallId, Place>
  readonly #agentCalls: CopyOnWrite<ToolCallId, AgentId>
  readonly #questions: CopyOnWrite<ToolCallId, Place>
  readonly #compactions: CopyOnWrite<string, Spot>
  #planCalls: Set<ToolCallId> | undefined
  #stateChange: SessionStateChanged | undefined
  #agentList: Array<AgentSummary> | undefined
  /** The threads changed in this batch: what they say of themselves, and their Turns. */
  readonly #ownThreads = new Map<ThreadId, MutableThread>()
  readonly #conversations = new Map<ThreadId, Conversation>()
  /** The subagents copied in this batch, which may change in place. */
  readonly #ownAgents = new Set<AgentId>()
  /** The subagents first seen or described anew, which the Turns they prompted name. */
  readonly #described = new Set<AgentId>()
  #asked = false

  constructor(from: LiveTranscript) {
    const fold = from.fold
    this.#from = from
    this.#main = new Conversation(fold.main)
    this.#threads = new CopyOnWrite(fold.threads)
    this.#agents = new CopyOnWrite(fold.agents)
    this.#tools = new CopyOnWrite(fold.tools)
    this.#agentCalls = new CopyOnWrite(fold.agentCalls)
    this.#questions = new CopyOnWrite(fold.questions)
    this.#compactions = new CopyOnWrite(fold.compactions)
    this.#stateChange = from.stateChange
  }

  /** Adds a subagent to the list, or changes it there, by what `update` makes of it. */
  #list(
    agentId: AgentId,
    update: (listed: AgentSummary | undefined) => AgentSummary | undefined,
  ): void {
    const list = this.#agentList ?? this.#from.agentList
    const at = list.findIndex((listed) => listed.id === agentId)
    const next = update(list[at])
    if (next === undefined || next === list[at]) return
    this.#agentList ??= [...list]
    if (at === -1) this.#agentList.push(next)
    else this.#agentList[at] = next
  }

  /**
   * A thread, to change. One not started yet in the log, whose events came first, is shown with
   * what they say until ThreadStarted says the rest.
   */
  #thread(entry: SessionLogEntry, threadId: ThreadId): MutableThread {
    const own = this.#ownThreads.get(threadId)
    if (own) {
      if (entry !== syntheticEntry) own.lastAt = entry.at
      return own
    }
    const folded = this.#threads.get(threadId)
    const thread: MutableThread = folded
      ? { ...folded, sent: [...folded.sent], people: [...folded.people] }
      : {
          threadId,
          title: "Thread",
          anchorTurnId: "" as TurnId,
          startedBy: { id: "", login: "", name: "Someone" } as Participant,
          at: entry.at,
          sent: [],
          people: [],
          replies: 0,
          lastAt: entry.at,
        }
    this.#ownThreads.set(threadId, thread)
    if (entry !== syntheticEntry) thread.lastAt = entry.at
    return thread
  }

  /** The conversation of an event: a thread's, which it names, or the main loop's. */
  #conversation(entry: SessionLogEntry, threadId: ThreadId | undefined): Conversation {
    if (threadId === undefined) return this.#main
    this.#thread(entry, threadId)
    const open = this.#conversations.get(threadId)
    if (open) return open
    const conversation = new Conversation(
      this.#threads.get(threadId)?.conversation ?? emptyConversation,
    )
    this.#conversations.set(threadId, conversation)
    return conversation
  }

  /** A conversation already open in this batch, or folded before it, without changing it. */
  #turnsOf(threadId: ThreadId | undefined): ReadonlyArray<FoldedTurn | undefined> | undefined {
    if (threadId === undefined) return this.#main.turns
    return (
      this.#conversations.get(threadId)?.turns ?? this.#threads.get(threadId)?.conversation.turns
    )
  }

  /** A subagent already seen, to change. */
  #agent(agentId: AgentId): MutableAgent | undefined {
    const agent = this.#agents.get(agentId)
    if (!agent || this.#ownAgents.has(agentId)) return agent as MutableAgent | undefined
    const own: MutableAgent = { ...agent, blocks: [...agent.blocks] }
    this.#agents.set(agentId, own)
    this.#ownAgents.add(agentId)
    return own
  }

  /**
   * The subagent, by agentId, to change. One not started yet collects its events until
   * AgentStarted says what it is; one that never starts is none the Session asked for, and isn't
   * shown.
   */
  #agentFor(agentId: AgentId): MutableAgent {
    const existing = this.#agent(agentId)
    if (existing) return existing
    const agent: MutableAgent = {
      agentId,
      agentType: "",
      description: "",
      model: "",
      background: false,
      status: "Running",
      blocks: [],
      placed: false,
    }
    this.#agents.set(agentId, agent)
    this.#ownAgents.add(agentId)
    this.#described.add(agentId)
    return agent
  }

  /** The Turn of an event in its conversation, by its place in the items. */
  #turnFor(entry: SessionLogEntry, turnId: TurnId, threadId?: ThreadId): number {
    const conversation = this.#conversation(entry, threadId)
    // An event for a Turn whose start isn't in the log: show it under an unattributed Turn.
    return (
      conversation.turnIds.get(turnId) ??
      this.#startTurn(entry, conversation, turnId, { _tag: "FromTerminal" }, "")
    )
  }

  #startTurn(
    entry: SessionLogEntry,
    conversation: Conversation,
    turnId: TurnId,
    sender: PromptSender,
    prompt: string,
    promptId?: PromptId,
    attachments?: ReadonlyArray<Attachment>,
  ): number {
    // A run picked up again after a restart goes on from the Turn the restart ended.
    if (sender._tag === "Resumed" && conversation.latest !== undefined) {
      const previous = conversation.turns[conversation.latest]
      if (previous && previous.end !== null) conversation.turn(conversation.latest).continued = true
    }
    return conversation.startTurn(entry, {
      turnId,
      sender,
      prompt: withoutAttachmentMarkers(displayPrompt(prompt, sender), attachments ?? []),
      ...(promptId !== undefined && { promptId }),
      ...(attachments !== undefined && { attachments }),
      blocks: [],
      stopRequests: [],
      unread: [],
      end: null,
    })
  }

  /** The block list an event writes to: its Turn's, in its conversation, or its subagent's. */
  #ownerFor(
    entry: SessionLogEntry,
    turnId: TurnId,
    agentId: AgentId | undefined,
    threadId: ThreadId | undefined,
  ): Owner {
    if (agentId !== undefined) {
      this.#agentFor(agentId)
      return { agent: agentId }
    }
    const turn = this.#turnFor(entry, turnId, threadId)
    return threadId === undefined ? { turn } : { turn, thread: threadId }
  }

  /** A block list, to change. */
  #blocks(owner: Owner, entry?: SessionLogEntry): Array<FoldedBlock> {
    if ("agent" in owner) return (this.#agent(owner.agent) as MutableAgent).blocks
    const conversation =
      owner.thread === undefined
        ? this.#main
        : this.#conversation(entry ?? syntheticEntry, owner.thread)
    return conversation.turn(owner.turn).blocks
  }

  #blockAt(place: Place | undefined): FoldedBlock | undefined {
    if (!place) return undefined
    const { owner } = place
    const list =
      "agent" in owner
        ? this.#agents.get(owner.agent)?.blocks
        : this.#turnsOf(owner.thread)?.[owner.turn]?.blocks
    return list?.[place.index]
  }

  /**
   * Where something of a conversation that happens now goes: its subagent's blocks, the blocks
   * of its Turn that runs, or, between Turns, none (an item of its own).
   */
  #runningOwner(
    entry: SessionLogEntry,
    of: { readonly threadId?: ThreadId; readonly agentId?: AgentId },
  ): Owner | undefined {
    if (of.agentId !== undefined) {
      this.#agentFor(of.agentId)
      return { agent: of.agentId }
    }
    const running = this.#conversation(entry, of.threadId).running
    if (running === undefined) return undefined
    return of.threadId === undefined ? { turn: running } : { turn: running, thread: of.threadId }
  }

  add(entry: SessionLogEntry): void {
    const event = entry.event
    switch (event._tag) {
      case "TurnStarted": {
        const conversation = this.#conversation(entry, event.threadId)
        this.#startTurn(
          entry,
          conversation,
          event.turnId,
          event.sender,
          event.text,
          event.promptId,
          event.attachments,
        )
        if (event.threadId !== undefined) {
          const thread = this.#thread(entry, event.threadId)
          // The prompt it was sent as is shown as this Turn now.
          if (event.promptId !== undefined) dropSent(thread, event.promptId)
          if (event.sender._tag !== "Resumed") thread.replies++
        }
        break
      }
      case "TextDelta": {
        const owner = this.#ownerFor(entry, event.turnId, event.agentId, event.threadId)
        const blocks = this.#blocks(owner, entry)
        const last = blocks.at(-1)
        if (last?.kind === "text") {
          blocks[blocks.length - 1] = { ...last, text: last.text + event.text }
        } else {
          blocks.push({ kind: "text", key: `text-${entry.seq}`, text: event.text })
        }
        break
      }
      case "ToolCallStarted": {
        if (
          this.#agentCalls.has(event.toolCallId) ||
          this.#questions.has(event.toolCallId) ||
          this.#isPlanCall(event.toolCallId)
        )
          break
        const owner = this.#ownerFor(entry, event.turnId, event.agentId, event.threadId)
        const blocks = this.#blocks(owner, entry)
        blocks.push({
          kind: "tool",
          key: `tool-${event.toolCallId}`,
          call: { toolCallId: event.toolCallId, tool: event.tool, input: event.input },
        })
        this.#tools.set(event.toolCallId, { owner, index: blocks.length - 1 })
        break
      }
      case "ToolCallEnded": {
        if (
          this.#agentCalls.has(event.toolCallId) ||
          this.#questions.has(event.toolCallId) ||
          this.#isPlanCall(event.toolCallId)
        )
          break
        const ended = { outcome: event.outcome, output: event.output }
        const started = this.#tools.get(event.toolCallId)
        const block = this.#blockAt(started)
        if (started && block?.kind === "tool") {
          this.#blocks(started.owner, entry)[started.index] = {
            ...block,
            call: { ...block.call, ...ended },
          }
        } else {
          const owner = this.#ownerFor(entry, event.turnId, event.agentId, event.threadId)
          this.#blocks(owner, entry).push({
            kind: "tool",
            key: `tool-${event.toolCallId}`,
            call: { toolCallId: event.toolCallId, tool: event.tool, input: "", ...ended },
          })
        }
        break
      }
      case "TurnEnded":
        // A subagent's run ending says nothing its status doesn't.
        if (event.agentId === undefined) {
          const conversation = this.#conversation(entry, event.threadId)
          conversation.turn(this.#turnFor(entry, event.turnId, event.threadId)).end = event
        }
        break
      case "AgentStarted": {
        this.#list(
          event.agentId,
          (listed) =>
            listed ?? { id: event.agentId, description: event.description, status: "Running" },
        )
        const agent = this.#agentFor(event.agentId)
        if (agent.description !== event.description) this.#described.add(event.agentId)
        agent.agentType = event.agentType
        agent.description = event.description
        agent.model = event.model
        agent.background = event.background
        if (event.threadId !== undefined) agent.threadId = event.threadId
        if (agent.placed) break
        agent.placed = true
        this.#agentCalls.set(event.toolCallId, event.agentId)
        const card: FoldedBlock = {
          kind: "agent",
          key: `agent-${event.agentId}`,
          agentId: event.agentId,
        }
        // In place of its Agent call; if that wasn't seen, at the end of the Turn that started it.
        const call = this.#tools.get(event.toolCallId)
        if (call && this.#blockAt(call)?.kind === "tool") {
          this.#blocks(call.owner, entry)[call.index] = card
          agent.card = call.owner
        } else {
          const conversation = this.#conversation(entry, event.threadId)
          const turn =
            conversation.turnIds.get(event.turnId) ??
            conversation.latest ??
            this.#turnFor(entry, event.turnId, event.threadId)
          const owner: Owner =
            event.threadId === undefined ? { turn } : { turn, thread: event.threadId }
          this.#blocks(owner, entry).push(card)
          agent.card = owner
        }
        break
      }
      case "QuestionAsked": {
        if (this.#questions.has(event.toolCallId)) break
        this.#asked = true
        const block: FoldedBlock = {
          kind: "question",
          key: `question-${event.toolCallId}`,
          question: { toolCallId: event.toolCallId, questions: event.questions },
        }
        // In place of its AskUserQuestion call, or at the end of its Turn if that wasn't seen.
        const call = this.#tools.get(event.toolCallId)
        if (call && this.#blockAt(call)?.kind === "tool") {
          this.#blocks(call.owner, entry)[call.index] = block
          this.#questions.set(event.toolCallId, call)
        } else {
          const owner = { turn: this.#turnFor(entry, event.turnId) }
          const blocks = this.#blocks(owner, entry)
          blocks.push(block)
          this.#questions.set(event.toolCallId, { owner, index: blocks.length - 1 })
        }
        break
      }
      case "QuestionClosed": {
        const at = this.#questions.get(event.toolCallId)
        const block = this.#blockAt(at)
        if (!at || block?.kind !== "question") break
        this.#asked = true
        const closed = { outcome: event.outcome, ...(event.by && { by: event.by }) }
        this.#blocks(at.owner, entry)[at.index] = {
          ...block,
          question: { ...block.question, closed },
        }
        break
      }
      case "AgentStatusChanged": {
        this.#list(event.agentId, (listed) => listed && { ...listed, status: event.status })
        const agent = this.#agent(event.agentId)
        if (!agent) break
        agent.status = event.status
        if (event.worktree) agent.worktree = event.worktree
        break
      }
      case "AgentMessaged":
        this.#agent(event.agentId)?.blocks.push({
          kind: "message",
          key: `message-${entry.seq}`,
          sender: event.sender,
          text: event.text,
          ...(event.attachments !== undefined && { attachments: event.attachments }),
        })
        break
      case "TurnStopRequested": {
        const conversation = this.#conversation(entry, event.threadId)
        const running = conversation.running
        if (running !== undefined) conversation.turn(running).stopRequests.push(event.by)
        break
      }
      case "PromptSteered": {
        const conversation = this.#conversation(entry, event.threadId)
        conversation.turn(this.#turnFor(entry, event.turnId, event.threadId)).unread.push({
          key: `steered-${entry.seq}`,
          promptId: event.promptId,
          sender: event.sender,
          text: event.text,
          ...(event.attachments !== undefined && { attachments: event.attachments }),
        })
        // A prompt posted into a busy thread is shown in its Turn now.
        if (event.threadId !== undefined)
          dropSent(this.#thread(entry, event.threadId), event.promptId)
        break
      }
      case "SteeredPromptRead": {
        // Claude read it here, after what the Turn had said and done so far.
        const conversation = this.#conversation(entry, event.threadId)
        const index = conversation.turnIds.get(event.turnId)
        if (index === undefined) break
        const unread = conversation.turns[index]?.unread ?? []
        if (!unread.some((prompt) => prompt.promptId === event.promptId)) break
        const turn = conversation.turn(index)
        const [read] = turn.unread.splice(
          turn.unread.findIndex((prompt) => prompt.promptId === event.promptId),
          1,
        )
        if (read) turn.blocks.push({ kind: "steered", ...read })
        break
      }
      case "SessionStateChanged":
      case "SandboxNoted":
      case "ModelSwitched":
        if (event._tag === "SessionStateChanged") this.#stateChange = event
        this.#main.push({ kind: "notice", key: `notice-${entry.seq}`, at: entry.at, event })
        break
      case "PromptCancelled":
        this.#main.push({ kind: "cancelled", key: `cancelled-${entry.seq}`, at: entry.at, event })
        break
      case "ThreadStarted": {
        const thread = this.#thread(entry, event.threadId)
        thread.title = event.title
        thread.anchorTurnId = event.anchorTurnId
        thread.startedBy = event.startedBy
        thread.at = entry.at
        if (event.model !== undefined) thread.model = event.model
        if (event.thinkingLevel !== undefined) thread.thinkingLevel = event.thinkingLevel
        this.#conversation(entry, event.threadId)
        break
      }
      case "ThreadPromptSent": {
        const thread = this.#thread(entry, event.threadId)
        thread.sent.push({
          key: `sent-${entry.seq}`,
          at: entry.at,
          promptId: event.promptId,
          sender: event.sender,
          text: event.text,
          ...(event.attachments !== undefined && { attachments: event.attachments }),
        })
        if (!thread.people.some((person) => person.id === event.sender.id))
          thread.people.push(event.sender)
        thread.replies++
        break
      }
      case "ThreadModelChanged": {
        const thread = this.#thread(entry, event.threadId)
        thread.model = event.model
        if (event.thinkingLevel === undefined) delete thread.thinkingLevel
        else thread.thinkingLevel = event.thinkingLevel
        this.#conversation(entry, event.threadId).push({
          kind: "notice",
          key: `notice-${entry.seq}`,
          at: entry.at,
          event,
        })
        break
      }
      case "CompactionStarted": {
        const compaction: CompactionView = {
          at: entry.at,
          reason: event.reason,
          ...(event.by !== undefined && { by: event.by }),
        }
        const key = `compaction-${entry.seq}`
        const owner = this.#runningOwner(entry, event)
        let spot: Spot
        if (owner) {
          const blocks = this.#blocks(owner, entry)
          blocks.push({ kind: "compaction", key, compaction })
          spot = { place: { owner, index: blocks.length - 1 } }
        } else {
          const item = this.#conversation(entry, event.threadId).push({
            kind: "compaction",
            key,
            compaction,
          })
          spot = event.threadId === undefined ? { item } : { item, thread: event.threadId }
        }
        this.#compactions.set(conversationKey(event), spot)
        break
      }
      case "CompactionEnded": {
        const end = {
          outcome: event.outcome,
          ...(event.summary !== undefined && { summary: event.summary }),
          ...(event.error !== undefined && { error: event.error }),
        }
        const key = conversationKey(event)
        const spot = this.#compactions.get(key)
        this.#compactions.delete(key)
        if (spot && "place" in spot) {
          const block = this.#blockAt(spot.place)
          if (block?.kind === "compaction") {
            this.#blocks(spot.place.owner, entry)[spot.place.index] = {
              ...block,
              compaction: { ...block.compaction, end },
            }
            break
          }
        } else if (spot) {
          const conversation = this.#conversation(entry, spot.thread)
          const item = conversation.items[spot.item]
          if (item?.kind === "compaction") {
            conversation.items[spot.item] = {
              ...item,
              compaction: { ...item.compaction, end },
            }
            conversation.touched = true
            break
          }
        }
        // Its start isn't in the log: shown where it ended.
        if (event.agentId !== undefined) break
        this.#conversation(entry, event.threadId).push({
          kind: "compaction",
          key: `compaction-${entry.seq}`,
          compaction: { at: entry.at, reason: "threshold", end },
        })
        break
      }
      case "PlanChanged": {
        let previous: Plan | undefined
        if (event.agentId !== undefined) {
          const agent = this.#agentFor(event.agentId)
          previous = agent.plan
          agent.plan = event.plan
        } else {
          const conversation = this.#conversation(entry, event.threadId)
          previous = conversation.plan
          conversation.plan = event.plan
          conversation.touched = true
        }
        // Marked where it changed, in place of the call that changed it; between Turns, the Plan
        // shown is all.
        const owner = this.#runningOwner(entry, event)
        if (!owner) break
        const block: FoldedBlock = {
          kind: "plan",
          key: `plan-${entry.seq}`,
          plan: event.plan,
          ...(previous !== undefined && { previous }),
        }
        const blocks = this.#blocks(owner, entry)
        const call = blocks.findLastIndex(
          (each) => each.kind === "tool" && isPlanTool(each.call.tool),
        )
        const replaced = blocks[call]
        if (replaced?.kind === "tool") {
          blocks[call] = { ...block, key: replaced.key }
          this.#planCalls ??= new Set(this.#from.fold.planCalls)
          this.#planCalls.add(replaced.call.toolCallId)
        } else {
          blocks.push(block)
        }
        break
      }
      case "UsageChanged":
        if (event.agentId !== undefined) {
          this.#agentFor(event.agentId).usage = event.usage
        } else {
          const conversation = this.#conversation(entry, event.threadId)
          conversation.usage = event.usage
          conversation.touched = true
        }
        break
    }
  }

  #isPlanCall(toolCallId: ToolCallId): boolean {
    return (this.#planCalls ?? this.#from.fold.planCalls).has(toolCallId)
  }

  finish(): LiveTranscript {
    const from = this.#from
    const agents = this.#agents.map
    // What a change shows in: a subagent's card, in the Turn or subagent it is in, and the name of
    // a subagent in the Turns it prompted.
    const changedTurns = new Map<ThreadId | undefined, Set<number>>([
      [undefined, new Set(this.#main.own)],
    ])
    for (const [threadId, conversation] of this.#conversations)
      changedTurns.set(threadId, new Set(conversation.own))
    const markTurn = (threadId: ThreadId | undefined, index: number) => {
      const set = changedTurns.get(threadId)
      if (set) set.add(index)
      else changedTurns.set(threadId, new Set([index]))
    }
    const changedAgents = new Set<AgentId>()
    const pending = [...this.#ownAgents]
    for (let agentId = pending.pop(); agentId !== undefined; agentId = pending.pop()) {
      if (changedAgents.has(agentId)) continue
      changedAgents.add(agentId)
      const card = agents.get(agentId)?.card
      if (card && "turn" in card) markTurn(card.thread, card.turn)
      else if (card) pending.push(card.agent)
    }
    if (this.#described.size > 0) {
      const named = (threadId: ThreadId | undefined) =>
        this.#turnsOf(threadId)?.forEach((turn, index) => {
          if (turn?.sender._tag === "FromAgent" && this.#described.has(turn.sender.agentId))
            markTurn(threadId, index)
        })
      named(undefined)
      for (const threadId of this.#threads.map.keys()) named(threadId)
    }

    const views = new Map<AgentId, AgentView>()
    const viewBlocks = (blocks: ReadonlyArray<FoldedBlock>): ReadonlyArray<Block> =>
      blocks.map((block) =>
        block.kind === "agent"
          ? { kind: "agent", key: block.key, agent: agentView(block.agentId) }
          : block,
      )
    const agentView = (agentId: AgentId): AgentView => {
      const done =
        views.get(agentId) ?? (changedAgents.has(agentId) ? undefined : from.agents.get(agentId))
      if (done) return done
      const {
        placed: _,
        card: __,
        blocks,
        worktree,
        threadId,
        plan,
        usage,
        ...rest
      } = agents.get(agentId) as FoldedAgent
      const view: AgentView = {
        ...rest,
        ...(worktree && { worktree }),
        ...(threadId !== undefined && { threadId }),
        blocks: viewBlocks(blocks),
        ...(plan !== undefined && { plan }),
        ...(usage !== undefined && { usage }),
      }
      views.set(agentId, view)
      return view
    }
    const turnView = (turn: FoldedTurn): TurnView => {
      const description =
        turn.sender._tag === "FromAgent" ? agents.get(turn.sender.agentId)?.description : undefined
      return {
        turnId: turn.turnId,
        seq: turn.seq,
        at: turn.at,
        sender: turn.sender,
        ...(description !== undefined && { agentDescription: description }),
        prompt: turn.prompt,
        ...(turn.promptId !== undefined && { promptId: turn.promptId }),
        ...(turn.attachments !== undefined && { attachments: turn.attachments }),
        blocks: viewBlocks(turn.blocks),
        stopRequests: [...turn.stopRequests],
        unread: [...turn.unread],
        end: turn.end,
        ...(turn.continued && { continued: true }),
      }
    }

    const main = this.#main.finish(changedTurns.get(undefined) ?? new Set(), turnView)

    // Threads whose Turns change only by a subagent's card are opened to show it.
    for (const [threadId, set] of changedTurns) {
      if (threadId === undefined || set.size === 0 || this.#conversations.has(threadId)) continue
      this.#conversation(syntheticEntry, threadId)
    }
    let threads = from.threads
    let anchored = from.anchored
    if (this.#ownThreads.size > 0) {
      const next = new Map(from.threads)
      const anchors = new Set<TurnId>()
      for (const [threadId, thread] of this.#ownThreads) {
        const conversation =
          this.#conversations.get(threadId) ??
          new Conversation(this.#threads.get(threadId)?.conversation ?? emptyConversation)
        const fold = conversation.finish(changedTurns.get(threadId) ?? new Set(), turnView)
        this.#threads.set(threadId, { ...thread, conversation: fold })
        const previous = from.threads.get(threadId)
        if (previous) anchors.add(previous.anchorTurnId)
        anchors.add(thread.anchorTurnId)
        // One whose ThreadStarted isn't in the log hangs off no Turn.
        anchors.delete("" as TurnId)
        next.set(threadId, {
          threadId,
          title: thread.title,
          anchorTurnId: thread.anchorTurnId,
          startedBy: thread.startedBy,
          at: thread.at,
          ...(thread.model !== undefined && { model: thread.model }),
          ...(thread.thinkingLevel !== undefined && { thinkingLevel: thread.thinkingLevel }),
          items: fold.items,
          sent: [...thread.sent],
          running: runningTurn(fold.items),
          ...(fold.plan !== undefined && { plan: fold.plan }),
          ...(fold.usage !== undefined && { usage: fold.usage }),
          people: [...thread.people],
          replies: thread.replies,
          lastAt: thread.lastAt,
        })
      }
      threads = next
      const nextAnchored = new Map(from.anchored)
      for (const anchor of anchors) {
        const off = [...next.values()].filter((thread) => thread.anchorTurnId === anchor)
        if (off.length === 0) nextAnchored.delete(anchor)
        else nextAnchored.set(anchor, off)
      }
      anchored = nextAnchored
    }

    let shown = from.agents
    if (changedAgents.size > 0) {
      const next = new Map<AgentId, AgentView>()
      for (const agent of agents.values())
        if (agent.placed) next.set(agent.agentId, agentView(agent.agentId))
      shown = next
    }
    let asked = from.questions
    if (this.#asked) {
      const next = new Map<ToolCallId, QuestionView>()
      for (const [toolCallId, at] of this.#questions.map) {
        const block = this.#blockAt(at)
        if (block?.kind === "question") next.set(toolCallId, block.question)
      }
      asked = next
    }
    return {
      items: main.items,
      agents: shown,
      questions: asked,
      agentList: this.#agentList ?? from.agentList,
      running: main === from.fold.main ? from.running : runningTurn(main.items),
      stateChange: this.#stateChange,
      threads,
      anchored,
      plan: main.plan,
      usage: main.usage,
      fold: {
        main,
        threads: this.#threads.map,
        agents,
        tools: this.#tools.map,
        agentCalls: this.#agentCalls.map,
        questions: this.#questions.map,
        planCalls: this.#planCalls ?? from.fold.planCalls,
        compactions: this.#compactions.map,
      },
    }
  }
}

/** Takes a prompt posted into a thread out of those shown as sent, by its id. */
function dropSent(thread: MutableThread, promptId: PromptId): void {
  const at = thread.sent.findIndex((prompt) => prompt.promptId === promptId)
  if (at !== -1) thread.sent.splice(at, 1)
}

/** Stands for an entry where a conversation is opened for no entry's sake. */
const syntheticEntry = { seq: -1, at: 0 } as unknown as SessionLogEntry

/** How many finished agents the open Session lists; the rest are in its transcript. */
const recentFinished = 3

/**
 * The open Session's agents for the sidebar: every Running and Interrupted one, the latest
 * finished ones, and the one whose view is open, in the order they started.
 */
export function recentAgents(
  agents: ReadonlyArray<AgentSummary>,
  open: string | undefined,
): ReadonlyArray<AgentSummary> {
  const finished = agents.filter((agent) => agent.status === "Done" || agent.status === "Stopped")
  const shown = new Set(finished.slice(-recentFinished))
  return agents.filter(
    (agent) => !finished.includes(agent) || shown.has(agent) || agent.id === open,
  )
}

/**
 * What a task notification says, for its Turn: Claude Code prompts the main loop with one, as XML
 * for the model, when a background agent ends or is stopped (ADR 0014). Its summary and result,
 * or the text as it is if it has neither.
 */
export function taskNotificationText(text: string): string {
  const field = (name: string) =>
    new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim() ?? ""
  const said = [field("summary"), field("result")].filter((part) => part !== "")
  return said.length > 0 ? said.join("\n\n") : text
}

/**
 * The prompt as its sender wrote it. The Hub prefixes a Participant's prompt with `[Name] `, so
 * the model knows who is talking; the chat already says who, so the prefix is dropped. A Turn
 * from an agent shows what its task notification says.
 */
export function displayPrompt(text: string, sender: PromptSender): string {
  if (sender._tag === "FromAgent") return taskNotificationText(text)
  if (sender._tag !== "FromParticipant") return text
  const { name, login } = sender.participant
  for (const label of [name, login]) {
    const prefix = `[${label}] `
    if (text.startsWith(prefix)) return text.slice(prefix.length)
  }
  return text
}

/** The Turn still running, if any: the last one without an end. */
export function runningTurn(items: ReadonlyArray<TranscriptItem>): TurnView | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]
    if (item?.kind === "turn") return item.turn.end === null ? item.turn : undefined
  }
  return undefined
}

/** A one-line summary of a tool call's input: the command, path or pattern it was given. */
export function toolSummary(input: string): string {
  try {
    const parsed: unknown = JSON.parse(input)
    if (typeof parsed === "object" && parsed !== null) {
      const fields = parsed as Record<string, unknown>
      for (const key of [
        "command",
        "file_path",
        "path",
        "pattern",
        "url",
        "description",
        "prompt",
      ]) {
        const value = fields[key]
        if (typeof value === "string" && value !== "") return value
      }
    }
  } catch {
    // Not JSON (or clipped mid-way): show it as it is.
  }
  return input
}

/** The input pretty-printed when it's whole JSON, for the expanded tool call. */
export function prettyInput(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input), null, 2)
  } catch {
    return input
  }
}
