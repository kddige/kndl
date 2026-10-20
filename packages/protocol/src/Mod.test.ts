import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  HubToMod,
  ModCommand,
  ModCommands,
  ModCommandsQuery,
  ModEvent,
  ModEvents,
  ModHelloReply,
  ModToHub,
} from "./Mod.ts"
import {
  alice,
  bob,
  expectEveryTag,
  expectRejected,
  expectRoundTrips,
  turnEvents,
} from "./testSupport.ts"
import { MaxToolSummaryLength } from "./Turn.ts"
import { ProtocolVersion } from "./Version.ts"

const shot = { id: "att-1", name: "shot.png", mediaType: "image/png", size: 12 }

const modToHub = [
  {
    _tag: "ModHello",
    protocolVersion: ProtocolVersion,
    sessionId: "s-1",
    conversationId: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
    model: "claude-opus-5-5",
  },
  ...turnEvents,
  { _tag: "PromptFailed", promptId: "p-1", message: "prompt dropped by a hook" },
  { _tag: "PromptAlreadySubmitted", promptId: "p-1" },
  {
    _tag: "AgentCommandFailed",
    agentId: "a-1",
    command: "MessageAgent",
    senderId: "u-1",
    message: "No agent a-1",
  },
  { _tag: "AgentCommandFailed", agentId: "a-1", command: "StopAgent", message: "No task a-1" },
  { _tag: "AnswerFailed", toolCallId: "toolu_ask", senderId: "u-2", message: "already answered" },
  {
    _tag: "ModelSwitchFailed",
    asked: "openai/gpt-6-sol",
    model: "anthropic/claude-opus-5-5",
    message: "pi has no Model openai/gpt-6-sol",
  },
  { _tag: "ModelSwitchFailed", model: "openai/gpt-6-luna", message: "No default Model" },
  {
    _tag: "ModelSwitchFailed",
    asked: "openai/gpt-6-sol",
    model: "openai/gpt-6-luna",
    message: "No Model openai/gpt-6-sol",
    threadId: "thr-1",
  },
]

const hubToMod = [
  { _tag: "ModWelcome", protocolVersion: ProtocolVersion },
  {
    _tag: "HandshakeRejected",
    reason: "ProtocolVersionMismatch",
    protocolVersion: ProtocolVersion,
    message: "update",
  },
  { _tag: "DeliverPrompt", sessionId: "s-1", promptId: "p-1", text: "add tests", sender: alice },
  {
    _tag: "DeliverIntoTurn",
    sessionId: "s-1",
    promptId: "p-2",
    text: "use the README's port",
    sender: bob,
  },
  { _tag: "StopTurn", sessionId: "s-1" },
  {
    _tag: "DeliverAgentMessage",
    sessionId: "s-1",
    agentId: "a-1",
    text: "also cover the edge cases",
    sender: alice,
  },
  { _tag: "StopAgent", sessionId: "s-1", agentId: "a-1" },
  { _tag: "PresenceChanged", sessionId: "s-1", participants: [alice, bob] },
  { _tag: "PresenceChanged", sessionId: "s-1", participants: [] },
  {
    _tag: "DeliverAnswer",
    sessionId: "s-1",
    toolCallId: "toolu_ask",
    answer: { _tag: "Answered", answers: { "Which date library?": "date-fns, Temporal" } },
    sender: alice,
  },
  {
    _tag: "DeliverAnswer",
    sessionId: "s-1",
    toolCallId: "toolu_ask",
    answer: { _tag: "Replied", text: "let me explain" },
    sender: bob,
  },
  {
    _tag: "DeliverAnswer",
    sessionId: "s-1",
    toolCallId: "toolu_ask",
    answer: { _tag: "Dismissed" },
    sender: bob,
  },
  { _tag: "SwitchModel", sessionId: "s-1", model: "openai/gpt-6-sol", thinkingLevel: "high" },
  { _tag: "SwitchModel", sessionId: "s-1" },
  {
    _tag: "DeliverHandoff",
    sessionId: "s-1",
    from: "Pi",
    text: "Context handoff: Ada asked for a health check; GPT-6-Sol added one.",
    earlierBefore: 12,
  },
  { _tag: "DeliverHandoff", sessionId: "s-1", from: "ClaudeCode", text: "" },
  {
    _tag: "StartThread",
    sessionId: "s-1",
    threadId: "thr-1",
    anchorTurnId: "t-1",
    promptId: "p-7",
    text: "what about Windows?",
    sender: bob,
    model: "openai/gpt-6-luna",
    thinkingLevel: "low",
  },
  {
    _tag: "DeliverThreadPrompt",
    sessionId: "s-1",
    threadId: "thr-1",
    promptId: "p-8",
    text: "and macOS",
    sender: alice,
  },
  { _tag: "StopThread", sessionId: "s-1", threadId: "thr-1" },
  { _tag: "StopThread", sessionId: "s-1", threadId: "thr-1", turnId: "t-4" },
  { _tag: "SwitchThreadModel", sessionId: "s-1", threadId: "thr-1", model: "openai/gpt-6-sol" },
  { _tag: "Compact", requestId: "c-1", sessionId: "s-1", sender: alice },
  {
    _tag: "Compact",
    requestId: "c-2",
    sessionId: "s-1",
    threadId: "thr-1",
    instructions: "Keep the test names",
    sender: bob,
  },
]

describe("ModToHub", () => {
  test("round-trips every message", () => {
    expectEveryTag(ModToHub, modToHub)
    expectRoundTrips(ModToHub, modToHub)
  })

  test("rejects malformed Turn events", () => {
    const [started, , delta, , toolStarted, toolEnded, , ended] = turnEvents
    expectRejected(ModToHub, { ...started, sender: { _tag: "FromParticipant" } })
    expectRejected(ModToHub, { ...started, sender: { _tag: "FromNowhere" } })
    expectRejected(ModToHub, { ...delta, text: "" })
    expectRejected(ModToHub, { ...delta, turnId: 7 })
    expectRejected(ModToHub, { ...delta, agentId: "" })
    expectRejected(ModToHub, { ...toolStarted, tool: "" })
    expectRejected(ModToHub, { ...toolStarted, input: "x".repeat(MaxToolSummaryLength + 1) })
    expectRejected(ModToHub, { ...toolEnded, outcome: "Crashed" })
    expectRejected(ModToHub, { ...ended, reason: "answer" })
    expectRejected(ModToHub, { ...ended, durationMs: -1 })
    expectRejected(ModToHub, {
      ...ended,
      usage: { model: "m", input: 1, output: 1, cacheRead: 0 },
    })
  })

  test("reads a steered prompt of attachments alone (#278)", () => {
    const steered = turnEvents.find((event) => event._tag === "PromptSteered")
    expectRoundTrips(ModToHub, [{ ...steered, text: "", attachments: [shot] }])
  })

  test("rejects a steered prompt without its text or sender", () => {
    const steered = turnEvents.find((event) => event._tag === "PromptSteered")
    expectRejected(ModToHub, { ...steered, text: "" })
    expectRejected(ModToHub, { ...steered, sender: { _tag: "FromTerminal" } })
    expectRejected(ModToHub, { _tag: "SteeredPromptRead", turnId: "t-1" })
  })

  test("rejects a hello without its conversation", () => {
    const { conversationId: _, ...hello } = modToHub[0] as Record<string, unknown>
    expectRejected(ModToHub, hello)
  })

  test("rejects a conversation id that isn't a plain name, which the Runner names files after", () => {
    const hello = modToHub[0] as Record<string, unknown>
    for (const conversationId of [
      "../../.claude/.credentials",
      "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f/../x",
      " 0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
      ".hidden",
      "",
      "x".repeat(129),
    ]) {
      expectRejected(ModToHub, { ...hello, conversationId })
    }
  })
})

describe("HubToMod", () => {
  test("round-trips every message", () => {
    expectEveryTag(HubToMod, hubToMod)
    expectRoundTrips(HubToMod, hubToMod)
  })

  test("rejects malformed messages", () => {
    expectRejected(HubToMod, { ...hubToMod[2], text: "" })
    expectRejected(HubToMod, { ...hubToMod[2], sender: { id: "u-1" } })
    expectRejected(HubToMod, { ...hubToMod[3], text: "" })
    expectRejected(HubToMod, { _tag: "DeliverIntoTurn", sessionId: "s-1", promptId: "p-2" })
    expectRejected(HubToMod, { _tag: "StopTurn" })
    // A Compact without its request id could not be told from one sent again.
    expectRejected(HubToMod, { _tag: "Compact", sessionId: "s-1", sender: alice })
    expectRejected(HubToMod, { _tag: "PresenceChanged", sessionId: "s-1", participants: [{}] })
    expectRejected(HubToMod, { _tag: "SendPrompt", sessionId: "s-1", text: "web-only message" })
    const answer = hubToMod.find((message) => message._tag === "DeliverAnswer")
    expectRejected(HubToMod, { ...answer, toolCallId: "" })
    expectRejected(HubToMod, { ...answer, answer: { _tag: "Replied", text: "" } })
    expectRejected(HubToMod, { ...answer, answer: { _tag: "Cancelled" } })
    expectRejected(HubToMod, { ...answer, answer: { _tag: "Answered", answers: { q: 1 } } })
    expectRejected(HubToMod, {
      ...answer,
      answer: { _tag: "Replied", text: "", attachments: [shot] },
    })
  })

  test("carries files into a Turn, to a subagent and with a reply; files alone too, but a reply's (#278)", () => {
    const [steer, message] = [hubToMod[3], hubToMod[5]]
    const answer = hubToMod.find((m) => m._tag === "DeliverAnswer")
    expectRoundTrips(HubToMod, [
      { ...steer, text: "", attachments: [shot] },
      { ...message, text: "", attachments: [shot] },
      { ...answer, answer: { _tag: "Replied", text: "like this", attachments: [shot] } },
    ])
  })
})

describe("the HTTP bodies", () => {
  const events = modToHub.slice(1)
  const commands = hubToMod.slice(2)

  test("ModEvents round-trips a batch of every event, and an empty one", () => {
    expectEveryTag(ModEvent, events as Array<{ _tag: string }>)
    expectRoundTrips(ModEvents, [{ messages: events }, { messages: [] }])
  })

  test("ModEvents refuses a hello", () => {
    expectRejected(ModEvents, { messages: [modToHub[0]] })
    expectRejected(ModEvents, events)
  })

  test("ModHelloReply round-trips a welcome and a rejection", () => {
    expectEveryTag(ModHelloReply, hubToMod.slice(0, 2))
    expectRoundTrips(ModHelloReply, hubToMod.slice(0, 2))
    expectRejected(ModHelloReply, hubToMod[3])
  })

  test("ModCommands round-trips numbered commands, and none", () => {
    expectEveryTag(ModCommand, commands)
    expectRoundTrips(ModCommands, [
      { messages: commands.map((message, i) => ({ seq: i + 1, message })) },
      { messages: [] },
    ])
  })

  test("ModCommands refuses a welcome, and a seq that isn't a whole number", () => {
    expectRejected(ModCommands, { messages: [{ seq: 1, message: hubToMod[0] }] })
    expectRejected(ModCommands, { messages: [{ seq: -1, message: hubToMod[3] }] })
    expectRejected(ModCommands, { messages: [{ seq: 1.5, message: hubToMod[3] }] })
  })

  test("ModCommandsQuery reads numbers from the query string", () => {
    expectRoundTrips(ModCommandsQuery, [{ after: "3", waitMs: "25000" }, {}])
    expect(Schema.decodeUnknownSync(ModCommandsQuery)({ after: "3", waitMs: "100" })).toEqual({
      after: 3,
      waitMs: 100,
    } as typeof ModCommandsQuery.Type)
    expectRejected(ModCommandsQuery, { after: "-1" })
    expectRejected(ModCommandsQuery, { after: "x" })
    expectRejected(ModCommandsQuery, { waitMs: "1.5" })
  })
})
