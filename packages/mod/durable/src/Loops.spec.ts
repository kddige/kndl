import { afterEach, describe, expect, test } from "bun:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { InboxDoc, ProviderDoc } from "@earendil-works/pi-durable"
import type { ConversationId } from "@earendil-works/pi-durable"
import {
  TestAgent,
  ada,
  bob,
  callTool,
  conversationOf,
  eventually,
  fauxAssistantMessage,
  fauxText,
  holdTool,
  say,
} from "../test/TestAgent.ts"
import { ThreadsDoc, TurnsDoc } from "./Docs.ts"
import { LoopReporter } from "./Loops.ts"

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
    // A lost admission acknowledgement must be recoverable even after that Turn ended.
    await agent.stop()
    agent.hub.forget()
    const from = agent.hub.events.length
    const requests = agent.requests.length
    await agent.start()
    agent.send({ _tag: "DeliverIntoTurn", promptId: "q2", text: "Use pnpm", sender: bob })
    expect(
      await agent.event((event) => event._tag === "PromptAlreadySubmitted", from),
    ).toMatchObject({ promptId: "q2" })
    expect(agent.requests).toHaveLength(requests)
  })

  test("a steer a tool round's boundary placed before the command looked is still reported, in order", async () => {
    const hold = holdTool()
    agent = new TestAgent({
      extensions: [hold.extension],
      reply: (request) =>
        request.text.includes("[Ada Lovelace] Go") ? callTool("hold", {}) : say("Done."),
    })
    const started = await agent.start()
    // The tool round ends, and places the steer, right after the steer is submitted.
    const root = await started.harness.root(BACKGROUND_CONTEXT)
    const conversation = Object.getPrototypeOf(root) as { submit: typeof root.submit }
    const submit = conversation.submit
    conversation.submit = async function (this: typeof root, draft, context) {
      const submission = await submit.call(this, draft, context)
      if (draft.type === "input" && draft.requestId === "q2") {
        hold.release()
        await eventually(async () => (await submission.status(context)).status !== "queued")
      }
      return submission
    }
    try {
      agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Go", sender: ada })
      const call = await agent.event((event) => event._tag === "ToolCallStarted")
      agent.send({ _tag: "DeliverIntoTurn", promptId: "q2", text: "Use pnpm", sender: bob })
      const events = await agent.until((event) => event._tag === "TurnEnded")
      const steered = events.findIndex((event) => event._tag === "PromptSteered")
      const read = events.findIndex((event) => event._tag === "SteeredPromptRead")
      expect(events[steered]).toMatchObject({
        turnId: call.turnId,
        promptId: "q2",
        text: "Use pnpm",
        sender: bob,
      })
      expect(events[read]).toMatchObject({ turnId: call.turnId, promptId: "q2" })
      expect(steered).toBeGreaterThan(events.findIndex((event) => event._tag === "TurnStarted"))
      expect(read).toBeGreaterThan(steered)
      expect(events.at(-1)).toMatchObject({ turnId: call.turnId, reason: "stop" })
      expect(events.filter((event) => event._tag === "TurnStarted")).toHaveLength(1)
    } finally {
      conversation.submit = submit
    }
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

  test("a steer the stop withdraws stays in the conversation, and the model reads it ahead of the next prompt", async () => {
    const hold = holdTool()
    agent = new TestAgent({
      extensions: [hold.extension],
      reply: (request) => (request.text.includes("Go") ? callTool("hold", {}) : say("Done.")),
    })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Go", sender: ada })
    await agent.event((event) => event._tag === "ToolCallStarted")
    agent.send({ _tag: "DeliverIntoTurn", promptId: "q2", text: "Use pnpm", sender: bob })
    await agent.event((event) => event._tag === "PromptSteered")
    agent.send({ _tag: "StopTurn" })
    await agent.event((event) => event._tag === "TurnEnded")
    // The Turn ended before it read the steer: no one told the Hub it did.
    expect(agent.hub.ofTag("SteeredPromptRead")).toHaveLength(0)
    agent.send({ _tag: "DeliverPrompt", promptId: "q3", text: "Next", sender: ada })
    await agent.event((event) => event._tag === "TurnEnded" && event.reason === "stop")
    const texts = conversationOf(agent.requests.at(-1)).map((message) => message.text)
    const steer = texts.findIndex((text) => text.includes("Use pnpm"))
    const next = texts.findIndex((text) => text.includes("Next"))
    expect(steer).toBeGreaterThan(0)
    expect(next).toBeGreaterThan(steer)
    // Redelivered, the steer is the Hub's to drop: it is in the conversation, and isn't run again.
    const requests = agent.requests.length
    const from = agent.hub.events.length
    agent.send({ _tag: "DeliverIntoTurn", promptId: "q2", text: "Use pnpm", sender: bob })
    await agent.event((event) => event._tag === "PromptAlreadySubmitted", from)
    expect(agent.requests).toHaveLength(requests)
  })

  test("a prompt queued behind the running Turn runs after the stop, and is not lost", async () => {
    const hold = holdTool()
    agent = new TestAgent({
      extensions: [hold.extension],
      reply: (request) => (request.text.includes("Go") ? callTool("hold", {}) : say("Done.")),
    })
    const started = await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Go", sender: ada })
    await agent.event((event) => event._tag === "ToolCallStarted")
    agent.send({ _tag: "DeliverPrompt", promptId: "q2", text: "Then this", sender: bob })
    const root = await started.harness.root(BACKGROUND_CONTEXT)
    await eventually(async () => {
      const inbox = await started.harness.snapshot(InboxDoc, root.id, BACKGROUND_CONTEXT)
      return inbox?.items.length === 1 || undefined
    })
    agent.send({ _tag: "StopTurn" })
    const second = await agent.event(
      (event) => event._tag === "TurnStarted" && event.promptId === "q2",
    )
    expect(second).toMatchObject({ sender: { _tag: "FromParticipant", participant: bob } })
    await agent.event((event) => event._tag === "TurnEnded" && event.turnId === second.turnId)
    expect(conversationOf(agent.requests.at(-1)).at(-1)?.text).toContain("Then this")
    const from = agent.hub.events.length
    agent.send({ _tag: "DeliverPrompt", promptId: "q2", text: "Then this", sender: bob })
    await agent.event((event) => event._tag === "PromptAlreadySubmitted", from)
    expect(agent.hub.ofTag("TurnStarted").filter((event) => event.promptId === "q2")).toHaveLength(
      1,
    )
  })

  test("a prompt delivered again after its submission was withdrawn runs", async () => {
    const hold = holdTool()
    agent = new TestAgent({
      extensions: [hold.extension],
      reply: (request) => (request.text.includes("Go") ? callTool("hold", {}) : say("Done.")),
    })
    const started = await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Go", sender: ada })
    await agent.event((event) => event._tag === "ToolCallStarted")
    // Someone else withdrew the follow-up before the Hub could hear it start.
    const root = await started.harness.root(BACKGROUND_CONTEXT)
    const withdrawn = await root.submit(
      { type: "input", content: "Then this", requestId: "q2" },
      BACKGROUND_CONTEXT,
    )
    await withdrawn.abort(BACKGROUND_CONTEXT)
    agent.send({ _tag: "DeliverPrompt", promptId: "q2", text: "Then this", sender: bob })
    await eventually(async () => {
      const inbox = await started.harness.snapshot(InboxDoc, root.id, BACKGROUND_CONTEXT)
      return inbox?.items.length === 1 || undefined
    })
    hold.release()
    await agent.event((event) => event._tag === "TurnStarted" && event.promptId === "q2")
    expect(agent.hub.ofTag("PromptAlreadySubmitted")).toHaveLength(0)
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

describe("a run that fails", () => {
  test("goes on to the follow-ups queued behind it, which Pi Durable leaves for the next input", async () => {
    const hold = holdTool()
    agent = new TestAgent({
      extensions: [hold.extension],
      settings: { retry: { enabled: false } },
      reply: (request) => {
        if (request.text.includes("Then this")) return say("Did that.")
        return request.last?.role === "toolResult"
          ? fauxAssistantMessage([fauxText("")], {
              stopReason: "error",
              errorMessage: "overloaded",
            })
          : callTool("hold", {})
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
    const failed = await agent.event((event) => event._tag === "TurnEnded")
    expect(failed).toMatchObject({ reason: "error" })
    const second = await agent.event(
      (event) => event._tag === "TurnStarted" && event.promptId === "q2",
    )
    expect(second).toMatchObject({ sender: { _tag: "FromParticipant", participant: bob } })
    expect(
      await agent.event((event) => event._tag === "TurnEnded" && event.turnId === second.turnId),
    ).toMatchObject({ reason: "stop" })
    const inbox = await started.harness.snapshot(InboxDoc, root.id, BACKGROUND_CONTEXT)
    expect(inbox?.items).toEqual([])
  })
})

/** The provider session id of a conversation, which the Claude bridge knows its query by. */
const sessionOf = async (conversationId: ConversationId) => {
  const provider = await agent?.agent?.harness.snapshot(
    ProviderDoc,
    conversationId,
    BACKGROUND_CONTEXT,
  )
  if (provider === undefined) throw new Error("the conversation has no provider session")
  return provider.sessionId
}

describe("a conversation's run settling", () => {
  test("is told to the Models when a Turn ends, and not while it runs", async () => {
    const hold = holdTool()
    agent = new TestAgent({
      extensions: [hold.extension],
      reply: (request) =>
        request.last?.role === "toolResult" ? say("Done.") : callTool("hold", {}),
    })
    const started = await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Go", sender: ada })
    await hold.firstCall
    await Bun.sleep(100)
    expect(agent.settled).toEqual([])
    hold.release()
    await agent.event((event) => event._tag === "TurnEnded")
    const root = await started.harness.root(BACKGROUND_CONTEXT)
    await eventually(() => (agent?.settled.length === 1 ? true : undefined))
    expect(agent.settled).toEqual([await sessionOf(root.id)])
  })

  test("is told when a Turn is stopped, and when it fails", async () => {
    const hold = holdTool()
    agent = new TestAgent({
      extensions: [hold.extension],
      settings: { retry: { enabled: false } },
      reply: (request) =>
        request.text.includes("Fail")
          ? fauxAssistantMessage([fauxText("")], {
              stopReason: "error",
              errorMessage: "overloaded",
            })
          : callTool("hold", {}),
    })
    const started = await agent.start()
    const root = await started.harness.root(BACKGROUND_CONTEXT)
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Go", sender: ada })
    await hold.firstCall
    agent.send({ _tag: "StopTurn" })
    await agent.event((event) => event._tag === "TurnEnded" && event.reason === "aborted")
    await eventually(() => (agent?.settled.length === 1 ? true : undefined))
    agent.send({ _tag: "DeliverPrompt", promptId: "q2", text: "Fail", sender: ada })
    await agent.event((event) => event._tag === "TurnEnded" && event.reason === "error")
    await eventually(() => (agent?.settled.length === 2 ? true : undefined))
    expect(agent.settled).toEqual(Array(2).fill(await sessionOf(root.id)))
  })

  test("is not told when the next run has taken over, but when that ends", async () => {
    const hold = holdTool()
    agent = new TestAgent({
      extensions: [hold.extension],
      reply: (request) =>
        request.last?.role === "toolResult" ? say("Done.") : callTool("hold", {}),
    })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Go", sender: ada })
    await hold.firstCall
    agent.send({ _tag: "DeliverPrompt", promptId: "q2", text: "Then this", sender: bob })
    await Bun.sleep(100)
    // The first Turn ends, and the follow-up's starts and holds its own tool call.
    hold.release()
    hold.rearm()
    await agent.event((event) => event._tag === "TurnEnded")
    await agent.event((event) => event._tag === "TurnStarted" && event.promptId === "q2")
    await Bun.sleep(200)
    expect(agent.settled).toEqual([])
    hold.release()
    await agent.hub.until(() => (agent?.hub.ofTag("TurnEnded").length === 2 ? true : undefined))
    await eventually(() => (agent?.settled.length === 1 ? true : undefined))
    await Bun.sleep(100)
    expect(agent.settled).toHaveLength(1)
  })

  test("is told of a thread's by the thread's own session id", async () => {
    agent = new TestAgent({ reply: () => say("Ok.") })
    const started = await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Hi", sender: ada })
    const first = await agent.event((event) => event._tag === "TurnEnded")
    await eventually(() => (agent?.settled.length === 1 ? true : undefined))
    agent.send({
      _tag: "StartThread",
      threadId: "t1",
      anchorTurnId: first.turnId,
      promptId: "q2",
      text: "Dig in",
      sender: bob,
      model: "openai/gpt-test",
    })
    await agent.event((event) => event._tag === "TurnEnded" && event.threadId === "t1")
    await eventually(() => (agent?.settled.length === 2 ? true : undefined))
    const root = await started.harness.root(BACKGROUND_CONTEXT)
    const thread = (await started.harness.snapshot(ThreadsDoc, BACKGROUND_CONTEXT))?.threads.t1
    expect(agent.settled).toEqual([
      await sessionOf(root.id),
      await sessionOf(thread?.conversationId as ConversationId),
    ])
    expect(agent.settled[1]).not.toBe(agent.settled[0])
  })
})

describe("a stopped reply", () => {
  const poem = Array.from({ length: 40 }, (_, n) => `Verse${n}`).join(" ")

  test("stays in what the model reads, with the marker that it was stopped", async () => {
    agent = new TestAgent({
      reply: (request) => (request.text.includes("Go") ? say(poem) : say("Done.")),
      tokensPerSecond: 60,
    })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Go", sender: ada })
    // Pi Durable commits what streamed every 100 ms: let some words be saved.
    await agent.until(
      (event) =>
        event._tag === "TextDelta" &&
        agent?.hub
          .ofTag("TextDelta")
          .map((each) => each.text)
          .join("")
          .includes("Verse8") === true,
    )
    agent.send({ _tag: "StopTurn" })
    await agent.event((event) => event._tag === "TurnEnded")
    agent.send({ _tag: "DeliverPrompt", promptId: "q2", text: "Instead", sender: bob })
    await agent.event((event) => event._tag === "TurnEnded" && event.reason === "stop")
    const messages = conversationOf(agent.requests.at(-1))
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "user"])
    expect(messages[0]?.text).toContain("[Ada Lovelace] Go")
    expect(messages[1]?.text).toStartWith("Verse0 Verse1")
    expect(messages[1]?.text).not.toContain("Verse39")
    expect(messages[2]?.text).toBe("[Request interrupted by user]")
    expect(messages[3]?.text).toContain("[Bob] Instead")
  })

  test("is stopped once, however often the stop comes", async () => {
    agent = new TestAgent({
      reply: (request) => (request.text.includes("Go") ? say(poem) : say("Done.")),
      tokensPerSecond: 60,
    })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Go", sender: ada })
    await agent.until((event) => event._tag === "TextDelta")
    agent.send({ _tag: "StopTurn" })
    agent.send({ _tag: "StopTurn" })
    await agent.event((event) => event._tag === "TurnEnded")
    agent.send({ _tag: "DeliverPrompt", promptId: "q2", text: "Instead", sender: bob })
    await agent.event((event) => event._tag === "TurnEnded" && event.reason === "stop")
    const marked = conversationOf(agent.requests.at(-1)).filter(
      (message) => message.text === "[Request interrupted by user]",
    )
    expect(marked).toHaveLength(1)
  })

  test("is left out when the reply ended in an error, which no one stopped", async () => {
    agent = new TestAgent({
      reply: (request) =>
        request.text.includes("Go")
          ? fauxAssistantMessage([fauxText("Half an answ")], {
              stopReason: "error",
              errorMessage: "overloaded",
            })
          : say("Done."),
      settings: { retry: { enabled: false } },
    })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Go", sender: ada })
    await agent.event((event) => event._tag === "TurnEnded")
    agent.send({ _tag: "DeliverPrompt", promptId: "q2", text: "Again", sender: ada })
    await agent.event((event) => event._tag === "TurnEnded" && event.reason === "stop")
    const messages = conversationOf(agent.requests.at(-1))
    expect(messages.map((message) => message.role)).toEqual(["user", "user"])
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

  test("streams all of an answer whose first committed partial already holds text", async () => {
    // Pi Durable commits the partial every 100 ms: streamed for longer than that, its first has words.
    const answer = Array.from({ length: 12 }, (_, n) => `Sentence ${n} of the answer.`).join(" ")
    agent = new TestAgent({ reply: () => say(answer), tokensPerSecond: 300 })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Hi", sender: ada })
    const events = await agent.until((event) => event._tag === "TurnEnded")
    expect(
      events
        .filter((event) => event._tag === "TextDelta")
        .map((event) => event.text)
        .join(""),
    ).toBe(answer)
  })
})

describe("the boundary between storage and the Hub's projection", () => {
  test("deduplicates a settled prompt whose events died in the volatile outbox, but does not replay its transcript", async () => {
    agent = new TestAgent({ reply: () => say("This answer remains in SQLite.") })
    agent.hub.rejectEvents = true
    const started = await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q-lost", text: "Persist it", sender: ada })
    await eventually(() => (agent?.requests.length ?? 0) > 0 || undefined)
    const root = await started.harness.root(BACKGROUND_CONTEXT)
    await root.waitForIdle(BACKGROUND_CONTEXT)
    await eventually(async () => {
      const turns = await started.harness.snapshot(TurnsDoc, root.id, BACKGROUND_CONTEXT)
      return (
        (turns !== undefined &&
          turns.current === undefined &&
          Object.keys(turns.turns).length > 0) ||
        undefined
      )
    })
    // A process death discards its unacknowledged outbox. Stop the link before clean shutdown
    // so this test has the same persisted state, without spending two seconds draining to 503.
    started.link.stop()
    await agent.stop()
    expect(agent.hub.events).toHaveLength(0)
    agent.hub.rejectEvents = false
    agent.hub.forget()
    const restarted = await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q-lost", text: "Persist it", sender: ada })
    await agent.event((event) => event._tag === "PromptAlreadySubmitted")
    expect(agent.requests).toHaveLength(1)
    // Characterizes a draft limitation, not an exactly-once event-delivery promise.
    expect(agent.hub.ofTag("TurnStarted")).toHaveLength(0)
    expect(agent.hub.ofTag("TextDelta")).toHaveLength(0)
    const entries = await (
      await restarted.harness.root(BACKGROUND_CONTEXT)
    ).entries({}, 20, undefined, BACKGROUND_CONTEXT)
    expect(JSON.stringify(entries.items)).toContain("This answer remains in SQLite.")
  })
})

describe("a reporter that falls behind", () => {
  test("reconciles committed text and an aborted outcome, without routing agent events to main or thread", async () => {
    const hold = holdTool()
    let rounds = 0
    agent = new TestAgent({
      extensions: [hold.extension],
      reply: () => {
        rounds++
        const call = rounds <= 35 ? callTool("bash", { command: "true" }) : callTool("hold", {})
        return rounds <= 35
          ? { ...call, content: [{ type: "text", text: `Step ${rounds}.` }, ...call.content] }
          : call
      },
    })
    const started = await agent.start()
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const paused = new Promise<void>((resolve) => {
      entered = resolve
    })
    // Pause only this consumer, not the storage/scheduler or the agent's normal reporter.
    const slow = new Proxy(started.harness, {
      get(target, key) {
        if (key === "commit")
          return async (...args: Parameters<typeof target.commit>) => {
            entered()
            await gate
            return target.commit(...args)
          }
        const value = Reflect.get(target, key)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    const events: Array<Record<string, unknown>> = []
    let observing = true
    const reporter = new LoopReporter(
      (await started.harness.root(BACKGROUND_CONTEXT)).id,
      { kind: "agent", agentId: "slow-agent", reported: true },
      {
        harness: () => {
          // watchEvents identifies a Harness by object identity; its later reads can be delayed.
          if (observing) {
            observing = false
            return started.harness
          }
          return slow
        },
        report: (event) => events.push(event),
        newId: () => "slow-turn",
        now: () => performance.now(),
        context: BACKGROUND_CONTEXT,
        secrets: [],
        log: () => {},
        runSettled: () => {},
      },
    )
    try {
      await reporter.attach()
      agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Go", sender: ada })
      await paused
      await hold.firstCall
      agent.send({ _tag: "StopTurn" })
      await agent.event((event) => event._tag === "TurnEnded")
      release()
      await agent.hub.until(() => events.find((event) => event._tag === "TurnEnded"))
      expect(events.find((event) => event._tag === "TurnEnded")).toMatchObject({
        agentId: "slow-agent",
        reason: "aborted",
      })
      // The snapshot's committed tool results must not vanish from the transcript either.
      expect(events.filter((event) => event._tag === "ToolCallEnded")).toHaveLength(36)
      expect(
        events
          .filter((event) => event._tag === "TextDelta")
          .map((event) => event.text)
          .join(""),
      ).toBe(Array.from({ length: 35 }, (_, index) => `Step ${index + 1}.`).join(""))
      expect(
        events.every((event) => event.agentId === "slow-agent" && event.threadId === undefined),
      ).toBe(true)
    } finally {
      release()
      await reporter.stop()
    }
  }, 15_000)
})

describe("a subagent the Hub wasn't told of", () => {
  test("is reported nowhere: none of its events reach the Hub", async () => {
    agent = new TestAgent({
      reply: (request) =>
        request.last?.role === "toolResult"
          ? say("It holds a README.")
          : callTool("bash", { command: "echo hi" }),
    })
    const started = await agent.start()
    const rootId = (await started.harness.root(BACKGROUND_CONTEXT)).id
    const follow = async (agentId: string, reported: boolean) => {
      const events: Array<Record<string, unknown>> = []
      const reporter = new LoopReporter(
        rootId,
        { kind: "agent", agentId, reported },
        {
          harness: () => started.harness,
          report: (event) => events.push(event),
          newId: () => agentId,
          now: () => performance.now(),
          context: BACKGROUND_CONTEXT,
          secrets: [],
          log: () => {},
          runSettled: () => {},
        },
      )
      await reporter.attach()
      return { events, reporter }
    }
    const told = await follow("told", true)
    const quiet = await follow("quiet", false)
    try {
      agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "What's here?", sender: ada })
      await agent.hub.until(() => told.events.find((event) => event._tag === "UsageChanged"))
      await Bun.sleep(100)
      // What the Hub is told of an agent it knows: its text, tools, usage and Turn's end.
      expect(new Set(told.events.map((event) => event._tag))).toEqual(
        new Set([
          "AgentStatusChanged",
          "TextDelta",
          "ToolCallStarted",
          "ToolCallEnded",
          "TurnEnded",
          "UsageChanged",
        ]),
      )
      expect(quiet.events).toEqual([])
    } finally {
      await told.reporter.stop()
      await quiet.reporter.stop()
    }
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
