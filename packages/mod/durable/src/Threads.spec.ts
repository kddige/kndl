import { afterEach, describe, expect, test } from "bun:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type { EntryId } from "@earendil-works/pi-durable"
import { TestAgent, ada, bob, callTool, conversationOf, holdTool, say } from "../test/TestAgent.ts"
import type { Request } from "../test/TestAgent.ts"
import { PlanDoc, TurnsDoc } from "./Docs.ts"

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
      model: "openai/gpt-test",
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

  test("forks a running Turn at its newest committed progress, not its original prompt", async () => {
    const hold = holdTool()
    agent = new TestAgent({
      extensions: [hold.extension],
      reply: (request) => {
        if (inThread(request)) return say("Following the progress.")
        const call = callTool("hold", {})
        return {
          ...call,
          content: [
            { type: "text", text: "Committed progress: README was examined." },
            ...call.content,
          ],
        }
      },
    })
    const started = await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Investigate", sender: ada })
    const running = await agent.event((event) => event._tag === "ToolCallStarted")
    const root = await started.harness.root(BACKGROUND_CONTEXT)
    const turns = await started.harness.snapshot(TurnsDoc, root.id, BACKGROUND_CONTEXT)
    expect(turns?.turns[String(running.turnId)]?.entry).toBeDefined()
    agent.send({
      _tag: "StartThread",
      threadId: "t1",
      anchorTurnId: running.turnId,
      promptId: "q2",
      text: "About that progress",
      sender: bob,
      model: "openai/gpt-test",
    })
    await agent.event((event) => event._tag === "TurnEnded" && event.threadId === "t1")
    expect(JSON.stringify(agent.requests.find(inThread)?.context.messages)).toContain(
      "Committed progress: README was examined.",
    )
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
      model: "openai/gpt-test",
    }
    agent.send(start)
    await agent.event((event) => event._tag === "TurnEnded" && event.threadId === "t1")
    const redelivered = agent.hub.events.length
    agent.send(start)
    expect(
      await agent.event((event) => event._tag === "PromptAlreadySubmitted", redelivered),
    ).toMatchObject({ promptId: "q2" })
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

  test("recovers an answer's fork anchor if the process died before recording its end", async () => {
    agent = new TestAgent({
      reply: (request) =>
        inThread(request) ? say("Thread answer.") : say("The original answer was 42."),
    })
    const started = await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Original question", sender: ada })
    const first = await agent.event((event) => event._tag === "TurnEnded")
    const root = await started.harness.root(BACKGROUND_CONTEXT)
    await started.harness.commit(async (tx) => {
      const submission = await tx.submissionByRequest(root.id, "q1")
      if (submission === undefined) throw new Error("missing input")
      const doc = await tx.doc(TurnsDoc, root.id)
      const turnId = String(first.turnId)
      doc.current = { input: submission.id, turnIds: [turnId] }
      const turn = doc.turns[turnId]
      if (turn === undefined) throw new Error("missing Turn")
      delete turn.answer
      delete turn.last
    }, BACKGROUND_CONTEXT)
    await agent.stop()
    agent.hub.forget()
    const from = agent.hub.events.length
    await agent.start()
    agent.send({
      _tag: "StartThread",
      threadId: "t1",
      anchorTurnId: first.turnId,
      promptId: "q2",
      text: "Explain",
      sender: bob,
      model: "openai/gpt-test",
    })
    await agent.event((event) => event._tag === "TurnEnded" && event.threadId === "t1", from)
    expect(JSON.stringify(agent.requests.find(inThread)?.context.messages)).toContain(
      "The original answer was 42.",
    )
  })

  test("reports an admission exception instead of leaving a thread prompt pending forever", async () => {
    agent = new TestAgent({ reply: () => say("Main.") })
    const started = await agent.start()
    const root = await started.harness.root(BACKGROUND_CONTEXT)
    // A stale fork point, for example after reopening a mismatched Session's state volume.
    await started.harness.commit(async (tx) => {
      ;(await tx.doc(TurnsDoc, root.id)).turns.stale = { answer: 999_999 as EntryId }
    }, BACKGROUND_CONTEXT)
    agent.send({
      _tag: "StartThread",
      threadId: "t1",
      anchorTurnId: "stale",
      promptId: "q1",
      text: "Try it",
      sender: bob,
      model: "openai/gpt-test",
    })
    expect(await agent.event((event) => event._tag === "PromptFailed")).toMatchObject({
      promptId: "q1",
    })
    agent.send({ _tag: "DeliverPrompt", promptId: "q2", text: "Still working?", sender: ada })
    expect(await agent.event((event) => event._tag === "TurnEnded")).toMatchObject({
      reason: "stop",
    })
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
      model: "openai/gpt-test",
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

  test("keeps what the stop withdrew from it, and a reply it stopped", async () => {
    const hold = holdTool()
    const poem = Array.from({ length: 40 }, (_, n) => `Verse${n}`).join(" ")
    agent = new TestAgent({
      extensions: [hold.extension],
      tokensPerSecond: 60,
      reply: (request) => {
        if (!inThread(request)) return say("Main.")
        if (request.text.includes("Hold")) return callTool("hold", {})
        if (request.text.includes("Recite")) return say(poem)
        return say("Thread.")
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
      text: "Hold",
      sender: bob,
      model: "openai/gpt-test",
    })
    await agent.event((event) => event._tag === "ToolCallStarted" && event.threadId === "t1")
    agent.send({
      _tag: "DeliverThreadPrompt",
      threadId: "t1",
      promptId: "q3",
      text: "Use pnpm",
      sender: ada,
    })
    await agent.event((event) => event._tag === "PromptSteered" && event.threadId === "t1")
    agent.send({ _tag: "StopThread", threadId: "t1" })
    await agent.event((event) => event._tag === "TurnEnded" && event.threadId === "t1")
    expect(agent.hub.ofTag("SteeredPromptRead")).toHaveLength(0)
    // The next prompt starts a Turn, and the model reads the steer ahead of it.
    let from = agent.hub.events.length
    agent.send({
      _tag: "DeliverThreadPrompt",
      threadId: "t1",
      promptId: "q4",
      text: "Recite",
      sender: bob,
    })
    // Pi Durable commits what streamed every 100 ms: let some words be saved.
    await agent.until(
      (event) =>
        event._tag === "TextDelta" &&
        agent?.hub
          .ofTag("TextDelta")
          .map((each) => each.text)
          .join("")
          .includes("Verse8") === true,
      from,
    )
    const steer = conversationOf(agent.requests.at(-1)).map((message) => message.text)
    expect(steer.findIndex((text) => text.includes("Use pnpm"))).toBeGreaterThan(0)
    expect(steer.findIndex((text) => text.includes("Recite"))).toBeGreaterThan(
      steer.findIndex((text) => text.includes("Use pnpm")),
    )
    // Stopped while it streams, its words and that it was stopped are read with the next prompt.
    agent.send({ _tag: "StopThread", threadId: "t1" })
    await agent.event((event) => event._tag === "TurnEnded" && event.threadId === "t1", from)
    from = agent.hub.events.length
    agent.send({
      _tag: "DeliverThreadPrompt",
      threadId: "t1",
      promptId: "q5",
      text: "Instead",
      sender: bob,
    })
    await agent.event((event) => event._tag === "TurnEnded" && event.threadId === "t1", from)
    const texts = conversationOf(agent.requests.at(-1)).map((message) => message.text)
    const marker = texts.indexOf("[Request interrupted by user]")
    expect(marker).toBeGreaterThan(0)
    expect(texts[marker - 1]).toStartWith("Verse0")
    expect(texts[marker + 1]).toContain("Instead")
    // Delivered again, the steer is the Hub's to drop: the thread has it, and doesn't run it twice.
    const requests = agent.requests.length
    from = agent.hub.events.length
    agent.send({
      _tag: "DeliverThreadPrompt",
      threadId: "t1",
      promptId: "q3",
      text: "Use pnpm",
      sender: ada,
    })
    await agent.event((event) => event._tag === "PromptAlreadySubmitted", from)
    expect(agent.requests).toHaveLength(requests)
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
  test("replays its absolute state after a crash between commit and report, including a clear", async () => {
    agent = new TestAgent({ reply: () => say("Ok.") })
    const started = await agent.start()
    const root = await started.harness.root(BACKGROUND_CONTEXT)
    await started.harness.commit(async (tx) => {
      ;(await tx.doc(PlanDoc, root.id)).steps = [
        { text: "Persisted but not reported", status: "pending" },
      ]
    }, BACKGROUND_CONTEXT)
    await agent.stop()
    agent.hub.forget()
    let from = agent.hub.events.length
    const restarted = await agent.start()
    expect(await agent.event((event) => event._tag === "PlanChanged", from)).toMatchObject({
      plan: { steps: [{ text: "Persisted but not reported" }] },
    })
    await restarted.harness.commit(async (tx) => {
      ;(await tx.doc(PlanDoc, root.id)).steps = []
    }, BACKGROUND_CONTEXT)
    await agent.stop()
    agent.hub.forget()
    from = agent.hub.events.length
    await agent.start()
    expect(await agent.event((event) => event._tag === "PlanChanged", from)).toMatchObject({
      plan: { steps: [] },
    })
  })

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
      model: "openai/gpt-test",
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

describe("Compact admission", () => {
  test("a skipped compaction starts before it ends, and invalid threads fail explicitly", async () => {
    agent = new TestAgent({ reply: () => say("Hi.") })
    await agent.start()
    agent.send({ _tag: "Compact", sender: bob })
    let events = await agent.until((event) => event._tag === "CompactionEnded")
    expect(events.map((event) => event._tag)).toEqual(["CompactionStarted", "CompactionEnded"])
    expect(events.at(-1)?.outcome).toBe("skipped")
    const from = agent.hub.events.length
    agent.send({ _tag: "Compact", threadId: "missing", sender: bob })
    events = await agent.until((event) => event._tag === "CompactionEnded", from)
    expect(events.map((event) => event._tag)).toEqual(["CompactionStarted", "CompactionEnded"])
    expect(events.at(-1)).toMatchObject({ threadId: "missing", outcome: "failed" })
  })
})

describe("background compaction", () => {
  test("summarizes a long conversation as it goes, and says so", async () => {
    agent = new TestAgent({
      model: "openai/gpt-tiny",
      settings: {
        compaction: { reserveTokens: 1_000, keepRecentTokens: 400, backgroundTokens: 800 },
      },
      reply: (request) => {
        const first = request.context.messages[0]
        if (first?.role === "system" && JSON.stringify(first.content).includes("summarization"))
          return say("## Goal\nThe summary so far.")
        return say(`An answer: ${"words ".repeat(250)}`)
      },
    })
    await agent.start()
    for (let index = 0; index < 6; index++) {
      const from = agent.hub.events.length
      agent.send({
        _tag: "DeliverPrompt",
        promptId: `q${index}`,
        text: `Question ${index}`,
        sender: ada,
      })
      await agent.until((event) => event._tag === "TurnEnded", from)
      if (agent.hub.ofTag("CompactionEnded").length > 0) break
    }
    const started = await agent.event((event) => event._tag === "CompactionStarted")
    expect(started).toMatchObject({ reason: "threshold" })
    expect(started.by).toBeUndefined()
    expect(await agent.event((event) => event._tag === "CompactionEnded")).toMatchObject({
      outcome: "compacted",
      summary: expect.stringContaining("The summary so far."),
    })
  })
})
