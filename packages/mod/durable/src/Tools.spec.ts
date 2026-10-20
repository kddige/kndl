import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { InboxDoc } from "@earendil-works/pi-durable"
import {
  TestAgent,
  ada,
  bob,
  callTool,
  eventually,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  holdTool,
  modToken,
  say,
} from "../test/TestAgent.ts"
import { TurnsDoc } from "./Docs.ts"

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

// Pi Durable places the oldest queued follow-up and the first queued steer when the handoff
// ends the run, so what was queued ahead of the handoff's own follow-up goes first. Sequential
// tools hold the handoff behind a tool the test holds, so it queues its follow-up last.
const handsOffAfterHolding = (hold: ReturnType<typeof holdTool>) =>
  new TestAgent({
    settings: { toolExecution: "sequential" },
    extensions: [hold.extension],
    reply: (request) => {
      if (request.text.includes("Continue the work from your handoff note"))
        return say("Carried on.")
      if (request.text.includes("[Bob] Then this")) return say("Did that.")
      return fauxAssistantMessage(
        [fauxToolCall("hold", {}), fauxToolCall("handoff", { note: "We were going." })],
        { stopReason: "toolUse" },
      )
    },
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
    // The handoff's run carries on in the same Turn: the Models hear of its end only once.
    await eventually(() => (agent?.settled.length === 1 ? true : undefined))
    await Bun.sleep(100)
    expect(agent.settled).toHaveLength(1)
    expect(
      events
        .filter((event) => event._tag === "TextDelta")
        .map((event) => event.text)
        .join(""),
    ).toContain("The word is xyzzy")
  })

  test("with a prompt queued ahead of it, goes on in that prompt's Turn, which the handoff ended the first", async () => {
    const hold = holdTool()
    agent = handsOffAfterHolding(hold)
    const started = await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Go", sender: ada })
    await hold.firstCall
    agent.send({ _tag: "DeliverPrompt", promptId: "q2", text: "Then this", sender: bob })
    const root = await started.harness.root(BACKGROUND_CONTEXT)
    await eventually(async () => {
      const inbox = await started.harness.snapshot(InboxDoc, root.id, BACKGROUND_CONTEXT)
      return inbox?.items.length === 1 || undefined
    })
    hold.release()
    await agent.hub.until(() => (agent?.hub.ofTag("TurnEnded").length === 2 ? true : undefined))
    expect(agent.hub.ofTag("TurnStarted").map((turn) => turn.sender)).toMatchObject([
      { _tag: "FromParticipant", participant: ada },
      { _tag: "FromParticipant", participant: bob },
    ])
    expect(
      agent.hub
        .ofTag("TextDelta")
        .map((event) => event.text)
        .join(""),
    ).toBe("Did that.Carried on.")
  })

  test("with a steer queued ahead of it, stays in the same Turn, and the steer is read", async () => {
    const hold = holdTool()
    agent = handsOffAfterHolding(hold)
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Go", sender: ada })
    await hold.firstCall
    agent.send({ _tag: "DeliverIntoTurn", promptId: "q2", text: "Then this", sender: bob })
    await agent.event((event) => event._tag === "PromptSteered")
    hold.release()
    const events = await agent.until((event) => event._tag === "TurnEnded")
    const turn = events.find((event) => event._tag === "TurnStarted")
    expect(events.filter((event) => event._tag === "TurnStarted")).toHaveLength(1)
    expect(events.filter((event) => event._tag === "SteeredPromptRead")).toMatchObject([
      { turnId: turn?.turnId, promptId: "q2" },
    ])
    expect(events.at(-1)).toMatchObject({ turnId: turn?.turnId, reason: "stop" })
    expect(
      events
        .filter((event) => event._tag === "TextDelta")
        .map((event) => event.text)
        .join(""),
    ).toContain("Carried on.")
  })

  test("left queued by a run that failed ahead of it, starts a Turn of its own that is from no terminal", async () => {
    const hold = holdTool()
    agent = new TestAgent({
      settings: { toolExecution: "sequential", retry: { enabled: false } },
      extensions: [hold.extension],
      reply: (request) => {
        if (request.text.includes("Continue the work from your handoff note"))
          return say("Carried on.")
        if (request.text.includes("[Bob] Then this"))
          return fauxAssistantMessage([fauxText("")], {
            stopReason: "error",
            errorMessage: "overloaded",
          })
        return fauxAssistantMessage(
          [fauxToolCall("hold", {}), fauxToolCall("handoff", { note: "We were going." })],
          { stopReason: "toolUse" },
        )
      },
    })
    const started = await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Go", sender: ada })
    await hold.firstCall
    agent.send({ _tag: "DeliverPrompt", promptId: "q2", text: "Then this", sender: bob })
    const root = await started.harness.root(BACKGROUND_CONTEXT)
    await eventually(async () => {
      const inbox = await started.harness.snapshot(InboxDoc, root.id, BACKGROUND_CONTEXT)
      return inbox?.items.length === 1 || undefined
    })
    hold.release()
    await agent.hub.until(() => (agent?.hub.ofTag("TurnEnded").length === 3 ? true : undefined))
    expect(agent.hub.ofTag("TurnEnded").map((turn) => turn.reason)).toEqual([
      "stop",
      "error",
      "stop",
    ])
    expect(agent.hub.ofTag("TurnStarted").map((turn) => turn.sender)).toMatchObject([
      { _tag: "FromParticipant", participant: ada },
      { _tag: "FromParticipant", participant: bob },
      { _tag: "Resumed" },
    ])
    expect(agent.hub.ofTag("TurnStarted")[2]?.text).toBe("")
  })

  test("after a restart, ends the Turn it resumed and the one it went on from, both with their answer", async () => {
    const hold = holdTool()
    agent = new TestAgent({
      extensions: [hold.extension],
      reply: (request) => {
        if (request.text.includes("Continue the work from your handoff note"))
          return say("Carried on.")
        if (request.last?.role === "toolResult" && request.last.toolName === "hold")
          return callTool("handoff", { note: "We were going." })
        return callTool("hold", {})
      },
    })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Go", sender: ada })
    const first = await agent.event((event) => event._tag === "ToolCallStarted")
    await agent.stop()
    agent.hub.forget()
    const from = agent.hub.events.length
    const restarted = await agent.start()
    const resumed = await agent.event((event) => event._tag === "TurnStarted", from)
    await hold.firstCall
    hold.release()
    const events = await agent.until((event) => event._tag === "TurnEnded", from)
    expect(events.filter((event) => event._tag === "TurnStarted")).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ turnId: resumed.turnId, reason: "stop" })
    // A thread forks at either Turn's answer.
    const root = await restarted.harness.root(BACKGROUND_CONTEXT)
    const doc = await eventually(async () => {
      const turns = await restarted.harness.snapshot(TurnsDoc, root.id, BACKGROUND_CONTEXT)
      return turns?.current === undefined ? turns : undefined
    })
    expect(doc.turns[first.turnId as string]?.answer).toBeDefined()
    expect(doc.turns[resumed.turnId as string]?.answer).toBe(
      doc.turns[first.turnId as string]?.answer,
    )
  })
})
