// The Claude bridge's stream: the provider for Claude's Models runs Claude Code, through the
// Agent SDK, as a model only (ADR 0029). Claude Code gets none of its own tools (`tools: []`); the
// durable agent's are served to it over an in-process MCP server (ToolServer.ts).
//
// One run of a conversation is one Claude Code query, which the run's requests stream from in
// turn:
// 1. A request brings a prompt: a query starts, resuming Claude Code's mirror of the conversation
//    (SessionMirror.ts), and its messages stream into the request's turn (consumeQuery).
// 2. Claude calls a tool: the turn ends on the tool call, and the MCP call is held open, which
//    holds the query.
// 3. Pi Durable runs the tool and makes the next request with its result: the held call is
//    answered with it, and the query streams into this new turn.
//
// Pi Durable runs many conversations at once in one process (threads, subagents), each with its
// own provider session id on every request: everything the bridge keeps is kept by it, in the
// bridge made by createBridge, so two bridges share nothing either. Nothing tells a provider a run
// ended or a conversation was compacted, so the bridge finds out: a new prompt for a conversation
// stops the query it still holds, a held query no request comes back to is stopped after a while
// (the reaper), and a conversation that doesn't start with the messages a query was given was
// rewritten under it.
//
// No message is changed once the caller has it (QueryState.ts): a turn's terminal event carries a
// copy of its message, and an abort or failure with no turn open ends nothing.
//
// Ported from pi-claude-bridge 0.9.3 (MIT, Copyright (c) 2026 Eli Dickinson): see
// THIRD_PARTY_NOTICES.md.

import type { EffortLevel, Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { createAssistantMessageEventStream, toToolDeclaration } from "@earendil-works/pi-ai"
import type {
  Api,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  Tool,
  TranscriptContext,
} from "@earendil-works/pi-ai"
import type { BridgeLog } from "./Log.ts"
import { claudeCodeModelId, defaultLongContext } from "./Models.ts"
import { McpServerName, McpToolPrefix } from "./Names.ts"
import { watchProcess } from "./ProcessExit.ts"
import type { ProcessWatch } from "./ProcessExit.ts"
import {
  assertSendablePrompt,
  extractUserPrompt,
  extractUserPromptBlocks,
  promptContent,
  steerBlocks,
  toBridgeContext,
} from "./Prompt.ts"
import type { BridgeContext, PromptBlock } from "./Prompt.ts"
import { makePromptStream, userMessage } from "./PromptStream.ts"
import type { PromptStream } from "./PromptStream.ts"
import { newAssistantOutput, QueryContext } from "./QueryState.ts"
import type { Notice, QueryHandle } from "./QueryState.ts"
import type { Checkpoint } from "./Rewind.ts"
import { prefixHash } from "./SessionMirror.ts"
import type { SessionMirrors } from "./SessionMirror.ts"
import {
  claimCurrentPiStream,
  consumeQuery,
  errorText,
  finalizeCurrentStream,
  logServedContextWindow,
  resultErrorText,
} from "./Stream.ts"
import type { SdkMessage } from "./Stream.ts"
import { extractAllToolResults, hasAbortedResult } from "./ToolResults.ts"
import type { McpResult } from "./ToolResults.ts"
import { createToolServer } from "./ToolServer.ts"

/** A Claude Code query, as the bridge drives it: what the SDK's `query()` returns. */
export type ClaudeQuery = AsyncIterable<unknown> & {
  readonly interrupt: () => Promise<unknown>
  readonly close: () => void
}

/** How the bridge starts a query: the SDK's `query()`, or a test's fake Claude Code. */
export type QueryFn = (params: {
  readonly prompt: string | AsyncIterable<SDKUserMessage>
  readonly options: Options
}) => ClaudeQuery

/** What a bridge runs Claude Code as and with. */
export interface BridgeConfig {
  /** The pinned Claude Code's executable, never the SDK's bundled one. */
  readonly claudeCodePath: string
  /** The environment every Claude Code runs with, whole (Settings.ts). */
  readonly childEnv: Readonly<Record<string, string>>
  /** The working directory of a conversation's Claude Code, by its provider session id. */
  readonly cwd: (sessionId: string | undefined) => string
  readonly mirrors: SessionMirrors
  readonly log: BridgeLog
  readonly notice: Notice
  readonly query: QueryFn
  /** How long a query held at a tool call waits for its results before it is stopped. */
  readonly idleQueryMs: number
}

/** A bridge: the provider's stream, and what ends the queries it holds. */
export interface Bridge {
  readonly streamSimple: (
    model: Model<Api>,
    transcript: TranscriptContext,
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStream
  /** Stops the conversation's query, if one is held, and deletes its mirror. */
  readonly forget: (sessionId: string) => void
  /** Stops every query, and waits for their Claude Codes to exit. */
  readonly close: () => Promise<void>
  /** The query context of each conversation, by provider session id: for tests to look at. */
  readonly contexts: ReadonlyMap<string, QueryContext>
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
 * A thinking level as Claude Code's effort: the model's own thinkingLevelMap first (pi-ai's
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

// --- Tools ---

/** The agent's tools as Claude Code will call them, and the maps between the two names. */
function resolveMcpTools(context: BridgeContext): {
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

/** The tools' declarations as one string: a query's MCP server serves the ones it opened with. */
const toolsKeyOf = (tools: ReadonlyArray<Tool> | undefined) =>
  JSON.stringify((tools ?? []).map(toToolDeclaration))

/**
 * The MCP server serving the agent's tools to one query. A handler and the tool's result come in
 * either order: a result that comes first waits in `pendingResults`, a handler that comes first
 * parks in `pendingToolCalls`, both by the tool call's id.
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
        queryCtx.log.debug(`mcp handler: ${tool.name} [${toolCallId}] → resolved from queue`)
        return queued
      }
      queryCtx.log.debug(`mcp handler: ${tool.name} [${toolCallId}] → waiting`)
      return new Promise<McpResult>((resolve) => {
        queryCtx.pendingToolCalls.set(toolCallId, { toolName: tool.name, resolve })
      })
    },
  }))
  return { [McpServerName]: createToolServer(McpServerName, mcpTools) }
}

/** Whether `results` answer the tool calls `c`'s query is held at. */
function holdsCallsOf(c: QueryContext, results: ReadonlyArray<McpResult>): boolean {
  return results.some(
    ({ toolCallId: id }) =>
      id !== undefined &&
      (c.pendingToolCalls.has(id) || c.pendingResults.has(id) || c.turnToolCallIds.includes(id)),
  )
}

/**
 * Answers the turn's held tool calls with the agent's results, after writing any steer to Claude
 * Code. `steerMissed` is told of a steer that never reached it.
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
  steerMissed: (text: string) => void = () => {},
): Promise<void> {
  if (steer) {
    const text = steer.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n")
    if (!c.promptStream) {
      c.log.debug(`WARNING: steer with no prompt stream, dropping: ${text.slice(0, 60)}`)
      c.missedSteer = true
      steerMissed(text)
    } else {
      try {
        await c.promptStream.push(userMessage(promptContent(steer), "next"))
        c.log.debug(`provider: steer written before tool result: ${text.slice(0, 60)}`)
      } catch (error) {
        // The query is ending: the steer stays in the conversation, and the mirror rebuilds with it.
        c.log.debug(`provider: steer push rejected, delivering tool result anyway:`, error)
        c.missedSteer = true
        steerMissed(text)
      }
    }
  }

  c.log.debug(
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
      c.log.debug(`WARNING: tool result without toolCallId, cannot match`)
    }
  }
  if (c.pendingToolCalls.size > 0) {
    c.log.debug(`WARNING: ${c.pendingToolCalls.size} MCP handlers still waiting`)
    c.notice(
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

/** What a query is opened with when the conversation was rewritten under a held turn. */
const ContinueAfterRewritePrompt =
  "[Your context was compacted. What precedes this is a summary plus the most recent messages, " +
  "ending with the tool result you were waiting for. Continue the task from there.]"

/** What a query is opened with for a tool result no query holds (a restart, a reaped query). */
const ContinueAfterResumePrompt =
  "[Your session was interrupted and resumed. What precedes this ends with the tool result " +
  "you were waiting for. Continue the task from there.]"

/** What a query is opened with when the tools changed under a held turn (one tool_search loaded). */
const ContinueAfterToolsChangedPrompt =
  "[The tools available to you changed. What precedes this ends with the tool result you were " +
  "waiting for. Continue the task from there.]"

/**
 * Claude Code's settings for a turn: none of the instructions files it would load itself (the
 * agent's prompt has its context files), no git status (its changes would bust the cached prompt
 * each time), and no auto-memory.
 */
const ClaudeMdExcludes = ["**/CLAUDE.md", "**/AGENTS.md", "**/.claude/rules/**"]

/** What holds a context while its query waits for the stopped one's Claude Code to exit. */
const WaitingForExit: QueryHandle = {}

const sessionKey = (sessionId: string | undefined) => sessionId ?? "(none)"

/** A turn that ends at once, with `stopReason` (and the error, for an error). */
function endedAtOnce(
  model: Model<Api>,
  stopReason: "stop" | "error",
  errorMessage?: string,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()
  const message = newAssistantOutput(model, "", stopReason, errorMessage)
  queueMicrotask(() => {
    stream.push(
      stopReason === "error"
        ? { type: "error", reason: "error", error: message }
        : { type: "done", reason: "stop", message },
    )
    stream.end()
  })
  return stream
}

/** Makes a bridge: its own queries, mirrors and reaper, which `close()` ends. */
export function createBridge(config: BridgeConfig): Bridge {
  const { log, mirrors } = config

  /** Each conversation's latest query context, by provider session id. */
  const contexts = new Map<string, QueryContext>()
  /**
   * Per conversation, the stopped query whose Claude Code may still be writing to the session
   * file: settles once it has exited, or given up on. The conversation's next query waits for it.
   */
  const stoppingQueries = new Map<string, Promise<void>>()
  /** Queries the conversation moved out from under: their ending touches neither mirror nor stream. */
  const abandonedQueries = new WeakSet<object>()
  let closed = false

  // Queries held at a tool call that no request came back to: the run ended without one (a tool
  // that ends it, a reset, a failure), or Pi Durable went on with another model.
  const reaper = setInterval(
    () => {
      const now = Date.now()
      for (const c of contexts.values()) {
        if (c.activeQuery === null || c.activeQuery === WaitingForExit || c.currentPiStream)
          continue
        if (now - c.idleSince < config.idleQueryMs) continue
        log.debug(`reaper: no call came back to ${c.piSessionId}'s held query: stopping it`)
        c.stop?.()
      }
    },
    Math.min(60_000, Math.max(50, config.idleQueryMs / 4)),
  )
  reaper.unref?.()

  /**
   * A query stopped before its end (an abort): its Claude Code may still write to the session for
   * a moment. The next sync cuts the session back to where the query began, once that Claude Code
   * has exited; with no checkpoint to cut back to, it rebuilds, as it does should the Claude Code
   * not exit (SessionMirrors' `queryStopped`).
   */
  const markStopped = (
    key: string,
    cwd: string,
    checkpoint: Checkpoint | undefined,
    capturedSessionId: string | undefined,
  ): void => {
    const next = mirrors.queryStopped(key, checkpoint, capturedSessionId, cwd)
    if (next !== undefined) log.debug(`provider: query stopped, ${next} next`)
  }

  /**
   * Holds the conversation's next query until the stopped query's Claude Code has exited, and then
   * lets the session file be touched again. One that doesn't exit in time leaves the session to be
   * rebuilt under a new id.
   */
  const noteStoppedQuery = (key: string, claudeProcess: ProcessWatch): void => {
    const settle = (exited: boolean) => {
      mirrors.stoppedClaudeCodeExited(key, exited)
      if (!exited)
        log.debug("provider: the stopped Claude Code didn't exit; the next query rebuilds")
    }
    // No process, nothing writing.
    if (!claudeProcess.spawned()) return settle(true)
    const stopping = claudeProcess.exited().then((exited) => {
      log.debug(`provider: the stopped Claude Code ${exited ? "exited" : "is still running"}`)
      settle(exited)
      if (stoppingQueries.get(key) === stopping) stoppingQueries.delete(key)
    })
    stoppingQueries.set(key, stopping)
  }

  /**
   * Drops a query held at a tool call whose conversation was since rewritten (a compaction placed
   * during the tool round): answering it would hand Claude Code the context Pi Durable just
   * shrank. The caller goes on with a query over the rewritten conversation, the tool result in it.
   */
  const discardRewrittenQuery = (c: QueryContext): void => {
    const discarded = c.activeQuery
    if (discarded) abandonedQueries.add(discarded)
    c.activeQuery = null
    c.aborted = true
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
    mirrors.queryDiscarded(c.piSessionId)
    log.debug("provider: conversation rewritten under a held query — discarded it")
  }

  /**
   * A one-off summary (compaction), in a Claude Code of its own that keeps no session, leaving the
   * conversation's own Claude Code session to the next turn. Pi Durable marks every such call
   * `cacheRetention: "none"`, which is how the stream function routes it here.
   */
  const isolatedSummary = (
    model: Model<Api>,
    context: BridgeContext,
    options: SimpleStreamOptions | undefined,
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream()
    void runIsolatedSummary(model, context, options, stream)
    return stream
  }

  async function runIsolatedSummary(
    model: Model<Api>,
    context: BridgeContext,
    options: SimpleStreamOptions | undefined,
    stream: AssistantMessageEventStream,
  ): Promise<void> {
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
      const cliModel = claudeCodeModelId(model, defaultLongContext)
      const effort = effortForReasoning(model, options?.reasoning)
      log.debug(`compact summary: model=${cliModel} effort=${effort ?? "default"}`)

      sdkQuery = config.query({
        prompt: promptText,
        options: {
          cwd: config.cwd(options?.sessionId),
          env: { ...config.childEnv },
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
          pathToClaudeCodeExecutable: config.claudeCodePath,
        },
      })

      // One request in one invocation of the compaction task: its signal is the call's throughout.
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
          logServedContextWindow(log, "compact summary", message, model)
          failure = resultErrorText(message)
          if (!failure && message.subtype === "success") finalText = message.result || assistantText
        }
      }

      if (wasAborted) return aborted()
      const text = finalText || assistantText
      if (failure || !text.trim()) return fail(failure ?? "Claude Code summary returned empty text")
      stream.push({
        type: "done",
        reason: "stop",
        message: newAssistantOutput(model, text, "stop"),
      })
      stream.end()
    } catch (error) {
      log.debug("runIsolatedSummary threw", error)
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

  /**
   * The provider's stream function: each new prompt, and each tool result, of a Claude Model.
   * Either delivers a turn's tool results to the query holding them, or starts a query.
   */
  const streamClaude = (
    model: Model<Api>,
    transcript: TranscriptContext,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const context = toBridgeContext(transcript.messages)

    // Compaction: a Claude Code of its own.
    if (options?.cacheRetention === "none") return isolatedSummary(model, context, options)
    if (closed) return endedAtOnce(model, "error", "The Claude bridge is closed")

    const key = sessionKey(options?.sessionId)
    const lastMsgRole = context.messages.at(-1)?.role
    const held = contexts.get(key)
    const holding = held !== undefined && held.activeQuery !== null && !held.aborted
    const allResults = extractAllToolResults(context.messages).results
    const toolsKey = toolsKeyOf(context.tools)

    // --- A held turn's tool results, or why they can't go to it ---
    let rewrittenUnderQuery = false
    let toolsChanged = false
    /** Why the query the conversation holds is stopped, when it is: a new run's start. */
    let superseding = "a new prompt"
    if (
      holding &&
      held.activeQuery !== WaitingForExit &&
      held.currentPiStream === null &&
      allResults.length > 0 &&
      holdsCallsOf(held, allResults)
    ) {
      if (prefixHash(context.messages, held.latestHistory.length) !== held.latestPrefixHash) {
        // The conversation was rewritten while the query was held (a compaction placed at the tool
        // round's end): discard it, and let this result carry the turn into a query over the
        // rewritten conversation.
        rewrittenUnderQuery = true
        discardRewrittenQuery(held)
      } else if (hasAbortedResult(context.messages)) {
        // The run was stopped while its tools ran, and this is the next run's prompt: the query
        // the stopped run left is stopped below, as Esc would have stopped it while it streamed.
        superseding = "a tool result of a stopped run"
      } else if (held.toolsKey !== toolsKey) {
        // The query's MCP server serves the tools it opened with: one that loaded since (a
        // tool_search) couldn't be called. Stopped below, and a query with the new tools goes on.
        superseding = "the tools changed"
        toolsChanged = true
      } else {
        const stream = createAssistantMessageEventStream()
        claimCurrentPiStream(stream, "tool-result", held, options)
        held.resetTurnState(model)
        // This call's signal stops the query while its turn is open: the last turn's was the
        // generation task's that ended with it.
        held.bindSignal(options?.signal)
        held.idleSince = Date.now()
        // A message steered in while the tool ran comes after its results.
        const steer = lastMsgRole === "user" ? steerBlocks(context.messages, log) : null
        // After the steer's write, so detached: the stream goes back now.
        void deliverToolResults(held, allResults, steer, context.messages.length, () =>
          mirrors.steerMissed(held.piSessionId),
        )
        mirrors.resultsDelivered(held.piSessionId, context.messages)
        held.latestHistory = context.messages
        held.latestPrefixHash = prefixHash(context.messages, context.messages.length)
        return stream
      }
    }

    // --- A tool result after an abort ---
    // A result that comes with its call's signal aborted already ends with an empty message of
    // its own. One that comes otherwise (a restart, a reaped or superseded query) starts a query
    // below.
    const unparkedToolResult = lastMsgRole === "toolResult" && !rewrittenUnderQuery
    if (unparkedToolResult && options?.signal?.aborted) {
      log.debug(`provider: tool result with its call aborted, ending the turn`)
      return endedAtOnce(model, "stop")
    }

    // --- A new query ---
    // The prompt first: one that can't be sent fails the turn before anything is claimed.
    try {
      assertSendablePrompt(context.systemPrompt)
    } catch (error) {
      log.diag("prompt_refused", {
        promptChars: context.systemPrompt?.length ?? 0,
        error: errorText(error),
      })
      // As the refusal says: the whole prompt, in the debug log (KNDL_CLAUDE_DEBUG=1).
      log.debug(`provider: the system prompt refused, in full:\n${context.systemPrompt ?? ""}`)
      return endedAtOnce(model, "error", errorText(error))
    }

    // A query the conversation still holds is the last run's: it ends with this one's start.
    if (holding && held.stop !== undefined) {
      log.debug(`provider: ${superseding} for ${key}: stopping the query it held`)
      held.stop()
    }

    const stream = createAssistantMessageEventStream()
    const queryCtx = new QueryContext(log, config.notice)
    if (held) {
      queryCtx.lastRateLimitWarnStep = held.lastRateLimitWarnStep
      queryCtx.lastRateLimitWarnThreshold = held.lastRateLimitWarnThreshold
    }
    contexts.set(key, queryCtx)
    claimCurrentPiStream(stream, "fresh-query", queryCtx, options)
    queryCtx.resetTurnState(model)
    queryCtx.piSessionId = key
    queryCtx.latestHistory = context.messages
    queryCtx.latestPrefixHash = prefixHash(context.messages, context.messages.length)
    queryCtx.toolsKey = toolsKey
    queryCtx.idleSince = Date.now()

    const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools(context)
    const cwd = config.cwd(options?.sessionId)
    const cliModel = claudeCodeModelId(model, defaultLongContext)
    let settle!: () => void
    queryCtx.settled = new Promise<void>((resolve) => {
      settle = resolve
    })

    const startQuery = (): void => {
      const syncResult = mirrors.sync(context.messages, cwd, customToolNameToSdk, cliModel, key)
      const resumeSessionId = syncResult.sessionId
      // What of the user turn the session doesn't hold already.
      const promptMessages = context.messages.slice(syncResult.promptFrom)
      const promptBlocks = extractUserPromptBlocks(promptMessages, log)
      let promptText = extractUserPrompt(promptMessages) ?? ""

      // A turn going on past a rewrite, a restart, or a change of tools ends at a tool result, not
      // a prompt: say so.
      if (!promptText && !promptBlocks) {
        if (rewrittenUnderQuery) promptText = ContinueAfterRewritePrompt
        else if (toolsChanged) promptText = ContinueAfterToolsChangedPrompt
        else if (unparkedToolResult) promptText = ContinueAfterResumePrompt
      }
      if (!promptText && !promptBlocks) {
        log.diag("empty_prompt", {
          contextLength: context.messages.length,
          lastMsgRole,
          messageRoles: context.messages.map((m, i) => `[${i}]${m.role}`).join(" "),
        })
        promptText = "[continue]"
      }

      // Always a stream, never a string: an open input is what lets a steer reach Claude Code
      // mid-turn. The SDK then doesn't close stdin at the first result: consumeQuery does.
      const promptStream = makePromptStream()
      void promptStream
        .push(userMessage(promptContent(promptBlocks ?? [{ type: "text", text: promptText }])))
        .catch((error: unknown) => log.debug(`provider: initial prompt push rejected:`, error))
      queryCtx.promptStream = promptStream
      const mcpServers = buildMcpServers(mcpTools, queryCtx)
      const effort = effortForReasoning(model, options?.reasoning)

      // Opus 4.7 and on default to omitted thinking text; summarized makes thinking_delta come.
      const extraArgs: Record<string, string | null> = { model: cliModel }
      if (effort) extraArgs["thinking-display"] = "summarized"

      const claudeProcess = watchProcess(
        log.debugEnabled
          ? (text) => {
              for (const line of text.split(/\r?\n/)) if (line) log.debug(`[claude-code] ${line}`)
            }
          : undefined,
      )

      const queryOptions: Options = {
        cwd,
        env: { ...config.childEnv },
        tools: [],
        permissionMode: "bypassPermissions",
        includePartialMessages: true,
        // Only the mcpServers given: none from `.mcp.json`, settings or plugins.
        strictMcpConfig: true,
        // No settings files: none of a Repo's Claude Code hooks or plugins run in a Session.
        settingSources: [],
        settings: {
          autoMemoryEnabled: false,
          claudeMdExcludes: ClaudeMdExcludes,
          includeGitInstructions: false,
        },
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          ...(context.systemPrompt ? { append: context.systemPrompt } : {}),
        },
        extraArgs,
        ...(effort ? { effort } : {}),
        ...(mcpServers ? { mcpServers } : {}),
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        pathToClaudeCodeExecutable: config.claudeCodePath,
        // Spawned by the bridge, which so knows when it has exited (ProcessExit.ts).
        spawnClaudeCodeProcess: claudeProcess.spawn,
      }

      log.debug(
        "provider: query",
        `session=${key} model=${cliModel} msgs=${context.messages.length} tools=${mcpTools.length}`,
        `resume=${resumeSessionId?.slice(0, 8) ?? "none"} effort=${effort ?? "default"}`,
      )

      let wasAborted = false
      const sdkQuery = config.query({ prompt: promptStream.stream, options: queryOptions })
      const handle: QueryHandle = sdkQuery
      queryCtx.activeQuery = handle

      const onAbort = () => {
        if (wasAborted) return
        wasAborted = true
        // Out of the routing's reach: the next call may bring the aborted tool's result, which
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
      // The open turn's call's signal, and anything that ends the query held (a new prompt, the
      // reaper, forget, close), stop it.
      queryCtx.stop = onAbort
      if (queryCtx.signalAborted) onAbort()

      consumeQuery(sdkQuery, customToolNameToPi, model, () => wasAborted, queryCtx)
        .then(({ capturedSessionId }) => {
          queryCtx.stop = undefined
          // Discarded: the query that took over owns the session and the stream.
          if (abandonedQueries.has(handle)) return

          if (wasAborted) {
            markStopped(key, cwd, syncResult.checkpoint, capturedSessionId)
            noteStoppedQuery(key, claudeProcess)
            // The turn open now, if one is, ends aborted, with a new message; a turn that ended
            // already (a tool call the agent was running) is the caller's, and stays as it is.
            queryCtx.endTurn({ stopReason: "aborted", errorMessage: "Operation aborted" })
            queryCtx.heldRateLimit = undefined
            return
          }

          const sessionId = capturedSessionId ?? mirrors.state(key)?.sessionId
          if (sessionId) {
            // A steer that never reached Claude Code is in the conversation only, and a request
            // the API failed left Claude Code's record of the failure in the session: either way
            // the session is cut back to where the query began, and the messages since written
            // after it.
            const cutBack = mirrors.queryCompleted(key, {
              sessionId,
              history: queryCtx.latestHistory,
              cwd,
              incomplete: queryCtx.missedSteer || queryCtx.failed,
              checkpoint: syncResult.checkpoint,
            })
            if (cutBack) noteStoppedQuery(key, claudeProcess)
          }

          if (queryCtx.activeQuery === handle) queryCtx.activeQuery = null
          finalizeCurrentStream(queryCtx)
        })
        .catch((error: unknown) => {
          queryCtx.stop = undefined
          log.debug(`provider: query error, model=${cliModel}, error=`, error)
          if (abandonedQueries.has(handle)) return
          if (wasAborted) {
            markStopped(key, cwd, syncResult.checkpoint, queryCtx.capturedSessionId)
            noteStoppedQuery(key, claudeProcess)
            queryCtx.heldRateLimit = undefined
          } else {
            // The session's state is unknown after the failure: the mirror goes, with its file.
            mirrors.queryFailed(key)
          }
          promptStream.fail(error instanceof Error ? error : new Error(String(error)))
          if (queryCtx.activeQuery === handle) {
            queryCtx.releasePendingToolCalls("Query ended")
            queryCtx.activeQuery = null
          }
          // The SDK drops a result's text if anything follows it: prefer what consumeQuery took.
          queryCtx.endTurn({
            stopReason: wasAborted ? "aborted" : "error",
            errorMessage:
              queryCtx.turnOutput?.errorMessage ?? claudeProcess.withStderr(errorText(error)),
          })
        })
        .finally(() => {
          queryCtx.unbindSignal()
          // Settles an ack still parked in the generator: nothing will resume it now.
          promptStream.fail(new Error("query ended"))
          if (queryCtx.promptStream === promptStream) queryCtx.promptStream = null
          queryCtx.releasePendingToolCalls("Query ended")
          queryCtx.activeQuery = null
          queryCtx.stop = undefined
          queryCtx.latestHistory = []
          sdkQuery.close()
          settle()
        })
    }

    // The signal of this call stops the query, or the wait before it, while this turn is open.
    // The wait: for the query this one superseded to end, and then for a stopped query's Claude
    // Code to exit, as it may still be writing to the session file.
    queryCtx.activeQuery = WaitingForExit
    let waiting = true
    const stoppedWhileWaiting = () => {
      if (!waiting) return
      waiting = false
      queryCtx.activeQuery = null
      queryCtx.aborted = true
      queryCtx.stop = undefined
      // Rather than once the stopped Claude Code has exited.
      queryCtx.endTurn({ stopReason: "aborted", errorMessage: "Operation aborted" })
      settle()
    }
    queryCtx.stop = stoppedWhileWaiting
    queryCtx.bindSignal(options?.signal)
    if (!waiting) return stream

    const start = () => {
      if (!waiting) return
      waiting = false
      queryCtx.activeQuery = null
      queryCtx.stop = undefined
      try {
        startQuery()
      } catch (error) {
        // Thrown to the caller when it's called at once; here, the turn's end says it.
        log.debug("provider: query failed to start", error)
        queryCtx.endTurn({ stopReason: "error", errorMessage: errorText(error) })
        settle()
      }
    }
    // Any query of the conversation's still going, stopped or not, ends before this one starts.
    const before = held !== undefined && held.activeQuery !== null ? held.settled : undefined
    if (before === undefined && !stoppingQueries.has(key)) {
      start()
      return stream
    }
    log.debug("provider: waiting for the query before to end, and its Claude Code to exit")
    void (async () => {
      await before
      await stoppingQueries.get(key)
      start()
    })()
    return stream
  }

  const stopAll = () => {
    for (const c of contexts.values()) c.stop?.()
  }

  return {
    streamSimple: streamClaude,
    contexts,
    forget: (sessionId) => {
      const key = sessionKey(sessionId)
      const c = contexts.get(key)
      c?.stop?.()
      contexts.delete(key)
      // Once its Claude Code is gone, which might write the file again.
      void (async () => {
        await c?.settled
        await stoppingQueries.get(key)
        mirrors.forget(key)
        log.debug(`forget: ${key}`)
      })()
    },
    close: async () => {
      if (closed) return
      closed = true
      clearInterval(reaper)
      stopAll()
      await Promise.all([...contexts.values()].map((c) => c.settled))
      await Promise.all(stoppingQueries.values())
    },
  }
}
