import { afterEach, describe, expect, test } from "bun:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { TestAgent, ada, callTool, holdTool, say } from "../test/TestAgent.ts"
import { deferred } from "./claude/testing/Durable.ts"

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

  test("doesn't fail the prompt whose handler the closing Harness cuts off, and runs it after the restart", async () => {
    agent = new TestAgent({ reply: () => say("Ok.") })
    const started = await agent.start()
    // A handler still running when the Harness closes, which it then finds closed.
    const root = started.harness.root.bind(started.harness)
    const gate = deferred()
    const entered = deferred()
    Object.assign(started.harness, {
      root: async (...args: Parameters<typeof root>) => {
        entered.resolve()
        await gate.promise
        return root(...args)
      },
    })
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Hi", sender: ada })
    await entered.promise
    // The handler goes on once the Harness has closed, while the link still sends what is reported.
    const close = started.harness.close.bind(started.harness)
    Object.assign(started.harness, {
      close: async (...args: Parameters<typeof close>) => {
        const closed = await close(...args)
        gate.resolve()
        await Bun.sleep(50)
        return closed
      },
    })
    await agent.stop()
    expect(agent.hub.ofTag("PromptFailed")).toEqual([])
    await agent.start()
    const turn = await agent.event(
      (event) => event._tag === "TurnStarted" && event.promptId === "q1",
    )
    await agent.event((event) => event._tag === "TurnEnded" && event.turnId === turn.turnId)
    expect(agent.hub.ofTag("PromptFailed")).toEqual([])
  }, 15_000)
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
