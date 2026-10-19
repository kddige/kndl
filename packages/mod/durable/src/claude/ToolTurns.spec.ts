// Claude's tool calls after a tool call, in one run: the continuation of a held query calls
// another tool, after another Provider's turn (the mirror rebuilds), after a steer, and after a
// compaction placed during the tool round discarded the held query; and one message calls two
// tools. A real Pi Durable Harness, with only Claude Code's query replaced, playing Claude Code's
// messages in the order the real one yields them.

import { afterEach, describe, expect, test } from "bun:test"
import { fauxAssistantMessage } from "@earendil-works/pi-ai"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import { ask, context, Echoed, haiku, other, startDurable, transcript } from "./testing/Durable.ts"
import type { DurableBridge } from "./testing/Durable.ts"
import {
  callTool,
  init,
  result,
  streamedToolCalls,
  text,
  toolUse,
} from "./testing/FakeClaudeCode.ts"
import type { Step } from "./testing/FakeClaudeCode.ts"

let env: DurableBridge | undefined
afterEach(async () => {
  await env?.dispose()
  env = undefined
})

const start = async (options: Parameters<typeof startDurable>[0] = {}) => {
  env = await startDurable({ settings: { retry: { enabled: false } } as never, ...options })
  return env
}

/** Echo, then echo again, thinking before each, then the answer. */
const twoEchoes: ReadonlyArray<Step> = [
  ...streamedToolCalls("msg_first", [{ id: "toolu_first", tool: "echo" }], {
    thinking: "I should echo first.",
  }),
  ...streamedToolCalls("msg_second", [{ id: "toolu_second", tool: "echo" }], {
    thinking: "Now again.",
  }),
  ...text("Echoed twice.", "msg_answer"),
  result("Echoed twice."),
]

const twoEchoesShape = [
  "assistant:[thinking]call:echo",
  `toolResult:${Echoed}`,
  "assistant:[thinking]call:echo",
  `toolResult:${Echoed}`,
  "assistant:Echoed twice.",
]

/** The conversation's assistant messages. */
const assistants = async (bridge: DurableBridge) =>
  (await bridge.conversation.context(context)).messages.filter(
    (message): message is AssistantMessage => message.role === "assistant",
  )

describe("a Claude turn's second tool call", () => {
  test("reaches the Harness after the first's result, and the run ends with the answer", async () => {
    const bridge = await start()
    bridge.fake.scripts.push({ label: "two echoes", steps: [init("cc"), ...twoEchoes] })

    expect((await ask(bridge.conversation, "echo twice")).status).toBe("done")

    expect(await transcript(bridge.conversation)).toEqual(["user:echo twice", ...twoEchoesShape])
    const [first, second] = await assistants(bridge)
    expect(first?.content.map((block) => block.type)).toEqual(["thinking", "toolCall"])
    expect(second?.content.map((block) => block.type)).toEqual(["thinking", "toolCall"])
    // One query held across the run's three requests.
    expect(bridge.fake.calls).toHaveLength(1)
    expect(bridge.calls).toHaveLength(3)
  })

  test("reaches the Harness when the run follows another Provider's turn, on a rebuilt mirror", async () => {
    const bridge = await start()
    bridge.fake.scripts.push(
      { label: "hello", steps: [init("cc"), ...text("Hello."), result("Hello.")] },
      { label: "two echoes", steps: [init("cc"), ...twoEchoes] },
    )
    await ask(bridge.conversation, "hello")
    await bridge.conversation.configure({ model: other }, context)
    bridge.faux.setResponses([fauxAssistantMessage("Something.")])
    await ask(bridge.conversation, "anything?")
    await bridge.conversation.configure({ model: haiku }, context)

    expect((await ask(bridge.conversation, "echo twice")).status).toBe("done")

    expect((await assistants(bridge)).map((message) => message.provider)).toEqual([
      "anthropic",
      "other",
      "anthropic",
      "anthropic",
      "anthropic",
    ])
    // Rebuilt from the conversation, the other Provider's turn in it, under the session's id.
    const [hello, echoes] = bridge.fake.calls
    expect(echoes?.options.resume).toBe(hello?.sessionId)
    expect(echoes?.request).toEqual([
      "user:hello",
      "assistant:Hello.",
      "user:anything?",
      "assistant:Something.",
      "user:echo twice",
      "attachment:total_tokens_reminder",
    ])
    expect((await transcript(bridge.conversation)).slice(4)).toEqual([
      "user:echo twice",
      ...twoEchoesShape,
    ])
  })

  test("reaches the Harness after a steer sent while the first ran", async () => {
    const bridge = await start()
    bridge.fake.scripts.push({
      label: "gate, then echo",
      steps: [
        init("cc"),
        ...toolUse("toolu_gate", "gate"),
        callTool("gate", "toolu_gate"),
        ...streamedToolCalls("msg_echo", [{ id: "toolu_echo", tool: "echo" }]),
        ...text("Done.", "msg_answer"),
        result("Done."),
      ],
    })
    const submission = await bridge.conversation.submit({ type: "input", content: "gate" }, context)
    await bridge.gate.started
    await bridge.conversation.submit(
      { type: "input", content: "and echo, please", whenBusy: "steer" },
      context,
    )
    bridge.gate.open()
    expect((await submission.wait(context)).status).toBe("done")

    expect(await transcript(bridge.conversation)).toEqual([
      "user:gate",
      "assistant:call:gate",
      `toolResult:${Echoed}`,
      "user:and echo, please",
      "assistant:call:echo",
      `toolResult:${Echoed}`,
      "assistant:Done.",
    ])
    // The steer went to the held query, ahead of the result.
    expect(bridge.fake.calls).toHaveLength(1)
    expect(bridge.fake.calls[0]?.steers).toEqual(["and echo, please"])
  })

  test("reaches the Harness from the query that replaced one a compaction discarded", async () => {
    const bridge = await start({
      settings: {
        retry: { enabled: false },
        compaction: { enabled: true, keepRecentTokens: 1 },
      } as never,
    })
    bridge.fake.scripts.push(
      { label: "hello", steps: [init("cc"), ...text("Hello."), result("Hello.")] },
      {
        label: "gate",
        steps: [init("cc"), ...toolUse("toolu_gate", "gate"), callTool("gate", "toolu_gate")],
      },
      {
        label: "summary",
        steps: [
          { type: "assistant", message: { content: [{ type: "text", text: "SUMMARY" }] } },
          result("SUMMARY"),
        ],
      },
      {
        label: "echo, after the compaction",
        steps: [
          init("cc"),
          ...streamedToolCalls("msg_echo", [{ id: "toolu_echo", tool: "echo" }]),
          ...text("Done.", "msg_answer"),
          result("Done."),
        ],
      },
    )
    await ask(bridge.conversation, "hello")
    const submission = await bridge.conversation.submit(
      { type: "input", content: "gate, then echo" },
      context,
    )
    await bridge.gate.started
    // Made while the tool runs, placed at the tool round's end.
    const compaction = await bridge.conversation.compact(undefined, context)
    await bridge.harness.waitForTask(compaction, context)
    bridge.gate.open()
    expect((await submission.wait(context)).status).toBe("done")

    const [hello, gate, , after] = bridge.fake.calls
    expect(gate?.closed).toBe(true)
    expect(gate?.steers).toEqual([])
    expect(after?.prompt).toContain("Your context was compacted")
    // Rebuilt from the compacted conversation, under a new id: the discarded one's Claude Code
    // may still write to the old.
    expect(after?.options.resume).toBeDefined()
    expect(after?.options.resume).not.toBe(hello?.sessionId)
    expect(after?.request?.[0]).toContain("SUMMARY")
    expect((await transcript(bridge.conversation)).slice(-4)).toEqual([
      `toolResult:${Echoed}`,
      "assistant:call:echo",
      `toolResult:${Echoed}`,
      "assistant:Done.",
    ])
  })
})

describe("a Claude message with two tool calls", () => {
  test("reaches the Harness whole, and both results go back to the one query", async () => {
    const bridge = await start()
    bridge.fake.scripts.push({
      label: "both",
      steps: [
        init("cc"),
        ...streamedToolCalls(
          "msg_both",
          [
            { id: "toolu_a", tool: "echo" },
            { id: "toolu_b", tool: "echo" },
          ],
          { thinking: "Both at once." },
        ),
        ...streamedToolCalls("msg_again", [{ id: "toolu_c", tool: "echo" }]),
        ...text("Three echoes.", "msg_answer"),
        result("Three echoes."),
      ],
    })

    expect((await ask(bridge.conversation, "echo")).status).toBe("done")

    expect(await transcript(bridge.conversation)).toEqual([
      "user:echo",
      "assistant:[thinking]call:echocall:echo",
      `toolResult:${Echoed}`,
      `toolResult:${Echoed}`,
      "assistant:call:echo",
      `toolResult:${Echoed}`,
      "assistant:Three echoes.",
    ])
    expect(bridge.fake.calls).toHaveLength(1)
  })
})
