// Folds a Session's event log into what the chat shows: Turns with their prompt and sender, the
// streamed text merged into blocks, and each tool call's start and end joined. A subagent (ADR
// 0014) is a card at the Agent call that started it: its events are grouped by agentId, whichever
// run they come in, so a background agent keeps filling its card after its Turn ended. A prompt
// steered into a Turn (#195) is shown where Claude read it. State changes between Turns, notes
// about the Sandbox, and a change of model (#128) become notices.

import type {
  AgentId,
  AgentStatus,
  AgentSummary,
  AgentWorktree,
  EventSeq,
  Participant,
  PromptId,
  PromptSender,
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
}

interface MutableAgent {
  agentId: AgentId
  agentType: string
  description: string
  model: string
  background: boolean
  status: AgentStatus
  worktree?: AgentWorktree
  blocks: Array<Block>
  /** Whether AgentStarted placed it; its events before that wait in its blocks. */
  placed: boolean
}

interface MutableTurn {
  turnId: TurnId
  seq: EventSeq
  at: number
  sender: PromptSender
  prompt: string
  promptId?: PromptId
  blocks: Array<Block>
  stopRequests: Array<Participant>
  unread: Array<SteeredPrompt>
  end: TurnEnded | null
}

export function buildTranscript(log: ReadonlyArray<SessionLogEntry>): Transcript {
  const items: Array<TranscriptItem> = []
  const turns = new Map<TurnId, MutableTurn>()
  const agents = new Map<AgentId, MutableAgent>()
  /** Where each tool call's block is, so its end finds it, in any loop. */
  const tools = new Map<ToolCallId, { list: Array<Block>; index: number }>()
  /** The Agent calls that started a subagent: its card stands for the call. */
  const agentCalls = new Set<ToolCallId>()
  let latest: MutableTurn | undefined

  const turnFor = (entry: SessionLogEntry, turnId: TurnId): MutableTurn => {
    const existing = turns.get(turnId)
    if (existing) return existing
    // An event for a Turn whose start isn't in the log: show it under an unattributed Turn.
    return startTurn(entry, turnId, { _tag: "FromTerminal" }, "")
  }

  const startTurn = (
    entry: SessionLogEntry,
    turnId: TurnId,
    sender: PromptSender,
    prompt: string,
    promptId?: PromptId,
  ): MutableTurn => {
    const turn: MutableTurn = {
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
    }
    turns.set(turnId, turn)
    latest = turn
    items.push({ kind: "turn", key: `turn-${entry.seq}`, turn: turn as TurnView })
    return turn
  }

  /**
   * The subagent, by agentId. One not started yet collects its events until AgentStarted says
   * what it is; one that never starts is none the Session asked for, and isn't shown.
   */
  const agentFor = (agentId: AgentId): MutableAgent => {
    let agent = agents.get(agentId)
    if (!agent) {
      agent = {
        agentId,
        agentType: "",
        description: "",
        model: "",
        background: false,
        status: "Running",
        blocks: [],
        placed: false,
      }
      agents.set(agentId, agent)
    }
    return agent
  }

  /** The block list an event writes to: its main-loop Turn's, or its subagent's card's. */
  const blocksFor = (
    entry: SessionLogEntry,
    turnId: TurnId,
    agentId: AgentId | undefined,
  ): Array<Block> =>
    agentId === undefined ? turnFor(entry, turnId).blocks : agentFor(agentId).blocks

  for (const entry of log) {
    const event = entry.event
    switch (event._tag) {
      case "TurnStarted":
        startTurn(entry, event.turnId, event.sender, event.text, event.promptId)
        break
      case "TextDelta": {
        const blocks = blocksFor(entry, event.turnId, event.agentId)
        const last = blocks.at(-1)
        if (last?.kind === "text") {
          blocks[blocks.length - 1] = { ...last, text: last.text + event.text }
        } else {
          blocks.push({ kind: "text", key: `text-${entry.seq}`, text: event.text })
        }
        break
      }
      case "ToolCallStarted": {
        if (agentCalls.has(event.toolCallId)) break
        const blocks = blocksFor(entry, event.turnId, event.agentId)
        blocks.push({
          kind: "tool",
          key: `tool-${event.toolCallId}`,
          call: { toolCallId: event.toolCallId, tool: event.tool, input: event.input },
        })
        tools.set(event.toolCallId, { list: blocks, index: blocks.length - 1 })
        break
      }
      case "ToolCallEnded": {
        if (agentCalls.has(event.toolCallId)) break
        const ended = { outcome: event.outcome, output: event.output }
        const started = tools.get(event.toolCallId)
        const block = started?.list[started.index]
        if (started && block?.kind === "tool") {
          started.list[started.index] = { ...block, call: { ...block.call, ...ended } }
        } else {
          blocksFor(entry, event.turnId, event.agentId).push({
            kind: "tool",
            key: `tool-${event.toolCallId}`,
            call: { toolCallId: event.toolCallId, tool: event.tool, input: "", ...ended },
          })
        }
        break
      }
      case "TurnEnded":
        // A subagent's run ending says nothing its status doesn't.
        if (event.agentId === undefined) turnFor(entry, event.turnId).end = event
        break
      case "AgentStarted": {
        const agent = agentFor(event.agentId)
        agent.agentType = event.agentType
        agent.description = event.description
        agent.model = event.model
        agent.background = event.background
        if (agent.placed) break
        agent.placed = true
        agentCalls.add(event.toolCallId)
        const card: Block = {
          kind: "agent",
          key: `agent-${event.agentId}`,
          agent: agent as AgentView,
        }
        // In place of its Agent call; if that wasn't seen, at the end of the Turn that started it.
        const call = tools.get(event.toolCallId)
        if (call && call.list[call.index]?.kind === "tool") call.list[call.index] = card
        else (turns.get(event.turnId) ?? latest ?? turnFor(entry, event.turnId)).blocks.push(card)
        break
      }
      case "AgentStatusChanged": {
        const agent = agents.get(event.agentId)
        if (!agent) break
        agent.status = event.status
        if (event.worktree) agent.worktree = event.worktree
        break
      }
      case "AgentMessaged":
        agents.get(event.agentId)?.blocks.push({
          kind: "message",
          key: `message-${entry.seq}`,
          sender: event.sender,
          text: event.text,
        })
        break
      case "TurnStopRequested":
        if (latest && latest.end === null) latest.stopRequests.push(event.by)
        break
      case "PromptSteered":
        turnFor(entry, event.turnId).unread.push({
          key: `steered-${entry.seq}`,
          promptId: event.promptId,
          sender: event.sender,
          text: event.text,
        })
        break
      case "SteeredPromptRead": {
        // Claude read it here, after what the Turn had said and done so far.
        const turn = turns.get(event.turnId)
        const index = turn?.unread.findIndex((prompt) => prompt.promptId === event.promptId) ?? -1
        const [read] = index === -1 ? [] : (turn?.unread.splice(index, 1) ?? [])
        if (turn && read) turn.blocks.push({ kind: "steered", ...read })
        break
      }
      case "SessionStateChanged":
      case "SandboxNoted":
      case "ModelSwitched":
        items.push({ kind: "notice", key: `notice-${entry.seq}`, at: entry.at, event })
        break
    }
  }

  // Hand out plain snapshots, so a later build never shares mutable state with this one. Each
  // agent is frozen once, so its card and the map hold the same view.
  const frozen = new Map<AgentId, AgentView>()
  const freezeBlocks = (blocks: ReadonlyArray<Block>): ReadonlyArray<Block> =>
    blocks.map((block) =>
      block.kind === "agent"
        ? { ...block, agent: freezeAgent(block.agent as MutableAgent) }
        : block,
    )
  const freezeAgent = (agent: MutableAgent): AgentView => {
    const done = frozen.get(agent.agentId)
    if (done) return done
    const { placed: _, blocks, worktree, ...rest } = agent
    const view: AgentView = {
      ...rest,
      ...(worktree && { worktree }),
      blocks: freezeBlocks(blocks),
    }
    frozen.set(agent.agentId, view)
    return view
  }
  const frozenItems = items.map((item): TranscriptItem => {
    if (item.kind !== "turn") return item
    const turn = item.turn as MutableTurn
    const description =
      turn.sender._tag === "FromAgent" ? agents.get(turn.sender.agentId)?.description : undefined
    return {
      ...item,
      turn: {
        turnId: turn.turnId,
        seq: turn.seq,
        at: turn.at,
        sender: turn.sender,
        ...(description !== undefined && { agentDescription: description }),
        prompt: turn.prompt,
        ...(turn.promptId !== undefined && { promptId: turn.promptId }),
        blocks: freezeBlocks(turn.blocks),
        stopRequests: [...turn.stopRequests],
        unread: [...turn.unread],
        end: turn.end,
      },
    }
  })
  const shown = new Map<AgentId, AgentView>()
  for (const agent of agents.values())
    if (agent.placed) shown.set(agent.agentId, freezeAgent(agent))
  return { items: frozenItems, agents: shown }
}

/**
 * The Session's subagents from its event log, in the order they started, with their status: for
 * a list that needs no more, such as the sidebar's.
 */
export function agentsOf(log: ReadonlyArray<SessionLogEntry>): ReadonlyArray<AgentSummary> {
  const agents = new Map<AgentId, AgentSummary>()
  for (const { event } of log) {
    if (event._tag === "AgentStarted" && !agents.has(event.agentId)) {
      agents.set(event.agentId, {
        id: event.agentId,
        description: event.description,
        status: "Running",
      })
    } else if (event._tag === "AgentStatusChanged") {
      const agent = agents.get(event.agentId)
      if (agent) agents.set(event.agentId, { ...agent, status: event.status })
    }
  }
  return [...agents.values()]
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
