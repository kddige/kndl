// A scripted stand-in for the Agent SDK's query(), for the Claude bridge's tests: each query plays
// the next script, a list of SDK messages to yield and steps to run between them, such as calling
// one of pi's tools over the query's MCP server, as Claude Code would. close() ends a script,
// as killing Claude Code ends a query.
//
// Given Claude Code's state directory, it also keeps a session file as Claude Code does
// (FakeTranscript), and records each query's request as Claude Code would build it from that
// file; and given `process`, it runs a process for each query through the bridge's spawn, which
// goes on writing to the session file for a moment after close(), as a stopped Claude Code does.

import { randomUUID } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { getSessionPath, normalizeProjectPath } from "cc-session-io"
import type { ClaudeQuery, QueryFn } from "../Bridge.ts"
import type { McpResult } from "../ToolResults.ts"

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
  /** With a transcript: the session the query ran in. */
  sessionId?: string | undefined
  /**
   * With a transcript: the query's first request, as Claude Code builds it from its session, one
   * message each (`role:text`, an attachment as `attachment:<type>`).
   */
  request?: ReadonlyArray<string> | undefined
}

export interface FakeClaudeCodeOptions {
  /** Claude Code's state directory: each query keeps its session file in it. */
  readonly claudeDir?: string
  /**
   * Runs a process for each query through `spawnClaudeCodeProcess`, which, after close(), goes on
   * for `lateMs`, writes the end of the stopped turn, and exits.
   */
  readonly process?: { readonly lateMs: number }
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

  constructor(private readonly fakeOptions: FakeClaudeCodeOptions = {}) {}

  readonly query: QueryFn = ({ prompt, options }) => {
    const script = this.scripts.shift()
    if (script === undefined) throw new Error("no fake Claude Code script queued")
    const call: Call = { label: script.label, options, closed: false, steers: [] }
    this.calls.push(call)
    let onClose: (() => void) | undefined
    const killed = new Promise<void>((resolve) => {
      onClose = resolve
    })
    const { claudeDir, process } = this.fakeOptions
    const transcript =
      claudeDir === undefined
        ? undefined
        : new FakeTranscript(claudeDir, options.cwd ?? ".", options.resume)
    call.sessionId = transcript?.sessionId
    const child =
      process === undefined
        ? undefined
        : options.spawnClaudeCodeProcess?.({
            command: "sleep",
            args: ["30"],
            env: {},
            signal: new AbortController().signal,
          })
    let finished = false
    const generator = (async function* () {
      if (typeof prompt === "string") call.prompt = prompt
      else {
        const input = prompt[Symbol.asyncIterator]()
        const first = await input.next()
        call.prompt = promptText(first.value as SDKUserMessage | undefined)
        if (transcript) call.request = transcript.prompt(call.prompt ?? "")
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
          const connected = (callTool ??= await connect(options))
          await step({
            callTool: async (name, toolUseId) => {
              const reply = await connected(name, toolUseId)
              if (!call.closed) transcript?.toolResult(toolUseId)
              return reply
            },
            killed,
          })
          continue
        }
        transcript?.observe(step)
        yield transcript?.withSession(step) ?? step
      }
      if (!call.closed) finished = true
    })()
    return Object.assign(generator, {
      interrupt: async () => {},
      close: () => {
        if (call.closed) return
        call.closed = true
        onClose?.()
        // What Claude Code writes as it stops mid-script: at once, or a moment later by a process.
        const stop = () => {
          if (!finished) transcript?.interrupted()
          child?.kill("SIGTERM")
        }
        if (child === undefined) stop()
        else setTimeout(stop, process?.lateMs ?? 0)
      },
    }) as unknown as ClaudeQuery
  }
}

type Rec = Record<string, unknown>

const Chained = new Set(["user", "assistant", "attachment"])

const readRecords = (path: string): Array<Rec> =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Rec)
    : []

/** A record as the message it makes in Claude Code's request. */
function render(record: Rec): string {
  if (record.type === "attachment") return `attachment:${String((record.attachment as Rec).type)}`
  const message = record.message as { role: string; model?: string; content: string | Array<Rec> }
  const role = message.model === "<synthetic>" ? "synthetic" : message.role
  const content =
    typeof message.content === "string"
      ? message.content
      : message.content
          .map((block) =>
            block.type === "text"
              ? String(block.text)
              : block.type === "tool_use"
                ? `tool_use:${String(block.id)}`
                : block.type === "tool_result"
                  ? `tool_result:${String(block.tool_use_id)}`
                  : `[${String(block.type)}]`,
          )
          .join("\n")
  return `${role}:${content}`
}

/** A Claude Code session file, written as Claude Code writes one, as far as the bridge's tests need. */
export class FakeTranscript {
  readonly sessionId: string
  readonly path: string
  private leaf: string | null
  /** The text block streaming now: written when it ends, or as far as it got when stopped. */
  private open: { text: string } | undefined
  private toolUse: { readonly id: string; readonly name: string } | undefined

  constructor(claudeDir: string, cwd: string, resume: string | undefined) {
    this.sessionId = resume ?? randomUUID()
    this.path = getSessionPath(this.sessionId, normalizeProjectPath(cwd), claudeDir)
    const last = this.chain().at(-1)?.uuid
    this.leaf = typeof last === "string" ? last : null
  }

  /** The records Claude Code resumes, oldest first: the chain back from the file's last message. */
  chain(): Array<Rec> {
    const records = readRecords(this.path)
    const byUuid = new Map(records.map((record) => [record.uuid, record]))
    const chain: Array<Rec> = []
    let record = records.findLast(
      (candidate) => typeof candidate.uuid === "string" && Chained.has(String(candidate.type)),
    )
    for (; record !== undefined; record = byUuid.get(record.parentUuid)) chain.unshift(record)
    return chain
  }

  /** Writes a prompt as Claude Code does, and returns the request it then makes. */
  prompt(text: string): Array<string> {
    this.write({ type: "queue-operation", operation: "enqueue" })
    this.append({ type: "user", message: { role: "user", content: text } })
    this.append({ type: "attachment", attachment: { type: "total_tokens_reminder" } })
    return this.chain().map(render)
  }

  /**
   * Follows the stream, writing each block once it's whole, and the failure reports Claude Code
   * writes as `<synthetic>` assistant messages.
   */
  observe(step: Rec): void {
    const reported = step.message as { model?: unknown; content?: Array<Rec> } | undefined
    if (step.type === "assistant" && reported?.model === "<synthetic>") {
      this.append({
        type: "assistant",
        isApiErrorMessage: true,
        message: { role: "assistant", model: "<synthetic>", content: reported.content ?? [] },
      })
      return
    }
    if (step.type !== "stream_event") return
    const event = step.event as Rec
    const block = event.content_block as Rec | undefined
    const delta = event.delta as Rec | undefined
    if (event.type === "content_block_start" && block?.type === "text") this.open = { text: "" }
    else if (event.type === "content_block_start" && block?.type === "tool_use")
      this.toolUse = { id: String(block.id), name: String(block.name) }
    else if (event.type === "content_block_delta" && delta?.type === "text_delta" && this.open)
      this.open.text += String(delta.text)
    else if (event.type === "content_block_stop") {
      if (this.open) this.assistant([{ type: "text", text: this.open.text }])
      if (this.toolUse)
        this.assistant([
          { type: "tool_use", id: this.toolUse.id, name: this.toolUse.name, input: {} },
        ])
      this.open = undefined
      this.toolUse = undefined
    }
  }

  /** The init message, naming this session. */
  withSession(step: Rec): Rec {
    return step.type === "system" && step.subtype === "init"
      ? { ...step, session_id: this.sessionId }
      : step
  }

  toolResult(id: string): void {
    this.append({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
    })
  }

  /** What a stopped Claude Code writes: the reply as far as it got, and that it was stopped. */
  interrupted(): void {
    if (this.open) this.assistant([{ type: "text", text: this.open.text }])
    this.open = undefined
    this.append({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
    })
  }

  private assistant(content: Array<Rec>): void {
    this.append({ type: "assistant", message: { role: "assistant", content } })
  }

  private append(record: Rec): void {
    const uuid = randomUUID()
    this.write({ ...record, uuid, parentUuid: this.leaf, isSidechain: false })
    this.leaf = uuid
  }

  private write(record: Rec): void {
    mkdirSync(dirname(this.path), { recursive: true })
    appendFileSync(
      this.path,
      `${JSON.stringify({ ...record, sessionId: this.sessionId, timestamp: new Date().toISOString() })}\n`,
    )
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

/** The start of a message of text, as Claude Code streams it, cut off before its end. */
export const partialText = (t: string, id = "msg_partial") => [
  event({ type: "message_start", message: { id, usage: { input_tokens: 20 } } }),
  event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }),
]

/** A step that says it's reached, and waits for the query's killing. */
export const untilKilled =
  (reached?: () => void) =>
  async (context: StepContext): Promise<void> => {
    reached?.()
    await context.killed
  }

export const result = (t: string) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: t,
})

/**
 * A request the API failed, as Claude Code reports it: a `<synthetic>` assistant message with the
 * failure, which it also writes to its session, then a success-shaped result with `is_error`.
 */
export const apiError = (t: string) => [
  {
    type: "assistant",
    message: { id: "msg_synthetic", model: "<synthetic>", content: [{ type: "text", text: t }] },
  },
  { type: "result", subtype: "success", is_error: true, result: t },
]

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
