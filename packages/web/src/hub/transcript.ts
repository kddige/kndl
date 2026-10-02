// Folds a Session's event log into what the chat shows: Turns with their prompt and sender, the
// streamed text merged into blocks, each tool call's start and end joined, and a subagent's events
// grouped under its agentId. State changes between Turns become notices.

import type {
  AgentId,
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
} from "@claude-hub/protocol"

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

export interface AgentView {
  readonly agentId: AgentId
  readonly blocks: ReadonlyArray<Block>
  /** How the subagent's loop ended; null while it runs. */
  readonly end: TurnEnded | null
}

export type TurnBlock =
  | Block
  | { readonly kind: "agent"; readonly key: string; readonly agent: AgentView }

export interface TurnView {
  readonly turnId: TurnId
  /** The `seq` the Turn started at. */
  readonly seq: EventSeq
  readonly at: number
  readonly sender: PromptSender
  /** The prompt as sent, without the `[Name] ` the Hub prefixes for the model. */
  readonly prompt: string
  readonly promptId?: PromptId
  /** The main loop's text and tool calls, with subagents where they first spoke. */
  readonly blocks: ReadonlyArray<TurnBlock>
  /** Who asked to stop this Turn, in order. */
  readonly stopRequests: ReadonlyArray<Participant>
  /** How the Turn ended; null while it runs. */
  readonly end: TurnEnded | null
}

export type TranscriptItem =
  | { readonly kind: "turn"; readonly key: string; readonly turn: TurnView }
  | {
      readonly kind: "notice"
      readonly key: string
      readonly at: number
      readonly event: SessionStateChanged
    }

interface MutableAgent {
  agentId: AgentId
  blocks: Array<Block>
  end: TurnEnded | null
}

interface MutableTurn {
  turnId: TurnId
  seq: EventSeq
  at: number
  sender: PromptSender
  prompt: string
  promptId?: PromptId
  blocks: Array<TurnBlock>
  agents: Map<AgentId, MutableAgent>
  tools: Map<ToolCallId, { list: Array<Block>; index: number }>
  stopRequests: Array<Participant>
  end: TurnEnded | null
}

export function buildTranscript(
  log: ReadonlyArray<SessionLogEntry>,
): ReadonlyArray<TranscriptItem> {
  const items: Array<TranscriptItem> = []
  const turns = new Map<TurnId, MutableTurn>()
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
      agents: new Map(),
      tools: new Map(),
      stopRequests: [],
      end: null,
    }
    turns.set(turnId, turn)
    latest = turn
    items.push({ kind: "turn", key: `turn-${entry.seq}`, turn: turn as TurnView })
    return turn
  }

  /** The block list an event writes to: the main loop's, or its subagent's. */
  const blocksFor = (turn: MutableTurn, agentId: AgentId | undefined): Array<Block | TurnBlock> => {
    if (agentId === undefined) return turn.blocks
    let agent = turn.agents.get(agentId)
    if (!agent) {
      agent = { agentId, blocks: [], end: null }
      turn.agents.set(agentId, agent)
      turn.blocks.push({ kind: "agent", key: `agent-${agentId}`, agent })
    }
    return agent.blocks
  }

  for (const entry of log) {
    const event = entry.event
    switch (event._tag) {
      case "TurnStarted":
        startTurn(entry, event.turnId, event.sender, event.text, event.promptId)
        break
      case "TextDelta": {
        const blocks = blocksFor(turnFor(entry, event.turnId), event.agentId)
        const last = blocks.at(-1)
        if (last?.kind === "text") {
          blocks[blocks.length - 1] = { ...last, text: last.text + event.text }
        } else {
          blocks.push({ kind: "text", key: `text-${entry.seq}`, text: event.text })
        }
        break
      }
      case "ToolCallStarted": {
        const turn = turnFor(entry, event.turnId)
        const blocks = blocksFor(turn, event.agentId) as Array<Block>
        blocks.push({
          kind: "tool",
          key: `tool-${event.toolCallId}`,
          call: { toolCallId: event.toolCallId, tool: event.tool, input: event.input },
        })
        turn.tools.set(event.toolCallId, { list: blocks, index: blocks.length - 1 })
        break
      }
      case "ToolCallEnded": {
        const turn = turnFor(entry, event.turnId)
        const ended = { outcome: event.outcome, output: event.output }
        const started = turn.tools.get(event.toolCallId)
        const block = started?.list[started.index]
        if (started && block?.kind === "tool") {
          started.list[started.index] = { ...block, call: { ...block.call, ...ended } }
        } else {
          const blocks = blocksFor(turn, event.agentId) as Array<Block>
          blocks.push({
            kind: "tool",
            key: `tool-${event.toolCallId}`,
            call: { toolCallId: event.toolCallId, tool: event.tool, input: "", ...ended },
          })
        }
        break
      }
      case "TurnEnded": {
        const turn = turnFor(entry, event.turnId)
        if (event.agentId === undefined) turn.end = event
        else {
          blocksFor(turn, event.agentId)
          const agent = turn.agents.get(event.agentId)
          if (agent) agent.end = event
        }
        break
      }
      case "TurnStopRequested":
        if (latest && latest.end === null) latest.stopRequests.push(event.by)
        break
      case "SessionStateChanged":
        items.push({ kind: "notice", key: `notice-${entry.seq}`, at: entry.at, event })
        break
    }
  }

  // Hand out plain snapshots, so a later build never shares mutable state with this one.
  return items.map((item) =>
    item.kind === "turn" ? { ...item, turn: freeze(item.turn as MutableTurn) } : item,
  )
}

function freeze(turn: MutableTurn): TurnView {
  return {
    turnId: turn.turnId,
    seq: turn.seq,
    at: turn.at,
    sender: turn.sender,
    prompt: turn.prompt,
    ...(turn.promptId !== undefined && { promptId: turn.promptId }),
    blocks: turn.blocks.map((block) =>
      block.kind === "agent"
        ? { ...block, agent: { ...block.agent, blocks: [...block.agent.blocks] } }
        : block,
    ),
    stopRequests: [...turn.stopRequests],
    end: turn.end,
  }
}

/**
 * The prompt as its sender wrote it. The Hub prefixes a Participant's prompt with `[Name] ` so
 * the model knows who is talking; the chat already says who, so the prefix is dropped.
 */
export function displayPrompt(text: string, sender: PromptSender): string {
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
