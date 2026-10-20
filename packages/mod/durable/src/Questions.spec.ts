import { afterEach, describe, expect, test } from "bun:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable"
import {
  TestAgent,
  ada,
  bob,
  callTool,
  conversationOf,
  eventually,
  holdTool,
  say,
} from "../test/TestAgent.ts"
import { QuestionsDoc } from "./Docs.ts"

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

  test("is woken by an answer committed just after it read the question open", async () => {
    agent = new TestAgent({
      reply: (request) =>
        request.last?.role === "toolResult"
          ? say(`Going with it. ${request.text}`)
          : callTool("ask_user_question", { questions: [question] }),
    })
    const started = await agent.start()
    // The answer comes between the call's read of its question and its wait for the answer.
    const snapshot = started.harness.snapshot.bind(started.harness) as (
      ...args: Array<unknown>
    ) => Promise<{ open?: Record<string, { closed?: unknown }> } | undefined>
    let injected = false
    Object.assign(started.harness, {
      snapshot: async (...args: Array<unknown>) => {
        const value = await snapshot(...args)
        const [toolCallId, record] = Object.entries(value?.open ?? {})[0] ?? []
        if (args[0] !== QuestionsDoc || injected || record?.closed !== undefined) return value
        injected = true
        agent?.send({
          _tag: "DeliverAnswer",
          toolCallId,
          answer: { _tag: "Answered", answers: { "Which library?": "luxon" } },
          sender: bob,
        })
        await eventually(async () => {
          const now = await snapshot(...args)
          return now?.open?.[toolCallId ?? ""]?.closed !== undefined || undefined
        })
        return value
      },
    })
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Pick one", sender: ada })
    const ended = await agent.event((event) => event._tag === "TurnEnded")
    expect(ended).toMatchObject({ reason: "stop" })
    expect(
      agent.hub
        .ofTag("TextDelta")
        .map((event) => event.text)
        .join(""),
    ).toContain('"Which library?": luxon')
  }, 5_000)

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

  test("an async answer the stop withdraws stays in the conversation, and the model reads it with the next prompt", async () => {
    const hold = holdTool()
    agent = new TestAgent({
      extensions: [hold.extension],
      reply: (request) =>
        request.text.includes("Go")
          ? callTool("hold", {})
          : request.text.includes("Pick one")
            ? callTool("ask_user_question", { questions: [question], async: true })
            : request.last?.role === "toolResult"
              ? say("Asked; carrying on.")
              : say("Done."),
    })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Pick one", sender: ada })
    const asked = await agent.event((event) => event._tag === "QuestionAsked")
    await agent.event((event) => event._tag === "TurnEnded")
    agent.send({ _tag: "DeliverPrompt", promptId: "q2", text: "Go", sender: ada })
    await agent.event((event) => event._tag === "ToolCallStarted" && event.tool === "hold")
    agent.send({
      _tag: "DeliverAnswer",
      toolCallId: asked.toolCallId,
      answer: { _tag: "Replied", text: "Neither; use Temporal." },
      sender: bob,
    })
    await agent.event((event) => event._tag === "QuestionClosed")
    // Let the answer join the busy run's inbox before the stop withdraws it.
    await new Promise((resolve) => setTimeout(resolve, 200))
    agent.send({ _tag: "StopTurn" })
    await agent.event((event) => event._tag === "TurnEnded" && event.reason === "aborted")
    const from = agent.hub.events.length
    agent.send({ _tag: "DeliverPrompt", promptId: "q3", text: "Next", sender: ada })
    await agent.event((event) => event._tag === "TurnEnded" && event.reason === "stop", from)
    const texts = conversationOf(agent.requests.at(-1)).map((message) => message.text)
    const answer = texts.findIndex((text) => text.includes("Neither; use Temporal."))
    const next = texts.findIndex((text) => text.includes("Next"))
    expect(answer).toBeGreaterThan(0)
    expect(next).toBeGreaterThan(answer)
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

  test("an accepted sync answer survives a restart before the tool result commits", async () => {
    let holding = true
    let accepted!: () => void
    const atResult = new Promise<void>((resolve) => {
      accepted = resolve
    })
    const pause = defineExtension({
      name: "test-answer-checkpoint",
      hooks: [
        hook(ToolTask, {
          afterTool: async (call, _result, _api, context) => {
            if (call.name !== "ask_user_question" || !holding) return
            accepted()
            await new Promise<void>((_resolve, reject) => {
              const abort = () => reject(new Error("restart before result commit"))
              if (context.abortSignal?.aborted) abort()
              else context.abortSignal?.addEventListener("abort", abort, { once: true })
            })
          },
        }),
      ],
    })
    agent = new TestAgent({
      extensions: [pause],
      reply: (request) =>
        request.last?.role === "toolResult"
          ? say(`Kept the answer: ${request.text}`)
          : callTool("ask_user_question", { questions: [question] }),
    })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Pick one", sender: ada })
    const asked = await agent.event((event) => event._tag === "QuestionAsked")
    agent.send({
      _tag: "DeliverAnswer",
      toolCallId: asked.toolCallId,
      answer: { _tag: "Answered", answers: { "Which library?": "luxon" } },
      sender: bob,
    })
    await atResult
    await agent.stop()
    holding = false
    agent.hub.forget()
    const from = agent.hub.events.length
    await agent.start()
    const events = await agent.until((event) => event._tag === "TurnEnded", from)
    expect(events.filter((event) => event._tag === "QuestionAsked")).toHaveLength(0)
    expect(
      events
        .filter((event) => event._tag === "TextDelta")
        .map((event) => event.text)
        .join(""),
    ).toContain("luxon")
  })

  test("recovers an async answer accepted just before its input was admitted", async () => {
    agent = new TestAgent({
      reply: (request) =>
        request.text.includes("Next")
          ? say("Next.")
          : request.text.includes("answered the questions you asked earlier")
            ? say("Recovered Bob's answer.")
            : request.last?.role === "toolResult"
              ? say("Working on.")
              : callTool("ask_user_question", { questions: [question], async: true }),
    })
    const started = await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Pick one", sender: ada })
    const asked = await agent.event((event) => event._tag === "QuestionAsked")
    await agent.event((event) => event._tag === "TurnEnded")
    // The durable checkpoint after accepting an answer, before submitting it to the model.
    await started.harness.commit(async (tx) => {
      const record = (await tx.doc(QuestionsDoc)).open[String(asked.toolCallId)]
      if (record === undefined) throw new Error("missing question")
      record.closed = {
        outcome: { _tag: "Answered", answers: { "Which library?": "luxon" } },
        by: bob,
      }
    }, BACKGROUND_CONTEXT)
    await agent.stop()
    agent.hub.forget()
    const from = agent.hub.events.length
    await agent.start()
    const events = await agent.until((event) => event._tag === "TurnEnded", from)
    expect(events.find((event) => event._tag === "TurnStarted")).toMatchObject({
      sender: { _tag: "FromParticipant", participant: bob },
      text: expect.stringContaining("luxon"),
    })
    expect(events.some((event) => event._tag === "QuestionAsked")).toBe(false)
    // Another crash, after submit but before its acknowledgement, finds the same request id.
    await agent.agent?.harness.commit(async (tx) => {
      const record = (await tx.doc(QuestionsDoc)).open[String(asked.toolCallId)]
      if (record !== undefined) delete record.answerSubmitted
    }, BACKGROUND_CONTEXT)
    await agent.stop()
    agent.hub.forget()
    const requests = agent.requests.length
    const againFrom = agent.hub.events.length
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "barrier", text: "Next", sender: ada })
    await agent.event((event) => event._tag === "TurnEnded", againFrom)
    expect(agent.requests).toHaveLength(requests + 1)
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
