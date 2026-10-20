import { afterEach, describe, expect, test } from "bun:test"
import { TestAgent, ada, callTool, modToken, say } from "../test/TestAgent.ts"

let agent: TestAgent | undefined
afterEach(async () => {
  await agent?.dispose()
  agent = undefined
})

describe("MCP servers", () => {
  test("their tools are deferred, found with tool_search, and called at the Gateway", async () => {
    agent = new TestAgent({
      mcpServers: [{ installationId: "inst1", server: "fake" }],
      reply: (request) => {
        const offered = JSON.stringify(request.context.messages)
        if (request.last?.role === "toolResult" && request.last.toolName === "mcp__fake__echo")
          return say(`It said: ${request.text}`)
        if (request.last?.role === "toolResult")
          return offered.includes('"name":"mcp__fake__echo"')
            ? callTool("mcp__fake__echo", { text: "hi" })
            : say("Discovery wasn't ready.")
        return callTool("tool_search", { query: "echo text back" })
      },
    })
    agent.hub.mcpListDelayMs = 100
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Echo it", sender: ada })
    const events = await agent.until((event) => event._tag === "TurnEnded")
    // Not offered at first: the first request lists no MCP tool.
    expect(JSON.stringify(agent.requests[0]?.context.messages)).not.toContain(
      '"name":"mcp__fake__echo"',
    )
    expect(
      events.filter((event) => event._tag === "ToolCallStarted").map((event) => event.tool),
    ).toEqual(["tool_search", "mcp__fake__echo"])
    expect(
      events
        .filter((event) => event._tag === "TextDelta")
        .map((event) => event.text)
        .join(""),
    ).toBe("It said: echo: hi")
    const call = agent.hub.mcpRequests.find((request) => request.method === "tools/call")
    expect(call).toMatchObject({ installationId: "inst1", authorization: `Bearer ${modToken}` })
  })
})

describe("code mode", () => {
  test("runs a script that calls the agent's tools", async () => {
    agent = new TestAgent({
      codemode: true,
      reply: (request) =>
        request.last?.role === "toolResult"
          ? say(`Script said: ${request.text}`)
          : callTool("codemode", {
              code: 'const out = await tools.bash({ command: "echo from-a-script" }); console.log(out.output.trim())',
            }),
    })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Script it", sender: ada })
    const events = await agent.until((event) => event._tag === "TurnEnded")
    expect(
      events.filter((event) => event._tag === "ToolCallStarted").map((event) => event.tool),
    ).toEqual(["codemode"])
    expect(
      events
        .filter((event) => event._tag === "TextDelta")
        .map((event) => event.text)
        .join(""),
    ).toContain("from-a-script")
  })
})
