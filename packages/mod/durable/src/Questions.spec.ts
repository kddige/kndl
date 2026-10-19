import { afterEach, describe, expect, test } from "bun:test"
import { TestAgent, ada, bob, callTool, say } from "../test/TestAgent.ts"

let agent: TestAgent | undefined
afterEach(async () => {
  await agent?.dispose()
  agent = undefined
})

const question = {
  question: "Which library?",
  header: "Library",
  options: [{ label: "date-fns" }, { label: "luxon" }],
  multiSelect: false,
}

describe("ask_user_question", () => {
  test("waits for the answer from the web, which the model reads", async () => {
    agent = new TestAgent({
      reply: (request) =>
        request.last?.role === "toolResult"
          ? say(`Going with it. ${request.text}`)
          : callTool("ask_user_question", { questions: [question] }),
    })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Pick one", sender: ada })
    const asked = await agent.event((event) => event._tag === "QuestionAsked")
    const turn = agent.hub.ofTag("TurnStarted")[0]
    expect(asked).toMatchObject({ turnId: turn?.turnId, questions: [question] })
    expect(asked.async).toBeUndefined()
    agent.send({
      _tag: "DeliverAnswer",
      toolCallId: asked.toolCallId,
      answer: { _tag: "Answered", answers: { "Which library?": "luxon" } },
      sender: bob,
    })
    const events = await agent.until((event) => event._tag === "TurnEnded")
    expect(events.find((event) => event._tag === "QuestionClosed")).toMatchObject({
      toolCallId: asked.toolCallId,
      outcome: { _tag: "Answered" },
      by: bob,
    })
    const said = events
      .filter((event) => event._tag === "TextDelta")
      .map((event) => event.text)
      .join("")
    expect(said).toContain('"Which library?": luxon')
    // An answer after the first comes too late.
    agent.send({
      _tag: "DeliverAnswer",
      toolCallId: asked.toolCallId,
      answer: { _tag: "Dismissed" },
      sender: ada,
    })
    expect(await agent.event((event) => event._tag === "AnswerFailed")).toMatchObject({
      toolCallId: asked.toolCallId,
      senderId: ada.id,
    })
  })

  test("asked async, goes on, and the answer comes as a Turn from whoever answered", async () => {
    agent = new TestAgent({
      reply: (request) => {
        if (request.text.includes("answered the questions you asked earlier"))
          return say("Thanks, Bob.")
        if (request.last?.role === "toolResult") return say("Asked; carrying on.")
        return callTool("ask_user_question", { questions: [question], async: true })
      },
    })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Pick one", sender: ada })
    const asked = await agent.event((event) => event._tag === "QuestionAsked")
    expect(asked.async).toBe(true)
    await agent.event((event) => event._tag === "TurnEnded")
    agent.send({
      _tag: "DeliverAnswer",
      toolCallId: asked.toolCallId,
      answer: { _tag: "Replied", text: "Neither; use Temporal." },
      sender: bob,
    })
    const from = agent.hub.ofTag("TurnEnded").length
    const answered = await agent.event(
      (event) =>
        event._tag === "TurnStarted" &&
        (event.sender as { participant?: { id: string } }).participant?.id === bob.id,
    )
    expect(answered.text).toContain("Neither; use Temporal.")
    expect(answered.promptId).toBeUndefined()
    await agent.event((event) => event._tag === "TurnEnded" && event.turnId === answered.turnId)
    expect(agent.hub.ofTag("TurnEnded").length).toBe(from + 1)
  })

  test("a question a restart cut off is asked again, and its answer still reaches the model", async () => {
    agent = new TestAgent({
      reply: (request) =>
        request.last?.role === "toolResult"
          ? say(`So: ${request.text}`)
          : callTool("ask_user_question", { questions: [question] }),
    })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Pick one", sender: ada })
    const asked = await agent.event((event) => event._tag === "QuestionAsked")
    await agent.stop()
    agent.hub.forget()
    const from = agent.hub.events.length
    await agent.start()
    const again = await agent.event((event) => event._tag === "QuestionAsked", from)
    const resumed = agent.hub.events.slice(from).find((event) => event._tag === "TurnStarted")
    expect(again).toMatchObject({ toolCallId: asked.toolCallId, turnId: resumed?.turnId })
    agent.send({
      _tag: "DeliverAnswer",
      toolCallId: asked.toolCallId,
      answer: { _tag: "Answered", answers: { "Which library?": "date-fns" } },
      sender: bob,
    })
    const events = await agent.until((event) => event._tag === "TurnEnded", from)
    expect(
      events
        .filter((event) => event._tag === "TextDelta")
        .map((event) => event.text)
        .join(""),
    ).toContain("date-fns")
  })

  test("a stopped Turn cancels its question", async () => {
    agent = new TestAgent({ reply: () => callTool("ask_user_question", { questions: [question] }) })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Pick one", sender: ada })
    const asked = await agent.event((event) => event._tag === "QuestionAsked")
    agent.send({ _tag: "StopTurn" })
    const closed = await agent.event((event) => event._tag === "QuestionClosed")
    expect(closed).toMatchObject({ toolCallId: asked.toolCallId, outcome: { _tag: "Cancelled" } })
    await agent.event((event) => event._tag === "TurnEnded")
  })
})
