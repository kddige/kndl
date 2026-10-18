// A scripted stand-in for the Agent SDK's query(), for the Claude bridge's tests: each query plays
// the next script, a list of SDK messages to yield and steps to run between them, such as calling
// one of pi's tools over the query's MCP server, as Claude Code would. close() ends a script,
// as killing Claude Code ends a query.

import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { ClaudeQuery, QueryFn } from "../src/claude/Bridge.ts"
import type { McpResult } from "../src/claude/ToolResults.ts"

/** What a step can do: call a served tool, and know when the query is killed. */
export interface StepContext {
  /** Calls a tool as Claude Code does, over MCP, stamped with its tool_use id. */
  readonly callTool: (name: string, toolUseId: string) => Promise<McpResult>
  /** Settles when the query is closed. */
  readonly killed: Promise<void>
}

export type Step = Record<string, unknown> | ((context: StepContext) => Promise<void>)

export interface Script {
  readonly label: string
  readonly steps: ReadonlyArray<Step>
}

/** One query the bridge made. */
export interface Call {
  readonly label: string
  readonly options: Options
  /** The text of the prompt the query was opened with. */
  prompt?: string | undefined
  /** The text of each message written to the query's input after its prompt. */
  readonly steers: Array<string>
  closed: boolean
}

/** A prompt message's text. */
const promptText = (message: SDKUserMessage | undefined): string | undefined => {
  const content = message?.message.content
  return typeof content === "string"
    ? content
    : (content as Array<{ type: string; text?: string }> | undefined)
        ?.map((block) => block.text ?? "")
        .join("")
}

interface McpInstance {
  readonly connect: (transport: unknown) => Promise<void>
}

interface Transport {
  start: () => Promise<void>
  close: () => Promise<void>
  send: (message: { id?: number; result?: unknown; error?: unknown }) => Promise<void>
  onmessage?: (message: unknown) => void
}

/** Connects to a query's MCP server as the SDK does, and returns how to call its tools. */
async function connect(options: Options): Promise<StepContext["callTool"]> {
  const servers = (options.mcpServers ?? {}) as Record<string, { instance?: McpInstance }>
  const server = Object.values(servers)[0]?.instance
  if (server === undefined) throw new Error("the query serves no tools")
  const pending = new Map<number, (message: { result?: unknown; error?: unknown }) => void>()
  const transport: Transport = {
    start: async () => {},
    close: async () => {},
    send: async (message) => {
      if (message.id !== undefined) pending.get(message.id)?.(message)
    },
  }
  await server.connect(transport)
  let nextId = 0
  const request = (method: string, params: unknown) =>
    new Promise<{ result?: unknown; error?: unknown }>((resolve) => {
      const id = ++nextId
      pending.set(id, resolve)
      transport.onmessage?.({ jsonrpc: "2.0", id, method, params })
    })
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "fake-claude-code", version: "1.0.0" },
  })
  transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/initialized" })
  return async (name, toolUseId) => {
    const response = await request("tools/call", {
      name,
      arguments: {},
      _meta: { "claudecode/toolUseId": toolUseId },
    })
    if (response.error !== undefined) throw new Error(JSON.stringify(response.error))
    return response.result as McpResult
  }
}

export class FakeClaudeCode {
  readonly calls: Array<Call> = []
  readonly scripts: Array<Script> = []

  readonly query: QueryFn = ({ prompt, options }) => {
    const script = this.scripts.shift()
    if (script === undefined) throw new Error("no fake Claude Code script queued")
    const call: Call = { label: script.label, options, closed: false, steers: [] }
    this.calls.push(call)
    let onClose: (() => void) | undefined
    const killed = new Promise<void>((resolve) => {
      onClose = resolve
    })
    const generator = (async function* () {
      if (typeof prompt === "string") call.prompt = prompt
      else {
        const input = prompt[Symbol.asyncIterator]()
        const first = await input.next()
        call.prompt = promptText(first.value as SDKUserMessage | undefined)
        // The rest of the input, read as Claude Code reads its stdin: a steer.
        void (async () => {
          for (let next = await input.next(); !next.done; next = await input.next())
            call.steers.push(promptText(next.value) ?? "")
        })().catch(() => {})
      }
      let callTool: StepContext["callTool"] | undefined
      for (const step of script.steps) {
        if (call.closed) return
        if (typeof step === "function") {
          callTool ??= await connect(options)
          await step({ callTool, killed })
          continue
        }
        yield step
      }
    })()
    return Object.assign(generator, {
      interrupt: async () => {},
      close: () => {
        call.closed = true
        onClose?.()
      },
    }) as unknown as ClaudeQuery
  }
}

// --- SDK messages ---

export const init = (sessionId: string) => ({
  type: "system",
  subtype: "init",
  session_id: sessionId,
})

const event = (e: Record<string, unknown>) => ({ type: "stream_event", event: e })

/** A message that calls one tool, as Claude Code streams it. */
export const toolUse = (id: string, tool: string, input: Record<string, unknown> = {}) => [
  event({ type: "message_start", message: { id: `msg_${id}`, usage: { input_tokens: 10 } } }),
  event({
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id, name: `mcp__custom-tools__${tool}`, input: {} },
  }),
  event({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
  }),
  event({ type: "content_block_stop", index: 0 }),
  event({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }),
  event({ type: "message_stop" }),
]

/** A message of text, as Claude Code streams it. */
export const text = (t: string, id = "msg_text") => [
  event({ type: "message_start", message: { id, usage: { input_tokens: 20 } } }),
  event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }),
  event({ type: "content_block_stop", index: 0 }),
  event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }),
  event({ type: "message_stop" }),
]

export const result = (t: string) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: t,
})

/** A step that calls a tool and waits for its answer, or for the query's killing. */
export const callTool =
  (name: string, toolUseId: string, answered?: (result: McpResult) => void) =>
  async (context: StepContext) => {
    const reply = await Promise.race([
      context.callTool(name, toolUseId),
      context.killed.then(() => undefined),
    ])
    if (reply !== undefined) answered?.(reply)
  }

export interface StreamedToolCall {
  readonly id: string
  readonly tool: string
  readonly input?: Record<string, unknown>
}

/**
 * A message that calls tools, in the order the real Claude Code yields it: a thinking block first
 * if given, each block's whole `assistant` message just before its content_block_stop, and each
 * tool called over MCP as soon as its block is whole (Claude Code's streaming tool execution),
 * without waiting on the answer. Then message_stop and the rate-limit event, and Claude Code waits
 * for every answer, or the query's killing, before it goes on.
 */
export const streamedToolCalls = (
  messageId: string,
  calls: ReadonlyArray<StreamedToolCall>,
  options: { readonly thinking?: string } = {},
): Array<Step> => {
  const replies: Array<Promise<unknown>> = []
  const whole = (block: Record<string, unknown>) => ({
    type: "assistant",
    message: { id: messageId, model: "claude-haiku-5-5", content: [block] },
  })
  const steps: Array<Step> = [
    event({ type: "message_start", message: { id: messageId, usage: { input_tokens: 2 } } }),
  ]
  let index = 0
  if (options.thinking !== undefined) {
    steps.push(
      event({ type: "content_block_start", index, content_block: { type: "thinking" } }),
      { type: "system", subtype: "thinking_tokens" },
      event({
        type: "content_block_delta",
        index,
        delta: { type: "thinking_delta", thinking: options.thinking },
      }),
      event({
        type: "content_block_delta",
        index,
        delta: { type: "signature_delta", signature: "sig" },
      }),
      whole({ type: "thinking", thinking: options.thinking, signature: "sig" }),
      event({ type: "content_block_stop", index }),
    )
    index++
  }
  for (const call of calls) {
    const input = call.input ?? {}
    const name = `mcp__custom-tools__${call.tool}`
    steps.push(
      event({
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: call.id, name, input: {} },
      }),
      event({
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
      }),
      whole({ type: "tool_use", id: call.id, name, input }),
      async (context: StepContext) => {
        replies.push(Promise.race([context.callTool(call.tool, call.id), context.killed]))
      },
      event({ type: "content_block_stop", index }),
    )
    index++
  }
  steps.push(
    event({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 255 },
    }),
    event({ type: "message_stop" }),
    {
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", rateLimitType: "five_hour" },
    },
    async () => {
      await Promise.all(replies)
    },
    ...calls.map((call) => ({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: call.id }] },
    })),
  )
  return steps
}
