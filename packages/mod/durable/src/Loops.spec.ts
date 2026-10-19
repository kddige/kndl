import { afterEach, describe, expect, test } from "bun:test"
import { TestAgent, ada, bob, callTool, holdTool, say } from "../test/TestAgent.ts"

let agent: TestAgent | undefined
afterEach(async () => {
  await agent?.dispose()
  agent = undefined
})

describe("a prompt's Turn", () => {
  test("is reported from its start to its end, with its text, tool calls and usage", async () => {
    agent = new TestAgent({
      reply: (request) =>
        request.last?.role === "toolResult"
          ? say("It holds a README.")
          : callTool("bash", { command: "echo hi" }),
    })
    await agent.start()
    await agent.hub.until(() => (agent?.hub.hellos.length ?? 0) > 0 || undefined)
    expect(agent.hub.hellos[0]).toMatchObject({
      _tag: "ModHello",
      sessionId: "s-durable",
      conversationId: "conv-1",
      model: "openai/gpt-test",
      switchesModels: true,
      steers: true,
      attaches: true,
      durable: true,
    })
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "What's here?", sender: ada })
    const events = await agent.until((event) => event._tag === "TurnEnded")
    const started = events.find((event) => event._tag === "TurnStarted")
    expect(started).toMatchObject({
      text: "[Ada Lovelace] What's here?",
      sender: { _tag: "FromParticipant", participant: ada },
      promptId: "q1",
    })
    const turnId = started?.turnId
    expect(events.filter((event) => event._tag === "ToolCallStarted")).toMatchObject([
      { turnId, tool: "bash", input: '{"command":"echo hi"}' },
    ])
    expect(events.filter((event) => event._tag === "ToolCallEnded")).toMatchObject([
      { turnId, tool: "bash", outcome: "Succeeded", output: expect.stringContaining("hi") },
    ])
    const text = events
      .filter((event) => event._tag === "TextDelta")
      .map((event) => event.text)
      .join("")
    expect(text).toBe("It holds a README.")
    expect(events.at(-1)).toMatchObject({
      _tag: "TurnEnded",
      turnId,
      reason: "stop",
      usage: { model: "openai/gpt-test", input: expect.any(Number), output: expect.any(Number) },
    })
    const usage = await agent.event((event) => event._tag === "UsageChanged")
    expect(usage).toMatchObject({ usage: { input: expect.any(Number), cost: 0 } })
    expect(usage.threadId).toBeUndefined()
  })
})

describe("steering, stopping and redelivery", () => {
  test("a steered prompt joins the running Turn, and is read at its next step", async () => {
    const hold = holdTool()
    agent = new TestAgent({
      extensions: [hold.extension],
      reply: (request) =>
        request.text.includes("[Ada Lovelace] Go")
          ? callTool("hold", {})
          : request.last?.role === "user" && request.text.includes("Bob sent a new message")
            ? say("Noted, Bob.")
            : say("Done."),
    })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Go", sender: ada })
    const started = await agent.event((event) => event._tag === "ToolCallStarted")
    agent.send({ _tag: "DeliverIntoTurn", promptId: "q2", text: "Use pnpm", sender: bob })
    const steered = await agent.event((event) => event._tag === "PromptSteered")
    expect(steered).toMatchObject({
      turnId: started.turnId,
      promptId: "q2",
      text: "Use pnpm",
      sender: bob,
    })
    hold.release()
    const events = await agent.until((event) => event._tag === "TurnEnded")
    expect(events.find((event) => event._tag === "SteeredPromptRead")).toMatchObject({
      turnId: started.turnId,
      promptId: "q2",
    })
    expect(events.filter((event) => event._tag === "TurnStarted")).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ turnId: started.turnId, reason: "stop" })
    const read = agent.requests.find((request) => request.text.includes("Use pnpm"))
    expect(read?.text).toContain("Bob sent a new message while you were working")
  })

  test("a steer with no Turn running fails", async () => {
    agent = new TestAgent({ reply: () => say("Hi.") })
    await agent.start()
    agent.send({ _tag: "DeliverIntoTurn", promptId: "q9", text: "Late", sender: bob })
    expect(await agent.event((event) => event._tag === "PromptFailed")).toMatchObject({
      promptId: "q9",
      message: "no Turn is running",
    })
  })

  test("a stop ends the Turn as aborted", async () => {
    const hold = holdTool()
    agent = new TestAgent({ extensions: [hold.extension], reply: () => callTool("hold", {}) })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Go", sender: ada })
    await agent.event((event) => event._tag === "ToolCallStarted")
    agent.send({ _tag: "StopTurn" })
    const events = await agent.until((event) => event._tag === "TurnEnded")
    expect(events.at(-1)).toMatchObject({ reason: "aborted" })
    expect(events.find((event) => event._tag === "ToolCallEnded")).toMatchObject({
      outcome: "Failed",
    })
  })

  test("a prompt delivered twice is answered once", async () => {
    agent = new TestAgent({ reply: () => say("Once.") })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Hello", sender: ada })
    await agent.event((event) => event._tag === "TurnEnded")
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Hello", sender: ada })
    expect(await agent.event((event) => event._tag === "PromptAlreadySubmitted")).toMatchObject({
      promptId: "q1",
    })
    expect(agent.hub.ofTag("TurnStarted")).toHaveLength(1)
    expect(agent.requests).toHaveLength(1)
  })
})

describe("a restart", () => {
  test("in the middle of a tool call resumes the run, as a Turn Resumed", async () => {
    const hold = holdTool()
    agent = new TestAgent({
      extensions: [hold.extension],
      reply: (request) =>
        request.last?.role === "toolResult" ? say("Finished after all.") : callTool("hold", {}),
    })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Go", sender: ada })
    const first = await agent.event((event) => event._tag === "ToolCallStarted")
    await agent.stop()
    // The Hub ended the Turn when the agent stopped; it forgets the mod as it would on a restart.
    agent.hub.forget()
    const from = agent.hub.events.length
    await agent.start()
    const resumed = await agent.event((event) => event._tag === "TurnStarted", from)
    expect(resumed).toMatchObject({ sender: { _tag: "Resumed" }, text: "" })
    expect(resumed.turnId).not.toBe(first.turnId)
    await hold.firstCall
    hold.release()
    const events = await agent.until((event) => event._tag === "TurnEnded", from)
    expect(events.at(-1)).toMatchObject({ turnId: resumed.turnId, reason: "stop" })
    expect(
      events
        .filter((event) => event._tag === "TextDelta")
        .map((event) => event.text)
        .join(""),
    ).toBe("Finished after all.")
    // The same prompt delivered again after the restart isn't run again.
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Go", sender: ada })
    await agent.event((event) => event._tag === "PromptAlreadySubmitted", from)
    expect(agent.hub.hellos.length).toBe(2)
  })

  test("cuts off a command that isn't safe to run again, which the model is told", async () => {
    agent = new TestAgent({
      reply: (request) =>
        request.last?.role === "toolResult"
          ? say(`The tool said: ${request.text}`)
          : callTool("bash", { command: "sleep 30; echo late" }),
    })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Go", sender: ada })
    await agent.event((event) => event._tag === "ToolCallStarted")
    await new Promise((resolve) => setTimeout(resolve, 100))
    await agent.stop()
    agent.hub.forget()
    const from = agent.hub.events.length
    await agent.start()
    const events = await agent.until((event) => event._tag === "TurnEnded", from)
    expect(events[0]).toMatchObject({ _tag: "TurnStarted", sender: { _tag: "Resumed" } })
    expect(events.find((event) => event._tag === "ToolCallEnded")).toMatchObject({
      outcome: "Failed",
    })
    const said = events
      .filter((event) => event._tag === "TextDelta")
      .map((event) => event.text)
      .join("")
    expect(said).toContain("interrupted")
  })
})

describe("the Hub restarting", () => {
  test("has the agent say hello again, and take commands as before", async () => {
    agent = new TestAgent({ reply: () => say("Still here.") })
    await agent.start()
    await agent.hub.until(() => (agent?.hub.hellos.length ?? 0) > 0 || undefined)
    agent.hub.forget()
    await agent.hub.until(() => (agent?.hub.hellos.length ?? 0) > 1 || undefined)
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Hello", sender: ada })
    expect(await agent.event((event) => event._tag === "TurnEnded")).toMatchObject({
      reason: "stop",
    })
  })
})
