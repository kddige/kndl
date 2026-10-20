import { afterEach, describe, expect, test } from "bun:test"
import { TestAgent, ada, callTool, say } from "../test/TestAgent.ts"

let agent: TestAgent | undefined
afterEach(async () => {
  await agent?.dispose()
  agent = undefined
})

/** A 1x1 PNG. */
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

describe("the attachment tool", () => {
  test("opens a prompt's image from the Hub", async () => {
    agent = new TestAgent({
      attachments: { a1: { id: "a1", name: "shot.png", mediaType: "image/png", data: png } },
      reply: (request) =>
        request.last?.role === "toolResult"
          ? say("A tiny image.")
          : callTool("attachment", { id: "a1" }),
    })
    await agent.start()
    agent.send({
      _tag: "DeliverPrompt",
      promptId: "q1",
      text: "Look",
      sender: ada,
      attachments: [{ id: "a1", name: "shot.png", mediaType: "image/png", size: 68 }],
    })
    const events = await agent.until((event) => event._tag === "TurnEnded")
    expect(events.find((event) => event._tag === "TurnStarted")).toMatchObject({
      text: "[Ada Lovelace] Look\n[Image #1: shot.png (attachment a1)]",
      attachments: [{ id: "a1" }],
    })
    // The model was told to open it.
    expect(JSON.stringify(agent.requests[0]?.context.messages)).toContain(
      "the attachment tool once per file",
    )
    expect(events.find((event) => event._tag === "ToolCallEnded")).toMatchObject({
      tool: "attachment",
      outcome: "Succeeded",
      output: "shot.png\n[image/png]",
    })
  })

  test("says why it can't open an unknown file", async () => {
    agent = new TestAgent({
      reply: (request) =>
        request.last?.role === "toolResult"
          ? say("Couldn't.")
          : callTool("attachment", { id: "nope" }),
    })
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Look", sender: ada })
    const events = await agent.until((event) => event._tag === "TurnEnded")
    expect(events.find((event) => event._tag === "ToolCallEnded")).toMatchObject({
      outcome: "Failed",
      output: expect.stringContaining("No such attachment."),
    })
  })
})
