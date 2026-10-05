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

const modToHub = [
  {
    _tag: "ModHello",
    protocolVersion: ProtocolVersion,
    sessionId: "s-1",
    claudeSessionId: "0b6d6c1e-claude",
    model: "claude-opus-5-5",
  },
  ...turnEvents,
  { _tag: "PromptFailed", promptId: "p-1", message: "prompt dropped by a hook" },
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
    _tag: "DeliverPrompt",
    sessionId: "s-1",
    promptId: "p-2",
    text: "[Report from Child Session ...]",
    sender: alice,
    fromSession: { _tag: "FromChildSession", session: { id: "s-2", title: "claude/s-2" } },
  },
  { _tag: "StopTurn", sessionId: "s-1" },
  { _tag: "PresenceChanged", sessionId: "s-1", participants: [alice, bob] },
  { _tag: "PresenceChanged", sessionId: "s-1", participants: [] },
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
      usage: { model: "m", inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0 },
    })
  })

  test("rejects a hello without Claude Code's session id", () => {
    const { claudeSessionId: _, ...hello } = modToHub[0] as Record<string, unknown>
    expectRejected(ModToHub, hello)
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
    expectRejected(HubToMod, { _tag: "StopTurn" })
    expectRejected(HubToMod, { _tag: "PresenceChanged", sessionId: "s-1", participants: [{}] })
    expectRejected(HubToMod, { _tag: "SendPrompt", sessionId: "s-1", text: "web-only message" })
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
