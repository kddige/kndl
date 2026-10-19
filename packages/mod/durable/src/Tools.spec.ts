import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { TestAgent, ada, callTool, eventually, modToken, say } from "../test/TestAgent.ts"

let agent: TestAgent | undefined
afterEach(async () => {
  await agent?.dispose()
  agent = undefined
})

/** A 1x1 PNG. */
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

describe("MCP servers", () => {
  test("their tools are deferred, found with tool_search, and called at the Gateway", async () => {
    agent = new TestAgent({
      mcpServers: [{ installationId: "inst1", server: "fake" }],
      reply: (request) => {
        const offered = JSON.stringify(request.context.messages)
        if (request.last?.role === "toolResult" && request.last.toolName === "mcp__fake__echo")
          return say(`It said: ${request.text}`)
        if (offered.includes('"name":"mcp__fake__echo"') && request.last?.role === "toolResult")
          return callTool("mcp__fake__echo", { text: "hi" })
        return callTool("tool_search", { query: "echo text back" })
      },
    })
    await agent.start()
    await eventually(
      () => agent?.hub.mcpRequests.some((request) => request.method === "tools/list") || undefined,
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
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

describe("the attachment tool", () => {
  test("opens a prompt's image from the Hub", async () => {
    agent = new TestAgent({
      attachments: { a1: { id: "a1", name: "shot.png", mediaType: "image/png", data: png } },
      reply: (request) =>
        request.last?.role === "toolResult"
          ? say("A tiny image.")
          : callTool("attachment", { id: "a1" }),
    })
    await agent.start()
    agent.send({
      _tag: "DeliverPrompt",
      promptId: "q1",
      text: "Look",
      sender: ada,
      attachments: [{ id: "a1", name: "shot.png", mediaType: "image/png", size: 68 }],
    })
    const events = await agent.until((event) => event._tag === "TurnEnded")
    expect(events.find((event) => event._tag === "TurnStarted")).toMatchObject({
      text: "[Ada Lovelace] Look\n[Image #1: shot.png (attachment a1)]",
      attachments: [{ id: "a1" }],
    })
    // The model was told to open it.
    expect(JSON.stringify(agent.requests[0]?.context.messages)).toContain(
      "the attachment tool once per file",
    )
    expect(events.find((event) => event._tag === "ToolCallEnded")).toMatchObject({
      tool: "attachment",
      outcome: "Succeeded",
      output: "shot.png\n[image/png]",
    })
  })

  test("says why it can't open an unknown file", async () => {
    agent = new TestAgent({
      reply: (request) =>
        request.last?.role === "toolResult"
          ? say("Couldn't.")
          : callTool("attachment", { id: "nope" }),
    })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Look", sender: ada })
    const events = await agent.until((event) => event._tag === "TurnEnded")
    expect(events.find((event) => event._tag === "ToolCallEnded")).toMatchObject({
      outcome: "Failed",
      output: expect.stringContaining("No such attachment."),
    })
  })
})

describe("the system prompt", () => {
  test("has the Repo's AGENTS.md and skills, read again as they change", async () => {
    agent = new TestAgent({ reply: () => say("Ok.") })
    writeFileSync(join(agent.dir, "AGENTS.md"), "Always write tests first.\n")
    mkdirSync(join(agent.dir, ".agents/skills/tdd"), { recursive: true })
    writeFileSync(
      join(agent.dir, ".agents/skills/tdd/SKILL.md"),
      "---\nname: tdd\ndescription: Test-driven development, red-green-refactor.\n---\n\nSteps...\n",
    )
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Hi", sender: ada })
    await agent.event((event) => event._tag === "TurnEnded")
    const first = agent.requests[0]?.system ?? ""
    expect(first).toContain("This session is shared through kndl")
    expect(first).toContain("Always write tests first.")
    expect(first).toContain("<name>tdd</name>")
    expect(first).toContain(
      "<description>Test-driven development, red-green-refactor.</description>",
    )
    expect(first).toContain(`<cwd>\n${agent.dir}\n</cwd>`)
    await new Promise((resolve) => setTimeout(resolve, 20))
    writeFileSync(join(agent.dir, "AGENTS.md"), "Never write tests.\n")
    agent.send({ _tag: "DeliverPrompt", promptId: "q2", text: "Again", sender: ada })
    await eventually(() => (agent?.requests.length ?? 0) >= 2 || undefined)
    expect(agent.requests[1]?.system).toContain("Never write tests.")
  })
})

describe("the agent's secrets", () => {
  test("never reach the model or the Hub in a tool's result", async () => {
    agent = new TestAgent({
      reply: (request) =>
        request.last?.role === "toolResult"
          ? say(`Saw ${request.text}`)
          : callTool("bash", { command: `echo ${modToken}` }),
    })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Leak it", sender: ada })
    const events = await agent.until((event) => event._tag === "TurnEnded")
    expect(
      JSON.stringify(events.filter((event) => event._tag !== "ToolCallStarted")),
    ).not.toContain(modToken)
    expect(events.find((event) => event._tag === "ToolCallEnded")?.output).toContain("[redacted]")
    expect(agent.requests[1]?.text).not.toContain(modToken)
  })
})

describe("handing off to itself", () => {
  test("starts a fresh context from its note, in the same Turn, and the past stays searchable", async () => {
    agent = new TestAgent({
      reply: (request) => {
        const said = JSON.stringify(request.context.messages)
        if (request.last?.role === "toolResult" && request.last.toolName === "search_history")
          return say(`Found: ${request.text}`)
        if (request.text.includes("Continue the work from your handoff note"))
          return callTool("search_history", { query: "xyzzy" })
        if (said.includes("The word is xyzzy") && request.last?.role === "user")
          return callTool("update_plan", { steps: [{ text: "Carry on", status: "in_progress" }] })
        if (request.last?.role === "toolResult" && request.last.toolName === "update_plan")
          return callTool("handoff", { note: "We were carrying on. Look up the word." })
        return say("?")
      },
    })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "The word is xyzzy", sender: ada })
    const events = await agent.until((event) => event._tag === "TurnEnded")
    expect(agent.hub.ofTag("TurnStarted")).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ reason: "stop" })
    // The context after the handoff starts from the note: the prompt is gone, but searchable.
    const after = agent.requests.find((request) => request.text.includes("Continue the work"))
    const context = JSON.stringify(after?.context.messages)
    expect(context).toContain("We were carrying on.")
    expect(context).not.toContain("The word is xyzzy")
    expect(after?.text).toContain("[~] Carry on")
    expect(
      events
        .filter((event) => event._tag === "TextDelta")
        .map((event) => event.text)
        .join(""),
    ).toContain("The word is xyzzy")
  })
})
