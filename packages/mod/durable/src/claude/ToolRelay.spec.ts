// The tool relay: a turn's tool results reach Claude Code by two independent routes, Claude
// calling each tool over MCP and the next request bringing the results back to the provider, and
// either can come first. Also the steer's ordering on delivery, and abandoning a query.
//
// Ported from pi-claude-bridge 0.9.3's unit-queue and unit-deliver-tool-results tests (MIT, Copyright (c) 2026 Eli Dickinson): see
// THIRD_PARTY_NOTICES.md.

import { describe, expect, test } from "bun:test"
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { Tool } from "@earendil-works/pi-ai"
import { buildMcpServers, deliverToolResults, drainForAbort } from "./Bridge.ts"
import { silentLog } from "./Log.ts"
import { makePromptStream } from "./PromptStream.ts"
import type { PromptStream } from "./PromptStream.ts"
import { QueryContext } from "./QueryState.ts"
import { SessionMirrors } from "./SessionMirror.ts"
import { extractAllToolResults, hasAbortedResult } from "./ToolResults.ts"
import type { LooseMessage, McpResult } from "./ToolResults.ts"

interface JsonRpcReply {
  readonly result?: McpResult
  readonly error?: { readonly message?: string }
}

interface McpInstance {
  readonly connect: (transport: unknown) => Promise<void>
}

/** Connects as the SDK's connectSdkMcpServer does, and returns how to call a tool. */
async function connectClient(server: { readonly instance: unknown }) {
  const pending = new Map<number, (reply: JsonRpcReply) => void>()
  const transport: {
    start: () => Promise<void>
    close: () => Promise<void>
    send: (msg: { id?: number } & JsonRpcReply) => Promise<void>
    onmessage?: (msg: unknown) => void
  } = {
    start: async () => {},
    close: async () => {},
    send: async (msg) => {
      if (msg.id !== undefined) pending.get(msg.id)?.(msg)
    },
  }
  await (server.instance as McpInstance).connect(transport)
  let nextId = 0
  const request = (method: string, params: unknown) =>
    new Promise<JsonRpcReply>((resolve) => {
      const id = ++nextId
      pending.set(id, resolve)
      transport.onmessage?.({ jsonrpc: "2.0", id, method, params })
    })
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  })
  transport.onmessage?.({ jsonrpc: "2.0", method: "notifications/initialized" })
  return (name: string, toolUseId: string) =>
    request("tools/call", {
      name,
      arguments: {},
      _meta: { "claudecode/toolUseId": toolUseId },
    })
}

const Tools = ["alpha", "beta", "gamma"].map(
  (name) =>
    ({
      name,
      description: name,
      parameters: { type: "object", properties: {} },
    }) as unknown as Tool,
)

/** A live query: a real context and its real MCP server, connected as the SDK connects it. */
async function startQuery(turnToolCallIds: ReadonlyArray<string>) {
  const c = new QueryContext()
  c.turnToolCallIds = [...turnToolCallIds]
  const servers = buildMcpServers(Tools, c)
  const server = servers === undefined ? undefined : Object.values(servers)[0]
  if (server === undefined) throw new Error("no MCP server")
  return { c, callTool: await connectClient(server) }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const result = (toolCallId: string, text: string, isError?: boolean): McpResult => ({
  toolCallId,
  content: [{ type: "text", text }],
  isError,
})
const deliver = (c: QueryContext, ...results: Array<McpResult>) =>
  deliverToolResults(c, results, null, 4)
const replyText = (reply: JsonRpcReply) => {
  const first = reply.result?.content[0]
  return first?.type === "text" ? first.text : undefined
}

describe("the tool result queue", () => {
  test("hands a handler the result that came before it, isError included", async () => {
    const { c, callTool } = await startQuery(["toolu_1"])

    await deliver(c, result("toolu_1", "early", true))
    expect([...c.pendingResults.keys()]).toEqual(["toolu_1"])

    const reply = await callTool("alpha", "toolu_1")
    expect(replyText(reply)).toBe("early")
    expect(reply.result?.isError).toBe(true)
    expect(c.pendingResults.size).toBe(0)
  })

  test("parks a handler that comes before its result, then releases it", async () => {
    const { c, callTool } = await startQuery(["toolu_1"])

    const call = callTool("alpha", "toolu_1")
    await tick()
    expect([...c.pendingToolCalls.keys()]).toEqual(["toolu_1"])
    expect(c.pendingToolCalls.get("toolu_1")?.toolName).toBe("alpha")

    await deliver(c, result("toolu_1", "late", false))
    const reply = await call
    expect(replyText(reply)).toBe("late")
    expect(reply.result?.isError).toBe(false)
    expect(c.pendingToolCalls.size).toBe(0)
  })

  // Only the id on each tools/call can pair a result with its call: anything positional answers
  // the wrong call once Claude's call order and the delivery order diverge.
  test("pairs parallel calls by tool_use id, not by call or delivery order", async () => {
    const { c, callTool } = await startQuery(["toolu_1", "toolu_2", "toolu_3"])

    const third = callTool("gamma", "toolu_3")
    const first = callTool("alpha", "toolu_1")
    const second = callTool("beta", "toolu_2")
    await tick()
    expect(c.pendingToolCalls.size).toBe(3)

    await deliver(c, result("toolu_2", "r2"), result("toolu_3", "r3"), result("toolu_1", "r1"))

    expect(replyText(await first)).toBe("r1")
    expect(replyText(await second)).toBe("r2")
    expect(replyText(await third)).toBe("r3")
    expect(c.pendingToolCalls.size).toBe(0)
    expect(c.pendingResults.size).toBe(0)
  })

  test("moves an id between the maps without ever holding it in both", async () => {
    const { c, callTool } = await startQuery(["toolu_1", "toolu_2"])
    const expectDisjoint = () => {
      for (const id of c.pendingToolCalls.keys()) expect(c.pendingResults.has(id)).toBe(false)
    }

    const one = callTool("alpha", "toolu_1") // parks
    await tick()
    expectDisjoint()
    await deliver(c, result("toolu_1", "r1")) // releases it rather than queueing
    expect(replyText(await one)).toBe("r1")
    expect(c.pendingResults.size).toBe(0)

    await deliver(c, result("toolu_2", "r2")) // queues: no handler yet
    expect([...c.pendingResults.keys()]).toEqual(["toolu_2"])
    expectDisjoint()

    const two = await callTool("beta", "toolu_2") // claims it from the queue
    expect(replyText(two)).toBe("r2")
    expect(c.pendingResults.size).toBe(0)
    expect(c.pendingToolCalls.size).toBe(0)
  })

  test("leaves only the unanswered handler parked when a result never comes", async () => {
    const { c, callTool } = await startQuery(["toolu_1", "toolu_2"])
    const answered = callTool("alpha", "toolu_1")
    void callTool("beta", "toolu_2") // never gets a result
    await tick()

    await deliver(c, result("toolu_1", "r1"))

    expect(replyText(await answered)).toBe("r1")
    expect([...c.pendingToolCalls.keys()]).toEqual(["toolu_2"])
  })
})

// Every way out of a query (abort, error, normal end) settles its handlers: Claude Code's
// tools/call stays open until it's answered.
describe("abandoning a query", () => {
  test("answers every parked handler and forgets queued results", async () => {
    const { c, callTool } = await startQuery(["toolu_1", "toolu_2", "toolu_3"])
    const one = callTool("alpha", "toolu_1")
    const two = callTool("beta", "toolu_2")
    await tick()
    await deliver(c, result("toolu_3", "r3")) // queued, no handler ever came

    c.releasePendingToolCalls("Query ended")

    expect(replyText(await one)).toBe("Query ended")
    expect(replyText(await two)).toBe("Query ended")
    expect(c.pendingToolCalls.size).toBe(0)
    expect(c.pendingResults.size).toBe(0)
  })

  // The abort race: the person aborts while delivery is parked on the steer's stdin ack. Failing
  // the prompt stream is what unwedges it; the failure mode is a hang, hence the timeout.
  test("unwedges a delivery parked on the steer's ack, leaving no handler waiting", async () => {
    const { c, callTool } = await startQuery(["toolu_1"])
    const call = callTool("alpha", "toolu_1")
    await tick()

    // A real stream with no consumer: the push parks as when the CLI stops reading stdin.
    const promptStream = makePromptStream()
    c.promptStream = promptStream
    const delivery = deliverToolResults(
      c,
      [result("toolu_1", "r1")],
      [{ type: "text", text: "stop" }],
      4,
    )
    await tick()
    expect(c.pendingToolCalls.size).toBe(1)

    drainForAbort(c, promptStream)

    await delivery // resolves: the steer is lost, not the turn
    expect(replyText(await call)).toBe("Operation aborted")
    expect(c.pendingToolCalls.size).toBe(0)
  }, 5_000)
})

const assistant = (...ids: Array<string>): LooseMessage => ({
  role: "assistant",
  content: ids.map((id) => ({ type: "toolCall", name: "alpha", id })),
})
const toolResult = (toolCallId: string, content: string, isError?: boolean): LooseMessage => ({
  role: "toolResult",
  toolCallId,
  content,
  ...(isError === undefined ? {} : { isError }),
})
const texts = (results: ReadonlyArray<McpResult>) =>
  results.map((r) => (r.content[0]?.type === "text" ? r.content[0].text : undefined))

describe("a turn's tool results, from the call's transcript", () => {
  // Pi Durable's words for a call it aborted, the run's stop: the request bringing them is the next
  // run's.
  test("tell a call Pi Durable aborted from one that failed", () => {
    const aborted = {
      role: "toolResult",
      toolCallId: "toolu_1",
      toolName: "bash",
      content: [{ type: "text", text: "<harness>\n[error] Tool bash was aborted\n</harness>" }],
      isError: true,
    }
    const failed = {
      ...aborted,
      content: [{ type: "text", text: "Tool bash was aborted, said bash" }],
    }
    expect(hasAbortedResult([{ role: "user", content: "go" }, assistant("toolu_1"), aborted])).toBe(
      true,
    )
    expect(
      hasAbortedResult([assistant("toolu_1"), aborted, { role: "user", content: "next" }]),
    ).toBe(true)
    expect(hasAbortedResult([assistant("toolu_1"), failed])).toBe(false)
    expect(hasAbortedResult([assistant("toolu_1"), { ...aborted, isError: false }])).toBe(false)
    // An earlier turn's is the earlier run's.
    expect(hasAbortedResult([assistant("toolu_1"), aborted, assistant("toolu_2")])).toBe(false)
  })

  test("takes only the current turn, back to the last assistant message", () => {
    const { results, stopIdx } = extractAllToolResults([
      { role: "user", content: "prompt" },
      assistant("toolu_1"),
      toolResult("toolu_1", "turn 1"),
      assistant("toolu_2", "toolu_3"),
      toolResult("toolu_2", "turn 2a"),
      toolResult("toolu_3", "turn 2b"),
    ])

    expect(texts(results)).toEqual(["turn 2a", "turn 2b"])
    expect(stopIdx).toBe(3)
  })

  // Steers are placed among the results while the tools run.
  test("walks past user messages among the results, keeping isError", () => {
    const { results } = extractAllToolResults([
      { role: "user", content: "prompt" },
      assistant("toolu_1", "toolu_2", "toolu_3"),
      { role: "user", content: "steer before any result" },
      toolResult("toolu_1", "r1"),
      toolResult("toolu_2", "r2", true),
      { role: "user", content: "steer between results" },
      toolResult("toolu_3", "r3"),
      { role: "user", content: "steer after the last result" },
    ])

    expect(texts(results)).toEqual(["r1", "r2", "r3"])
    expect(results.map((r) => r.isError)).toEqual([undefined, true, undefined])
  })

  test("finds nothing when the turn's tools haven't reported yet", () => {
    const noResultsYet: Array<LooseMessage> = [
      { role: "user", content: "prompt" },
      assistant("toolu_1", "toolu_2"),
      { role: "user", content: "steer into the void" },
    ]
    expect(extractAllToolResults(noResultsYet).results.length).toBe(0)
    expect(extractAllToolResults([]).results.length).toBe(0)
  })

  test("releases every parked handler for a turn read out of the context", async () => {
    const { c, callTool } = await startQuery(["toolu_1", "toolu_2"])
    const beta = callTool("beta", "toolu_2")
    const alpha = callTool("alpha", "toolu_1")
    await tick()

    const { results } = extractAllToolResults([
      { role: "user", content: "prompt" },
      assistant("toolu_1", "toolu_2"),
      { role: "toolResult", toolCallId: "toolu_1", content: "read the file" },
      { role: "user", content: "steer" },
      { role: "toolResult", toolCallId: "toolu_2", content: "ran the command" },
    ])
    await deliverToolResults(c, results, null, 5)

    expect(replyText(await alpha)).toBe("read the file")
    expect(replyText(await beta)).toBe("ran the command")
    expect(c.pendingToolCalls.size).toBe(0)
  })
})

// --- Steering on delivery ---

/**
 * Records the order of stdin writes and handler releases. The ack, not the push, is the ordering
 * boundary: the SDK has written the steer only once the push's promise settles.
 */
function makeRecorder() {
  const order: Array<string> = []
  return {
    order,
    promptStream(behavior: "ack" | "reject" = "ack"): PromptStream {
      return {
        push: (msg: SDKUserMessage) => {
          const content = msg.message.content as Array<{ type: string; text?: string }>
          order.push(`push:${content.map((b) => b.text ?? `[${b.type}]`).join(",")}`)
          if (behavior === "reject") {
            return Promise.reject(new Error("prompt stream closed")).catch((error: unknown) => {
              order.push("push-rejected")
              throw error
            })
          }
          // Acked on a later turn of the event loop, so a caller that forgot to await it shows.
          return new Promise((resolve) => setTimeout(resolve, 5)).then(() => {
            order.push("ack")
          })
        },
      } as unknown as PromptStream
    },
    handler(name: string) {
      return { toolName: name, resolve: () => order.push(`resolve:${name}`) }
    },
  }
}

const steerText = [{ type: "text" as const, text: "actually stop" }]
const okResult = (toolCallId: string): McpResult => ({
  toolCallId,
  content: [{ type: "text", text: "ok" }],
})

/** A prompt stream that records what's pushed and acks at once. */
const recordingStream = (sent: Array<SDKUserMessage>) =>
  ({
    push: (msg: SDKUserMessage) => {
      sent.push(msg)
      return Promise.resolve()
    },
  }) as unknown as PromptStream

describe("delivering tool results with a steer", () => {
  test("writes the steer to stdin before releasing any tool result", async () => {
    const rec = makeRecorder()
    const c = new QueryContext()
    c.promptStream = rec.promptStream()
    c.pendingToolCalls.set("call-1", rec.handler("read"))
    c.pendingToolCalls.set("call-2", rec.handler("bash"))

    await deliverToolResults(c, [okResult("call-1"), okResult("call-2")], steerText, 4)

    expect(rec.order).toEqual(["push:actually stop", "ack", "resolve:read", "resolve:bash"])
  })

  test("sends the steer with priority next, so Claude Code reads it at the tool boundary", async () => {
    const sent: Array<SDKUserMessage> = []
    const c = new QueryContext()
    c.promptStream = recordingStream(sent)
    c.pendingToolCalls.set("call-1", { toolName: "read", resolve: () => {} })

    await deliverToolResults(c, [okResult("call-1")], steerText, 4)

    expect(sent.length).toBe(1)
    expect(sent[0]?.priority).toBe("next")
    expect(sent[0]?.message.content).toEqual(steerText)
  })

  test("keeps the steer's images", async () => {
    const sent: Array<SDKUserMessage> = []
    const c = new QueryContext()
    c.promptStream = recordingStream(sent)
    const withImage = [
      { type: "text" as const, text: "look at this" },
      {
        type: "image" as const,
        source: { type: "base64" as const, media_type: "image/png" as const, data: "iVBOR" },
      },
    ]

    await deliverToolResults(c, [], withImage, 4)

    expect(sent[0]?.message.content).toEqual(withImage)
  })

  // The cursor already counts the steer, so one that never reached Claude Code would be skipped
  // for good by count-based sync.
  test("marks the mirror for a rebuild when the push is refused, and still delivers", async () => {
    const rec = makeRecorder()
    const c = new QueryContext()
    c.promptStream = rec.promptStream("reject")
    c.pendingToolCalls.set("call-1", rec.handler("read"))
    const mirrors = new SessionMirrors({ claudeDir: undefined, log: silentLog })
    mirrors.setState(null, { sessionId: "abc", cursor: 3, cwd: "/tmp", needsRebuild: false })

    await deliverToolResults(c, [okResult("call-1")], steerText, 4, () => mirrors.steerMissed(null))

    expect(rec.order).toEqual(["push:actually stop", "push-rejected", "resolve:read"])
    expect(mirrors.state(null)?.needsRebuild).toBe(true)
    expect(c.missedSteer).toBe(true)
  })

  test("marks the mirror for a rebuild when there's no prompt stream", async () => {
    const c = new QueryContext()
    c.promptStream = null
    const missed: Array<string> = []

    await deliverToolResults(c, [], steerText, 4, (text) => missed.push(text))

    expect(missed).toEqual(["actually stop"])
    expect(c.missedSteer).toBe(true)
  })

  test("queues a result whose handler hasn't come yet", async () => {
    const c = new QueryContext()

    await deliverToolResults(c, [okResult("call-late")], null, 4)

    expect(c.pendingResults.get("call-late")?.toolCallId).toBe("call-late")
    expect(c.pendingToolCalls.size).toBe(0)
  })

  test("pairs results with handlers by tool_use id, not arrival order", async () => {
    const rec = makeRecorder()
    const c = new QueryContext()
    c.pendingToolCalls.set("call-1", rec.handler("read"))
    c.pendingToolCalls.set("call-2", rec.handler("bash"))

    await deliverToolResults(c, [okResult("call-2"), okResult("call-1")], null, 4)

    expect(rec.order).toEqual(["resolve:bash", "resolve:read"])
  })
})

describe("mirrors, one per conversation", () => {
  test("keep two conversations' Claude Code sessions apart", () => {
    const mirrors = new SessionMirrors({ claudeDir: undefined, log: silentLog })
    mirrors.setState("pi-a", { sessionId: "cc-a", cursor: 4, cwd: "/tmp" })
    mirrors.setState("pi-b", { sessionId: "cc-b", cursor: 1, cwd: "/tmp" })

    expect(mirrors.state("pi-a")?.sessionId).toBe("cc-a")
    expect(mirrors.state("pi-b")?.sessionId).toBe("cc-b")
    expect(mirrors.state("pi-c")).toBeNull()

    mirrors.setState("pi-b", null)
    expect(mirrors.state("pi-b")).toBeNull()
    expect(mirrors.state("pi-a")?.sessionId).toBe("cc-a")
  })

  test("share one bucket for callers that name no session", () => {
    const mirrors = new SessionMirrors({ claudeDir: undefined, log: silentLog })
    mirrors.setState(null, { sessionId: "cc-none", cursor: 2, cwd: "/tmp" })

    expect(mirrors.state(null)?.sessionId).toBe("cc-none")
    expect(mirrors.state("pi-a")).toBeNull()
  })

  test("two bridges' mirrors are their own", () => {
    const one = new SessionMirrors({ claudeDir: undefined, log: silentLog })
    const two = new SessionMirrors({ claudeDir: undefined, log: silentLog })
    one.setState("pi-a", { sessionId: "cc-a", cursor: 1, cwd: "/tmp" })
    expect(two.state("pi-a")).toBeNull()
  })
})
