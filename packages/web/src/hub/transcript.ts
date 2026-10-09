// Folds a Session's event log into what the chat shows: Turns with their prompt and sender, the
// streamed text merged into blocks, and each tool call's start and end joined. A subagent (ADR
// 0014) is a card at the Agent call that started it: its events are grouped by agentId, whichever
// run they come in, so a background agent keeps filling its card after its Turn ended. A prompt
// steered into a Turn (#195) is shown where Claude read it. State changes between Turns, notes
// about the Sandbox, and a change of model (#128) become notices. A question Claude asked with
// AskUserQuestion (#193) is a block of its own, in place of its tool call, with how it closed.
//
// The fold is incremental: the store folds each batch of entries a joined Session's log grows by
// into the transcript it has, and a whole log is the same fold from an empty transcript. A batch
// costs what it touches, so a Turn streaming in doesn't cost the whole Session's length.

import type {
  AgentId,
  AgentStatus,
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
      readonly text: string
    }
  /** A queued prompt steered into the Turn (#195), where Claude read it. */
  | ({ readonly kind: "steered" } & SteeredPrompt)

/** A queued prompt a person steered into a running Turn (#195). */
export interface SteeredPrompt {
  readonly key: string
  readonly promptId: PromptId
  readonly sender: Participant
  /** As its sender wrote it. */
  readonly text: string
}

/** A question Claude asked with AskUserQuestion on the main loop (#193), and how it closed. */
export interface QuestionView {
  readonly toolCallId: ToolCallId
  readonly questions: ReadonlyArray<Question>
  /** How it closed, and who closed it from the web UI; absent while it's open. */
  readonly closed?: Pick<QuestionClosed, "outcome" | "by">
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
  /** Its text, tool calls and the messages people sent it, across all its runs. */
  readonly blocks: ReadonlyArray<Block>
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
  /** The prompt as sent, without the `[Name] ` the Hub prefixes for the model. */
  readonly prompt: string
  readonly promptId?: PromptId
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
}

/** What happened between Turns, shown as a line of its own. */
export type NoticeEvent = SessionStateChanged | SandboxNoted | ModelSwitched

export type TranscriptItem =
  | { readonly kind: "turn"; readonly key: string; readonly turn: TurnView }
  | {
      readonly kind: "notice"
      readonly key: string
      readonly at: number
      readonly event: NoticeEvent
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
  /** The Turn still running, if any: the last one without an end. */
  readonly running: TurnView | undefined
  /** The latest change of the Session's state in the log, if any. */
  readonly stateChange: SessionStateChanged | undefined
}

/**
 * A transcript as the store keeps it for a joined Session, with what folding more entries into it
 * needs. {@link foldTranscript} makes the next one; this one never changes.
 */
export interface LiveTranscript extends Transcript {
  readonly fold: TranscriptFold
}

/** Where a list of blocks is: a Turn's, by its place in the items, or a subagent's. */
type Owner = { readonly turn: number } | { readonly agent: AgentId }

/** A block's place in its list; blocks are only ever added or replaced, so it holds. */
interface Place {
  readonly owner: Owner
  readonly index: number
}

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
  blocks: Array<FoldedBlock>
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
  blocks: Array<FoldedBlock>
  stopRequests: Array<Participant>
  unread: Array<SteeredPrompt>
  end: TurnEnded | null
}

type FoldedAgent = Readonly<MutableAgent> & { readonly blocks: ReadonlyArray<FoldedBlock> }
type FoldedTurn = Readonly<MutableTurn> & {
  readonly blocks: ReadonlyArray<FoldedBlock>
  readonly stopRequests: ReadonlyArray<Participant>
  readonly unread: ReadonlyArray<SteeredPrompt>
}

/** What folding more entries into a transcript needs, besides the transcript itself. */
export interface TranscriptFold {
  /** Each item's Turn as folded, in the items' order; undefined for a notice. */
  readonly turns: ReadonlyArray<FoldedTurn | undefined>
  /** Where each Turn is in the items, by its id: the latest Turn of that id. */
  readonly turnIds: ReadonlyMap<TurnId, number>
  /** Every subagent the log has an event of, placed or not, in the order first seen. */
  readonly agents: ReadonlyMap<AgentId, FoldedAgent>
  /** Where each tool call's block is, so its end finds it, in any loop. */
  readonly tools: ReadonlyMap<ToolCallId, Place>
  /** The Agent calls that started a subagent, and the one each started: its card stands for it. */
  readonly agentCalls: ReadonlyMap<ToolCallId, AgentId>
  /** Where each question's block is: it stands for its AskUserQuestion call. */
  readonly questions: ReadonlyMap<ToolCallId, Place>
  /** The latest Turn's place in the items. */
  readonly latest: number | undefined
}

export const emptyTranscript: LiveTranscript = {
  items: [],
  agents: new Map(),
  questions: new Map(),
  agentList: [],
  running: undefined,
  stateChange: undefined,
  fold: {
    turns: [],
    turnIds: new Map(),
    agents: new Map(),
    tools: new Map(),
    agentCalls: new Map(),
    questions: new Map(),
    latest: undefined,
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
}

/**
 * One batch of entries being folded into a transcript. A Turn or subagent the batch changes is
 * copied once, the first time, and changed in place after that; the rest are shared. `finish`
 * makes views of what changed, and of the Turns and subagents whose cards show what changed.
 */
class Folding {
  readonly #from: LiveTranscript
  readonly #items: Array<TranscriptItem | undefined>
  readonly #turns: Array<FoldedTurn | undefined>
  readonly #turnIds: CopyOnWrite<TurnId, number>
  readonly #agents: CopyOnWrite<AgentId, FoldedAgent>
  readonly #tools: CopyOnWrite<ToolCallId, Place>
  readonly #agentCalls: CopyOnWrite<ToolCallId, AgentId>
  readonly #questions: CopyOnWrite<ToolCallId, Place>
  #latest: number | undefined
  #stateChange: SessionStateChanged | undefined
  #agentList: Array<AgentSummary> | undefined
  /** The Turns and subagents copied in this batch, which may change in place. */
  readonly #ownTurns = new Set<number>()
  readonly #ownAgents = new Set<AgentId>()
  /** The subagents first seen or described anew, which the Turns they prompted name. */
  readonly #described = new Set<AgentId>()
  #asked = false

  constructor(from: LiveTranscript) {
    const fold = from.fold
    this.#from = from
    this.#items = [...from.items]
    this.#turns = [...fold.turns]
    this.#turnIds = new CopyOnWrite(fold.turnIds)
    this.#agents = new CopyOnWrite(fold.agents)
    this.#tools = new CopyOnWrite(fold.tools)
    this.#agentCalls = new CopyOnWrite(fold.agentCalls)
    this.#questions = new CopyOnWrite(fold.questions)
    this.#latest = fold.latest
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

  /** The Turn at a place in the items, to change. */

  #turn(index: number): MutableTurn {
    const turn = this.#turns[index] as FoldedTurn
    if (this.#ownTurns.has(index)) return turn as MutableTurn
    const own: MutableTurn = {
      ...turn,
      blocks: [...turn.blocks],
      stopRequests: [...turn.stopRequests],
      unread: [...turn.unread],
    }
    this.#turns[index] = own
    this.#ownTurns.add(index)
    return own
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

  /** The Turn of an event, by its place in the items. */
  #turnFor(entry: SessionLogEntry, turnId: TurnId): number {
    // An event for a Turn whose start isn't in the log: show it under an unattributed Turn.
    return this.#turnIds.get(turnId) ?? this.#startTurn(entry, turnId, { _tag: "FromTerminal" }, "")
  }

  #startTurn(
    entry: SessionLogEntry,
    turnId: TurnId,
    sender: PromptSender,
    prompt: string,
    promptId?: PromptId,
  ): number {
    const index = this.#items.length
    this.#items.push(undefined)
    this.#turns.push({
      turnId,
      seq: entry.seq,
      at: entry.at,
      sender,
      prompt: displayPrompt(prompt, sender),
      ...(promptId !== undefined && { promptId }),
      blocks: [],
      stopRequests: [],
      unread: [],
      end: null,
    })
    this.#ownTurns.add(index)
    this.#turnIds.set(turnId, index)
    this.#latest = index
    return index
  }

  /** The block list an event writes to: its main-loop Turn's, or its subagent's card's. */
  #ownerFor(entry: SessionLogEntry, turnId: TurnId, agentId: AgentId | undefined): Owner {
    if (agentId === undefined) return { turn: this.#turnFor(entry, turnId) }
    this.#agentFor(agentId)
    return { agent: agentId }
  }

  /** A block list, to change. */
  #blocks(owner: Owner): Array<FoldedBlock> {
    return "turn" in owner
      ? this.#turn(owner.turn).blocks
      : (this.#agent(owner.agent) as MutableAgent).blocks
  }

  #blockAt(place: Place | undefined): FoldedBlock | undefined {
    if (!place) return undefined
    const { owner } = place
    const list =
      "turn" in owner ? this.#turns[owner.turn]?.blocks : this.#agents.get(owner.agent)?.blocks
    return list?.[place.index]
  }

  add(entry: SessionLogEntry): void {
    const event = entry.event
    switch (event._tag) {
      case "TurnStarted":
        this.#startTurn(entry, event.turnId, event.sender, event.text, event.promptId)
        break
      case "TextDelta": {
        const blocks = this.#blocks(this.#ownerFor(entry, event.turnId, event.agentId))
        const last = blocks.at(-1)
        if (last?.kind === "text") {
          blocks[blocks.length - 1] = { ...last, text: last.text + event.text }
        } else {
          blocks.push({ kind: "text", key: `text-${entry.seq}`, text: event.text })
        }
        break
      }
      case "ToolCallStarted": {
        if (this.#agentCalls.has(event.toolCallId) || this.#questions.has(event.toolCallId)) break
        const owner = this.#ownerFor(entry, event.turnId, event.agentId)
        const blocks = this.#blocks(owner)
        blocks.push({
          kind: "tool",
          key: `tool-${event.toolCallId}`,
          call: { toolCallId: event.toolCallId, tool: event.tool, input: event.input },
        })
        this.#tools.set(event.toolCallId, { owner, index: blocks.length - 1 })
        break
      }
      case "ToolCallEnded": {
        if (this.#agentCalls.has(event.toolCallId) || this.#questions.has(event.toolCallId)) break
        const ended = { outcome: event.outcome, output: event.output }
        const started = this.#tools.get(event.toolCallId)
        const block = this.#blockAt(started)
        if (started && block?.kind === "tool") {
          this.#blocks(started.owner)[started.index] = {
            ...block,
            call: { ...block.call, ...ended },
          }
        } else {
          this.#blocks(this.#ownerFor(entry, event.turnId, event.agentId)).push({
            kind: "tool",
            key: `tool-${event.toolCallId}`,
            call: { toolCallId: event.toolCallId, tool: event.tool, input: "", ...ended },
          })
        }
        break
      }
      case "TurnEnded":
        // A subagent's run ending says nothing its status doesn't.
        if (event.agentId === undefined) this.#turn(this.#turnFor(entry, event.turnId)).end = event
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
          this.#blocks(call.owner)[call.index] = card
          agent.card = call.owner
        } else {
          const owner = {
            turn:
              this.#turnIds.get(event.turnId) ?? this.#latest ?? this.#turnFor(entry, event.turnId),
          }
          this.#blocks(owner).push(card)
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
          this.#blocks(call.owner)[call.index] = block
          this.#questions.set(event.toolCallId, call)
        } else {
          const owner = { turn: this.#turnFor(entry, event.turnId) }
          const blocks = this.#blocks(owner)
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
        this.#blocks(at.owner)[at.index] = { ...block, question: { ...block.question, closed } }
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
        })
        break
      case "TurnStopRequested": {
        const latest = this.#latest
        if (latest !== undefined && this.#turns[latest]?.end === null)
          this.#turn(latest).stopRequests.push(event.by)
        break
      }
      case "PromptSteered":
        this.#turn(this.#turnFor(entry, event.turnId)).unread.push({
          key: `steered-${entry.seq}`,
          promptId: event.promptId,
          sender: event.sender,
          text: event.text,
        })
        break
      case "SteeredPromptRead": {
        // Claude read it here, after what the Turn had said and done so far.
        const index = this.#turnIds.get(event.turnId)
        if (index === undefined) break
        const unread = this.#turns[index]?.unread ?? []
        if (!unread.some((prompt) => prompt.promptId === event.promptId)) break
        const turn = this.#turn(index)
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
        this.#items.push({ kind: "notice", key: `notice-${entry.seq}`, at: entry.at, event })
        this.#turns.push(undefined)
        break
    }
  }

  finish(): LiveTranscript {
    const from = this.#from
    const agents = this.#agents.map
    // What a change shows in: a subagent's card, in the Turn or subagent it is in, and the name of
    // a subagent in the Turns it prompted.
    const changedTurns = new Set(this.#ownTurns)
    const changedAgents = new Set<AgentId>()
    const pending = [...this.#ownAgents]
    for (let agentId = pending.pop(); agentId !== undefined; agentId = pending.pop()) {
      if (changedAgents.has(agentId)) continue
      changedAgents.add(agentId)
      const card = agents.get(agentId)?.card
      if (card && "turn" in card) changedTurns.add(card.turn)
      else if (card) pending.push(card.agent)
    }
    if (this.#described.size > 0) {
      this.#turns.forEach((turn, index) => {
        if (turn?.sender._tag === "FromAgent" && this.#described.has(turn.sender.agentId))
          changedTurns.add(index)
      })
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
      const { placed: _, card: __, blocks, worktree, ...rest } = agents.get(agentId) as FoldedAgent
      const view: AgentView = {
        ...rest,
        ...(worktree && { worktree }),
        blocks: viewBlocks(blocks),
      }
      views.set(agentId, view)
      return view
    }

    const items = this.#items
    for (const index of changedTurns) {
      const turn = this.#turns[index] as FoldedTurn
      const description =
        turn.sender._tag === "FromAgent" ? agents.get(turn.sender.agentId)?.description : undefined
      items[index] = {
        kind: "turn",
        key: `turn-${turn.seq}`,
        turn: {
          turnId: turn.turnId,
          seq: turn.seq,
          at: turn.at,
          sender: turn.sender,
          ...(description !== undefined && { agentDescription: description }),
          prompt: turn.prompt,
          ...(turn.promptId !== undefined && { promptId: turn.promptId }),
          blocks: viewBlocks(turn.blocks),
          stopRequests: [...turn.stopRequests],
          unread: [...turn.unread],
          end: turn.end,
        },
      }
    }
    const shownItems = items as ReadonlyArray<TranscriptItem>

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
      items: shownItems,
      agents: shown,
      questions: asked,
      agentList: this.#agentList ?? from.agentList,
      running: runningTurn(shownItems),
      stateChange: this.#stateChange,
      fold: {
        turns: this.#turns,
        turnIds: this.#turnIds.map,
        agents,
        tools: this.#tools.map,
        agentCalls: this.#agentCalls.map,
        questions: this.#questions.map,
        latest: this.#latest,
      },
    }
  }
}

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
