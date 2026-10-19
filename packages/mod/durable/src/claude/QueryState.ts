// The state of one Claude Code query, and of the turn it's streaming into.
//
// One turn is one call of the provider's stream function (one request of Pi Durable's generation
// task), which ends at a tool call or the answer's end; one Claude Code query runs across all the
// turns of a run, held open at each tool call until the next request brings its result. So a query
// outlives the turns it streams, and this keeps both: the query's, and the open turn's.
//
// A turn's assistant message is built up in `turnOutput`, the `partial` pi-ai's stream contract
// shares with the caller while it streams. Once its terminal event (done or error) is pushed, the
// caller holds that message for good: so the terminal event carries a copy, and `turnOutput` is
// dropped at once. Nothing the bridge does afterwards (an abort, a failed query, a late usage
// frame) can reach a message the caller holds; an abort or failure with no turn open ends no
// message at all, and one with a turn open ends it with a new message (`endTurn`). The reference
// rewrote a message pi held after an abort, which broke the next switch to another Provider
// (docs/research/claude-bridge-spike.md).
//
// A call's abort signal is the generation task's invocation's, which Pi Durable aborts whenever the
// task stops running: right after a turn that ends at a tool call too, as the task then waits on
// its tools. So a signal stops the query only while its own turn is open (`bindSignal`, until
// `endTurn`): the next call's, bringing the tool results, is bound in its place.
//
// Ported from pi-claude-bridge 0.9.3 (MIT, Copyright (c) 2026 Eli Dickinson): see
// THIRD_PARTY_NOTICES.md.

import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Message,
  Model,
  SimpleStreamOptions,
  StopReason,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai"
import { silentLog } from "./Log.ts"
import type { BridgeLog } from "./Log.ts"
import type { PromptStream } from "./PromptStream.ts"
import type { RateLimitInfo } from "./RateLimit.ts"
import type { McpResult } from "./ToolResults.ts"

/** A notice for the people watching the Session, such as a rate limit reached. */
export type Notice = (text: string, level: "info" | "warning" | "error") => void

export interface PendingToolCall {
  readonly toolName: string
  readonly resolve: (result: McpResult) => void
}

/**
 * A content block while it streams: `index` is the stream's block index until its
 * `content_block_stop`, and a tool call's `partialJson` is its arguments' text so far.
 */
export type LiveBlock =
  | (TextContent & { index?: number })
  | (ThinkingContent & { index?: number })
  | (ToolCall & { index?: number; partialJson?: string })

/** A turn's message while it streams, with its blocks as they stream. */
export type LiveMessage = Omit<AssistantMessage, "content"> & { content: Array<LiveBlock> }

/** The query the context belongs to, as far as the bridge reaches it. */
export interface QueryHandle {
  readonly interrupt?: () => Promise<unknown>
  readonly close?: () => void
}

/** A new assistant message for `model`, empty but for `text`. */
export function newAssistantOutput(
  model: Pick<Model<Api>, "api" | "provider" | "id">,
  text: string,
  stopReason: StopReason,
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  }
}

/**
 * A copy of the turn's message, for the caller to keep: its own object, all the way down, with none
 * of the streaming bookkeeping. Copied with JSON, as a message is JSON: it's what Pi Durable
 * stores it as.
 */
export function finalMessage(
  live: LiveMessage,
  change?: Partial<Pick<AssistantMessage, "stopReason" | "errorMessage">>,
): AssistantMessage {
  const copy = JSON.parse(JSON.stringify(live)) as LiveMessage
  for (const block of copy.content) {
    delete block.index
    if (block.type === "toolCall") delete block.partialJson
  }
  return { ...(copy as AssistantMessage), ...change }
}

export class QueryContext {
  constructor(
    readonly log: BridgeLog = silentLog,
    readonly notice: Notice = () => {},
  ) {}

  // The query's.
  activeQuery: QueryHandle | null = null
  /** The open turn's stream, until its terminal event. */
  currentPiStream: AssistantMessageEventStream | null = null
  /** onResponse from the provider call that owns currentPiStream. */
  currentOnResponse: SimpleStreamOptions["onResponse"] | undefined
  /**
   * The latest rate_limit_event not reported yet. Claude Code sends it after message_stop, when a
   * tool call has already ended the turn, so it waits for the next call's stream.
   */
  heldRateLimit: RateLimitInfo | undefined
  /**
   * The messages (system messages aside) of the latest call into the query: what Claude Code's
   * session holds once the query has answered them, and what the next call's must start with, or
   * the conversation was rewritten under the query.
   */
  latestHistory: ReadonlyArray<Message> = []
  /** {@link latestHistory}'s prefix hash (SessionMirror.ts). */
  latestPrefixHash: string | undefined
  /** The served tools' declarations, as the query was opened with them: its MCP server's. */
  toolsKey = ""
  /**
   * Since when the query has had no turn open (or the latest call came), for the reaper of held
   * queries no call comes back to.
   */
  idleSince = 0
  readonly pendingToolCalls = new Map<string, PendingToolCall>()
  readonly pendingResults = new Map<string, McpResult>()
  /**
   * The tool_use ids emitted this turn, only to route a delivered result to the query it belongs
   * to; a result is paired with its call by the id on Claude's tools/call.
   */
  turnToolCallIds: Array<string> = []
  /** The query's streaming input: how steers reach Claude Code mid-turn. */
  promptStream: PromptStream | null = null
  /** The last rate-limit rejection, which Claude Code sends just before the failure it caused. */
  rateLimitRejection: { readonly rateLimitType?: string; readonly resetsAt?: number } | null = null
  /** The highest 5% utilization step warned of, so repeated events don't warn again. */
  lastRateLimitWarnStep: number | null = null
  lastRateLimitWarnThreshold: number | undefined
  /**
   * The conversation the query serves (`SimpleStreamOptions.sessionId`): a process serves many at
   * once (threads, subagents), each its own context.
   */
  piSessionId: string | null = null
  /** A steer never reached Claude Code; the mirror the query completes has to rebuild. */
  missedSteer = false
  /**
   * The query's result was a failure (an API error): Claude Code wrote its record of it into the
   * session, which the conversation doesn't hold.
   */
  failed = false
  /** The query was stopped: a tool result a call brings next isn't for it. */
  aborted = false
  /** Stops the query as an abort does, while it runs (or the wait before it starts). */
  stop: (() => void) | undefined
  /** Settles once the query has ended and the bridge is done with it. */
  settled: Promise<void> = Promise.resolve()
  /** The open turn's call's abort signal, bound to {@link stop} until the turn ends. */
  private boundSignal: AbortSignal | undefined
  private readonly onSignal = () => this.stop?.()
  /** The Claude Code session the query runs in, once its init says. */
  capturedSessionId: string | undefined

  // The open turn's, reset together.
  /** The open turn's message as it streams; null once its terminal event is pushed. */
  turnOutput: LiveMessage | null = null
  turnStarted = false
  turnSawStreamEvent = false
  /** Content came whole, in an assistant message with nothing streamed: the result repeats it. */
  turnSawWholeContent = false
  turnSawToolCall = false
  /**
   * The API message id of the last message_start, and whether its message_stop has come: an
   * `assistant` message of another id while the stream is open is Claude Code's non-streaming
   * fallback for a stalled stream.
   */
  turnStreamMessageId: string | undefined
  turnStreamOpen = false
  /** turnBlocks' length at that message_start: where an abandoned attempt's blocks begin. */
  turnStreamBlockStart = 0

  get turnBlocks(): Array<LiveBlock> {
    if (!this.turnOutput) throw new Error("turnBlocks accessed with no turn open")
    return this.turnOutput.content
  }

  /**
   * Answers every parked MCP handler with `reason` and forgets the queued results, for a query
   * that's going away. Resolved, not rejected: an error reply is still a reply, and a handler left
   * waiting on a gone subprocess keeps Claude Code's tools/call open forever.
   */
  releasePendingToolCalls(reason: string): void {
    for (const pending of this.pendingToolCalls.values())
      pending.resolve({ content: [{ type: "text", text: reason }] })
    this.pendingToolCalls.clear()
    this.pendingResults.clear()
  }

  /** Opens a turn: a new message to stream into. */
  resetTurnState(model: Pick<Model<Api>, "api" | "provider" | "id">): void {
    this.turnOutput = newAssistantOutput(model, "", "stop")
    this.turnStarted = false
    this.turnSawStreamEvent = false
    this.turnSawWholeContent = false
    this.turnSawToolCall = false
    this.turnStreamMessageId = undefined
    this.turnStreamOpen = false
    this.turnStreamBlockStart = 0
    // turnToolCallIds stays: it routes the results of the message just ended to this query.
  }

  /**
   * Binds the open turn's call's abort signal to {@link stop}, in place of any other, until the
   * turn ends. One aborted already stops the query now, if it has started.
   */
  bindSignal(signal: AbortSignal | undefined): void {
    this.unbindSignal()
    if (signal === undefined) return
    this.boundSignal = signal
    if (signal.aborted) this.stop?.()
    else signal.addEventListener("abort", this.onSignal, { once: true })
  }

  /** Whether the open turn's call was aborted: a query starting now stops at once. */
  get signalAborted(): boolean {
    return this.boundSignal?.aborted === true
  }

  unbindSignal(): void {
    this.boundSignal?.removeEventListener("abort", this.onSignal)
    this.boundSignal = undefined
  }

  /** Pushes `start` for the open turn, once. */
  ensureTurnStarted(): void {
    if (!this.turnStarted && this.currentPiStream && this.turnOutput) {
      this.currentPiStream.push({ type: "start", partial: this.turnOutput as AssistantMessage })
      this.turnStarted = true
    }
  }

  /**
   * Ends the open turn: pushes its terminal event, with a copy of its message, changed as given,
   * and ends its stream. The turn's message is dropped, so nothing reaches the caller's copy
   * again, and its call's signal no longer stops the query. Returns the message the caller got,
   * or undefined when no turn was open.
   */
  endTurn(
    change?: Partial<Pick<AssistantMessage, "stopReason" | "errorMessage">>,
  ): AssistantMessage | undefined {
    const stream = this.currentPiStream
    const live = this.turnOutput
    if (!stream || !live) return undefined
    this.unbindSignal()
    this.idleSince = Date.now()
    this.ensureTurnStarted()
    const message = finalMessage(live, change)
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      stream.push({ type: "error", reason: message.stopReason, error: message })
    } else {
      const reason =
        message.stopReason === "length" || message.stopReason === "toolUse"
          ? message.stopReason
          : "stop"
      stream.push({ type: "done", reason, message })
    }
    stream.end()
    this.currentPiStream = null
    this.turnOutput = null
    return message
  }
}
