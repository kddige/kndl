import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { HubToMod, ModHello } from "./Mod.ts"
import { HubToRunner, RunnerHello, RunnerWelcome } from "./Runner.ts"
import { expectRoundTrips, runnerLogin } from "./testSupport.ts"
import { checkHandshake, HandshakeRejected, ProtocolVersion } from "./Version.ts"
import { HubToWeb, WebHello } from "./Web.ts"

const runnerHello = {
  _tag: "RunnerHello",
  protocolVersion: ProtocolVersion,
  name: "studio",
  login: runnerLogin,
  sessions: [],
}

describe("checkHandshake", () => {
  test("accepts a hello of this protocol version", () => {
    expect(checkHandshake(runnerHello)).toBeUndefined()
  })

  test("rejects a newer peer, telling this side to update", () => {
    // A future hello may carry fields this version has never heard of.
    const rejected = checkHandshake({ ...runnerHello, protocolVersion: ProtocolVersion + 1, x: 1 })
    expect(rejected).toEqual({
      _tag: "HandshakeRejected",
      reason: "ProtocolVersionMismatch",
      protocolVersion: ProtocolVersion,
      message: `Protocol version mismatch: the peer speaks version ${ProtocolVersion + 1}, this side speaks version ${ProtocolVersion}. Update this side.`,
    })
  })

  test("rejects an older peer, telling it to update", () => {
    const rejected = checkHandshake({ _tag: "ModHello", protocolVersion: 0 })
    expect(rejected?.reason).toBe("ProtocolVersionMismatch")
    expect(rejected?.message).toContain("Update the peer.")
  })

  test("rejects a first message without a protocol version", () => {
    for (const input of [null, "hello", {}, { protocolVersion: "1" }, { protocolVersion: 1.5 }]) {
      expect(checkHandshake(input)?.reason).toBe("MalformedHandshake")
    }
  })

  test("checks the Hub's welcome the same way", () => {
    expect(
      checkHandshake({ _tag: "RunnerWelcome", protocolVersion: 2, runnerId: "r" })?.reason,
    ).toBe("ProtocolVersionMismatch")
  })
})

describe("hellos and welcomes", () => {
  test("only decode at this protocol version", () => {
    const mismatched = { protocolVersion: ProtocolVersion + 1 }
    const schemas = [
      [RunnerHello, runnerHello],
      [RunnerWelcome, { _tag: "RunnerWelcome", protocolVersion: ProtocolVersion, runnerId: "r-1" }],
      [
        ModHello,
        {
          _tag: "ModHello",
          protocolVersion: ProtocolVersion,
          sessionId: "s-1",
          claudeSessionId: "c-1",
          model: "claude-opus-5-5",
        },
      ],
      [WebHello, { _tag: "WebHello", protocolVersion: ProtocolVersion }],
    ] as const
    for (const [schema, hello] of schemas) {
      expect(Schema.decodeUnknownSync(schema as Schema.Codec<unknown, unknown>)(hello)).toEqual(
        hello,
      )
      expect(() =>
        Schema.decodeUnknownSync(schema as Schema.Codec<unknown, unknown>)({
          ...hello,
          ...mismatched,
        }),
      ).toThrow()
    }
  })
})

describe("HandshakeRejected", () => {
  const rejected = checkHandshake({ protocolVersion: 9 })

  test("round-trips, and is in every Hub-to-peer union", () => {
    expectRoundTrips(HandshakeRejected, [rejected])
    expectRoundTrips(HubToRunner, [rejected])
    expectRoundTrips(HubToMod, [rejected])
    expectRoundTrips(HubToWeb, [rejected])
  })

  test("decodes whatever the rejecting side's version", () => {
    expect(
      Schema.decodeUnknownSync(HandshakeRejected)({ ...rejected, protocolVersion: 9 }),
    ).toEqual({
      ...rejected,
      protocolVersion: 9,
    } as HandshakeRejected)
  })

  test("rejects an unknown reason", () => {
    expect(() =>
      Schema.decodeUnknownSync(HandshakeRejected)({ ...rejected, reason: "Nope" }),
    ).toThrow()
  })
})
