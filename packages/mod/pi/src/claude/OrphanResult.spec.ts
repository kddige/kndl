// A tool result no query holds is dropped only when pi brings it on an aborted signal, as it does
// after an abort during a tool call. Otherwise (pi resuming a run after a restart, a retry after a
// failure) it starts a query that carries the turn on.
//
// Ported from pi-claude-bridge 0.9.3's unit-orphan-result-after-restart tests (MIT, Copyright (c)
// 2026 Eli Dickinson): see THIRD_PARTY_NOTICES.md.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { Api, AssistantMessage, Context, Message, Model, Tool } from "@earendil-works/pi-ai"
import { bridgeState, resetBridge, setQuery } from "../../test/BridgeTesting.ts"
import { markRebuildForSession, streamClaude } from "./Bridge.ts"
import type { ClaudeQuery } from "./Bridge.ts"
import { ClaudeApi } from "./Names.ts"
import { clearSessionStates, setClaudeDir } from "./SessionMirror.ts"

const claudeDir = mkdtempSync(join(tmpdir(), "kndl-claude-orphan-"))
afterAll(() => rmSync(claudeDir, { recursive: true, force: true }))

const model = {
  id: "claude-haiku-5-5",
  name: "Claude Haiku 5.5",
  api: ClaudeApi,
  provider: "anthropic",
  baseUrl: "claude-code",
  reasoning: false,
  input: ["text"],
  contextWindow: 200_000,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as unknown as Model<Api>

/** A step: an SDK message to yield, or a function to await, given a promise of the kill. */
type Step = Record<string, unknown> | ((killed: Promise<void>) => Promise<unknown>)

interface Call {
  readonly label: string
  readonly resume: string | undefined
  prompt?: string | undefined
}

const calls: Array<Call> = []
const scripts: Array<{ readonly label: string; readonly steps: ReadonlyArray<Step> }> = []

beforeEach(() => {
  resetBridge()
  clearSessionStates()
  setClaudeDir(claudeDir)
  calls.length = 0
  scripts.length = 0
  setQuery(({ prompt, options }: { prompt: unknown; options: Options }) => {
    const script = scripts.shift()
    if (!script) throw new Error("no fake script queued")
    const call: Call = { label: script.label, resume: options.resume }
    calls.push(call)
    // close() is how the bridge kills Claude Code on an abort; it ends a held script.
    let closed = false
    const { promise: killed, resolve: onClose } = Promise.withResolvers<void>()
    const generator = (async function* () {
      const first = await (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]().next()
      const content = (first.value as SDKUserMessage).message.content as Array<{ text?: string }>
      call.prompt = content[0]?.text
      for (const step of script.steps) {
        if (closed) return
        if (typeof step === "function") {
          await step(killed)
          continue
        }
        yield step
      }
    })()
    return Object.assign(generator, {
      interrupt: async () => {},
      close: () => {
        closed = true
        onClose()
      },
    }) as ClaudeQuery
  })
})

afterEach(() => {
  setQuery(null)
  setClaudeDir(undefined)
})

const init = (id: string) => ({ type: "system", subtype: "init", session_id: id })
const ev = (event: Record<string, unknown>) => ({ type: "stream_event", event })
const toolUse = (id: string) => [
  ev({ type: "message_start", message: { id: `msg_${id}`, usage: {} } }),
  ev({
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id, name: "mcp__custom-tools__read", input: {} },
  }),
  ev({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"path":"a"}' },
  }),
  ev({ type: "content_block_stop", index: 0 }),
  ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
  ev({ type: "message_stop" }),
]
const text = (t: string) => [
  ev({ type: "message_start", message: { id: "msg_text", usage: {} } }),
  ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } }),
  ev({ type: "content_block_stop", index: 0 }),
  ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }),
  ev({ type: "message_stop" }),
]
const result = (t: string) => ({ type: "result", subtype: "success", is_error: false, result: t })

let clock = 0
const user = (t: string): Message => ({ role: "user", content: t, timestamp: clock++ })
const toolCall = (id: string): Message => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name: "read", arguments: { path: "a" } }],
  api: ClaudeApi,
  provider: "anthropic",
  model: "claude-haiku-5-5",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "toolUse",
  timestamp: clock++,
})
const toolResult = (id: string): Message => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "read",
  content: [{ type: "text", text: "file" }],
  isError: false,
  timestamp: clock++,
})
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
const replyText = (message: AssistantMessage) =>
  message.content.map((block) => (block.type === "text" ? block.text : "")).join("")
const call = (context: Context, options: Record<string, unknown>) =>
  streamClaude(model, context, options)

/** Starts a query that holds on a tool call until it's killed, then aborts it. */
async function abortHeld(sessionId: string, id: string, controller: AbortController) {
  scripts.push({
    label: "held",
    steps: [init(`cc-${sessionId}`), ...toolUse(id), (killed) => killed],
  })
  const first = call({ messages: [user("read a")] }, { sessionId, signal: controller.signal })
  await settle()
  controller.abort()
  await first.result()
}

describe("a tool result no query holds", () => {
  test("after a restart, starts a query that answers the turn", async () => {
    scripts.push({
      label: "resumed",
      steps: [init("cc-resumed"), ...text("answer after restart"), result("answer after restart")],
    })
    const reply = await call(
      { messages: [user("read a"), toolCall("toolu_1"), toolResult("toolu_1")] },
      { sessionId: "pi-restarted" },
    ).result()

    expect(calls.length).toBe(1)
    expect(calls[0]?.prompt).toMatch(/interrupted and resumed/)
    expect(replyText(reply)).toBe("answer after restart")
  })

  test("after a compaction rewrote the history, tells Claude Code its context was compacted", async () => {
    markRebuildForSession("pi-compacted", "session_compact:overflow")
    scripts.push({
      label: "rebuilt",
      steps: [init("cc-rebuilt"), ...text("continued"), result("continued")],
    })
    await call(
      { messages: [user("read a"), toolCall("toolu_7"), toolResult("toolu_7")] },
      { sessionId: "pi-compacted" },
    ).result()

    expect(calls.length).toBe(1)
    expect(calls[0]?.prompt).toMatch(/context was compacted/)
  })

  test("after an abort, ends the turn without a query", async () => {
    const controller = new AbortController()
    await abortHeld("pi-aborted", "toolu_2", controller)
    bridgeState.activeQueryContexts.clear()

    // pi calls back with the run's signal, aborted.
    const reply = await call(
      { messages: [user("read a"), toolCall("toolu_2"), toolResult("toolu_2")] },
      { sessionId: "pi-aborted", signal: controller.signal },
    ).result()

    expect(calls.length).toBe(1)
    expect(replyText(reply)).toBe("")
  })

  test("a session aborted earlier still resumes a later retry ending at a tool result", async () => {
    await abortHeld("pi-retry", "toolu_5", new AbortController())
    bridgeState.activeQueryContexts.clear()

    scripts.push({
      label: "retry",
      steps: [init("cc-retry"), ...text("resumed"), result("resumed")],
    })
    const reply = await call(
      { messages: [user("read b"), toolCall("toolu_6"), toolResult("toolu_6")] },
      { sessionId: "pi-retry", signal: new AbortController().signal },
    ).result()

    expect(calls.length).toBe(2)
    expect(replyText(reply)).toBe("resumed")
  })

  test("a held query that fails resumes on pi's retry, even after an earlier abort (#192)", async () => {
    await abortHeld("pi-failed", "toolu_8", new AbortController())

    // The query holds on a tool call, then fails (a quota error) once its result comes.
    const { promise: failure, resolve: fail } = Promise.withResolvers<void>()
    scripts.push({
      label: "failing",
      steps: [
        init("cc-failing"),
        ...toolUse("toolu_9"),
        async () => {
          await failure
          throw new Error("rate limit (five_hour)")
        },
      ],
    })
    const ask = user("read b")
    const tools = [
      {
        name: "read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ] as unknown as Array<Tool>
    const held = await call(
      { messages: [ask], tools },
      { sessionId: "pi-failed", signal: new AbortController().signal },
    ).result()
    expect(held.stopReason).toBe("toolUse")
    const history = [ask, held, toolResult("toolu_9")]
    const failing = call(
      { messages: history, tools },
      { sessionId: "pi-failed", signal: new AbortController().signal },
    )
    fail()
    expect((await failing.result()).stopReason).toBe("error")
    await settle()
    // The message pi holds for the tool call is as it was.
    expect(held.stopReason).toBe("toolUse")

    // pi retries the same history on a new signal.
    scripts.push({
      label: "retry",
      steps: [init("cc-retry"), ...text("answer after retry"), result("answer after retry")],
    })
    const reply = await call(
      { messages: history, tools },
      { sessionId: "pi-failed", signal: new AbortController().signal },
    ).result()

    expect(calls.length).toBe(3)
    expect(replyText(reply)).toBe("answer after retry")
  })

  test("an abort in one session doesn't orphan another session's resumed result", async () => {
    await abortHeld("pi-other", "toolu_3", new AbortController())
    bridgeState.activeQueryContexts.clear()

    scripts.push({ label: "resumed", steps: [init("cc-mine"), ...text("mine"), result("mine")] })
    const reply = await call(
      { messages: [user("read a"), toolCall("toolu_4"), toolResult("toolu_4")] },
      { sessionId: "pi-mine" },
    ).result()

    expect(calls.length).toBe(2)
    expect(replyText(reply)).toBe("mine")
  })
})
