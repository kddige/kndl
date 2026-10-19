import { afterEach, describe, expect, test } from "bun:test"
import { TestAgent, ada, callTool, say } from "../test/TestAgent.ts"

let agent: TestAgent | undefined
afterEach(async () => {
  await agent?.dispose()
  agent = undefined
})

describe("a prompt's Turn", () => {
  test("is reported from its start to its end, with its text, tool calls and usage", async () => {
    agent = new TestAgent({
      reply: (request) =>
        request.last?.role === "toolResult" ? say("It holds a README.") : callTool("bash", { command: "echo hi" }),
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
