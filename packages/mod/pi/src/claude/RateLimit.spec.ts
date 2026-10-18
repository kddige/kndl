// Claude Code's rate_limit_event as pi's onResponse, with the Anthropic API's unified rate-limit
// headers. Ported from pi-claude-bridge 0.9.3's unit-rate-limit test (MIT, Copyright (c) 2026 Eli
// Dickinson): see THIRD_PARTY_NOTICES.md.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  ProviderResponse,
  Tool,
} from "@earendil-works/pi-ai"
import { consume, makeCtx, streamEvent, testModel } from "../../test/StreamHarness.ts"
import { resetBridge, setQuery, streamClaude } from "./Bridge.ts"
import type { ClaudeQuery } from "./Bridge.ts"
import { ClaudeApi } from "./Names.ts"
import { rateLimitResponse } from "./RateLimit.ts"
import type { RateLimitInfo } from "./RateLimit.ts"
import { clearSessionStates, setClaudeDir } from "./SessionMirror.ts"

const fixtureModel = testModel("claude-haiku-4-5")

const fixture = (name: string): Array<Record<string, unknown>> =>
  readFileSync(
    join(import.meta.dir, `../../test/fixtures/claude/sdk-streams/${name}.jsonl`),
    "utf8",
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)

async function replay(
  messages: ReadonlyArray<Record<string, unknown>>,
  onResponse: (response: ProviderResponse, model: Model<Api>) => void,
) {
  const { c, stream } = makeCtx(fixtureModel)
  c.currentOnResponse = onResponse
  await consume(c, messages, new Map(), fixtureModel)
  return { c, stream }
}

const gate = () => {
  const { promise, resolve } = Promise.withResolvers<void>()
  return { wait: () => promise, open: () => resolve() }
}
const usage = (utilization: number) => ({
  type: "rate_limit_event",
  rate_limit_info: {
    status: "allowed",
    rateLimitType: "five_hour",
    unifiedWindows: { five_hour: { utilization, resetsAt: 1789770600 } },
  },
})
const toolUse = (id: string) => [
  streamEvent({ type: "message_start", message: { id: `msg_${id}`, usage: {} } }),
  streamEvent({
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id, name: "mcp__custom-tools__read", input: {} },
  }),
  streamEvent({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"path":"a"}' },
  }),
  streamEvent({ type: "content_block_stop", index: 0 }),
  streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
  streamEvent({ type: "message_stop" }),
]
const textReply = [
  streamEvent({ type: "message_start", message: { id: "msg_text", usage: {} } }),
  streamEvent({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  }),
  streamEvent({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "done" },
  }),
  streamEvent({ type: "content_block_stop", index: 0 }),
  streamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }),
  streamEvent({ type: "message_stop" }),
]
const msgUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}
const user = { role: "user" as const, content: "read a", timestamp: 0 }
const call = {
  role: "assistant" as const,
  content: [{ type: "toolCall" as const, id: "toolu_1", name: "read", arguments: { path: "a" } }],
  api: ClaudeApi,
  provider: "anthropic",
  model: "claude-haiku-5-5",
  usage: msgUsage,
  stopReason: "toolUse" as const,
  timestamp: 1,
}
const toolResult = {
  role: "toolResult" as const,
  toolCallId: "toolu_1",
  toolName: "read",
  content: [{ type: "text" as const, text: "file" }],
  isError: false,
  timestamp: 2,
}
const tools = [
  { name: "read", description: "read", parameters: { type: "object", properties: {} } },
] as unknown as Array<Tool>
const context = (messages: ReadonlyArray<unknown>) => ({ messages, tools }) as unknown as Context

const asQuery = (generator: AsyncGenerator<unknown>, close: () => void = () => {}) =>
  Object.assign(generator, { interrupt: async () => {}, close }) as unknown as ClaudeQuery

const drain = async (stream: AssistantMessageEventStream, log: Array<string>) => {
  for await (const event of stream) log.push(event.type)
}
// Async, as an after_provider_response handler is: the report finishes before the next event.
const reportingTo = (log: Array<string>) => async (response: ProviderResponse) => {
  await new Promise((resolve) => setImmediate(resolve))
  log.push(`usage ${response.headers["anthropic-ratelimit-unified-5h-utilization"]}`)
}

describe("rateLimitResponse", () => {
  test("names each unified window by Claude Code's abbreviation for it", () => {
    const { status, headers } = rateLimitResponse({
      status: "allowed",
      resetsAt: 1789770600,
      rateLimitType: "five_hour",
      unifiedWindows: {
        five_hour: { utilization: 0.14, resetsAt: 1789770600 },
        seven_day: { utilization: 0.01, resetsAt: 1790042400 },
        seven_day_overage_included: { utilization: 0.5, resetsAt: 1790042400 },
      },
    })
    expect(status).toBe(200)
    expect(headers).toEqual({
      "anthropic-ratelimit-unified-status": "allowed",
      "anthropic-ratelimit-unified-reset": "1789770600",
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
      "anthropic-ratelimit-unified-5h-utilization": "0.14",
      "anthropic-ratelimit-unified-5h-reset": "1789770600",
      "anthropic-ratelimit-unified-7d-utilization": "0.01",
      "anthropic-ratelimit-unified-7d-reset": "1790042400",
      "anthropic-ratelimit-unified-7d_oi-utilization": "0.5",
      "anthropic-ratelimit-unified-7d_oi-reset": "1790042400",
    })
  })

  test("keeps a window's name Claude Code has no abbreviation for", () => {
    const { headers } = rateLimitResponse({
      status: "allowed",
      unifiedWindows: { seven_day_opus: { utilization: 0.3 } },
    })
    expect(headers["anthropic-ratelimit-unified-seven_day_opus-utilization"]).toBe("0.3")
  })

  test("says a rejection in the headers, not the status code", () => {
    const { status, headers } = rateLimitResponse({
      status: "rejected",
      rateLimitType: "five_hour",
      overageStatus: "rejected",
      overageResetsAt: 1790812800,
    })
    expect(status).toBe(200)
    expect(headers["anthropic-ratelimit-unified-status"]).toBe("rejected")
    expect(headers["anthropic-ratelimit-unified-overage-status"]).toBe("rejected")
    expect(headers["anthropic-ratelimit-unified-overage-reset"]).toBe("1790812800")
  })
})

describe("consumeQuery's rate_limit_events", () => {
  test("go to the provider call's onResponse, each of them", async () => {
    const messages = fixture("text")
    const events = messages.filter((m) => m.type === "rate_limit_event")
    const responses: Array<{ response: ProviderResponse; served: Model<Api> }> = []
    await replay(messages, (response, served) => responses.push({ response, served }))

    expect(events.length).toBeGreaterThan(0)
    expect(responses.map((r) => r.response)).toEqual(
      events.map((e) => rateLimitResponse(e.rate_limit_info as RateLimitInfo)),
    )
    expect(responses.every((r) => r.served === fixtureModel)).toBe(true)
  })

  test("don't stop the turn when onResponse throws", async () => {
    const { c } = await replay(fixture("text"), () => {
      throw new Error("consumer bug")
    })
    expect(c.turnOutput?.stopReason).toBe("stop")
    const text = (c.turnOutput?.content ?? [])
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("")
    expect(text.trim()).toBe("ALPHA")
  })
})

describe("rate_limit_events, to the provider call owning the stream", () => {
  let root: string
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "kndl-claude-rate-limit-"))
    setClaudeDir(join(root, "claude"))
  })
  afterAll(() => {
    setClaudeDir(undefined)
    rmSync(root, { recursive: true, force: true })
  })
  afterEach(() => {
    setQuery(null)
    resetBridge()
    clearSessionStates()
  })

  const model = testModel("claude-haiku-5-5")
  test("each is reported before the next event of the call owning the stream", async () => {
    const toolDelivered = gate()
    const usageConsumed = gate()
    setQuery(() =>
      asQuery(
        (async function* () {
          yield { type: "system", subtype: "init", session_id: "cc-rate-limit" }
          yield* toolUse("toolu_1")
          // Claude Code reports usage after message_stop, once the tool call has ended the stream.
          yield usage(0.05)
          yield usage(0.1)
          usageConsumed.open()
          await toolDelivered.wait()
          yield* textReply
          yield usage(0.2)
          yield { type: "result", subtype: "success", is_error: false, result: "done" }
        })(),
      ),
    )
    const first: Array<string> = []
    const second: Array<string> = []

    await drain(
      streamClaude(model, context([user]), {
        sessionId: "pi-rate-limit",
        onResponse: reportingTo(first),
      }),
      first,
    )
    await usageConsumed.wait()
    const resumed = drain(
      streamClaude(model, context([user, call, toolResult]), {
        sessionId: "pi-rate-limit",
        onResponse: reportingTo(second),
      }),
      second,
    )
    toolDelivered.open()
    await resumed

    // A call whose stream has ended hears nothing.
    expect(first.some((e) => e.startsWith("usage"))).toBe(false)
    // The latest held event comes before the next call's first event, replacing an older one.
    expect(second[0]).toBe("usage 0.1")
    expect(second).not.toContain("usage 0.05")
    // An event on an open stream comes before its end.
    expect(second.slice(-3)).toEqual(["text_end", "usage 0.2", "done"])
  })

  test("an aborted query's held event is dropped, not reported on the next query", async () => {
    const usageConsumed = gate()
    const closed = gate()
    const queries = [
      async function* () {
        yield { type: "system", subtype: "init", session_id: "cc-rate-limit-abort" }
        yield* toolUse("toolu_1")
        yield usage(0.1)
        usageConsumed.open()
        await closed.wait()
      },
      async function* () {
        yield { type: "system", subtype: "init", session_id: "cc-rate-limit-next" }
        yield* textReply
        yield { type: "result", subtype: "success", is_error: false, result: "done" }
      },
    ]
    setQuery(() => {
      const next = queries.shift()
      if (next === undefined) throw new Error("no query left")
      return asQuery(next(), () => closed.open())
    })
    const first: Array<string> = []
    const second: Array<string> = []
    const abort = new AbortController()

    await drain(
      streamClaude(model, context([user]), {
        sessionId: "pi-rate-limit-abort",
        signal: abort.signal,
        onResponse: reportingTo(first),
      }),
      first,
    )
    await usageConsumed.wait()
    abort.abort()
    await new Promise((resolve) => setImmediate(resolve))
    const next = { role: "user" as const, content: "something else", timestamp: 3 }
    await drain(
      streamClaude(model, context([user, call, next]), {
        sessionId: "pi-rate-limit-abort",
        onResponse: reportingTo(second),
      }),
      second,
    )

    expect(second.some((e) => e.startsWith("usage"))).toBe(false)
    expect(second.at(-1)).toBe("done")
  })
})
