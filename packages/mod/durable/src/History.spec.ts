import { afterEach, describe, expect, test } from "bun:test"
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
  say,
} from "../test/TestAgent.ts"
import { TurnsDoc } from "./Docs.ts"
import {
  handoffNote,
  historyAnswer,
  historyInputSchema,
  historyPath,
  historyRequest,
  historyText,
  historyToolDescription,
} from "./History.ts"

let agent: TestAgent | undefined
afterEach(async () => {
  await agent?.dispose()
  agent = undefined
})

const tool = "session_history"

describe("the handoff note", () => {
  test("frames the Hub's text as context for the next prompt, from the Harness before, and says where the left-out Turns are", () => {
    const note = handoffNote(
      {
        from: "Pi",
        text: "Turn #12, prompted by Ada Lovelace\nPrompt: add a health check",
        earlierBefore: 12,
      },
      tool,
    )
    expect(note).toStartWith("<context-handoff>\n")
    expect(note).toEndWith("\n</context-handoff>")
    expect(note).toContain("ran on another agent harness, pi,")
    expect(note).toContain("not a request of its own")
    expect(note).toContain("Turns before #12 were left out")
    expect(note).toContain("call session_history with before=12")
    expect(note).toContain("\n\nTurn #12, prompted by Ada Lovelace\nPrompt: add a health check\n")
  })

  test("names Claude Code, and the tool for any earlier Turn when none were left out", () => {
    const note = handoffNote({ from: "ClaudeCode", text: "Turn #1 …" }, tool)
    expect(note).toContain("ran on another agent harness, Claude Code,")
    expect(note).not.toContain("left out")
    expect(note).toContain(`call ${tool}`)
  })

  test("is nothing when there's nothing to hand over", () => {
    expect(handoffNote({ from: "Pi", text: " \n" }, tool)).toBeUndefined()
    expect(handoffNote({ from: "Pi", text: "", earlierBefore: 4 }, tool)).toContain("before=4")
  })
})

describe("the history tool", () => {
  test("says what a handoff is and when to read more", () => {
    expect(historyToolDescription).toContain("handoff")
    expect(historyToolDescription).toContain("before")
    expect(Object.keys(historyInputSchema.properties)).toEqual(["before", "limit"])
    expect(historyInputSchema).not.toHaveProperty("required")
  })

  test("reads its arguments leniently, and refuses ones that aren't numbers", () => {
    expect(historyRequest({})).toEqual({ limit: 10 })
    expect(historyRequest({ before: 12, limit: 5 })).toEqual({ before: 12, limit: 5 })
    expect(historyRequest({ before: "12", limit: "500" })).toEqual({ before: 12, limit: 50 })
    expect(historyRequest({ limit: 0 })).toEqual({ limit: 1 })
    expect(historyRequest({ before: null })).toEqual({ limit: 10 })
    expect(historyRequest({ before: -1 })).toEqual({
      error: "`before` must be a Turn number, a whole number from 0 up.",
    })
    expect(historyRequest({ limit: "lots" })).toEqual({
      error: "`limit` must be a whole number of Turns.",
    })
  })

  test("asks the Hub for the Turns before one, or the latest", () => {
    expect(historyPath({ before: 12, limit: 5 })).toBe("/mod/history?before=12&limit=5")
    expect(historyPath({ limit: 10 })).toBe("/mod/history?limit=10")
  })
})

describe("the Session's history as the agent reads it", () => {
  const turns = [
    {
      seq: 3,
      by: "Ada Lovelace",
      prompt: "Add a health check.",
      tools: ["bash: curl localhost:8080/health", "edit: src/server.ts"],
      answer: "Added GET /health.",
      model: "openai/gpt-6-sol",
    },
    { seq: 4, by: "terminal", prompt: "thanks", tools: [], answer: "You're welcome." },
  ]

  test("each Turn with its number, who prompted it, its tools and its answer, oldest first; and where the earlier ones are", () => {
    expect(historyText({ turns, earlierBefore: 3 }, { limit: 2 }, tool)).toBe(
      [
        "Turn #3, prompted by Ada Lovelace, on openai/gpt-6-sol",
        "Prompt: Add a health check.",
        "Tools called:",
        "- bash: curl localhost:8080/health",
        "- edit: src/server.ts",
        "Answer: Added GET /health.",
        "",
        "Turn #4, prompted by terminal",
        "Prompt: thanks",
        "Answer: You're welcome.",
        "",
        "There are earlier Turns: call session_history with before=3 to read them.",
      ].join("\n"),
    )
  })

  test("says when it reached the Session's start, or found nothing", () => {
    expect(historyText({ turns }, { limit: 10 }, tool)).toEndWith(
      "\n\nThis is the start of the session: there are no earlier Turns.",
    )
    expect(historyText({ turns: [] }, { before: 1, limit: 10 }, tool)).toBe(
      "There are no Turns before #1.",
    )
    expect(historyText({ turns: [] }, { limit: 10 }, tool)).toBe("This session has no Turns yet.")
  })

  test("reads the Hub's answer, or says why there's none", () => {
    expect(historyAnswer(200, JSON.stringify({ turns: [turns[1]] }), { limit: 10 }, tool)).toEqual({
      text: expect.stringContaining("Turn #4"),
    })
    expect(
      historyAnswer(404, JSON.stringify({ error: "No such Session." }), { limit: 1 }, tool),
    ).toEqual({ error: "Could not read the session's history: No such Session." })
    expect(historyAnswer(502, "Bad Gateway", { limit: 1 }, tool)).toEqual({
      error: "Could not read the session's history: the Hub answered 502.",
    })
    expect(historyAnswer(200, "{}", { limit: 1 }, tool)).toEqual({
      error: "Could not read the session's history: the Hub's answer was not one.",
    })
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
