// What Claude Code's query yields, as pi's turns see it: failures, stalled and cut streams, tool
// calls pi doesn't serve, and real recorded streams. Ported from pi-claude-bridge 0.9.3's
// unit-error-result, unit-nonstreaming-fallback, unit-unfinished-tool-call, unit-unserved-tool-use,
// unit-stream-replay and unit-querycontext tests (MIT, Copyright (c) 2026 Eli Dickinson): see
// THIRD_PARTY_NOTICES.md.
//
// Unlike the reference, a turn's message is a copy once it ends (QueryState.ts), and the context
// keeps no message for an ended turn: these read an ended turn's message off its terminal event.

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { isRetryableAssistantError } from "@earendil-works/pi-ai"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import {
  consume,
  ended,
  makeCtx,
  streamEvent,
  terminal,
  testModel,
  types,
} from "../../test/StreamHarness.ts"
import { finalizeCurrentStream, resultErrorText } from "./Bridge.ts"
import { QueryContext } from "./QueryState.ts"
import type { LiveBlock } from "./QueryState.ts"

const bashMap = new Map([["mcp__custom-tools__bash", "bash"]])

const errorResult = {
  type: "result",
  subtype: "success",
  is_error: true,
  api_error_status: 429,
  result: "API Error: Server is temporarily limiting requests (not your usage limit): Rate limited",
  terminal_reason: "model_error",
}

/** The open turn's message, as it streams. */
const live = (c: QueryContext) => {
  if (c.turnOutput === null) throw new Error("no turn is open")
  return c.turnOutput
}

const shape = (blocks: ReadonlyArray<LiveBlock | AssistantMessage["content"][number]>) =>
  blocks.map((b) => [b.type, b.type === "toolCall" ? b.id : undefined])

// A stream that got as far as a thinking block and the start of a tool call, then stalled.
const stalledStream = (id: string) => [
  streamEvent({ type: "message_start", message: { id } }),
  streamEvent({
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", thinking: "" },
  }),
  streamEvent({
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "Let me look" },
  }),
  streamEvent({
    type: "content_block_start",
    index: 1,
    content_block: {
      type: "tool_use",
      name: "mcp__custom-tools__bash",
      id: "toolu_dead",
      input: {},
    },
  }),
  streamEvent({
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '{"comm' },
  }),
]

const fallbackMessage = (id: string) => ({
  type: "assistant",
  message: {
    id,
    content: [
      { type: "thinking", thinking: "Let me look at both.", signature: "sig" },
      { type: "text", text: "Reading the log." },
      {
        type: "tool_use",
        name: "mcp__custom-tools__bash",
        id: "toolu_a",
        input: { command: "ls" },
      },
      {
        type: "tool_use",
        name: "mcp__custom-tools__bash",
        id: "toolu_b",
        input: { command: "pwd" },
      },
    ],
  },
})

const cutInsideToolInput = (id: string) => [
  streamEvent({ type: "message_start", message: { id } }),
  streamEvent({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  }),
  streamEvent({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Reporting both fixes now." },
  }),
  streamEvent({ type: "content_block_stop", index: 0 }),
  streamEvent({
    type: "content_block_start",
    index: 1,
    content_block: {
      type: "tool_use",
      name: "mcp__custom-tools__notify_parent",
      id: "toolu_cut",
      input: {},
    },
  }),
  streamEvent({ type: "message_stop" }),
]
const resumedCall = [
  streamEvent({ type: "message_start", message: { id: "msg_resumed" } }),
  streamEvent({
    type: "content_block_start",
    index: 0,
    content_block: {
      type: "tool_use",
      name: "mcp__custom-tools__notify_parent",
      id: "toolu_resumed",
      input: {},
    },
  }),
  streamEvent({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"summary":"Both fixes done."}' },
  }),
  streamEvent({ type: "content_block_stop", index: 0 }),
  streamEvent({ type: "message_stop" }),
]
const blocks = (message: { readonly content: ReadonlyArray<LiveBlock> }) =>
  message.content.map((b) =>
    b.type === "toolCall" ? [b.type, b.id, b.arguments] : [b.type, undefined, undefined],
  )

const toolUseTurn = (name: string, id: string) => [
  streamEvent({
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", name, id, input: {} },
  }),
  streamEvent({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' },
  }),
  streamEvent({ type: "content_block_stop", index: 0 }),
  streamEvent({ type: "message_stop" }),
]

const fixture = (name: string): Array<Record<string, unknown>> =>
  readFileSync(
    join(import.meta.dir, `../../test/fixtures/claude/sdk-streams/${name}.jsonl`),
    "utf8",
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)

describe("resultErrorText", () => {
  test("treats is_error on a success-shaped result as a failure", () => {
    expect(resultErrorText(errorResult)).toBe(errorResult.result)
  })

  test("returns undefined for a genuine success", () => {
    expect(
      resultErrorText({ type: "result", subtype: "success", is_error: false, result: "a summary" }),
    ).toBeUndefined()
  })

  test("joins errors[] for the dedicated error subtypes", () => {
    expect(
      resultErrorText({
        type: "result",
        subtype: "error_during_execution",
        errors: ["boom", "bang"],
      }),
    ).toBe("boom\nbang")
  })

  test("never returns an empty message for a failure", () => {
    expect(
      resultErrorText({ type: "result", subtype: "success", is_error: true, result: "" }),
    ).toBeTruthy()
    expect(resultErrorText({ type: "result", subtype: "error_max_budget_usd" })).toBeTruthy()
    expect(
      resultErrorText({ type: "result", subtype: "error_during_execution", errors: [] }),
    ).toBeTruthy()
  })
})

// pi carries a failure only as errorMessage text, so whatever reacts to a rate limit matches it:
// one pattern from pi-subagents' retryable list, and the tool-failure shape it won't retry.
const RateLimitPattern = /rate\s*limit/i
const ToolFailurePrefix = /^[\w.:@/-]+ failed (?:(?:\(exit \d+\):)|(?:with exit code \d+))(?:\s|$)/i

describe("a rate-limited failure", () => {
  const rejection = {
    type: "rate_limit_event",
    rate_limit_info: { status: "rejected", resetsAt: 1786141800, rateLimitType: "five_hour" },
  }
  const limitResult = {
    type: "result",
    subtype: "success",
    is_error: true,
    result: "You're out of extra usage · resets 6:30pm (America/New_York)",
  }

  test("is named as a rate limit, so fallback chains fire", async () => {
    const { c, stream } = makeCtx()
    await consume(c, [rejection, limitResult], bashMap)
    finalizeCurrentStream(c)
    const message = ended(stream)

    expect(message.errorMessage).toMatch(RateLimitPattern)
    expect(isRetryableAssistantError(message)).toBe(false)
    expect(message.errorMessage).not.toMatch(ToolFailurePrefix)
    expect(message.errorMessage).toContain(limitResult.result)
    expect(message.errorMessage).toContain("five_hour")
  })

  test("labels only the failure it caused, not a later one", async () => {
    const { c } = makeCtx()
    await consume(c, [rejection, limitResult, errorResult], bashMap)
    expect(live(c).errorMessage).toBe(errorResult.result)
  })

  test("leaves an unrelated failure alone", async () => {
    const { c } = makeCtx()
    await consume(c, [errorResult], bashMap)
    expect(live(c).errorMessage).toBe(errorResult.result)
  })
})

describe("error results", () => {
  test("mark the turn errored, and end it with an error event", async () => {
    const { c, stream } = makeCtx()
    await consume(c, [errorResult], bashMap)
    expect(live(c).stopReason).toBe("error")
    expect(live(c).errorMessage).toBe(errorResult.result)

    finalizeCurrentStream(c)
    const event = terminal(stream)
    expect(event?.type).toBe("error")
    expect(event?.reason).toBe("error")
    expect(ended(stream).errorMessage).toBe(errorResult.result)
    expect(stream.events.at(-1)?.type).toBe("end")
    expect(c.turnOutput).toBeNull()
  })

  test("don't repeat text the synthetic assistant message delivered", async () => {
    const { c } = makeCtx()
    await consume(
      c,
      [
        {
          type: "assistant",
          message: { model: "<synthetic>", content: [{ type: "text", text: errorResult.result }] },
        },
        errorResult,
      ],
      bashMap,
    )
    const texts = live(c).content.flatMap((b) => (b.type === "text" ? [b.text] : []))
    expect(texts).toEqual([errorResult.result])
  })

  // A consumer that fails over only before output commits (pi-model-fallback-alias) can't if
  // Claude Code's own failure report counts as output: only start and thinking events may come
  // before the terminal error.
  test("keep a synthetic report off the stream, so failover is still possible", async () => {
    const { c, stream } = makeCtx()
    await consume(
      c,
      [
        {
          type: "assistant",
          message: { model: "<synthetic>", content: [{ type: "text", text: errorResult.result }] },
        },
        errorResult,
      ],
      bashMap,
    )
    finalizeCurrentStream(c)

    const beforeTerminal = stream.events.slice(0, -2)
    expect(beforeTerminal.every((e) => e.type === "start" || e.type.startsWith("thinking_"))).toBe(
      true,
    )
    expect(stream.events.at(-2)?.type).toBe("error")
    // The wording still reaches pi's transcript, as the failed turn's content.
    expect(ended(stream).errorMessage).toBe(errorResult.result)
    expect(ended(stream).content).toEqual([{ type: "text", text: errorResult.result }])
  })

  // A stalled stream whose non-streaming retry also fails: the report has to drop the dead
  // stream's partial blocks, as the fallback path does.
  test("a synthetic report after a stalled stream drops the abandoned partial blocks", async () => {
    const { c } = makeCtx()
    await consume(
      c,
      [
        ...stalledStream("msg_stalled"),
        {
          type: "assistant",
          message: { model: "<synthetic>", content: [{ type: "text", text: errorResult.result }] },
        },
        errorResult,
      ],
      bashMap,
    )
    expect(live(c).content).toEqual([{ type: "text", text: errorResult.result }])
    expect(c.turnSawToolCall).toBe(false)
    expect(c.turnStreamOpen).toBe(false)
  })

  test("mark the query failed, even with no turn open, so its session isn't taken as pi's", async () => {
    const { c } = makeCtx()
    c.endTurn({ stopReason: "toolUse" })
    await consume(c, [errorResult], bashMap)
    expect(c.failed).toBe(true)
    const ok = makeCtx().c
    await consume(
      ok,
      [{ type: "result", subtype: "success", is_error: false, result: "ok" }],
      bashMap,
    )
    expect(ok.failed).toBe(false)
  })

  // With no stream events, the reply comes as the whole assistant message, then the result with
  // its text again.
  test("a reply that came whole, with nothing streamed, isn't added again from the result", async () => {
    const { c, stream } = makeCtx()
    await consume(
      c,
      [
        {
          type: "assistant",
          message: { id: "msg_whole", content: [{ type: "text", text: "Hi." }] },
        },
        { type: "result", subtype: "success", is_error: false, result: "Hi." },
      ],
      bashMap,
    )
    finalizeCurrentStream(c)
    expect(ended(stream).content).toEqual([{ type: "text", text: "Hi." }])
    expect(types(stream).filter((type) => type === "text_delta")).toHaveLength(1)
  })

  test("a block event without an index names no block, not one already closed", async () => {
    const { c, stream } = makeCtx()
    await consume(
      c,
      [
        streamEvent({ type: "message_start", message: { id: "msg_1" } }),
        streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
        streamEvent({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hi." },
        }),
        streamEvent({ type: "content_block_stop", index: 0 }),
        streamEvent({
          type: "content_block_delta",
          delta: { type: "text_delta", text: " Again." },
        }),
        streamEvent({ type: "content_block_stop" }),
      ],
      bashMap,
    )
    expect(live(c).content).toEqual([{ type: "text", text: "Hi." }])
    expect(types(stream).filter((type) => type === "text_end")).toHaveLength(1)
  })

  test("a successful result still streams and ends the turn normally", async () => {
    const { c, stream } = makeCtx()
    await consume(
      c,
      [{ type: "result", subtype: "success", is_error: false, result: "done" }],
      bashMap,
    )
    expect(live(c).stopReason).toBe("stop")
    expect(live(c).errorMessage).toBeUndefined()
    expect(live(c).content).toEqual([{ type: "text", text: "done" }])

    finalizeCurrentStream(c)
    expect(terminal(stream)?.type).toBe("done")
    expect(ended(stream).content).toEqual([{ type: "text", text: "done" }])
  })

  // The reference set the failure on the message the tool call had already ended with, which
  // pi holds: the bug class of the spike's (docs/research/claude-bridge-spike.md). Here the
  // message stays as pi got it, and with no turn open nothing records the failure on a message.
  test("one that comes after the turn ended on a tool call leaves the message pi holds alone", async () => {
    const { c, stream } = makeCtx()
    await consume(
      c,
      [
        streamEvent({ type: "message_start", message: { id: "msg_tool" } }),
        streamEvent({
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            name: "mcp__custom-tools__bash",
            id: "toolu_1",
            input: {},
          },
        }),
        streamEvent({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' },
        }),
        streamEvent({ type: "content_block_stop", index: 0 }),
        streamEvent({ type: "message_stop" }),
      ],
      bashMap,
    )
    const held = ended(stream)
    const before = structuredClone(held)
    expect(held.stopReason).toBe("toolUse")
    expect(c.turnOutput).toBeNull()
    expect(c.currentPiStream).toBeNull()

    await consume(c, [errorResult], bashMap)

    expect(held).toEqual(before)
    expect(c.turnOutput).toBeNull()
    expect(stream.events.filter((e) => e.type === "done" || e.type === "error")).toHaveLength(1)
  })

  test("report the dedicated error subtypes", async () => {
    const { c } = makeCtx()
    await consume(
      c,
      [{ type: "result", subtype: "error_max_turns", is_error: true, errors: ["hit the cap"] }],
      bashMap,
    )
    expect(live(c).stopReason).toBe("error")
    expect(live(c).errorMessage).toBe("hit the cap")
  })
})

// A stalled stream: Claude Code asks again without streaming, and the answer comes whole, under
// a new id, with no stream events of its own and no message_stop for the dead stream.
describe("the non-streaming fallback after a stalled stream", () => {
  test("delivers its tool calls to pi and ends the turn on them", async () => {
    const { c, stream } = makeCtx()
    await consume(c, [...stalledStream("msg_dead"), fallbackMessage("msg_fallback")], bashMap)

    const message = ended(stream)
    expect(message.content.flatMap((b) => (b.type === "toolCall" ? [b.id] : []))).toEqual([
      "toolu_a",
      "toolu_b",
    ])
    expect(c.turnToolCallIds).toEqual(["toolu_a", "toolu_b"])
    expect(message.stopReason).toBe("toolUse")
    expect(c.currentPiStream).toBeNull()
    expect(stream.events.at(-2)?.type).toBe("done")
    expect(stream.events.at(-1)?.type).toBe("end")
  })

  test("drops the dead stream's partial blocks instead of replaying them", async () => {
    const { c, stream } = makeCtx()
    await consume(c, [...stalledStream("msg_dead"), fallbackMessage("msg_fallback")], bashMap)

    const message = ended(stream)
    expect(message.content.map((b) => b.type)).toEqual(["thinking", "text", "toolCall", "toolCall"])
    expect(message.content[0]).toEqual({
      type: "thinking",
      thinking: "Let me look at both.",
      thinkingSignature: "sig",
    })
    expect(message.content.some((b) => b.type === "toolCall" && b.id === "toolu_dead")).toBe(false)
  })

  test("drops the dead stream when Claude Code retries it as a new stream", async () => {
    const { c, stream } = makeCtx()
    await consume(
      c,
      [
        ...stalledStream("msg_dead"),
        streamEvent({ type: "message_start", message: { id: "msg_retry" } }),
        streamEvent({
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            name: "mcp__custom-tools__bash",
            id: "toolu_retry",
            input: {},
          },
        }),
        streamEvent({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' },
        }),
        streamEvent({ type: "content_block_stop", index: 0 }),
        streamEvent({ type: "message_stop" }),
      ],
      bashMap,
    )
    const message = ended(stream)
    expect(shape(message.content)).toEqual([["toolCall", "toolu_retry"]])
    expect(message.stopReason).toBe("toolUse")
  })

  test("still skips the assistant message that repeats a completed stream", async () => {
    const { c } = makeCtx()
    await consume(
      c,
      [
        streamEvent({ type: "message_start", message: { id: "msg_1" } }),
        streamEvent({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
        streamEvent({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "hi" },
        }),
        streamEvent({ type: "content_block_stop", index: 0 }),
        { type: "assistant", message: { id: "msg_1", content: [{ type: "text", text: "hi" }] } },
        streamEvent({ type: "message_stop" }),
      ],
      bashMap,
    )
    expect(live(c).content.map((b) => (b.type === "text" ? b.text : b.type))).toEqual(["hi"])
  })
})

// A stream cut inside a tool call's input: its content_block_start came, then nothing. Claude
// Code drops the block from its own conversation and resumes the turn; dispatching it would have
// pi answer a call Claude Code will never make, while Claude Code waits on the resumed one.
describe("a tool call whose content_block_stop never came", () => {
  // notify_parent, not bash: bash gets a default timeout, beside the point here.
  const notifyMap = new Map([["mcp__custom-tools__notify_parent", "notify_parent"]])
  test("isn't dispatched to pi, and doesn't end pi's turn", async () => {
    const { c, stream } = makeCtx()
    await consume(c, cutInsideToolInput("msg_cut"), notifyMap)

    expect(live(c).content.some((b) => b.type === "toolCall")).toBe(false)
    expect(live(c).stopReason).not.toBe("toolUse")
    // Only the unfinished block goes: the text closed, and Claude Code keeps it too.
    expect(live(c).content.map((b) => b.type)).toEqual(["text"])
    expect(c.turnToolCallIds).toEqual([])
    // Left open: Claude Code's resume is more of this same pi turn.
    expect(c.currentPiStream as unknown).toBe(stream)
    expect(types(stream).some((t) => t === "done" || t === "end")).toBe(false)
  })

  test("is replaced by the resumed message's call, which ends the turn", async () => {
    const { c, stream } = makeCtx()
    await consume(c, [...cutInsideToolInput("msg_cut"), ...resumedCall], notifyMap)

    const message = ended(stream)
    expect(blocks(message)).toEqual([
      ["text", undefined, undefined],
      ["toolCall", "toolu_resumed", { summary: "Both fixes done." }],
    ])
    expect(c.turnToolCallIds).toEqual(["toolu_resumed"])
    expect(message.stopReason).toBe("toolUse")
    expect(c.currentPiStream).toBeNull()
    expect(stream.events.at(-2)?.type).toBe("done")
    expect(stream.events.at(-1)?.type).toBe("end")
  })

  test("is replaced by a resume that comes as an assistant message instead", async () => {
    const { c, stream } = makeCtx()
    await consume(
      c,
      [
        ...cutInsideToolInput("msg_cut"),
        {
          type: "assistant",
          message: {
            id: "msg_resumed",
            content: [
              {
                type: "tool_use",
                name: "mcp__custom-tools__notify_parent",
                id: "toolu_resumed",
                input: { summary: "Both fixes done." },
              },
            ],
          },
        },
      ],
      notifyMap,
    )
    const message = ended(stream)
    expect(blocks(message)).toEqual([
      ["text", undefined, undefined],
      ["toolCall", "toolu_resumed", { summary: "Both fixes done." }],
    ])
    expect(message.stopReason).toBe("toolUse")
    expect(c.currentPiStream).toBeNull()
  })

  // Dropping the whole message would throw away a call Claude Code kept and dispatched.
  test("leaves a sibling call that did close to be dispatched", async () => {
    const { c, stream } = makeCtx()
    await consume(
      c,
      [
        streamEvent({ type: "message_start", message: { id: "msg_pair" } }),
        streamEvent({
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            name: "mcp__custom-tools__notify_parent",
            id: "toolu_first",
            input: {},
          },
        }),
        streamEvent({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"summary":"First."}' },
        }),
        streamEvent({ type: "content_block_stop", index: 0 }),
        streamEvent({
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            name: "mcp__custom-tools__notify_parent",
            id: "toolu_cut",
            input: {},
          },
        }),
        streamEvent({
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"summ' },
        }),
        streamEvent({ type: "message_stop" }),
      ],
      notifyMap,
    )
    const message = ended(stream)
    expect(blocks(message)).toEqual([["toolCall", "toolu_first", { summary: "First." }]])
    expect(c.turnToolCallIds).toEqual(["toolu_first"])
    expect(message.stopReason).toBe("toolUse")
    expect(c.currentPiStream).toBeNull()
  })

  // The negative control: refusing to dispatch anything would pass every test above.
  test("still dispatches a tool call that does close, with its whole arguments", async () => {
    const { c, stream } = makeCtx()
    await consume(
      c,
      [
        streamEvent({ type: "message_start", message: { id: "msg_whole" } }),
        streamEvent({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
        streamEvent({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Reporting now." },
        }),
        streamEvent({ type: "content_block_stop", index: 0 }),
        streamEvent({
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            name: "mcp__custom-tools__notify_parent",
            id: "toolu_whole",
            input: {},
          },
        }),
        streamEvent({
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"summary":' },
        }),
        streamEvent({
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '"Both fixes done."}' },
        }),
        streamEvent({ type: "content_block_stop", index: 1 }),
        streamEvent({ type: "message_stop" }),
      ],
      notifyMap,
    )
    const message = ended(stream)
    expect(message.content.map((b) => b.type)).toEqual(["text", "toolCall"])
    expect(blocks(message)[1]).toEqual(["toolCall", "toolu_whole", { summary: "Both fixes done." }])
    expect(c.turnToolCallIds).toEqual(["toolu_whole"])
    expect(message.stopReason).toBe("toolUse")
    expect(c.currentPiStream).toBeNull()
    expect(stream.events.at(-2)?.type).toBe("done")
  })
})

// Claude sometimes calls a Claude Code builtin by its bare name. Claude Code, run with
// `tools: []`, refuses it itself and retries under a new id, never dispatching it: forwarding it
// to pi would run a tool Claude Code never asked for, and deadlock the turn.
describe("a tool_use for a tool pi doesn't serve", () => {
  test("is skipped, and only the retry under the served name reaches pi", async () => {
    const { c, stream } = makeCtx()
    await consume(
      c,
      [
        ...toolUseTurn("bash", "toolu_phantom"),
        ...toolUseTurn("mcp__custom-tools__bash", "toolu_retry"),
      ],
      bashMap,
    )
    const toolCalls = ended(stream).content.flatMap((b) => (b.type === "toolCall" ? [b] : []))
    expect(toolCalls.map((b) => [b.name, b.id])).toEqual([["bash", "toolu_retry"]])
    expect(c.turnToolCallIds).toEqual(["toolu_retry"])
    expect(toolCalls[0]?.arguments).toEqual({ command: "ls", timeout: 120 })
  })

  test("doesn't end pi's turn, so it goes on into the retry", async () => {
    const { c, stream } = makeCtx()
    await consume(c, toolUseTurn("Bash", "toolu_phantom"), bashMap)
    expect(c.turnSawToolCall).toBe(false)
    expect(live(c).content).toEqual([])
    expect(types(stream).filter((t) => t === "done" || t === "end")).toEqual([])
  })

  test("is skipped on the assistant-message path too", async () => {
    const { c, stream } = makeCtx()
    await consume(
      c,
      [
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", name: "bash", id: "toolu_phantom", input: { command: "ls" } },
              {
                type: "tool_use",
                name: "mcp__custom-tools__bash",
                id: "toolu_retry",
                input: { command: "ls" },
              },
            ],
          },
        },
      ],
      bashMap,
    )
    const toolCalls = ended(stream).content.flatMap((b) => (b.type === "toolCall" ? [b] : []))
    expect(toolCalls.map((b) => [b.name, b.id])).toEqual([["bash", "toolu_retry"]])
  })
})

// Verbatim message sequences from live Claude Code turns (the reference's
// tests/lib/record-sdk-streams.mjs): the shapes Claude Code really sends, `system/status` frames
// and `rate_limit_event`s included.
describe("recorded streams", () => {
  const model = testModel("claude-haiku-4-5")

  /** Replays a fixture through consumeQuery; `message` is the turn's, ended or still open. */
  async function replay(name: string, toolNames: ReadonlyArray<string> = ["read"]) {
    const { c, stream } = makeCtx(model)
    const toolMap = new Map(toolNames.map((n) => [`mcp__custom-tools__${n}`, n]))
    const messages = fixture(name)
    const { capturedSessionId } = await consume(c, messages, toolMap, model)
    const message = c.turnOutput ?? ended(stream)
    return { c, stream, message, messages, capturedSessionId }
  }

  interface Frame {
    readonly output_tokens_details?: { readonly thinking_tokens?: number | null } | null
  }
  /** Every usage frame of a fixture, in order. */
  const usageFrames = (messages: ReadonlyArray<Record<string, unknown>>): Array<Frame> =>
    messages.flatMap((m) => {
      const event = m.event as { message?: { usage?: Frame }; usage?: Frame } | undefined
      const usage =
        event?.message?.usage ?? event?.usage ?? (m.message as { usage?: Frame } | undefined)?.usage
      return usage === undefined ? [] : [usage]
    })

  /** The thinking count this pi turn ends on: the first, as a tool call ends the turn. */
  const turnThinkingTokens = (messages: ReadonlyArray<Record<string, unknown>>) => {
    for (const usage of usageFrames(messages)) {
      const thinking = usage.output_tokens_details?.thinking_tokens
      if (thinking != null) return thinking
    }
    return undefined
  }

  test("a text-only turn: the text, and a clean stop", async () => {
    const { c, message, stream } = await replay("text")
    const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("")
    expect(text.trim()).toBe("ALPHA")
    expect(message.stopReason).toBe("stop")
    expect(c.turnSawToolCall).toBe(false)
    expect(types(stream)).toContain("text_delta")
  })

  test("a text-only turn: its usage, and the session id", async () => {
    const { message, capturedSessionId } = await replay("text")
    expect(message.usage.output).toBeGreaterThan(0)
    expect(
      message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
    ).toBeGreaterThan(0)
    expect(capturedSessionId ?? "").toMatch(/^[0-9a-f-]{36}$/)
  })

  for (const name of ["text", "single-tool", "parallel-tools"]) {
    test(`the ${name} turn's thinking tokens are its usage.reasoning`, async () => {
      const { message, messages } = await replay(name)
      const expected = turnThinkingTokens(messages)
      expect(expected).toBeGreaterThan(0)
      expect(message.usage.reasoning).toBe(expected as number)
      expect(expected as number).toBeLessThanOrEqual(message.usage.output)
    })
  }

  test("counts from cycles of the next pi turn aren't this one's", async () => {
    const { message, messages } = await replay("single-tool")
    const counts = usageFrames(messages)
      .map((u) => u.output_tokens_details?.thinking_tokens)
      .filter((n) => n != null)
    expect(counts.length).toBeGreaterThan(1)
    expect(message.stopReason).toBe("toolUse")
    expect(message.usage.reasoning).toBe(counts[0] as number)
  })

  test("a single-tool turn: the call under its pi name, ending the turn", async () => {
    const { c, message } = await replay("single-tool")
    const calls = message.content.flatMap((b) => (b.type === "toolCall" ? [b] : []))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.name).toBe("read")
    expect(calls[0]?.id.startsWith("toolu_")).toBe(true)
    expect(c.turnSawToolCall).toBe(true)
    expect(c.turnToolCallIds).toEqual(calls.map((call) => call.id))
  })

  test("a parallel-tool turn: every call, in order", async () => {
    const { c, message } = await replay("parallel-tools")
    const calls = message.content.flatMap((b) => (b.type === "toolCall" ? [b] : []))
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(c.turnToolCallIds).toEqual(calls.map((call) => call.id))
    expect(new Set(calls.map((call) => call.id)).size).toBe(calls.length)
    for (const call of calls) expect(call.name).toBe("read")
  })

  test("a parallel-tool turn with no tools served leaves nothing for pi", async () => {
    const { c, message } = await replay("parallel-tools", [])
    expect(message.content.filter((b) => b.type === "toolCall")).toHaveLength(0)
    expect(c.turnSawToolCall).toBe(false)
  })
})

describe("QueryContext", () => {
  const model = testModel()

  test("has no turn blocks with no turn open", () => {
    expect(() => new QueryContext().turnBlocks).toThrow(/no turn open/)
  })

  test("its turn blocks are the open turn's message's content", () => {
    const c = new QueryContext()
    c.resetTurnState(model)
    expect(c.turnBlocks).toEqual([])
    c.turnBlocks.push({ type: "text", text: "hello" })
    expect(live(c).content).toEqual([{ type: "text", text: "hello" }])
    expect(c.turnBlocks).toBe(live(c).content)
  })

  test("keeps the turn's tool call ids when a turn opens", () => {
    const c = new QueryContext()
    c.turnToolCallIds = ["id1", "id2"]
    c.resetTurnState(model)
    expect(c.turnToolCallIds).toEqual(["id1", "id2"])
  })

  test("ends a turn with a copy of its message, and keeps none", () => {
    const { c, stream } = makeCtx(model)
    c.turnBlocks.push({ type: "text", text: "hi", index: 0 })
    const open = live(c)
    const message = c.endTurn()
    expect(message).toBeDefined()
    expect(message).not.toBe(open as unknown as AssistantMessage)
    expect(message?.content).toEqual([{ type: "text", text: "hi" }])
    expect(types(stream)).toEqual(["start", "done", "end"])
    expect(c.turnOutput).toBeNull()
    expect(c.currentPiStream).toBeNull()
    // Nothing left to end, and nothing to change.
    expect(c.endTurn({ stopReason: "aborted" })).toBeUndefined()
    expect(message?.stopReason).toBe("stop")
  })

  test("ends a turn aborted with a new message, as an error event", () => {
    const { c, stream } = makeCtx(model)
    const message = c.endTurn({ stopReason: "aborted", errorMessage: "Operation aborted" })
    expect(terminal(stream)).toMatchObject({ type: "error", reason: "aborted" })
    expect(message).toMatchObject({ stopReason: "aborted", errorMessage: "Operation aborted" })
  })
})
