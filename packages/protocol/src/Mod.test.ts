import { describe, test } from "bun:test"
import { HubToMod, ModToHub } from "./Mod.ts"
import { MaxToolSummaryLength } from "./Turn.ts"
import {
  alice,
  bob,
  expectEveryTag,
  expectRejected,
  expectRoundTrips,
  turnEvents,
} from "./testSupport.ts"
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
