// What Claude Code sends, streamed into the turn open on a query (QueryState.ts): the Agent SDK's
// messages read as pi-ai's assistant message events. Per message, the SDK yields Anthropic stream
// events, then the whole assistant message; a tool call ends the turn, and the MCP handler holds
// the query until the next call brings the result (Bridge.ts).
//
// Ported from pi-claude-bridge 0.9.3 (MIT, Copyright (c) 2026 Eli Dickinson): see
// THIRD_PARTY_NOTICES.md.

import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  JsonObject,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai"
import type { BridgeLog } from "./Log.ts"
import type { LiveBlock, QueryContext } from "./QueryState.ts"
import { rateLimitResponse } from "./RateLimit.ts"
import type { RateLimitInfo } from "./RateLimit.ts"
import { updateUsage } from "./Usage.ts"
import type { SdkUsage } from "./Usage.ts"

// --- What the SDK sends, as far as the bridge reads it ---

interface SdkContentBlock {
  readonly type: string
  readonly text?: string
  readonly thinking?: string
  readonly signature?: string
  readonly id?: string
  readonly name?: string
  readonly input?: unknown
}

interface SdkStreamEvent {
  readonly type?: string
  readonly index?: number
  readonly message?: { readonly id?: string; readonly usage?: SdkUsage }
  readonly content_block?: SdkContentBlock
  readonly delta?: {
    readonly type?: string
    readonly text?: string
    readonly thinking?: string
    readonly partial_json?: string
    readonly signature?: string
    readonly stop_reason?: string
  }
  readonly usage?: SdkUsage
}

/** A message the SDK yields, loosely: the bridge reads only these fields. */
export interface SdkMessage {
  readonly type: string
  readonly subtype?: string
  readonly is_error?: boolean
  readonly result?: string
  readonly errors?: unknown
  readonly error?: unknown
  readonly event?: SdkStreamEvent
  readonly message?: {
    readonly id?: string
    readonly model?: string
    readonly content?: ReadonlyArray<SdkContentBlock>
    readonly usage?: SdkUsage
  }
  readonly session_id?: string
  readonly rate_limit_info?: RateLimitInfo
  readonly modelUsage?: Readonly<
    Record<string, { readonly contextWindow?: number; readonly maxOutputTokens?: number }>
  >
}

// --- Results and failures ---

export const errorText = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>
    if (typeof record.message === "string") return record.message
    if (typeof record.error === "string") return record.error
    try {
      return JSON.stringify(error)
    } catch {
      // Not JSON either.
    }
  }
  return String(error)
}

/**
 * A result's failure, or undefined when it succeeded. Claude Code reports an API failure (a 429,
 * overload, a prompt too long) with `is_error` on a success-shaped result; the error subtypes
 * carry `errors`.
 */
export function resultErrorText(message: SdkMessage): string | undefined {
  if (message.subtype === "success")
    return message.is_error ? message.result || "Claude Code reported an error" : undefined
  if (Array.isArray(message.errors) && message.errors.length)
    return message.errors.map(String).join("\n")
  if (typeof message.error === "string") return message.error
  return `Claude Code failed: ${message.subtype ?? "unknown result"}`
}

/**
 * A failure named as the rate limit that preceded it. pi-ai has no typed rate-limit error, so
 * whatever reacts to one matches the message, and Claude Code's wording ("You're out of extra
 * usage · resets 6:30pm") matches none of their patterns. "quota exceeded" is on pi-ai's
 * non-retryable list, ahead of its retryable "rate limit", so a window that resets in hours isn't
 * retried.
 */
function describeRateLimitFailure(
  rejection: { readonly rateLimitType?: string; readonly resetsAt?: number },
  failure: string,
): string {
  const kind = rejection.rateLimitType ? ` (${rejection.rateLimitType})` : ""
  const resets = rejection.resetsAt
    ? ` — resets ${new Date(rejection.resetsAt * 1000).toLocaleTimeString()}`
    : ""
  return `Claude quota exceeded — rate limit${kind}${resets}: ${failure}`
}

/** Reports a held rate-limit event to the call owning the open stream, as pi-ai's providers do. */
async function reportHeldRateLimit(c: QueryContext, model: Model<Api>): Promise<void> {
  const info = c.heldRateLimit
  if (!info || !c.currentPiStream || !c.currentOnResponse) return
  c.heldRateLimit = undefined
  try {
    await c.currentOnResponse(rateLimitResponse(info), model)
  } catch (error) {
    c.log.debug("rate limit: onResponse failed", error)
  }
}

/** The context window Claude Code served, which may differ from the listed one. */
export function logServedContextWindow(
  log: BridgeLog,
  label: string,
  message: SdkMessage,
  model: Model<Api>,
): void {
  for (const [served, usage] of Object.entries(message.modelUsage ?? {})) {
    log.debug(
      `${label}: served contextWindow=${usage.contextWindow ?? "?"} servedModel=${served} registered=${model.contextWindow}`,
    )
  }
}

// --- Tool calls ---

/**
 * The agent's tool a Claude tool_use names, or undefined for one not served: the model making up
 * a builtin. Claude Code answers those itself ("No such tool available") and retries under a new
 * id, so one must never reach the agent: it would run a tool Claude Code never ran, and deadlock.
 */
function piToolNameFor(name: string, customToolNameToPi: Map<string, string>): string | undefined {
  return customToolNameToPi.get(name) ?? customToolNameToPi.get(name.toLowerCase())
}

/** Claude Code's argument names that differ from the coding tools' own. */
const SdkKeyRenames: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  read: { file_path: "path" },
  write: { file_path: "path" },
  edit: {
    file_path: "path",
    old_string: "oldText",
    new_string: "newText",
    old_text: "oldText",
    new_text: "newText",
  },
}

const asJsonObject = (value: unknown): JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {}

/** A tool's arguments as the agent takes them: renamed, the rest passed through. */
export function mapToolArgs(toolName: string, args: unknown): JsonObject {
  const input = asJsonObject(args)
  const renames = SdkKeyRenames[toolName.toLowerCase()]
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    const piKey = renames?.[key] ?? key
    if (!(piKey in result)) result[piKey] = value // the first alias wins
  }
  // The coding tools' bash has no timeout of its own: Claude Code's default.
  if (toolName.toLowerCase() === "bash" && result.timeout == null) result.timeout = 120
  return result as JsonObject
}

function parsePartialJson(input: string, fallback: JsonObject): JsonObject {
  if (!input) return fallback
  try {
    return JSON.parse(input) as JsonObject
  } catch {
    return fallback
  }
}

function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
  switch (reason) {
    case "tool_use":
      return "toolUse"
    case "max_tokens":
      return "length"
    default:
      return "stop"
  }
}

function recordUsage(c: QueryContext, usage: SdkUsage, model: Model<Api>): void {
  if (!c.turnOutput) return
  const { cachePct } = updateUsage(c.turnOutput as AssistantMessage, usage, model)
  const u = c.turnOutput.usage
  c.log.debug(
    `usage: in=${u.input} out=${u.output} cacheRead=${u.cacheRead} cacheWrite=${u.cacheWrite} cachePct=${cachePct}% model=${model.id}`,
  )
}

// --- Streaming into the open turn ---

/** Makes `stream` the open turn's, whose call's `onResponse` hears of rate limits. */
export function claimCurrentPiStream(
  stream: AssistantMessageEventStream,
  label: string,
  c: QueryContext,
  options: SimpleStreamOptions | undefined,
): void {
  if (c.currentPiStream)
    c.log.debug(`WARNING: currentPiStream overwritten before its end (${label})`)
  c.currentPiStream = stream
  c.currentOnResponse = options?.onResponse
}

/** Ends the open turn as the query left it, at the query's end. */
export function finalizeCurrentStream(c: QueryContext): AssistantMessage | undefined {
  const live = c.turnOutput
  if (!live) return undefined
  // Claude asked for a tool the agent doesn't serve and nothing else: the turn just stops.
  const stoppedOnUnservedTool =
    live.stopReason === "toolUse" && !live.content.some((block) => block.type === "toolCall")
  return c.endTurn(stoppedOnUnservedTool ? { stopReason: "stop" } : undefined)
}

/** Maps Anthropic stream events onto pi-ai's (text, thinking, tool calls); a tool call ends the turn. */
function processStreamEvent(
  message: SdkMessage,
  customToolNameToPi: Map<string, string>,
  model: Model<Api>,
  c: QueryContext,
): void {
  const stream = c.currentPiStream
  const output = c.turnOutput
  if (!stream || !output) return
  c.turnSawStreamEvent = true
  const event = message.event
  const partial = output as AssistantMessage

  if (event?.type === "message_start") {
    // Still open from an earlier message_start: Claude Code gave up on that stream and is asking
    // again. Its blocks never completed.
    if (c.turnStreamOpen) dropAbandonedStreamBlocks(c, `restreamed as ${event.message?.id}`)
    c.turnToolCallIds = []
    c.turnStreamMessageId = event.message?.id
    c.turnStreamOpen = true
    c.turnStreamBlockStart = c.turnBlocks.length
    if (event.message?.usage) recordUsage(c, event.message.usage, model)
    return
  }

  if (event?.type === "content_block_start") {
    c.ensureTurnStarted()
    const block = event.content_block
    const index = event.index
    if (block?.type === "text") {
      c.turnBlocks.push({ type: "text", text: "", ...(index === undefined ? {} : { index }) })
      stream.push({ type: "text_start", contentIndex: c.turnBlocks.length - 1, partial })
    } else if (block?.type === "thinking") {
      c.turnBlocks.push({
        type: "thinking",
        thinking: "",
        thinkingSignature: "",
        ...(index === undefined ? {} : { index }),
      })
      stream.push({ type: "thinking_start", contentIndex: c.turnBlocks.length - 1, partial })
    } else if (block?.type === "tool_use" && block.id !== undefined) {
      const piName = piToolNameFor(block.name ?? "", customToolNameToPi)
      if (!piName) {
        c.log.debug(
          `processStreamEvent: skipping tool_use for unserved tool ${block.name} [${block.id}]`,
        )
        return
      }
      c.turnToolCallIds.push(block.id)
      c.turnBlocks.push({
        type: "toolCall",
        id: block.id,
        name: piName,
        arguments: asJsonObject(block.input),
        partialJson: "",
        ...(index === undefined ? {} : { index }),
      })
      stream.push({ type: "toolcall_start", contentIndex: c.turnBlocks.length - 1, partial })
    } else {
      c.log.debug("processStreamEvent: unhandled content_block_start type", block?.type)
    }
    return
  }

  if (event?.type === "content_block_delta") {
    const index = openBlockIndex(c, event.index)
    const block = c.turnBlocks[index]
    if (!block) return
    const delta = event.delta
    if (delta?.type === "text_delta" && block.type === "text") {
      block.text += delta.text ?? ""
      stream.push({ type: "text_delta", contentIndex: index, delta: delta.text ?? "", partial })
    } else if (delta?.type === "thinking_delta" && block.type === "thinking") {
      block.thinking += delta.thinking ?? ""
      stream.push({
        type: "thinking_delta",
        contentIndex: index,
        delta: delta.thinking ?? "",
        partial,
      })
    } else if (delta?.type === "input_json_delta" && block.type === "toolCall") {
      block.partialJson = (block.partialJson ?? "") + (delta.partial_json ?? "")
      block.arguments = parsePartialJson(block.partialJson, block.arguments)
      stream.push({
        type: "toolcall_delta",
        contentIndex: index,
        delta: delta.partial_json ?? "",
        partial,
      })
    } else if (delta?.type === "signature_delta" && block.type === "thinking") {
      block.thinkingSignature = (block.thinkingSignature ?? "") + (delta.signature ?? "")
    } else {
      c.log.debug("processStreamEvent: unhandled content_block_delta type", delta?.type)
    }
    return
  }

  if (event?.type === "content_block_stop") {
    const index = openBlockIndex(c, event.index)
    const block = c.turnBlocks[index]
    if (!block) return
    delete block.index
    if (block.type === "text") {
      stream.push({ type: "text_end", contentIndex: index, content: block.text, partial })
    } else if (block.type === "thinking") {
      stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial })
    } else {
      c.turnSawToolCall = true
      block.arguments = mapToolArgs(
        block.name,
        parsePartialJson(block.partialJson ?? "", block.arguments),
      )
      delete block.partialJson
      stream.push({ type: "toolcall_end", contentIndex: index, toolCall: { ...block }, partial })
    }
    return
  }

  if (event?.type === "message_delta") {
    output.stopReason = mapStopReason(event.delta?.stop_reason)
    if (event.usage) recordUsage(c, event.usage, model)
    return
  }

  if (event?.type === "message_stop") {
    dropUnfinishedStreamBlocks(c, `message_stop for ${c.turnStreamMessageId}`)
    c.turnStreamOpen = false
    // A tool call ends the turn: the agent runs it, then calls again with its result. The SDK still
    // yields this message whole, which finds no turn open and is skipped; the MCP handler holds
    // the query until the result comes.
    if (c.turnSawToolCall) c.endTurn({ stopReason: "toolUse" })
    return
  }

  if (event?.type !== "ping") c.log.debug("processStreamEvent: unhandled event type", event?.type)
}

/**
 * Where the open block a stream event's `index` names is in the turn's blocks, or -1. An event
 * without an index names none: a closed block has none either.
 */
function openBlockIndex(c: QueryContext, index: number | undefined): number {
  return index === undefined ? -1 : c.turnBlocks.findIndex((block) => block.index === index)
}

/**
 * Drops the blocks of the message just stopped that never got their content_block_stop: the
 * stream was cut inside them. A tool call left so is one Claude Code drops before going on, so it
 * would never be answered; a thinking block has no signature.
 */
function dropUnfinishedStreamBlocks(c: QueryContext, why: string): void {
  const dropped: Array<string> = []
  for (let i = c.turnBlocks.length - 1; i >= c.turnStreamBlockStart; i--) {
    const block = c.turnBlocks[i]
    // `index` goes at content_block_stop, so it marks a block that never closed.
    if (block === undefined || block.index === undefined) continue
    dropped.push(`${block.type}${block.type === "toolCall" ? `[${block.id}]` : ""}`)
    c.turnBlocks.splice(i, 1)
  }
  if (!dropped.length) return
  c.log.debug(`dropUnfinishedStreamBlocks: ${why}; dropped ${dropped.toReversed().join(",")}`)
  c.turnToolCallIds = c.turnBlocks.flatMap((b) => (b.type === "toolCall" ? [b.id] : []))
  c.turnSawToolCall = c.turnBlocks.some((b) => b.type === "toolCall")
}

/** Drops the blocks of a stream Claude Code abandoned mid-message, before it asks again. */
function dropAbandonedStreamBlocks(c: QueryContext, why: string): void {
  const dropped = c.turnBlocks.splice(c.turnStreamBlockStart)
  c.log.debug(`dropAbandonedStreamBlocks: ${why}; dropped ${dropped.length} blocks`)
  c.turnToolCallIds = []
  c.turnSawToolCall = c.turnBlocks.some((b) => b.type === "toolCall")
  c.turnStreamOpen = false
}

/**
 * The SDK's whole `assistant` message, after its stream: nothing to do when the stream delivered
 * it, but the content's only way in when no stream event came, or when a stalled stream made
 * Claude Code ask again without streaming (the answer comes whole, under a new id).
 */
function processAssistantMessage(
  message: SdkMessage,
  model: Model<Api>,
  customToolNameToPi: Map<string, string>,
  c: QueryContext,
): void {
  const assistantMsg = message.message
  const stream = c.currentPiStream
  const output = c.turnOutput
  if (!assistantMsg?.content || !stream || !output) return
  const partial = output as AssistantMessage
  // Claude Code reports API failures and its own notices as a `<synthetic>` message: a report,
  // not the model's output. Kept off the stream, so a consumer that fails over only before output
  // can still; the failure itself ends the turn.
  if (assistantMsg.model === "<synthetic>") {
    if (c.turnSawStreamEvent && c.turnStreamOpen)
      dropAbandonedStreamBlocks(c, "synthetic failure report")
    for (const block of assistantMsg.content) {
      if (block.type === "text" && block.text) c.turnBlocks.push({ type: "text", text: block.text })
    }
    if (assistantMsg.usage) recordUsage(c, assistantMsg.usage, model)
    return
  }
  if (c.turnSawStreamEvent) {
    // The same id was delivered already; a new one is the non-streaming fallback.
    const id = assistantMsg.id
    if (!id || !c.turnStreamMessageId || id === c.turnStreamMessageId) return
    if (c.turnStreamOpen) dropAbandonedStreamBlocks(c, `non-streaming fallback ${id}`)
  }
  c.turnToolCallIds = []
  c.turnSawWholeContent = true
  for (const block of assistantMsg.content) {
    if (block.type === "text" && block.text) {
      c.ensureTurnStarted()
      c.turnBlocks.push({ type: "text", text: block.text })
      const idx = c.turnBlocks.length - 1
      stream.push({ type: "text_start", contentIndex: idx, partial })
      stream.push({ type: "text_delta", contentIndex: idx, delta: block.text, partial })
      stream.push({ type: "text_end", contentIndex: idx, content: block.text, partial })
    } else if (block.type === "thinking") {
      c.ensureTurnStarted()
      c.turnBlocks.push({
        type: "thinking",
        thinking: block.thinking ?? "",
        thinkingSignature: block.signature ?? "",
      })
      const idx = c.turnBlocks.length - 1
      stream.push({ type: "thinking_start", contentIndex: idx, partial })
      if (block.thinking)
        stream.push({ type: "thinking_delta", contentIndex: idx, delta: block.thinking, partial })
      stream.push({
        type: "thinking_end",
        contentIndex: idx,
        content: block.thinking ?? "",
        partial,
      })
    } else if (block.type === "tool_use" && block.id !== undefined) {
      const piName = piToolNameFor(block.name ?? "", customToolNameToPi)
      if (!piName) {
        c.log.debug(`processAssistantMessage: skipping tool_use for unserved tool ${block.name}`)
        continue
      }
      c.ensureTurnStarted()
      c.turnSawToolCall = true
      c.turnToolCallIds.push(block.id)
      const toolCall: LiveBlock = {
        type: "toolCall",
        id: block.id,
        name: piName,
        arguments: mapToolArgs(piName, block.input),
      }
      c.turnBlocks.push(toolCall)
      const idx = c.turnBlocks.length - 1
      stream.push({ type: "toolcall_start", contentIndex: idx, partial })
      stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: { ...toolCall }, partial })
    } else {
      c.log.debug("processAssistantMessage: unhandled block type", block.type)
    }
  }
  if (assistantMsg.usage) recordUsage(c, assistantMsg.usage, model)
  // A tool call ends the turn, as at message_stop.
  if (c.turnSawToolCall) c.endTurn({ stopReason: "toolUse" })
}

/**
 * Reads the query to its end, streaming into whichever turn is open. Per message, the SDK yields
 * stream events, then the whole assistant message; a tool call ends the turn, and the MCP handler
 * holds the query until the next call brings the result.
 */
export async function consumeQuery(
  sdkQuery: AsyncIterable<unknown>,
  customToolNameToPi: Map<string, string>,
  model: Model<Api>,
  wasAborted: () => boolean,
  queryCtx: QueryContext,
): Promise<{ capturedSessionId?: string }> {
  let capturedSessionId: string | undefined

  for await (const raw of sdkQuery) {
    const message = raw as SdkMessage
    if (wasAborted()) break
    await reportHeldRateLimit(queryCtx, model)
    // Not content, so not behind the open-turn guard below: closing stdin (nothing else closes
    // it, the prompt being a stream), the failure a result carries, and rate-limit events.
    let resultError: string | undefined
    if (message.type === "result") {
      queryCtx.promptStream?.end()
      logServedContextWindow(queryCtx.log, "result", message, model)
      resultError = resultErrorText(message)
      if (resultError !== undefined) {
        // Taken with the failure it caused, so a later failure isn't labelled with it.
        if (queryCtx.rateLimitRejection) {
          resultError = describeRateLimitFailure(queryCtx.rateLimitRejection, resultError)
          queryCtx.rateLimitRejection = null
        }
        queryCtx.log.debug(
          `consumeQuery: error result, subtype=${message.subtype}, error=${resultError}`,
        )
        // Claude Code wrote its record of the failure into the session: not the conversation's.
        queryCtx.failed = true
        // The open turn's, as it streams: its end carries it. With none open, there's no
        // message for it, and none the caller holds is touched.
        if (queryCtx.turnOutput) {
          queryCtx.turnOutput.stopReason = "error"
          queryCtx.turnOutput.errorMessage = resultError
        } else {
          queryCtx.log.diag("query_failed_between_turns", { error: resultError })
        }
      }
    }
    if (message.type === "rate_limit_event") {
      const info = message.rate_limit_info
      queryCtx.log.debug(
        "consumeQuery: rate_limit_event",
        JSON.stringify(info ?? null).slice(0, 300),
      )
      if (info) queryCtx.heldRateLimit = info
      await reportHeldRateLimit(queryCtx, model)
      noteRateLimit(queryCtx, info)
      continue
    }
    if (!queryCtx.currentPiStream || !queryCtx.turnOutput) continue

    switch (message.type) {
      case "stream_event":
        processStreamEvent(message, customToolNameToPi, model, queryCtx)
        break
      case "assistant":
        processAssistantMessage(message, model, customToolNameToPi, queryCtx)
        break
      case "result": {
        // The failure was taken above; on success, the result's text when nothing brought it,
        // neither a stream nor a whole assistant message.
        if (
          resultError === undefined &&
          !queryCtx.turnSawStreamEvent &&
          !queryCtx.turnSawWholeContent &&
          message.subtype === "success"
        ) {
          queryCtx.ensureTurnStarted()
          const text = message.result || ""
          queryCtx.turnBlocks.push({ type: "text", text })
          const idx = queryCtx.turnBlocks.length - 1
          const partial = queryCtx.turnOutput as AssistantMessage
          queryCtx.currentPiStream.push({ type: "text_start", contentIndex: idx, partial })
          queryCtx.currentPiStream.push({
            type: "text_delta",
            contentIndex: idx,
            delta: text,
            partial,
          })
          queryCtx.currentPiStream.push({
            type: "text_end",
            contentIndex: idx,
            content: text,
            partial,
          })
        }
        break
      }
      case "system":
        if (message.subtype === "init" && message.session_id) {
          capturedSessionId = message.session_id
          queryCtx.capturedSessionId = capturedSessionId
        }
        break
      case "user":
        // The SDK echoing a prompt or tool result: nothing to stream.
        break
      default:
        queryCtx.log.debug("consumeQuery: unhandled SDK message type", message.type)
        break
    }
  }

  queryCtx.log.debug(
    `consumeQuery: done, wasAborted=${wasAborted()}, session=${capturedSessionId?.slice(0, 8)}`,
  )
  return capturedSessionId === undefined ? {} : { capturedSessionId }
}

/** Tells the person at the terminal of a rate limit reached or near. */
function noteRateLimit(c: QueryContext, info: RateLimitInfo | undefined): void {
  if (info?.status === "rejected") {
    // Held, so the failure Claude Code sends next is named as a rate limit.
    c.rateLimitRejection = info
    c.lastRateLimitWarnStep = null
    c.lastRateLimitWarnThreshold = undefined
    const resetsAt = info.resetsAt ? new Date(info.resetsAt * 1000).toLocaleTimeString() : "unknown"
    c.notice(
      `Claude subscription rate limit reached (${info.rateLimitType ?? "unknown"}) — resets at ${resetsAt}`,
      "warning",
    )
  } else if (info?.status === "allowed") {
    c.lastRateLimitWarnStep = null
    c.lastRateLimitWarnThreshold = undefined
  } else if (info?.status === "allowed_warning") {
    const percent = Math.round((info.utilization ?? 0) * 100)
    // One event a request: warn again only past a new 5% step, or a new threshold.
    const step = Math.floor(percent / 5)
    const rose = c.lastRateLimitWarnStep === null || step > c.lastRateLimitWarnStep
    if (rose || info.surpassedThreshold !== c.lastRateLimitWarnThreshold) {
      c.lastRateLimitWarnStep = step
      c.lastRateLimitWarnThreshold = info.surpassedThreshold
      c.notice(
        `Claude rate limit warning: ${percent}% used (${info.rateLimitType ?? ""})`,
        "warning",
      )
    }
  }
}
