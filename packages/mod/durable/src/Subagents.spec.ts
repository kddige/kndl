import { afterEach, describe, expect, test } from "bun:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { TestAgent, ada, callTool, eventually, holdTool, say } from "../test/TestAgent.ts"
import type { Request } from "../test/TestAgent.ts"
import { AgentsDoc } from "./Docs.ts"

let agent: TestAgent | undefined
afterEach(async () => {
  await agent?.dispose()
  agent = undefined
})

const inAgent = (request: Request) =>
  request.system.includes("You are an agent that another agent started")

describe("a subagent", () => {
  test("runs in the background, and its result starts a Turn from it", async () => {
    agent = new TestAgent({
      reply: (request) => {
        if (inAgent(request)) return say("The repo has 3 files.")
        if (request.text.includes("<task-notification>")) return say("The agent found 3 files.")
        if (request.last?.role === "toolResult") return say("Started an agent.")
        return callTool("agent", { description: "Count files", prompt: "Count the files." })
      },
    })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Count", sender: ada })
    const started = await agent.event((event) => event._tag === "AgentStarted")
    const parent = agent.hub.events.find((event) => event._tag === "TurnStarted")
    expect(started).toMatchObject({
      turnId: parent?.turnId,
      agentType: "general-purpose",
      description: "Count files",
      model: "openai/gpt-test",
      background: true,
    })
    const agentId = started.agentId
    const fromAgent = await agent.event(
      (event) =>
        event._tag === "TurnStarted" && (event.sender as { _tag: string })._tag === "FromAgent",
    )
    expect(fromAgent).toMatchObject({ sender: { _tag: "FromAgent", agentId } })
    expect(fromAgent.text).toContain("<task-id>")
    expect(fromAgent.text).toContain("<status>completed</status>")
    expect(fromAgent.text).toContain("<result>The repo has 3 files.</result>")
    const statuses = agent.hub
      .ofTag("AgentStatusChanged")
      .filter((event) => event.agentId === agentId)
      .map((event) => event.status)
    expect(statuses).toEqual(["Running", "Done"])
    const own = agent.hub.events.filter(
      (event) => event.agentId === agentId && event._tag === "TurnEnded",
    )
    expect(own).toHaveLength(1)
    expect(
      agent.hub.events
        .filter((event) => event._tag === "TextDelta" && event.agentId === agentId)
        .map((event) => event.text)
        .join(""),
    ).toBe("The repo has 3 files.")
    await agent.event((event) => event._tag === "TurnEnded" && event.turnId === fromAgent.turnId)
  })

  test("a call that waits gets its answer", async () => {
    agent = new TestAgent({
      reply: (request) => {
        if (inAgent(request)) return say("42.")
        if (request.last?.role === "toolResult") return say(`It said ${request.text}`)
        return callTool("agent", {
          description: "Ask",
          prompt: "What is it?",
          wait: true,
          model: "xai/grok-test",
        })
      },
    })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Ask it", sender: ada })
    const events = await agent.until(
      (event) => event._tag === "TurnEnded" && event.agentId === undefined,
    )
    expect(events.find((event) => event._tag === "AgentStarted")).toMatchObject({
      background: false,
      model: "xai/grok-test",
    })
    expect(
      events
        .filter((event) => event._tag === "TextDelta" && event.agentId === undefined)
        .map((event) => event.text)
        .join(""),
    ).toBe("It said 42.")
    // Its answer went to the call: no Turn from the agent follows.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(agent.hub.ofTag("TurnStarted")).toHaveLength(1)
  })

  test("is messaged and stopped from the web", async () => {
    const hold = holdTool()
    agent = new TestAgent({
      extensions: [hold.extension],
      reply: (request) => {
        if (inAgent(request)) {
          if (request.text.includes("[Ada Lovelace] And then?")) return say("Then more.")
          return request.last?.role === "toolResult"
            ? say("Held long enough.")
            : callTool("hold", {})
        }
        if (request.text.includes("<task-notification>")) return say("Noted.")
        if (request.last?.role === "toolResult") return say("Started.")
        return callTool("agent", { description: "Hold", prompt: "Hold on." })
      },
    })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Go", sender: ada })
    const started = await agent.event((event) => event._tag === "AgentStarted")
    const agentId = started.agentId
    await agent.event((event) => event._tag === "ToolCallStarted" && event.agentId === agentId)
    agent.send({ _tag: "StopAgent", agentId })
    const stopped = await agent.event(
      (event) =>
        event._tag === "TurnStarted" && (event.sender as { agentId?: string }).agentId === agentId,
    )
    expect(stopped.text).toContain("<status>stopped</status>")
    expect(
      agent.hub
        .ofTag("AgentStatusChanged")
        .filter((event) => event.agentId === agentId)
        .map((event) => event.status),
    ).toEqual(["Running", "Stopped"])
    await agent.event((event) => event._tag === "TurnEnded" && event.turnId === stopped.turnId)
    hold.release()
    // A message resumes it with its context.
    agent.send({ _tag: "DeliverAgentMessage", agentId, text: "And then?", sender: ada })
    const from = agent.hub.events.length
    const resumed = await agent.event(
      (event) =>
        event._tag === "TurnStarted" &&
        (event.sender as { agentId?: string }).agentId === agentId &&
        event.turnId !== stopped.turnId,
      from,
    )
    expect(resumed.text).toContain("<result>Then more.</result>")
    agent.send({ _tag: "StopAgent", agentId: "nobody" })
    expect(await agent.event((event) => event._tag === "AgentCommandFailed")).toMatchObject({
      agentId: "nobody",
      command: "StopAgent",
    })
  })

  test("a thread's agent recovers independently and notifies only its thread", async () => {
    const hold = holdTool()
    agent = new TestAgent({
      extensions: [hold.extension],
      reply: (request) => {
        if (inAgent(request))
          return request.last?.role === "toolResult"
            ? say("Child recovered.")
            : callTool("hold", { label: "child" })
        if (request.system.includes("This is a thread of the session")) {
          if (request.text.includes("<task-notification>"))
            return say("Thread received the result.")
          if (request.last?.role === "toolResult") return say("Child started.")
          return callTool("agent", { description: "Thread child", prompt: "Work independently." })
        }
        if (request.text.includes("main busy")) return callTool("hold", { label: "main" })
        return say("Main answer.")
      },
    })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "anchor", text: "Anchor", sender: ada })
    const anchor = await agent.event((event) => event._tag === "TurnEnded")
    agent.send({ _tag: "DeliverPrompt", promptId: "main", text: "Keep main busy", sender: ada })
    await agent.event((event) => event._tag === "ToolCallStarted")
    agent.send({
      _tag: "StartThread",
      threadId: "t1",
      anchorTurnId: anchor.turnId,
      promptId: "thread",
      text: "Delegate",
      sender: ada,
    })
    const spawned = await agent.event((event) => event._tag === "AgentStarted")
    expect(spawned.threadId).toBe("t1")
    const agentId = String(spawned.agentId)
    await agent.event((event) => event._tag === "ToolCallStarted" && event.agentId === agentId)
    await agent.event((event) => event._tag === "TurnEnded" && event.threadId === "t1")
    const known = await agent.agent?.harness.snapshot(AgentsDoc, BACKGROUND_CONTEXT)
    const record = known?.agents[agentId]
    if (record === undefined) throw new Error("missing child")
    const child = await agent.agent?.harness.conversation(record.conversationId, BACKGROUND_CONTEXT)
    const tools = (await child?.agent(BACKGROUND_CONTEXT))?.tools.map((tool) => tool.name)
    expect(tools).not.toContain("agent")
    expect(tools).not.toContain("ask_user_question")
    await agent.stop()
    agent.hub.forget()
    const from = agent.hub.events.length
    await agent.start()
    await eventually(() => hold.calls.length >= 4 || undefined)
    hold.release()
    const result = await agent.event(
      (event) =>
        event._tag === "TurnStarted" && (event.sender as { agentId?: string }).agentId === agentId,
      from,
    )
    expect(result).toMatchObject({
      threadId: "t1",
      text: expect.stringContaining("Child recovered."),
    })
    await agent.event((event) => event._tag === "TurnEnded" && event.turnId === result.turnId, from)
    const own = agent.hub.events.slice(from).filter((event) => event.agentId === agentId)
    expect(own.length).toBeGreaterThan(2)
    expect(own.every((event) => event.threadId === undefined)).toBe(true)
    expect(
      agent.hub.events
        .slice(from)
        .filter((event) => event._tag === "TurnStarted" && event.threadId === undefined)
        .every((event) => (event.sender as { _tag: string })._tag === "Resumed"),
    ).toBe(true)
  })

  test("survives a restart, Running again, and its result still comes", async () => {
    const hold = holdTool()
    agent = new TestAgent({
      extensions: [hold.extension],
      reply: (request) => {
        if (inAgent(request))
          return request.last?.role === "toolResult" ? say("Survived.") : callTool("hold", {})
        if (request.text.includes("<task-notification>")) return say("Good.")
        if (request.last?.role === "toolResult") return say("Started.")
        return callTool("agent", { description: "Outlive", prompt: "Hold on." })
      },
    })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Go", sender: ada })
    const started = await agent.event((event) => event._tag === "AgentStarted")
    const agentId = started.agentId
    await agent.event((event) => event._tag === "ToolCallStarted" && event.agentId === agentId)
    await agent.event((event) => event._tag === "TurnEnded" && event.agentId === undefined)
    await agent.stop()
    agent.hub.forget()
    const from = agent.hub.events.length
    hold.rearm()
    await agent.start()
    // The Hub marked it Interrupted as the agent stopped; it runs again, where it was.
    expect(
      await agent.event(
        (event) => event._tag === "AgentStatusChanged" && event.agentId === agentId,
        from,
      ),
    ).toMatchObject({ status: "Running" })
    await eventually(() => hold.calls.length >= 2 || undefined)
    hold.release()
    const result = await agent.event(
      (event) =>
        event._tag === "TurnStarted" && (event.sender as { agentId?: string }).agentId === agentId,
      from,
    )
    expect(result.text).toContain("<result>Survived.</result>")
  })
})
