import { describe, expect, test } from "bun:test"
import { expectEveryTag, expectRejected, expectRoundTrips } from "./testSupport.ts"
import { Schema } from "effect"
import {
  SandboxTools,
  ToolBridgeCall,
  ToolBridgeReply,
  ToolCallReply,
  ToolCallStart,
  ToolWaitQuery,
} from "./ToolBridge.ts"

describe("ToolBridgeCall", () => {
  test("round-trips a call to every Sandbox tool", () => {
    expectRoundTrips(
      ToolBridgeCall,
      SandboxTools.map((tool) => ({ tool, input: { command: "ls", nested: { a: [1, 2] } } })),
    )
  })

  test("refuses tools the bridge doesn't run", () => {
    expectRejected(ToolBridgeCall, { tool: "WebFetch", input: {} })
    expectRejected(ToolBridgeCall, { tool: "mcp__x__bash", input: {} })
    expectRejected(ToolBridgeCall, { tool: "Bash" })
    expectRejected(ToolBridgeCall, { tool: "Bash", input: "ls" })
  })
})

describe("ToolBridgeReply", () => {
  const replies = [
    { _tag: "ToolRan", result: { stdout: "hi\n", stderr: "", interrupted: false } },
    { _tag: "ToolFailed", message: "Exit code 2\nls: /nope: No such file or directory" },
    { _tag: "BridgeUnavailable", message: "the Sandbox is not running" },
  ]

  test("round-trips every reply", () => {
    expectEveryTag(ToolBridgeReply, replies)
    expectRoundTrips(ToolBridgeReply, replies)
  })

  test("rejects malformed replies", () => {
    expectRejected(ToolBridgeReply, { _tag: "ToolFailed" })
    expectRejected(ToolBridgeReply, { _tag: "Ok", result: 1 })
    expect(() => expectRejected(ToolBridgeReply, replies[0])).toThrow()
  })
})

describe("ToolCallStart", () => {
  test("round-trips a call to start under the mod's id", () => {
    expectRoundTrips(ToolCallStart, [
      { callId: "toolu_01AbC.x7k2", tool: "Bash", input: { command: "bun test", timeout: 600000 } },
      { callId: "hub-link-3", tool: "Read", input: { file_path: "/workspace/a.ts" } },
    ])
  })

  test("refuses an id that can't stand in a path, and a call without one", () => {
    expectRejected(ToolCallStart, { callId: "", tool: "Bash", input: {} })
    expectRejected(ToolCallStart, { callId: "a/../b", tool: "Bash", input: {} })
    expectRejected(ToolCallStart, { callId: "a b", tool: "Bash", input: {} })
    expectRejected(ToolCallStart, { callId: "x".repeat(129), tool: "Bash", input: {} })
    expectRejected(ToolCallStart, { tool: "Bash", input: {} })
  })
})

describe("ToolCallReply", () => {
  const replies = [
    { _tag: "ToolRan", result: { stdout: "hi\n", stderr: "", interrupted: false } },
    { _tag: "ToolFailed", message: "Exit code 2" },
    { _tag: "BridgeUnavailable", message: "the Sandbox is not running" },
    { _tag: "ToolRunning", callId: "toolu_01.a1" },
    { _tag: "ToolLost", message: "it was cancelled" },
  ]

  test("round-trips every reply", () => {
    expectEveryTag(ToolCallReply, replies)
    expectRoundTrips(ToolCallReply, replies)
  })

  test("reads every reply of the single exchange the same way", () => {
    for (const reply of replies.slice(0, 3))
      expect(Schema.decodeUnknownSync(ToolCallReply)(reply)).toEqual(
        Schema.decodeUnknownSync(ToolBridgeReply)(reply),
      )
  })

  test("rejects malformed replies", () => {
    expectRejected(ToolCallReply, { _tag: "ToolRunning" })
    expectRejected(ToolCallReply, { _tag: "ToolLost" })
  })
})

describe("ToolWaitQuery", () => {
  test("reads waitMs as a whole number of milliseconds", () => {
    expectRoundTrips(ToolWaitQuery, [{ waitMs: "20000" }, {}])
    expect(Schema.decodeUnknownSync(ToolWaitQuery)({ waitMs: "100" })).toEqual({ waitMs: 100 })
    expectRejected(ToolWaitQuery, { waitMs: "1.5" })
    expectRejected(ToolWaitQuery, { waitMs: "-1" })
  })
})
