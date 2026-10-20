// A tool result no query holds is dropped only when its call's signal is aborted already. Otherwise
// (Pi Durable resuming a run after a restart, a retry after a failure, a query the conversation
// was rewritten under) it starts a query that carries the turn on.
//
// Ported from pi-claude-bridge 0.9.3's unit-orphan-result-after-restart tests (MIT, Copyright (c)
// 2026 Eli Dickinson): see THIRD_PARTY_NOTICES.md.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { Api, AssistantMessage, Context, Message, Model, Tool } from "@earendil-works/pi-ai"
import type { ClaudeQuery, QueryFn } from "./Bridge.ts"
import { ClaudeApi } from "./Names.ts"
import { makeBridge, transcriptOf } from "./testing/BridgeTesting.ts"
import type { TestBridge } from "./testing/BridgeTesting.ts"

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

let bridge: TestBridge

/** A fake Claude Code: plays the next script, which ends when the query is closed. */
const query: QueryFn = ({ prompt, options }: { prompt: unknown; options: Options }) => {
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
}

beforeEach(() => {
  calls.length = 0
  scripts.length = 0
  bridge = makeBridge({ claudeDir, query })
})

afterEach(async () => {
  await bridge.close()
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
  bridge.streamSimple(model, transcriptOf(context), options)

/** Starts a query that streams until it's killed, then aborts it, as Esc does. */
async function abortStreaming(sessionId: string, controller: AbortController) {
  scripts.push({
    label: "stopped",
    steps: [init(`cc-${sessionId}`), ...text("Once upon").slice(0, 3), (killed) => killed],
  })
  const first = call({ messages: [user("read a")] }, { sessionId, signal: controller.signal })
  await settle()
  controller.abort()
  expect((await first.result()).stopReason).toBe("aborted")
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

  test("after the conversation was rewritten under its query, tells Claude Code its context was compacted", async () => {
    const tools = [
      { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } },
    ] as unknown as Array<Tool>
    scripts.push(
      { label: "held", steps: [init("cc-held"), ...toolUse("toolu_7"), (killed) => killed] },
      { label: "rebuilt", steps: [init("cc-rebuilt"), ...text("continued"), result("continued")] },
    )
    const ask = user("read a")
    const held = await call({ messages: [ask], tools }, { sessionId: "pi-compacted" }).result()
    expect(held.stopReason).toBe("toolUse")

    // A compaction placed at the tool round's end: the conversation starts with its summary now.
    const summary = user("Summary: we were reading a.")
    await call(
      { messages: [summary, held, toolResult("toolu_7")], tools },
      { sessionId: "pi-compacted" },
    ).result()

    expect(calls.map((c) => c.label)).toEqual(["held", "rebuilt"])
    expect(calls[1]?.prompt).toMatch(/context was compacted/)
  })

  test("with its call aborted already, ends the turn without a query", async () => {
    const controller = new AbortController()
    controller.abort()

    const reply = await call(
      { messages: [user("read a"), toolCall("toolu_2"), toolResult("toolu_2")] },
      { sessionId: "pi-aborted", signal: controller.signal },
    ).result()

    expect(calls.length).toBe(0)
    expect(replyText(reply)).toBe("")
  })

  test("a conversation aborted earlier still resumes a later retry ending at a tool result", async () => {
    await abortStreaming("pi-retry", new AbortController())

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

  test("a held query that fails resumes on the retry, even after an earlier abort (#192)", async () => {
    await abortStreaming("pi-failed", new AbortController())

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
    // The message the caller holds for the tool call is as it was.
    expect(held.stopReason).toBe("toolUse")

    // Pi Durable retries the same history on a new signal.
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
    // The retry is told why, not that the session was interrupted.
    expect(calls[2]?.prompt).toMatch(/last request failed and is being retried/)
    expect(calls[2]?.prompt).not.toMatch(/interrupted and resumed/)
  })

  test("a held query the reaper stopped is told so, not that the session was interrupted", async () => {
    await bridge.close()
    bridge = makeBridge({ claudeDir, query, idleQueryMs: 50 })
    const tools = [
      { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } },
    ] as unknown as Array<Tool>
    scripts.push(
      { label: "held", steps: [init("cc-held"), ...toolUse("toolu_8"), (killed) => killed] },
      { label: "reopened", steps: [init("cc-reopened"), ...text("went on"), result("went on")] },
    )
    const ask = user("read a")
    const held = await call({ messages: [ask], tools }, { sessionId: "pi-reaped" }).result()
    expect(held.stopReason).toBe("toolUse")
    // Nothing comes back to the held call for a while: the reaper stops its query.
    await Bun.sleep(300)
    expect(calls).toHaveLength(1)

    const reply = await call(
      { messages: [ask, held, toolResult("toolu_8")], tools },
      { sessionId: "pi-reaped" },
    ).result()

    expect(calls.map((c) => c.label)).toEqual(["held", "reopened"])
    expect(replyText(reply)).toBe("went on")
    expect(calls[1]?.prompt).toMatch(/waiting a long time for a tool result/)
    expect(calls[1]?.prompt).not.toMatch(/interrupted and resumed/)
  })

  test("a steer that can't be read ends no turn it didn't start", async () => {
    const tools = [
      { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } },
    ] as unknown as Array<Tool>
    scripts.push({
      label: "held",
      steps: [init("cc-held"), ...toolUse("toolu_9"), (killed) => killed],
    })
    const ask = user("read a")
    const held = await call({ messages: [ask], tools }, { sessionId: "pi-malformed" }).result()
    expect(held.stopReason).toBe("toolUse")

    // The steer placed after the tool round is malformed: its content is neither text nor blocks.
    const malformed = { role: "user", content: 42, timestamp: clock++ } as unknown as Message
    expect(() =>
      call(
        { messages: [ask, held, toolResult("toolu_9"), malformed], tools },
        { sessionId: "pi-malformed" },
      ),
    ).toThrow(/user message content must be a string or block array/)
    // No turn was claimed for it: none is left open that nothing will end.
    expect(bridge.contexts.get("pi-malformed")?.currentStream).toBeNull()
  })

  test("an abort in one conversation doesn't orphan another's resumed result", async () => {
    await abortStreaming("pi-other", new AbortController())

    scripts.push({ label: "resumed", steps: [init("cc-mine"), ...text("mine"), result("mine")] })
    const reply = await call(
      { messages: [user("read a"), toolCall("toolu_4"), toolResult("toolu_4")] },
      { sessionId: "pi-mine" },
    ).result()

    expect(calls.length).toBe(2)
    expect(replyText(reply)).toBe("mine")
  })
})
