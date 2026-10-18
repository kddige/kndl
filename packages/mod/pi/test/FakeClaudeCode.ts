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
  closed: boolean
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
    const call: Call = { label: script.label, options, closed: false }
    this.calls.push(call)
    let onClose: (() => void) | undefined
    const killed = new Promise<void>((resolve) => {
      onClose = resolve
    })
    const generator = (async function* () {
      if (typeof prompt === "string") call.prompt = prompt
      else {
        const first = await prompt[Symbol.asyncIterator]().next()
        const content = (first.value as SDKUserMessage | undefined)?.message.content
        call.prompt =
          typeof content === "string"
            ? content
            : (content as Array<{ type: string; text?: string }> | undefined)
                ?.map((block) => block.text ?? "")
                .join("")
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
