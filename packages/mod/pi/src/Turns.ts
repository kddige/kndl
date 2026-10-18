// What a pi Session reports to the Hub of its runs, as hub-link reports Claude Code's Turns: a
// kndl Turn is one pi run, from the prompt that starts it until pi settles (`agent_settled`), so
// pi's retries, overflow recovery and continuations stay in the Turn they belong to.
//
// It takes pi's events in plain shapes, so it runs under `bun test` without pi.

import type { MarkedFile, TurnEndReason, TurnUsage } from "@kndl/protocol"
import { clip, isRecord } from "../../src/HubMessages.ts"
import type { Sender } from "../../src/HubMessages.ts"

/**
 * A prompt from the Prompt queue: as given to pi, when `text` is what the model reads, or as
 * steered into the running Turn, when it is as its sender wrote it.
 */
export interface DeliveredPrompt {
  readonly promptId: string
  readonly sender: Sender
  readonly text: string
  readonly attachments?: ReadonlyArray<MarkedFile & { readonly size: number }> | undefined
}

/**
 * A pi model's name as kndl names a pi Session's model, everywhere the mod says one (its hello, a
 * Turn's usage, a subagent's model, a failed switch): `<provider>/<id>`, as the protocol's
 * `providerModelName` names a Provider's Model, an id's own slashes kept
 * (`openrouter/anthropic/claude-sonnet-4`).
 */
export const modelName = (model: { readonly provider: string; readonly id: string }) =>
  `${model.provider}/${model.id}`

/**
 * An agent's result, as the main loop is given it (Subagents.ts): a message of its own, which
 * starts a run, so a Turn from the agent (ADR 0014), as Claude Code's task notification does.
 */
export interface AgentResultMessage {
  readonly agentId: string
  /** What the model reads. */
  readonly text: string
}

/**
 * The answer to an `async` question (Questions.ts), as the main loop is given it: a message of its
 * own, which, with no run going, starts a Turn from whoever answered.
 */
export interface AnswerMessage {
  /** What the model reads. */
  readonly text: string
  /** Who answered from the web UI; absent when it was at pi's terminal. */
  readonly sender?: Sender | undefined
}

/** What pi-ai says of a finished assistant message: its stop reason, model and usage. */
export interface AssistantEnd {
  readonly provider: string
  readonly model: string
  readonly stopReason: string
  /** What went wrong, when the stop reason is `error`: the Provider's message, or pi's. */
  readonly errorMessage?: string | undefined
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
  /**
   * What must never reach the Hub in an error's message, such as the Session token, which a
   * Provider may say back when it refuses the key pi sent.
   */
  readonly secrets?: ReadonlyArray<string> | undefined
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

/** The longest a Turn's error message is, after which it is clipped. */
export const turnErrorMessageLength = 500

/**
 * What looks like a credential in a Provider's message: a bearer token, or a key of a shape
 * Providers give out (OpenAI's, Anthropic's and others' `sk-`, xAI's, Groq's, GitHub's, Hugging
 * Face's, NVIDIA's, Google's `AIza`). A Provider that refuses a key often says part of it back.
 */
const credentialPatterns: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(Bearer\s+)[^\s"',;]+/gi, "$1[redacted]"],
  [
    /\b(?:sk|xai|gsk|csk|ghp|gho|ghu|ghs|ghr|github_pat|hf|nvapi|pplx)[-_][A-Za-z0-9_*.-]{8,}/g,
    "[redacted]",
  ],
  [/\bAIza[A-Za-z0-9_-]{20,}/g, "[redacted]"],
]

/**
 * Why a Turn failed, as the Hub shows it: the Provider's or pi's message, without the `secrets`
 * or anything that looks like a credential, on one line, and clipped; undefined when there is
 * nothing to say.
 */
export const turnErrorMessage = (
  message: string | undefined,
  secrets: ReadonlyArray<string> = [],
): string | undefined => {
  if (message === undefined) return undefined
  let text = message
  for (const secret of secrets)
    if (secret.length >= 8) text = text.replaceAll(secret, () => "[redacted]")
  for (const [pattern, replacement] of credentialPatterns) text = text.replace(pattern, replacement)
  text = text.replace(/\s+/g, " ").trim()
  return text === "" ? undefined : clip(text, turnErrorMessageLength)
}

const tokens = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0)

/**
 * A Turn's usage, summed over its model requests, with the model of the last, named as the
 * Session's model is (`<provider>/<id>`, {@link modelName}); undefined when no request counted.
 * The cost is pi-ai's, left out when it reports none.
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
    model: modelName({ provider: last.provider, id: last.model }),
    ...counted,
    ...(cost > 0 && { cost: Math.round(cost * 1e9) / 1e9 }),
  }
}

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

/** How the next run starts: its prompt, and who sent it. */
export interface NextRun {
  readonly text: string
  readonly from?: DeliveredPrompt | undefined
  readonly agentResult?: AgentResultMessage | undefined
  readonly answer?: AnswerMessage | undefined
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
  private next: NextRun | undefined
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
    if (this.next?.from?.promptId === promptId) this.next = undefined
  }

  /** Whether the prompt from the Hub given to pi (`deliver`) is yet to start its Turn. */
  yetToStart(promptId: string): boolean {
    return (
      this.pending?.promptId === promptId ||
      this.claimed?.promptId === promptId ||
      this.next?.from?.promptId === promptId
    )
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
   * extension's own (undefined): maybe an agent's result, or the answer to an `async` question.
   * Returns the prompt from the Hub it starts with, if it is one.
   */
  beforeAgentStart(
    prompt: string | undefined,
    agentResult?: AgentResultMessage,
    answer?: AnswerMessage,
  ): DeliveredPrompt | undefined {
    const from = prompt === undefined ? undefined : this.claimed
    this.claimed = undefined
    this.next =
      agentResult !== undefined
        ? { text: agentResult.text, agentResult }
        : answer !== undefined
          ? { text: answer.text, answer }
          : { text: prompt ?? "", from }
    return from
  }

  /**
   * pi's agent loop started (`agent_start`): a Turn starts, unless one runs. Returns how it
   * started, when it did.
   */
  agentStart(): NextRun | undefined {
    if (this.turn !== undefined) return undefined
    const next = this.next ?? { text: "" }
    this.next = undefined
    const turnId = this.options.newId()
    const { from, agentResult, answer } = next
    this.turn = { turnId, startedAt: this.options.now(), requests: [] }
    if (this.options.agentId !== undefined) return next
    this.options.report({
      _tag: "TurnStarted",
      turnId,
      text: next.text,
      sender:
        agentResult !== undefined
          ? { _tag: "FromAgent", agentId: agentResult.agentId }
          : answer?.sender !== undefined
            ? { _tag: "FromParticipant", participant: answer.sender }
            : from === undefined
              ? { _tag: "FromTerminal" }
              : { _tag: "FromParticipant", participant: from.sender },
      ...(from === undefined ? {} : { promptId: from.promptId }),
    })
    return next
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
  steered(prompt: DeliveredPrompt): boolean {
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
    const last = turn.requests.at(-1)
    const reason = turnEndReason(aborted, last?.stopReason)
    const errorMessage =
      reason === "error" ? turnErrorMessage(last?.errorMessage, this.options.secrets) : undefined
    this.options.report({
      _tag: "TurnEnded",
      turnId: turn.turnId,
      ...this.loop,
      reason,
      durationMs: Math.max(0, Math.round(this.options.now() - turn.startedAt)),
      ...(usage === undefined ? {} : { usage }),
      ...(errorMessage === undefined ? {} : { errorMessage }),
    })
  }
}
