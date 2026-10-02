import { describe, expect, test } from "bun:test"
import { expectEveryTag, expectRejected, expectRoundTrips } from "./testSupport.ts"
import { SandboxTools, ToolBridgeCall, ToolBridgeReply } from "./ToolBridge.ts"

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
