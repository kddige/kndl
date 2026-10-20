import { afterEach, describe, expect, test } from "bun:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { TestAgent, ada, callTool, holdTool, say } from "../test/TestAgent.ts"

let agent: TestAgent | undefined
afterEach(async () => {
  await agent?.dispose()
  agent = undefined
})

describe("shutting down", () => {
  test("leaves a prompt delivered meanwhile for the next start, not failed", async () => {
    const hold = holdTool()
    agent = new TestAgent({
      reply: (request) => (request.last?.role === "toolResult" ? say("Ok.") : callTool("hold", {})),
      extensions: [hold.extension],
    })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q0", text: "Busy", sender: ada })
    await hold.firstCall
    const stopping = agent.stop()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Hi", sender: ada })
    await stopping
    expect(agent.hub.ofTag("PromptFailed")).toEqual([])
    // The Hub still has the command, which the restarted agent takes after the Turn it resumes.
    hold.release()
    await agent.start()
    const started = await agent.event(
      (event) => event._tag === "TurnStarted" && event.promptId === "q1",
    )
    await agent.event((event) => event._tag === "TurnEnded" && event.turnId === started.turnId)
    expect(agent.hub.ofTag("PromptFailed")).toEqual([])
  })
})

describe("the agent tool", () => {
  test("offers a Model that came to the catalogue after the agent started", async () => {
    agent = new TestAgent({ reply: () => say("Ok.") })
    agent.connectedLater = ["openai/gpt-later"]
    await agent.start()
    agent.send({ _tag: "SwitchModel", model: "openai/gpt-later" })
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Hi", sender: ada })
    await agent.event((event) => event._tag === "TurnEnded")
    const root = await agent.agent?.harness.root(BACKGROUND_CONTEXT)
    const tool = (await root?.agent(BACKGROUND_CONTEXT))?.tools.find(
      (each) => each.name === "agent",
    )
    expect(JSON.stringify(tool?.parameters)).toContain("openai/gpt-later")
  })
})
