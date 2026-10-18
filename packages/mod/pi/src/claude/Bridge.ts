// The Claude bridge's stream: pi's provider for Claude's Models runs Claude Code, through the
// Agent SDK, as a model only (ADR 0029). Claude Code gets none of its own tools (`tools: []`);
// pi's are served to it over an in-process MCP server (ToolServer.ts).
//
// One pi run is one Claude Code query, which pi's turns stream from in turn:
// 1. pi calls the stream function with a prompt: a query starts, resuming Claude Code's mirror of
//    pi's history (SessionMirror.ts), and its messages stream into pi's turn (consumeQuery).
// 2. Claude calls a tool: the turn ends on the tool call, and the MCP call is held open, which
//    holds the query.
// 3. pi runs the tool and calls the stream function again with its result: the held call is
//    answered with it, and the query streams into this new turn.
//
// No message is changed once pi has it (QueryState.ts): a turn's terminal event carries a copy of
// its message, and an abort or failure with no turn open ends nothing.
//
// Ported from pi-claude-bridge 0.9.3 (MIT, Copyright (c) 2026 Eli Dickinson): see
// THIRD_PARTY_NOTICES.md.

import type { EffortLevel, Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai"
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  JsonObject,
  Model,
  SimpleStreamOptions,
  Tool,
} from "@earendil-works/pi-ai"
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent"
import { bridge } from "./BridgeState.ts"
import type { ClaudeQuery } from "./BridgeState.ts"
import { userTurnText } from "./Convert.ts"
import { debug, diag } from "./Log.ts"
import { claudeCodeModelId, defaultLongContext } from "./Models.ts"
import { McpServerName, McpToolPrefix } from "./Names.ts"
import { watchProcess } from "./ProcessExit.ts"
import type { ProcessWatch } from "./ProcessExit.ts"
import { projectPromptCapture, sharedPromptCaptures } from "./PromptCapture.ts"
import type { PromptCapture } from "./PromptCapture.ts"
import { makePromptStream, userMessage } from "./PromptStream.ts"
import type { PromptStream } from "./PromptStream.ts"
import { newAssistantOutput, QueryContext } from "./QueryState.ts"
import type { LiveBlock, QueryHandle } from "./QueryState.ts"
import { rateLimitResponse } from "./RateLimit.ts"
import type { RateLimitInfo } from "./RateLimit.ts"
import type { Checkpoint } from "./Rewind.ts"
import { sessionCwdFor, summarySessionFor } from "./SessionCwd.ts"
import {
  deleteClaudeSession,
  historyReplaced,
  queryCompleted,
  queryDiscarded,
  queryFailed,
  queryStopped,
  resultsDelivered,
  sessionStateFor,
  steerMissed,
  stoppedClaudeCodeExited,
  syncSharedSession,
  turnStart,
} from "./SessionMirror.ts"
import { claudeCodeEnvironment } from "./Settings.ts"
import type { ClaudeSettings } from "./Settings.ts"
import { extractAllToolResults } from "./ToolResults.ts"
import type { McpResult } from "./ToolResults.ts"
import { createToolServer } from "./ToolServer.ts"
import { toBridgeContext } from "./Transcript.ts"
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

export type { ClaudeQuery, QueryFn } from "./BridgeState.ts"

/** A block of a prompt to Claude Code. */
type PromptBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image"
      readonly source: {
        readonly type: "base64"
        readonly media_type: string
        readonly data: string
      }
    }

// --- The bridge's state (BridgeState.ts) ---

const { activeQueryContexts, historyRewrittenBySession, abandonedQueries } = bridge

const stoppingKey = (piSessionId: string | null) => piSessionId ?? "(none)"

/** What holds a context while its query waits for the stopped one's Claude Code to exit. */
const WaitingForExit: QueryHandle = {}

const promptCaptures = sharedPromptCaptures((diagnostic) => {
  const first = diagnostic.matches[0]
  debug(
    `prompt-capture: no match for ${diagnostic.systemPrompt.length}-char system prompt. ` +
      (first
        ? `closest known (${first.key.length}-char) diverges at offset ${first.firstDivergent}: ` +
          JSON.stringify(
            diagnostic.systemPrompt.slice(
              Math.max(0, first.firstDivergent - 40),
              first.firstDivergent + 60,
            ),
          )
        : "no known captures to compare against."),
  )
})

/** Sets what Claude Code runs as and with: called at registration. */
export function configureBridge(options: {
  readonly settings: ClaudeSettings
  readonly env: NodeJS.ProcessEnv
}): void {
  bridge.settings = options.settings
  bridge.childEnv = () => claudeCodeEnvironment(options.env)
}

export function setPiUI(ui: ExtensionUIContext | null): void {
  bridge.piUI = ui
}

export const capturedPrompts = () => promptCaptures

// --- History rewrites ---

/**
 * pi replaced `piSession`'s history (compaction, tree navigation): its mirror's next sync
 * rebuilds, and its queries held at a tool call are discarded when their result comes.
 */
export function markRebuildForSession(piSession: string | null, event: string): void {
  const state = historyReplaced(piSession)
  debug(
    state
      ? `${event}: marking needsRebuild on session ${state.sessionId.slice(0, 8)}`
      : `${event}: history rewritten, no session to mark yet`,
  )
  // Now, not on delivery: compaction runs inside pi's turn loop, while a query is held.
  if (piSession) historyRewrittenBySession.add(piSession)
  armStaleContexts()
}

/** Marks each held query built from a rewritten session's history. */
export function armStaleContexts(): void {
  for (const c of activeQueryContexts) {
    if (c.piSessionId && historyRewrittenBySession.has(c.piSessionId)) c.historyStale = true
  }
}

// --- Prompts ---

/** The current user turn as text, or null when the last message isn't a user message. */
function extractUserPrompt(messages: Context["messages"]): string | null {
  const turn = messages.slice(turnStart(messages))
  if (turn.length === 0) return null
  // Empties out first, so an all-empty turn is "" for the empty-prompt guard.
  return userTurnText(turn)
}

/** The current user turn as blocks, keeping its images; null when it has none. */
export function extractUserPromptBlocks(messages: Context["messages"]): Array<PromptBlock> | null {
  const turn = messages.slice(turnStart(messages))
  if (turn.length === 0) return null

  let hasImage = false
  const blocks: Array<PromptBlock> = []
  for (const message of turn) {
    if (message.role !== "user") continue
    const content =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content
    // Off-type content breaks UserMessage's contract: almost always another extension's message.
    if (!Array.isArray(content)) {
      throw new Error(
        `extractUserPromptBlocks: user message content must be a string or block array, got ${typeof content} — likely a malformed message from another extension`,
      )
    }
    for (const block of content) {
      if (block.type === "text" && block.text) {
        blocks.push({ type: "text", text: block.text })
      } else if (block.type === "image") {
        if (!block.data || !block.mimeType) {
          debug(`image block missing data or mimeType, skipping`)
          continue
        }
        hasImage = true
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: block.mimeType, data: block.data },
        })
      }
    }
  }
  return hasImage ? blocks : null
}

/** The trailing user turn as blocks, images kept, or null when there's none. */
function steerBlocks(messages: Context["messages"]): Array<PromptBlock> | null {
  const blocks = extractUserPromptBlocks(messages)
  if (blocks) return blocks
  const text = extractUserPrompt(messages)
  return text ? [{ type: "text", text }] : null
}

/**
 * A prompt's blocks as the SDK takes a user message's content. An image's type is pi's, which
 * the Messages API checks: one it doesn't take fails the request there, as it would from pi.
 */
const promptContent = (blocks: ReadonlyArray<PromptBlock>) =>
  blocks as unknown as SDKUserMessage["message"]["content"]

// --- Results and failures ---

const errorText = (error: unknown): string => {
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
 * A failure named as the rate limit that preceded it. pi has no typed rate-limit error, so
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

/** Reports a held rate-limit event to the call owning the open stream, as pi's providers do. */
async function reportHeldRateLimit(c: QueryContext, model: Model<Api>): Promise<void> {
  const info = c.heldRateLimit
  if (!info || !c.currentPiStream || !c.currentOnResponse) return
  c.heldRateLimit = undefined
  try {
    await c.currentOnResponse(rateLimitResponse(info), model)
  } catch (error) {
    debug("rate limit: onResponse failed", error)
  }
}

/** The context window Claude Code served, which may differ from the registered one. */
function logServedContextWindow(label: string, message: SdkMessage, model: Model<Api>): void {
  for (const [served, usage] of Object.entries(message.modelUsage ?? {})) {
    debug(
      `${label}: served contextWindow=${usage.contextWindow ?? "?"} servedModel=${served} registered=${model.contextWindow}`,
    )
  }
}

// --- Effort ---

const ReasoningToEffort: Readonly<Record<string, EffortLevel>> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max",
  max: "max",
}

const ValidEfforts = new Set<string>(["low", "medium", "high", "xhigh", "max"])

/**
 * pi's thinking level as Claude Code's effort: the model's own thinkingLevelMap first (pi-ai's
 * per-model overrides), else the table. A null entry is a level the model doesn't take: no effort
 * is given, and Claude Code's default applies.
 */
export function effortForReasoning(
  model: Model<Api>,
  reasoning: string | undefined,
): EffortLevel | undefined {
  if (!reasoning) return undefined
  const mapped = (model.thinkingLevelMap as Readonly<Record<string, string | null>> | undefined)?.[
    reasoning
  ]
  if (mapped === undefined) return ReasoningToEffort[reasoning]
  return mapped !== null && ValidEfforts.has(mapped) ? (mapped as EffortLevel) : undefined
}

// --- Summaries: compaction, branch summaries ---

/**
 * A one-off summary (compaction, branch summary), in a Claude Code of its own that keeps no
 * session, leaving the Session's own Claude Code session to the next turn. pi marks every such
 * call `cacheRetention: "none"`, which is how the stream function routes it here.
 */
export function isolatedStreamFn(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()
  void runIsolatedSummary(model, context, options, stream)
  return stream
}

async function runIsolatedSummary(
  model: Model<Api>,
  rawContext: Context,
  options: SimpleStreamOptions | undefined,
  stream: AssistantMessageEventStream,
): Promise<void> {
  const context = toBridgeContext(rawContext)
  let sdkQuery: ClaudeQuery | undefined
  let wasAborted = false
  const onAbort = () => {
    wasAborted = true
    void sdkQuery?.interrupt().catch(() => {})
    try {
      sdkQuery?.close()
    } catch {
      // Gone already.
    }
  }
  const fail = (message: string) => {
    stream.push({
      type: "error",
      reason: "error",
      error: newAssistantOutput(model, "", "error", message),
    })
    stream.end()
  }
  const aborted = () => {
    stream.push({
      type: "error",
      reason: "aborted",
      error: newAssistantOutput(model, "", "aborted", "Operation aborted"),
    })
    stream.end()
  }

  try {
    const promptText = extractUserPrompt(context.messages)
    if (!promptText) throw new Error("runIsolatedSummary: one-off summary without a user prompt")
    const cwd = sessionCwdFor(summarySessionFor(options?.signal) ?? options?.sessionId)
    const cliModel = claudeCodeModelId(model, defaultLongContext)
    const effort = effortForReasoning(model, options?.reasoning)
    debug(`compact summary: model=${cliModel} effort=${effort ?? "default"}`)

    sdkQuery = bridge.query({
      prompt: promptText,
      options: {
        cwd,
        env: bridge.childEnv(),
        settings: { autoMemoryEnabled: false },
        tools: [],
        strictMcpConfig: true,
        settingSources: [],
        skills: [],
        persistSession: false,
        ...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
        model: cliModel,
        maxTurns: 1,
        ...(effort ? { effort } : {}),
        ...(bridge.settings ? { pathToClaudeCodeExecutable: bridge.settings.executable } : {}),
      },
    })

    if (options?.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener("abort", onAbort, { once: true })
    }

    let assistantText = ""
    let finalText = ""
    let failure: string | undefined

    for await (const raw of sdkQuery) {
      const message = raw as SdkMessage
      if (wasAborted) break
      if (message.type === "assistant") {
        for (const block of message.message?.content ?? []) {
          if (block.type === "text" && typeof block.text === "string") assistantText += block.text
        }
      } else if (message.type === "result") {
        logServedContextWindow("compact summary", message, model)
        failure = resultErrorText(message)
        if (!failure && message.subtype === "success") finalText = message.result || assistantText
      }
    }

    if (wasAborted) return aborted()
    const text = finalText || assistantText
    if (failure || !text.trim()) return fail(failure ?? "Claude Code summary returned empty text")
    stream.push({ type: "done", reason: "stop", message: newAssistantOutput(model, text, "stop") })
    stream.end()
  } catch (error) {
    debug("runIsolatedSummary threw", error)
    // Killing the stopped Claude Code can end the query with a throw: it was still a stop.
    if (wasAborted) aborted()
    else fail(errorText(error))
  } finally {
    options?.signal?.removeEventListener("abort", onAbort)
    try {
      sdkQuery?.close()
    } catch {
      // Gone already.
    }
  }
}

// --- Tools ---

/** The tool calls delivered results may belong to: the query they were emitted in. */
export function contextForToolResults(results: ReadonlyArray<McpResult>): QueryContext | undefined {
  for (const result of results) {
    const id = result.toolCallId
    if (!id) continue
    for (const queryCtx of activeQueryContexts) {
      if (queryCtx.aborted) continue
      if (
        queryCtx.pendingToolCalls.has(id) ||
        queryCtx.pendingResults.has(id) ||
        queryCtx.turnToolCallIds.includes(id)
      )
        return queryCtx
    }
  }
  return undefined
}

/** pi's tools as Claude Code will call them, and the maps between the two names. */
function resolveMcpTools(context: Context): {
  mcpTools: Array<Tool>
  customToolNameToSdk: Map<string, string>
  customToolNameToPi: Map<string, string>
} {
  const mcpTools: Array<Tool> = []
  const customToolNameToSdk = new Map<string, string>()
  const customToolNameToPi = new Map<string, string>()
  for (const tool of context.tools ?? []) {
    const sdkName = `${McpToolPrefix}${tool.name}`
    mcpTools.push(tool)
    customToolNameToSdk.set(tool.name, sdkName)
    customToolNameToSdk.set(tool.name.toLowerCase(), sdkName)
    customToolNameToPi.set(sdkName, tool.name)
    customToolNameToPi.set(sdkName.toLowerCase(), tool.name)
  }
  return { mcpTools, customToolNameToSdk, customToolNameToPi }
}

/**
 * The MCP server serving pi's tools to one query. A handler and pi's result come in either order:
 * a result that comes first waits in `pendingResults`, a handler that comes first parks in
 * `pendingToolCalls`, both by the tool call's id.
 */
export function buildMcpServers(tools: ReadonlyArray<Tool>, queryCtx: QueryContext) {
  if (!tools.length) return undefined
  const mcpTools = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
    handler: async (toolCallId: string) => {
      const queued = queryCtx.pendingResults.get(toolCallId)
      if (queued !== undefined) {
        queryCtx.pendingResults.delete(toolCallId)
        debug(`mcp handler: ${tool.name} [${toolCallId}] → resolved from queue`)
        return queued
      }
      debug(`mcp handler: ${tool.name} [${toolCallId}] → waiting`)
      return new Promise<McpResult>((resolve) => {
        queryCtx.pendingToolCalls.set(toolCallId, { toolName: tool.name, resolve })
      })
    },
  }))
  return { [McpServerName]: createToolServer(McpServerName, mcpTools) }
}

/**
 * The pi tool a Claude tool_use names, or undefined for one not served: the model making up a
 * builtin. Claude Code answers those itself ("No such tool available") and retries under a new
 * id, so one must never reach pi: it would run a tool Claude Code never ran, and deadlock.
 */
function piToolNameFor(name: string, customToolNameToPi: Map<string, string>): string | undefined {
  return customToolNameToPi.get(name) ?? customToolNameToPi.get(name.toLowerCase())
}

/** Claude Code's argument names that differ from pi's own. */
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

/** A tool's arguments as pi takes them: renamed, the rest passed through. */
function mapToolArgs(toolName: string, args: unknown): JsonObject {
  const input = asJsonObject(args)
  const renames = SdkKeyRenames[toolName.toLowerCase()]
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    const piKey = renames?.[key] ?? key
    if (!(piKey in result)) result[piKey] = value // the first alias wins
  }
  // pi's bash has no timeout of its own: Claude Code's default.
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
  debug(
    `usage: in=${u.input} out=${u.output} cacheRead=${u.cacheRead} cacheWrite=${u.cacheWrite} cachePct=${cachePct}% model=${model.id}`,
  )
}

// --- Streaming into pi's turn ---

function claimCurrentPiStream(
  stream: AssistantMessageEventStream,
  label: string,
  c: QueryContext,
  options: SimpleStreamOptions | undefined,
): void {
  if (c.currentPiStream) debug(`WARNING: currentPiStream overwritten before its end (${label})`)
  c.currentPiStream = stream
  c.currentOnResponse = options?.onResponse
}

/** Ends the open turn as the query left it, at the query's end. */
export function finalizeCurrentStream(c: QueryContext): AssistantMessage | undefined {
  const live = c.turnOutput
  if (!live) return undefined
  // Claude asked for a tool pi doesn't serve and nothing else: the turn just stops.
  const stoppedOnUnservedTool =
    live.stopReason === "toolUse" && !live.content.some((block) => block.type === "toolCall")
  return c.endTurn(stoppedOnUnservedTool ? { stopReason: "stop" } : undefined)
}

/** Maps Anthropic stream events onto pi's (text, thinking, tool calls); a tool call ends the turn. */
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
        debug(`processStreamEvent: skipping tool_use for unserved tool ${block.name} [${block.id}]`)
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
      debug("processStreamEvent: unhandled content_block_start type", block?.type)
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
      debug("processStreamEvent: unhandled content_block_delta type", delta?.type)
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
    // A tool call ends pi's turn: pi runs it, then calls again with its result. The SDK still
    // yields this message whole, which finds no turn open and is skipped; the MCP handler holds
    // the query until the result comes.
    if (c.turnSawToolCall) c.endTurn({ stopReason: "toolUse" })
    return
  }

  if (event?.type !== "ping") debug("processStreamEvent: unhandled event type", event?.type)
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
  debug(`dropUnfinishedStreamBlocks: ${why}; dropped ${dropped.toReversed().join(",")}`)
  c.turnToolCallIds = c.turnBlocks.flatMap((b) => (b.type === "toolCall" ? [b.id] : []))
  c.turnSawToolCall = c.turnBlocks.some((b) => b.type === "toolCall")
}

/** Drops the blocks of a stream Claude Code abandoned mid-message, before it asks again. */
function dropAbandonedStreamBlocks(c: QueryContext, why: string): void {
  const dropped = c.turnBlocks.splice(c.turnStreamBlockStart)
  debug(`dropAbandonedStreamBlocks: ${why}; dropped ${dropped.length} blocks`)
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
        debug(`processAssistantMessage: skipping tool_use for unserved tool ${block.name}`)
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
      debug("processAssistantMessage: unhandled block type", block.type)
    }
  }
  if (assistantMsg.usage) recordUsage(c, assistantMsg.usage, model)
  // A tool call ends the turn, as at message_stop.
  if (c.turnSawToolCall) c.endTurn({ stopReason: "toolUse" })
}

/**
 * Reads the query to its end, streaming into whichever turn is open. Per message, the SDK yields
 * stream events, then the whole assistant message; a tool call ends the turn, and the MCP handler
 * holds the query until pi brings the result.
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
      logServedContextWindow("result", message, model)
      resultError = resultErrorText(message)
      if (resultError !== undefined) {
        // Taken with the failure it caused, so a later failure isn't labelled with it.
        if (queryCtx.rateLimitRejection) {
          resultError = describeRateLimitFailure(queryCtx.rateLimitRejection, resultError)
          queryCtx.rateLimitRejection = null
        }
        debug(`consumeQuery: error result, subtype=${message.subtype}, error=${resultError}`)
        // Claude Code wrote its record of the failure into the session: not pi's history.
        queryCtx.failed = true
        // The open turn's, as it streams: its end carries it. With none open, there's no
        // message for it, and none pi holds is touched.
        if (queryCtx.turnOutput) {
          queryCtx.turnOutput.stopReason = "error"
          queryCtx.turnOutput.errorMessage = resultError
        } else {
          diag("query_failed_between_turns", { error: resultError })
        }
      }
    }
    if (message.type === "rate_limit_event") {
      const info = message.rate_limit_info
      debug("consumeQuery: rate_limit_event", JSON.stringify(info ?? null).slice(0, 300))
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
        debug("consumeQuery: unhandled SDK message type", message.type)
        break
    }
  }

  debug(`consumeQuery: done, wasAborted=${wasAborted()}, session=${capturedSessionId?.slice(0, 8)}`)
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
    bridge.piUI?.notify(
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
      bridge.piUI?.notify(
        `Claude rate limit warning: ${percent}% used (${info.rateLimitType ?? ""})`,
        "warning",
      )
    }
  }
}

/**
 * A steer that never reached Claude Code: the cursor counts it already, so the mirror rebuilds,
 * importing it from pi's context.
 */
function steerMissedSession(c: QueryContext, text: string): void {
  c.missedSteer = true
  steerMissed(c.piSessionId)
  debug(`provider: steer never reached Claude Code, marked for rebuild: ${text.slice(0, 60)}`)
}

/**
 * A query stopped before its end (an abort): its Claude Code may still write to the session for a
 * moment. The next sync cuts the session back to where the query began, once that Claude Code has
 * exited; with no checkpoint to cut back to, it rebuilds, as it does should the Claude Code not
 * exit (SessionMirror's `queryStopped`).
 */
function markStopped(
  piSessionId: string | null,
  checkpoint: Checkpoint | undefined,
  capturedSessionId?: string,
): void {
  const next = queryStopped(piSessionId, checkpoint, capturedSessionId)
  if (next !== undefined) debug(`provider: query stopped, ${next} next`)
}

/**
 * Holds the session's next query until the stopped query's Claude Code has exited, and then lets
 * the session file be touched again. One that doesn't exit in time leaves the session to be
 * rebuilt under a new id.
 */
function noteStoppedQuery(piSessionId: string | null, claudeProcess: ProcessWatch): void {
  const settle = (exited: boolean) => {
    stoppedClaudeCodeExited(piSessionId, exited)
    if (!exited) debug("provider: the stopped Claude Code didn't exit; the next query rebuilds")
  }
  // No process, nothing writing.
  if (!claudeProcess.spawned()) return settle(true)
  const key = stoppingKey(piSessionId)
  const stopping = claudeProcess.exited().then((exited) => {
    debug(`provider: the stopped Claude Code ${exited ? "exited" : "is still running"}`)
    settle(exited)
    if (bridge.stoppingQueries.get(key) === stopping) bridge.stoppingQueries.delete(key)
  })
  bridge.stoppingQueries.set(key, stopping)
}

/**
 * Answers the turn's held tool calls with pi's results, after writing any steer to Claude Code.
 *
 * The order matters: the steer and the results go back over the same stdin, and awaiting the
 * steer's write first means Claude Code has it queued before it reads the result, so it reads it
 * at this tool boundary, not as a follow-up.
 */
export async function deliverToolResults(
  c: QueryContext,
  results: ReadonlyArray<McpResult>,
  steer: ReadonlyArray<PromptBlock> | null,
  contextLength: number,
): Promise<void> {
  if (steer) {
    const text = steer.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n")
    if (!c.promptStream) {
      debug(`WARNING: steer with no prompt stream, dropping: ${text.slice(0, 60)}`)
      steerMissedSession(c, text)
    } else {
      try {
        await c.promptStream.push(userMessage(promptContent(steer), "next"))
        debug(`provider: steer written before tool result: ${text.slice(0, 60)}`)
      } catch (error) {
        // The query is ending: the steer stays in pi's context, and the mirror rebuilds with it.
        debug(`provider: steer push rejected, delivering tool result anyway:`, error)
        steerMissedSession(c, text)
      }
    }
  }

  debug(
    `provider: ${results.length} tool results, ${c.pendingToolCalls.size} waiting, msgs=${contextLength}`,
  )
  for (const result of results) {
    const id = result.toolCallId
    const pending = id === undefined ? undefined : c.pendingToolCalls.get(id)
    if (id !== undefined && pending !== undefined) {
      c.pendingToolCalls.delete(id)
      pending.resolve(result)
    } else if (id !== undefined) {
      c.pendingResults.set(id, result)
    } else {
      debug(`WARNING: tool result without toolCallId, cannot match`)
    }
  }
  if (c.pendingToolCalls.size > 0) {
    debug(`WARNING: ${c.pendingToolCalls.size} MCP handlers still waiting`)
    bridge.piUI?.notify(
      `Claude bridge: ${c.pendingToolCalls.size} tool handler(s) still waiting — provider may be stuck`,
      "warning",
    )
  }
}

/**
 * Settles everything an aborted query leaves waiting on the Claude Code about to be killed: the
 * prompt stream's acks (a delivery may be parked on one) and the held tool calls.
 */
export function drainForAbort(c: QueryContext, promptStream: PromptStream): void {
  promptStream.fail(new Error("Operation aborted"))
  c.releasePendingToolCalls("Operation aborted")
}

/** What a continuation query is opened with when pi's history was rewritten under a held turn. */
const ContinueAfterRewritePrompt =
  "[Your context was compacted. What precedes this is a summary plus the most recent messages, " +
  "ending with the tool result you were waiting for. Continue the task from there.]"

/** What a query is opened with for a tool result no query of this process holds (a restart). */
const ContinueAfterResumePrompt =
  "[Your session was interrupted and resumed. What precedes this ends with the tool result " +
  "you were waiting for. Continue the task from there.]"

/**
 * Drops a query held at a tool call whose conversation pi has since rewritten (compaction, tree
 * navigation): answering it would hand Claude Code the context pi just shrank. The caller goes on
 * with a query over the rewritten history, the tool result in it.
 */
export function discardRewrittenQuery(c: QueryContext): void {
  const discarded = c.activeQuery
  if (discarded) abandonedQueries.add(discarded)
  c.activeQuery = null
  activeQueryContexts.delete(c)
  c.turnToolCallIds = []
  c.promptStream?.fail(new Error("conversation rewritten"))
  c.promptStream = null
  c.releasePendingToolCalls("Context was compacted; this query was discarded.")
  void discarded?.interrupt?.().catch(() => {})
  try {
    discarded?.close?.()
  } catch {
    // Gone already.
  }
  c.stop = undefined
  // The killed Claude Code may still write to the session: rotate, as after an abort.
  queryDiscarded(c.piSessionId)
  if (c.piSessionId) historyRewrittenBySession.delete(c.piSessionId)
  debug("provider: history rewritten under a held query — discarded it")
}

/**
 * Claude Code's settings for a turn: none of the instructions files it would load itself (pi gives
 * the model its context files), no git status (its changes would bust the cached prompt each
 * time), and no auto-memory.
 */
const ClaudeMdExcludes = ["**/CLAUDE.md", "**/AGENTS.md", "**/.claude/rules/**"]

/**
 * The provider's stream function: each new prompt, and each tool result, of a Claude Model.
 * Either delivers a turn's tool results to the query holding them, or starts a query.
 */
export function streamClaude(
  model: Model<Api>,
  transcript: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const context = toBridgeContext(transcript)

  // Compaction, branch summaries: a Claude Code of their own.
  if (options?.cacheRetention === "none") return isolatedStreamFn(model, context, options)

  const stream = createAssistantMessageEventStream()
  const lastMsg = context.messages[context.messages.length - 1]
  const lastMsgRole = lastMsg?.role

  const allResults =
    activeQueryContexts.size > 0
      ? extractAllToolResults(context.messages as ReadonlyArray<{ role: string }>).results
      : []
  let resultCtx = allResults.length > 0 ? contextForToolResults(allResults) : undefined

  // pi rewrote the history while the query was held: discard it, and let this result carry the
  // turn into a query over the rewritten history.
  const rewrittenUnderQuery = Boolean(resultCtx?.historyStale)
  if (resultCtx && rewrittenUnderQuery) {
    discardRewrittenQuery(resultCtx)
    resultCtx = undefined
  }

  // --- A held turn's tool results ---
  if (resultCtx) {
    claimCurrentPiStream(stream, "tool-result", resultCtx, options)
    resultCtx.resetTurnState(model)
    // A message steered in while the tool ran comes after its results.
    const steer = lastMsgRole === "user" ? steerBlocks(context.messages) : null
    // After the steer's write, so detached: the stream goes back now.
    void deliverToolResults(resultCtx, allResults, steer, context.messages.length)
    resultsDelivered(resultCtx.piSessionId, context.messages.length)
    resultCtx.latestCursor = Math.max(resultCtx.latestCursor, context.messages.length)
    return stream
  }

  // --- A tool result after an abort ---
  // The query is gone; pi calls back with the run's signal, aborted. The turn ends with an empty
  // message of its own. A result that comes otherwise (a restart) starts a query below.
  const unparkedToolResult = lastMsgRole === "toolResult" && !rewrittenUnderQuery
  if (unparkedToolResult && options?.signal?.aborted) {
    debug(`provider: orphaned tool result after abort, ending the turn`)
    const message = newAssistantOutput(model, "", "stop")
    queueMicrotask(() => {
      stream.push({ type: "done", reason: "stop", message })
      stream.end()
    })
    return stream
  }

  // --- A new query ---
  // In the top-level context, unless another query holds it (a subagent's query while its
  // parent's is held at the agent's tool call): then in a context of its own.
  const topContextBusy = bridge.topContext.activeQuery !== null
  const queryCtx = topContextBusy ? new QueryContext() : bridge.topContext
  const promptWhileTopContextBusy =
    topContextBusy && lastMsgRole === "user" && allResults.length === 0
  debug(`provider: new query, topContextBusy=${topContextBusy}, active=${activeQueryContexts.size}`)

  // The prompt first: one that can't be accounted for fails the turn before anything is claimed.
  const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools(context)
  let promptCapture: PromptCapture | undefined
  let systemPromptAppend: string | undefined
  try {
    promptCapture = promptCaptures.resolveOrDerive(context.systemPrompt)
    systemPromptAppend = promptCapture
      ? projectPromptCapture(promptCapture, {
          skillReadTool: mcpTools.some((tool) => tool.name === "read") ? "mcp" : "none",
        })
      : undefined
  } catch (error) {
    const output = newAssistantOutput(model, "", "error", errorText(error))
    queueMicrotask(() => {
      stream.push({ type: "error", reason: "error", error: output })
      stream.end()
    })
    diag("prompt_capture_unresolved", {
      promptChars: context.systemPrompt?.length ?? 0,
      knownKeys: promptCaptures.size,
      promptWhileTopContextBusy,
      error: errorText(error),
    })
    // As the refusal says: the whole prompt, in the debug log (KNDL_CLAUDE_DEBUG=1).
    debug(`provider: the system prompt refused, in full:\n${context.systemPrompt ?? ""}`)
    return stream
  }

  claimCurrentPiStream(stream, "fresh-query", queryCtx, options)
  queryCtx.heldRateLimit = undefined
  queryCtx.pendingToolCalls.clear()
  queryCtx.pendingResults.clear()
  // Old ids would route a late result from the last query here, its steer into this one's stdin.
  queryCtx.turnToolCallIds = []
  queryCtx.resetTurnState(model)
  queryCtx.latestCursor = 0
  queryCtx.piSessionId = options?.sessionId ?? null
  queryCtx.historyStale = false
  queryCtx.missedSteer = false
  queryCtx.failed = false
  queryCtx.aborted = false
  queryCtx.capturedSessionId = undefined

  const cwd = sessionCwdFor(options?.sessionId)
  const cliModel = claudeCodeModelId(model, defaultLongContext)
  const piSessionId = options?.sessionId ?? null
  const startQuery = (): void => {
    // Read before it's consumed: with no query held, the session's mark is the only sign of a
    // rewrite.
    const historyRewritten =
      rewrittenUnderQuery || (piSessionId !== null && historyRewrittenBySession.has(piSessionId))
    const syncResult = syncSharedSession(
      context.messages,
      cwd,
      customToolNameToSdk,
      cliModel,
      piSessionId,
    )
    if (piSessionId) historyRewrittenBySession.delete(piSessionId)
    const resumeSessionId = syncResult.sessionId
    const promptBlocks = extractUserPromptBlocks(context.messages)
    let promptText = extractUserPrompt(context.messages) ?? ""

    // A turn going on past a rewrite, or a restart, ends at a tool result, not a prompt: say so.
    if (historyRewritten && !promptText && !promptBlocks) promptText = ContinueAfterRewritePrompt
    if (unparkedToolResult && !promptText && !promptBlocks) promptText = ContinueAfterResumePrompt
    if (!promptText && !promptBlocks) {
      diag("empty_prompt", {
        contextLength: context.messages.length,
        lastMsgRole,
        topContextBusy,
        messageRoles: context.messages.map((m, i) => `[${i}]${m.role}`).join(" "),
      })
      promptText = "[continue]"
    }

    // Always a stream, never a string: an open input is what lets a steer reach Claude Code
    // mid-turn. The SDK then doesn't close stdin at the first result: consumeQuery does.
    const promptStream = makePromptStream()
    void promptStream
      .push(userMessage(promptContent(promptBlocks ?? [{ type: "text", text: promptText }])))
      .catch((error: unknown) => debug(`provider: initial prompt push rejected:`, error))
    queryCtx.promptStream = promptStream
    const mcpServers = buildMcpServers(mcpTools, queryCtx)
    const effort = effortForReasoning(model, options?.reasoning)

    // Opus 4.7 and on default to omitted thinking text; summarized makes thinking_delta come.
    const extraArgs: Record<string, string | null> = { model: cliModel }
    if (effort) extraArgs["thinking-display"] = "summarized"

    const claudeProcess = watchProcess(
      bridge.settings?.debug
        ? (text) => {
            for (const line of text.split(/\r?\n/)) if (line) debug(`[claude-code] ${line}`)
          }
        : undefined,
    )

    const queryOptions: Options = {
      cwd,
      env: bridge.childEnv(),
      tools: [],
      permissionMode: "bypassPermissions",
      includePartialMessages: true,
      // Only the mcpServers given: none from `.mcp.json`, settings or plugins.
      strictMcpConfig: true,
      // No settings files: none of a Repo's Claude Code hooks or plugins run in a pi Session.
      settingSources: [],
      settings: {
        autoMemoryEnabled: false,
        claudeMdExcludes: ClaudeMdExcludes,
        includeGitInstructions: false,
      },
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        ...(systemPromptAppend ? { append: systemPromptAppend } : {}),
      },
      extraArgs,
      ...(effort ? { effort } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      ...(bridge.settings ? { pathToClaudeCodeExecutable: bridge.settings.executable } : {}),
      // Spawned by the bridge, which so knows when it has exited (ProcessExit.ts).
      spawnClaudeCodeProcess: claudeProcess.spawn,
    }

    debug(
      "provider: query",
      `model=${cliModel} msgs=${context.messages.length} tools=${mcpTools.length}`,
      `resume=${resumeSessionId?.slice(0, 8) ?? "none"} effort=${effort ?? "default"}`,
      `ctxFiles=${promptCapture?.contextFiles.length ?? 0}`,
    )

    let wasAborted = false
    const sdkQuery = bridge.query({ prompt: promptStream.stream, options: queryOptions })
    const handle: QueryHandle = sdkQuery
    queryCtx.activeQuery = handle
    activeQueryContexts.add(queryCtx)

    const onAbort = () => {
      wasAborted = true
      // Out of the routing set's reach: pi's next call brings the aborted tool's result, which
      // this query mustn't take.
      queryCtx.aborted = true
      drainForAbort(queryCtx, promptStream)
      // interrupt() asks Claude Code to stop, close() kills it: both, or the API call finishes.
      void sdkQuery.interrupt().catch(() => {})
      try {
        sdkQuery.close()
      } catch {
        // Gone already.
      }
    }
    if (options?.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener("abort", onAbort, { once: true })
    }
    // pi's run can end with the query held at a tool call: it is stopped then (runSettled).
    queryCtx.stop = onAbort

    /**
     * The query ran in a Claude Code session of its own, the mirror being a longer history's
     * (`preserveSharedSession`): that session is never resumed, so it goes.
     */
    const deleteOwnSession = (capturedSessionId: string | undefined) => {
      if (!syncResult.preserveSharedSession || capturedSessionId === undefined) return
      if (capturedSessionId === sessionStateFor(queryCtx.piSessionId)?.sessionId) return
      deleteClaudeSession(capturedSessionId, cwd)
      debug(`provider: deleted ephemeral session ${capturedSessionId.slice(0, 8)}`)
    }

    consumeQuery(sdkQuery, customToolNameToPi, model, () => wasAborted, queryCtx)
      .then(({ capturedSessionId }) => {
        queryCtx.stop = undefined
        // Discarded: the query that took over owns the context, the session and the stream.
        if (abandonedQueries.has(handle)) return

        if (wasAborted || options?.signal?.aborted) {
          // A query in a session of its own left the mirror's untouched.
          if (syncResult.preserveSharedSession) deleteOwnSession(capturedSessionId)
          else {
            markStopped(queryCtx.piSessionId, syncResult.checkpoint, capturedSessionId)
            noteStoppedQuery(queryCtx.piSessionId, claudeProcess)
          }
          // The turn open now, if one is, ends aborted, with a new message; a turn that ended
          // already (a tool call pi was running) is pi's, and stays as it is.
          queryCtx.endTurn({ stopReason: "aborted", errorMessage: "Operation aborted" })
          queryCtx.heldRateLimit = undefined
          return
        }

        if (syncResult.preserveSharedSession) deleteOwnSession(capturedSessionId)
        else {
          const sessionId = capturedSessionId ?? sessionStateFor(queryCtx.piSessionId)?.sessionId
          if (sessionId) {
            // A steer that never reached Claude Code is in pi's history only, and a request the
            // API failed left Claude Code's record of the failure in the session: either way the
            // session is cut back to where the query began, and pi's messages since written after
            // it, unless pi rewrote its history meanwhile, which rebuilds.
            const rewrittenSince =
              queryCtx.historyStale ||
              (piSessionId !== null && historyRewrittenBySession.has(piSessionId))
            const cutBack = queryCompleted(queryCtx.piSessionId, {
              sessionId,
              cursor: Math.max(context.messages.length, queryCtx.latestCursor),
              cwd,
              incomplete: queryCtx.missedSteer || queryCtx.failed,
              checkpoint: rewrittenSince ? undefined : syncResult.checkpoint,
            })
            if (cutBack) noteStoppedQuery(queryCtx.piSessionId, claudeProcess)
          }
        }

        if (!topContextBusy && queryCtx.activeQuery === handle) queryCtx.activeQuery = null
        finalizeCurrentStream(queryCtx)
      })
      .catch((error: unknown) => {
        queryCtx.stop = undefined
        debug(`provider: query error, model=${cliModel}, error=`, error)
        if (abandonedQueries.has(handle)) return
        const aborted = wasAborted || options?.signal?.aborted === true
        if (syncResult.preserveSharedSession) {
          // A query in a session of its own left the mirror's untouched.
          deleteOwnSession(queryCtx.capturedSessionId)
          if (aborted) queryCtx.heldRateLimit = undefined
        } else if (aborted) {
          markStopped(queryCtx.piSessionId, syncResult.checkpoint)
          noteStoppedQuery(queryCtx.piSessionId, claudeProcess)
          queryCtx.heldRateLimit = undefined
        } else {
          // The session's state is unknown after the failure: the mirror goes, with its file.
          queryFailed(queryCtx.piSessionId)
        }
        promptStream.fail(error instanceof Error ? error : new Error(String(error)))
        if (!topContextBusy && queryCtx.activeQuery === handle) {
          queryCtx.releasePendingToolCalls("Query ended")
          queryCtx.activeQuery = null
        }
        // The SDK drops a result's text if anything follows it: prefer what consumeQuery took.
        queryCtx.endTurn({
          stopReason: aborted ? "aborted" : "error",
          errorMessage:
            queryCtx.turnOutput?.errorMessage ?? claudeProcess.withStderr(errorText(error)),
        })
      })
      .finally(() => {
        options?.signal?.removeEventListener("abort", onAbort)
        // Settles an ack still parked in the generator: nothing will resume it now.
        promptStream.fail(new Error("query ended"))
        if (queryCtx.promptStream === promptStream) queryCtx.promptStream = null
        // Unless a later query took the context over.
        if (queryCtx.activeQuery === handle || queryCtx.activeQuery === null) {
          queryCtx.releasePendingToolCalls("Query ended")
          queryCtx.activeQuery = null
          activeQueryContexts.delete(queryCtx)
        }
        sdkQuery.close()
      })
  }

  // A query of this session's that stopped may still be writing to its session file: the next
  // waits for its Claude Code to exit before touching it.
  const stopping = bridge.stoppingQueries.get(stoppingKey(piSessionId))
  if (stopping === undefined) {
    startQuery()
    return stream
  }
  debug("provider: waiting for the stopped Claude Code to exit")
  // Held meanwhile, so another session's query doesn't take this context.
  queryCtx.activeQuery = WaitingForExit
  let waiting = true
  const release = () => {
    waiting = false
    options?.signal?.removeEventListener("abort", stoppedWhileWaiting)
    if (queryCtx.activeQuery === WaitingForExit) queryCtx.activeQuery = null
  }
  // A stop while it waits ends the turn now, rather than once the stopped Claude Code has exited.
  function stoppedWhileWaiting() {
    if (!waiting) return
    release()
    queryCtx.endTurn({ stopReason: "aborted", errorMessage: "Operation aborted" })
  }
  if (options?.signal?.aborted) queueMicrotask(stoppedWhileWaiting)
  else options?.signal?.addEventListener("abort", stoppedWhileWaiting, { once: true })
  void stopping.then(() => {
    if (!waiting) return
    release()
    try {
      startQuery()
    } catch (error) {
      // Thrown to pi when it's called at once; here, the turn's end says it.
      debug("provider: query failed to start", error)
      queryCtx.endTurn({ stopReason: "error", errorMessage: errorText(error) })
    }
  })
  return stream
}

// --- A pi session's runs and end ---

/**
 * pi settled a run of `piSessionId` (`agent_settled`): a query still held at a tool call is one pi
 * won't call back, as when its run ended after a tool batch, or failed. It is stopped as an abort
 * stops one, so its Claude Code doesn't live on, and the session's next query takes the top-level
 * context.
 */
export function runSettled(piSessionId: string | null): void {
  for (const c of activeQueryContexts) {
    if (c.piSessionId !== piSessionId || c.currentPiStream !== null || c.stop === undefined)
      continue
    debug(`provider: pi's run settled with its query held at a tool call: stopping it`)
    c.stop()
  }
}

/** The pi session ended: its history-rewrite mark goes with it. */
export function forgetRewriteMark(piSessionId: string): void {
  historyRewrittenBySession.delete(piSessionId)
}
