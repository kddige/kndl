// What a pi Session reports to the Hub of its runs, as hub-link reports Claude Code's Turns: a
// kndl Turn is one pi run, from the prompt that starts it until pi settles (`agent_settled`), so
// pi's retries, overflow recovery and continuations stay in the Turn they belong to.
//
// It takes pi's events in plain shapes, so it runs under `bun test` without pi.

import type { MarkedFile, Participant, TurnEndReason, TurnUsage } from "@kndl/protocol"

/** A Participant as JSON: the Hub's commands carry them, and the events say them back. */
type Sender = typeof Participant.Encoded
import { clip } from "../../src/HubMessages.ts"

/** A prompt from the Prompt queue, as given to pi: `text` is what the model reads. */
export interface DeliveredPrompt {
  readonly promptId: string
  readonly sender: Sender
  readonly text: string
  readonly attachments?: ReadonlyArray<MarkedFile & { readonly size: number }> | undefined
}

/** A prompt steered into the running Turn: `text` is as its sender wrote it. */
export interface SteeredPrompt {
  readonly promptId: string
  readonly sender: Sender
  readonly text: string
  readonly attachments?: ReadonlyArray<MarkedFile & { readonly size: number }> | undefined
}

/** What pi-ai says of a finished assistant message: its stop reason, model and usage. */
export interface AssistantEnd {
  readonly provider: string
  readonly model: string
  readonly stopReason: string
  readonly usage?:
    | {
        readonly input: number
        readonly output: number
        readonly cacheRead: number
        readonly cacheWrite: number
        readonly cost?: { readonly total: number } | undefined
      }
    | undefined
}

export interface TurnsOptions {
  readonly report: (event: Record<string, unknown>) => void
  /** Milliseconds, for the Turn's duration. */
  readonly now: () => number
  /** A new Turn's id. */
  readonly newId: () => string
  /**
   * The subagent whose runs these are (ADR 0014), whose events all carry its id. A subagent's run
   * has no TurnStarted: the web groups its events by agent.
   */
  readonly agentId?: string | undefined
}

/**
 * How a Turn ended, from whether it was stopped and pi-ai's stop reason of its last request. A
 * tool that ends the run (`toolUse`) or a deferred response ends it as answered; a run with no
 * request ends in an error.
 */
export const turnEndReason = (aborted: boolean, stopReason: string | undefined): TurnEndReason => {
  if (aborted) return "aborted"
  switch (stopReason) {
    case "length":
    case "error":
    case "aborted":
      return stopReason
    case undefined:
      return "error"
    default:
      return "stop"
  }
}

const tokens = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0)

/**
 * A Turn's usage, summed over its model requests, with the model of the last, as
 * `<provider>/<id>`; undefined when no request counted. The cost is pi-ai's, left out when it
 * reports none.
 */
export const turnUsage = (messages: ReadonlyArray<AssistantEnd>): TurnUsage | undefined => {
  const last = messages.at(-1)
  if (last === undefined) return undefined
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
  for (const { usage } of messages) {
    if (usage === undefined) continue
    sum.input += tokens(usage.input)
    sum.output += tokens(usage.output)
    sum.cacheRead += tokens(usage.cacheRead)
    sum.cacheWrite += tokens(usage.cacheWrite)
    const cost = usage.cost?.total
    if (cost !== undefined && Number.isFinite(cost) && cost > 0) sum.cost += cost
  }
  const { cost, ...counted } = sum
  if (counted.input + counted.output + counted.cacheRead + counted.cacheWrite === 0)
    return undefined
  return {
    model: `${last.provider}/${last.model}`,
    ...counted,
    ...(cost > 0 && { cost: Math.round(cost * 1e9) / 1e9 }),
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * A tool's result as the web UI shows it: its text blocks, and a note of each image, never its
 * bytes; clipped.
 */
export const toolResultSummary = (result: unknown): string => {
  if (typeof result === "string") return clip(result)
  const content = isRecord(result) ? result.content : undefined
  if (!Array.isArray(content)) return ""
  return clip(
    content
      .filter(isRecord)
      .map((block) =>
        block.type === "text"
          ? String(block.text ?? "")
          : `[${typeof block.mimeType === "string" ? block.mimeType : String(block.type)}]`,
      )
      .join("\n"),
  )
}

interface RunningTurn {
  readonly turnId: string
  readonly startedAt: number
  readonly requests: Array<AssistantEnd>
}

export class Turns {
  private turn: RunningTurn | undefined
  /** The prompt from the Hub given to pi last, until a run starts with it. */
  private pending: DeliveredPrompt | undefined
  /** The prompt from the Hub pi took in as input, for the run it starts. */
  private claimed: DeliveredPrompt | undefined
  /** How the next run starts: its prompt, and who sent it. */
  private next: { readonly text: string; readonly from?: DeliveredPrompt | undefined } | undefined
  /** The prompts steered into the running Turn that no request has read yet. */
  private readonly unread = new Set<string>()

  /** What each event carries of whose loop it is: a subagent's id, or nothing for the main loop. */
  private readonly loop: { readonly agentId?: string }

  constructor(private readonly options: TurnsOptions) {
    this.loop = options.agentId === undefined ? {} : { agentId: options.agentId }
  }

  /** The Turn running, if any. */
  get turnId(): string | undefined {
    return this.turn?.turnId
  }

  /** A prompt from the Prompt queue is being given to pi. */
  deliver(prompt: DeliveredPrompt) {
    this.pending = prompt
  }

  /** The prompt being given to pi wasn't, so it starts no Turn. */
  deliveryFailed(promptId: string) {
    if (this.pending?.promptId === promptId) this.pending = undefined
    if (this.claimed?.promptId === promptId) this.claimed = undefined
  }

  /** pi took in a prompt (its `input` event): the one the Hub's prompt was given as, or another. */
  input(text: string, source: string) {
    if (source === "extension" && this.pending !== undefined && text === this.pending.text) {
      this.claimed = this.pending
      this.pending = undefined
    }
  }

  /**
   * A run is starting (`before_agent_start`) with this prompt, or with a message of an
   * extension's own (undefined). Returns the prompt from the Hub it starts with, if it is one.
   */
  beforeAgentStart(prompt: string | undefined): DeliveredPrompt | undefined {
    const from = prompt === undefined ? undefined : this.claimed
    this.claimed = undefined
    this.next = { text: prompt ?? "", from }
    return from
  }

  /** pi's agent loop started (`agent_start`): a Turn starts, unless one runs. */
  agentStart() {
    if (this.turn !== undefined) return
    const next = this.next ?? { text: "" }
    this.next = undefined
    const turnId = this.options.newId()
    this.turn = { turnId, startedAt: this.options.now(), requests: [] }
    if (this.options.agentId !== undefined) return
    const from = next.from
    this.options.report({
      _tag: "TurnStarted",
      turnId,
      text: next.text,
      sender:
        from === undefined
          ? { _tag: "FromTerminal" }
          : { _tag: "FromParticipant", participant: from.sender },
      ...(from === undefined ? {} : { promptId: from.promptId }),
    })
  }

  /** A piece of the text the model is streaming. */
  textDelta(text: string) {
    if (this.turn === undefined || text === "") return
    this.options.report({ _tag: "TextDelta", turnId: this.turn.turnId, ...this.loop, text })
  }

  /** A model request ended: its usage counts toward the Turn's. */
  assistantEnded(message: AssistantEnd) {
    this.turn?.requests.push(message)
  }

  /** A tool started running; one another tool called (`parentToolCallId`) isn't reported. */
  toolStarted(toolCallId: string, tool: string, args: unknown, parentToolCallId?: string) {
    if (this.turn === undefined || parentToolCallId !== undefined) return
    this.options.report({
      _tag: "ToolCallStarted",
      turnId: this.turn.turnId,
      ...this.loop,
      toolCallId,
      tool,
      input: clip(JSON.stringify(args ?? {}) ?? ""),
    })
  }

  /** A tool finished, with the result the model reads. */
  toolEnded(
    toolCallId: string,
    tool: string,
    result: unknown,
    isError: boolean,
    parentToolCallId?: string,
  ) {
    if (this.turn === undefined || parentToolCallId !== undefined) return
    this.options.report({
      _tag: "ToolCallEnded",
      turnId: this.turn.turnId,
      ...this.loop,
      toolCallId,
      tool,
      outcome: isError ? "Failed" : "Succeeded",
      output: toolResultSummary(result),
    })
  }

  /**
   * A prompt was steered into the running Turn (ADR 0018); false when no Turn runs to take it.
   */
  steered(prompt: SteeredPrompt): boolean {
    if (this.turn === undefined) return false
    this.unread.add(prompt.promptId)
    this.options.report({
      _tag: "PromptSteered",
      turnId: this.turn.turnId,
      promptId: prompt.promptId,
      text: prompt.text,
      sender: prompt.sender,
      ...(prompt.attachments === undefined || prompt.attachments.length === 0
        ? {}
        : { attachments: prompt.attachments }),
    })
    return true
  }

  /** pi put a steered prompt into the conversation, before the run's next request. */
  steeredMessageStarted(promptId: string) {
    if (this.turn === undefined || !this.unread.delete(promptId)) return
    this.options.report({ _tag: "SteeredPromptRead", turnId: this.turn.turnId, promptId })
  }

  /** pi settled (`agent_settled`): the Turn ends. */
  settled(aborted: boolean) {
    const turn = this.turn
    if (turn === undefined) return
    this.turn = undefined
    // Left unread, it stays in the conversation, and the model reads it with the next prompt.
    this.unread.clear()
    const usage = turnUsage(turn.requests)
    this.options.report({
      _tag: "TurnEnded",
      turnId: turn.turnId,
      ...this.loop,
      reason: turnEndReason(aborted, turn.requests.at(-1)?.stopReason),
      durationMs: Math.max(0, Math.round(this.options.now() - turn.startedAt)),
      ...(usage === undefined ? {} : { usage }),
    })
  }
}
