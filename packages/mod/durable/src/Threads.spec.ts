import { afterEach, describe, expect, test } from "bun:test"
import { TestAgent, ada, bob, callTool, holdTool, say } from "../test/TestAgent.ts"
import type { Request } from "../test/TestAgent.ts"

let agent: TestAgent | undefined
afterEach(async () => {
  await agent?.dispose()
  agent = undefined
})

const inThread = (request: Request) => request.system.includes("This is a thread of the session")

describe("a thread", () => {
  test("forks at the anchor's answer, runs beside the main loop, and carries its id", async () => {
    const hold = holdTool()
    agent = new TestAgent({
      extensions: [hold.extension],
      reply: (request) => {
        if (inThread(request)) return say("In the thread: the answer was 42.")
        if (request.text.includes("first question")) return say("The answer is 42.")
        if (request.text.includes("long job")) return callTool("hold", {})
        return say("Main loop done.")
      },
    })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "The first question", sender: ada })
    const first = await agent.event((event) => event._tag === "TurnEnded")
    // The main loop goes on with a long Turn, after the answer the thread forks at.
    agent.send({ _tag: "DeliverPrompt", promptId: "q2", text: "A long job", sender: ada })
    const busy = await agent.event((event) => event._tag === "ToolCallStarted")
    agent.send({
      _tag: "StartThread",
      threadId: "t1",
      anchorTurnId: first.turnId,
      promptId: "q3",
      text: "Why 42?",
      sender: bob,
    })
    const events = await agent.until(
      (event) => event._tag === "TurnEnded" && event.threadId === "t1",
    )
    const started = events.find((event) => event._tag === "TurnStarted" && event.threadId === "t1")
    expect(started).toMatchObject({
      threadId: "t1",
      promptId: "q3",
      text: "[Bob] Why 42?",
      sender: { _tag: "FromParticipant", participant: bob },
    })
    const threadEvents = events.filter((event) => event.turnId === started?.turnId)
    expect(threadEvents.every((event) => event.threadId === "t1")).toBe(true)
    expect(events.at(-1)).toMatchObject({ threadId: "t1", reason: "stop", turnId: started?.turnId })
    // The main loop's Turn is still running meanwhile: no TurnEnded of its own yet.
    expect(
      agent.hub.events.filter(
        (event) => event._tag === "TurnEnded" && event.turnId === busy.turnId,
      ),
    ).toHaveLength(0)
    // The thread saw the main loop up to the answer, and nothing after it.
    const request = agent.requests.find(inThread)
    const said = JSON.stringify(request?.context.messages)
    expect(said).toContain("The answer is 42.")
    expect(said).not.toContain("A long job")
    hold.release()
    await agent.event((event) => event._tag === "TurnEnded" && event.turnId === busy.turnId)
  })

  test("is started once, however often its StartThread is delivered", async () => {
    agent = new TestAgent({
      reply: (request) => (inThread(request) ? say("Thread.") : say("Main.")),
    })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Hi", sender: ada })
    const first = await agent.event((event) => event._tag === "TurnEnded")
    const start = {
      _tag: "StartThread",
      threadId: "t1",
      anchorTurnId: first.turnId,
      promptId: "q2",
      text: "Again?",
      sender: bob,
    }
    agent.send(start)
    await agent.event((event) => event._tag === "TurnEnded" && event.threadId === "t1")
    agent.send(start)
    agent.send({
      _tag: "DeliverThreadPrompt",
      threadId: "t1",
      promptId: "q3",
      text: "More",
      sender: bob,
    })
    await agent.event(
      (event) => event._tag === "TurnStarted" && event.threadId === "t1" && event.promptId === "q3",
    )
    expect(
      agent.hub.events.filter((event) => event._tag === "TurnStarted" && event.promptId === "q2"),
    ).toHaveLength(1)
  })

  test("is steered by a prompt while it runs, and stopped on its own", async () => {
    const hold = holdTool()
    agent = new TestAgent({
      extensions: [hold.extension],
      reply: (request) => {
        if (!inThread(request)) return say("Main.")
        if (request.text.includes("Ada Lovelace sent a new message")) return say("Seen Ada's note.")
        return callTool("hold", {})
      },
    })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Hi", sender: ada })
    const first = await agent.event((event) => event._tag === "TurnEnded")
    agent.send({
      _tag: "StartThread",
      threadId: "t1",
      anchorTurnId: first.turnId,
      promptId: "q2",
      text: "Dig in",
      sender: bob,
    })
    const call = await agent.event(
      (event) => event._tag === "ToolCallStarted" && event.threadId === "t1",
    )
    agent.send({
      _tag: "DeliverThreadPrompt",
      threadId: "t1",
      promptId: "q3",
      text: "Also this",
      sender: ada,
    })
    expect(
      await agent.event((event) => event._tag === "PromptSteered" && event.threadId === "t1"),
    ).toMatchObject({ turnId: call.turnId, promptId: "q3", text: "Also this", sender: ada })
    hold.release()
    const events = await agent.until(
      (event) => event._tag === "TurnEnded" && event.threadId === "t1",
    )
    expect(events.find((event) => event._tag === "SteeredPromptRead")).toMatchObject({
      threadId: "t1",
      turnId: call.turnId,
      promptId: "q3",
    })
    // Stopped: a Turn of the thread ends aborted, the main loop untouched.
    hold.rearm()
    agent.send({
      _tag: "DeliverThreadPrompt",
      threadId: "t1",
      promptId: "q4",
      text: "Hold on",
      sender: ada,
    })
    const from = agent.hub.events.length
    await agent.event((event) => event._tag === "ToolCallStarted" && event.threadId === "t1", from)
    agent.send({ _tag: "StopThread", threadId: "t1" })
    expect(
      await agent.event((event) => event._tag === "TurnEnded" && event.threadId === "t1", from),
    ).toMatchObject({ reason: "aborted" })
  })

  test("runs on its own model, which it switches on its own", async () => {
    agent = new TestAgent({ reply: () => say("Fine.") })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Hi", sender: ada })
    const first = await agent.event((event) => event._tag === "TurnEnded")
    agent.send({
      _tag: "StartThread",
      threadId: "t1",
      anchorTurnId: first.turnId,
      promptId: "q2",
      text: "On grok",
      sender: bob,
      model: "xai/grok-test",
    })
    const ended = await agent.event(
      (event) => event._tag === "TurnEnded" && event.threadId === "t1",
    )
    expect(ended).toMatchObject({ usage: { model: "xai/grok-test" } })
    agent.send({ _tag: "SwitchThreadModel", threadId: "t1", model: "openai/gpt-other" })
    agent.send({ _tag: "SwitchThreadModel", threadId: "t1", model: "openai/nope" })
    expect(await agent.event((event) => event._tag === "ModelSwitchFailed")).toMatchObject({
      threadId: "t1",
      asked: "openai/nope",
      model: "openai/gpt-other",
    })
    agent.send({
      _tag: "DeliverThreadPrompt",
      threadId: "t1",
      promptId: "q3",
      text: "Now?",
      sender: bob,
    })
    expect(
      await agent.event(
        (event) =>
          event._tag === "TurnEnded" && event.threadId === "t1" && event.turnId !== ended.turnId,
      ),
    ).toMatchObject({ usage: { model: "openai/gpt-other" } })
    // The main loop stays on its own.
    agent.send({ _tag: "DeliverPrompt", promptId: "q4", text: "And you?", sender: ada })
    const from = agent.hub.events.length
    expect(
      await agent.event(
        (event) => event._tag === "TurnEnded" && event.threadId === undefined,
        from,
      ),
    ).toMatchObject({ usage: { model: "openai/gpt-test" } })
  })
})

describe("the Plan", () => {
  test("is reported as the agent changes it, and a thread starts with it as of its fork", async () => {
    agent = new TestAgent({
      reply: (request) => {
        if (request.last?.role === "toolResult") return say("Planned.")
        if (inThread(request)) return say("Thread here.")
        if (request.text.includes("Plan it"))
          return callTool("update_plan", {
            steps: [
              { text: "Read the code", status: "done" },
              { text: "Fix the bug", status: "in_progress" },
            ],
          })
        return callTool("update_plan", { steps: [{ text: "Something else", status: "pending" }] })
      },
    })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Plan it", sender: ada })
    const events = await agent.until((event) => event._tag === "TurnEnded")
    expect(events.find((event) => event._tag === "PlanChanged")).toEqual({
      _tag: "PlanChanged",
      plan: {
        steps: [
          { text: "Read the code", status: "done" },
          { text: "Fix the bug", status: "in_progress" },
        ],
      },
    })
    expect(events.find((event) => event._tag === "ToolCallEnded")).toMatchObject({
      output: expect.stringContaining("[~] Fix the bug"),
    })
    const anchor = events.at(-1)
    agent.send({ _tag: "DeliverPrompt", promptId: "q2", text: "Replan", sender: ada })
    await agent.event((event) => event._tag === "TurnEnded" && event.turnId !== anchor?.turnId)
    agent.send({
      _tag: "StartThread",
      threadId: "t1",
      anchorTurnId: anchor?.turnId,
      promptId: "q3",
      text: "Branch off",
      sender: bob,
    })
    const plan = await agent.event(
      (event) => event._tag === "PlanChanged" && event.threadId === "t1",
    )
    expect(plan).toMatchObject({
      plan: { steps: [{ text: "Read the code" }, { text: "Fix the bug", status: "in_progress" }] },
    })
  })
})

describe("Compact", () => {
  test("summarizes the main loop now, as someone asked, and says how it went", async () => {
    agent = new TestAgent({
      reply: (request) =>
        request.system.includes("summar") && !request.system.includes("kndl")
          ? say("## Goal\nA summary of it all.")
          : say(`A long answer: ${"detail ".repeat(400)}`),
      settings: { compaction: { keepRecentTokens: 50 } },
    })
    await agent.start()
    for (const [index, text] of ["One", "Two", "Three"].entries()) {
      agent.send({ _tag: "DeliverPrompt", promptId: `q${index}`, text, sender: ada })
      await agent.until(
        (event) => event._tag === "TurnEnded",
        agent.hub.events.findLastIndex((event) => event._tag === "TurnStarted"),
      )
    }
    agent.send({ _tag: "Compact", instructions: "Keep the names", sender: bob })
    const events = await agent.until((event) => event._tag === "CompactionEnded")
    expect(events.find((event) => event._tag === "CompactionStarted")).toEqual({
      _tag: "CompactionStarted",
      reason: "manual",
      by: bob,
    })
    expect(events.at(-1)).toMatchObject({
      _tag: "CompactionEnded",
      outcome: "compacted",
      summary: expect.stringContaining("A summary of it all."),
    })
  })
})
