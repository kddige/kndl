// The preamble each kind of conversation reads (Sections.ts): who can do what to it.

import { afterEach, describe, expect, test } from "bun:test"
import { TestAgent, ada, callTool, eventually, say } from "../test/TestAgent.ts"
import type { Request } from "../test/TestAgent.ts"
import { preambleFor } from "./Sections.ts"

let agent: TestAgent | undefined
afterEach(async () => {
  await agent?.dispose()
  agent = undefined
})

const inAgent = (request: Request) =>
  request.system.includes("You are an agent that another agent started")
const inThread = (request: Request) => request.system.includes("This is a thread of the session")

/** The preamble the model reads: the newest text of the "kndl" section. */
const preambleOf = (request: Request) =>
  request.context.messages
    .flatMap((message) => (message.role === "system" ? [message.sections?.kndl ?? ""] : []))
    .findLast((text) => text !== "") ?? ""

describe("the preamble", () => {
  test("tells the main loop that people answer its questions, and reply in threads", () => {
    expect(preambleFor("main")).toContain("or answer your questions")
    expect(preambleFor("main")).toContain("People can also reply in threads")
  })

  test("doesn't tell a thread or a subagent of questions it can't ask", () => {
    for (const kind of ["thread", "agent"] as const) {
      expect(preambleFor(kind)).not.toContain("answer your questions")
      expect(preambleFor(kind)).not.toContain("People can also reply in threads")
    }
    expect(preambleFor("thread")).toContain("steer you while you work, or stop you.")
    expect(preambleFor("agent")).toContain("message you or stop you")
  })

  test("is the one each conversation of a Session reads", async () => {
    const seen = { main: "", thread: "", agent: "" }
    agent = new TestAgent({
      reply: (request) => {
        const kind = inAgent(request) ? "agent" : inThread(request) ? "thread" : "main"
        seen[kind] = preambleOf(request)
        if (kind !== "main") return say("Done.")
        if (request.text.includes("<task-notification>")) return say("Counted.")
        if (request.last?.role === "toolResult") return say("Started an agent.")
        return callTool("agent", { description: "Count files", prompt: "Count the files." })
      },
    })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Count", sender: ada })
    // The Turn that started the agent, and the one its result starts.
    const answered = await eventually(() => {
      const ended = (agent?.hub.ofTag("TurnEnded") ?? []).filter(
        (event) => event.agentId === undefined,
      )
      return ended.length >= 2 ? ended.at(-1) : undefined
    })
    agent.send({
      _tag: "StartThread",
      threadId: "t1",
      anchorTurnId: answered.turnId,
      promptId: "q2",
      text: "Dig in",
      sender: ada,
      model: "openai/gpt-test",
    })
    await agent.event((event) => event._tag === "TurnEnded" && event.threadId === "t1")
    expect(seen.main).toContain("or answer your questions")
    expect(seen.agent).toContain("message you or stop you")
    expect(seen.agent).not.toContain("answer your questions")
    expect(seen.thread).toContain("steer you while you work, or stop you.")
    expect(seen.thread).not.toContain("answer your questions")
  })
})
