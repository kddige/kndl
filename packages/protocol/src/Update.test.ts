import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { HubToRunner, RunnerHello, RunnerToHub } from "./Runner.ts"
import { runnerLogin } from "./testSupport.ts"
import {
  NeedsUpdateText,
  type RunnerUpdateState,
  refusalText,
  sessionsRefusal,
  UpdatingText,
} from "./Update.ts"
import { checkHandshake, HandshakeRejected, ProtocolVersion } from "./Version.ts"

const target = { commit: "a".repeat(40), branch: "main" }

describe("HandshakeRejected", () => {
  test("carries the Hub's commit to a Runner it turns away", () => {
    const rejected = checkHandshake({ protocolVersion: ProtocolVersion + 1 }, target)
    expect(rejected?.hubVersion).toEqual(target)
  })

  test("keeps a shape a Runner from before the commit was added reads", () => {
    // The shape before #87: no hubVersion. Effect Schema ignores the field it doesn't know.
    const Before = Schema.TaggedStruct("HandshakeRejected", {
      reason: Schema.Literals(["ProtocolVersionMismatch", "MalformedHandshake"]),
      protocolVersion: Schema.Int,
      message: Schema.String,
    })
    const rejected = checkHandshake({ protocolVersion: 0 }, target)
    const encoded = JSON.parse(JSON.stringify(Schema.encodeSync(HandshakeRejected)(rejected!)))
    expect(Schema.decodeUnknownSync(Before)(encoded).message).toContain("Update the peer.")
    expect(Schema.decodeUnknownSync(HandshakeRejected)(encoded).hubVersion).toEqual(target)
  })

  test("a Runner on this version reads it without the commit too", () => {
    const rejected = checkHandshake({ protocolVersion: 0 })
    expect(rejected).not.toHaveProperty("hubVersion")
    expect(Schema.decodeUnknownSync(HubToRunner)(rejected)._tag).toBe("HandshakeRejected")
  })
})

describe("RunnerHello", () => {
  const hello = {
    _tag: "RunnerHello",
    protocolVersion: ProtocolVersion,
    name: "studio",
    login: runnerLogin,
    sessions: [],
  }

  test("a Runner from before says nothing of updating", () => {
    expect(Schema.decodeUnknownSync(RunnerHello)(hello)).not.toHaveProperty("updater")
  })

  test("says whether it updates itself, and its last failed update", () => {
    const failure = { target, message: "bun install failed", rolledBack: true, at: 5 }
    const decoded = Schema.decodeUnknownSync(RunnerHello)({
      ...hello,
      updater: { self: true, anyCommit: true },
      lastUpdate: failure,
    })
    expect(decoded.updater).toEqual({ self: true, anyCommit: true })
    expect(decoded.lastUpdate).toEqual(failure)
  })
})

describe("update messages", () => {
  test("round-trip on the Runner channel", () => {
    for (const message of [
      { _tag: "CheckUpdate", target },
      { _tag: "ApplyUpdate", target },
    ]) {
      expect(Schema.decodeUnknownSync(HubToRunner)(message)).toEqual(message as never)
    }
    for (const message of [
      { _tag: "UpdateChecked", target },
      {
        _tag: "UpdateChecked",
        target,
        refusal: { reason: "NotOnMain", message: "not on main" },
      },
      { _tag: "UpdateProgress", target, step: "Installing" },
      {
        _tag: "UpdateFailed",
        failure: { target, message: "x", rolledBack: false, at: 1 },
      },
    ]) {
      expect(Schema.decodeUnknownSync(RunnerToHub)(message)).toEqual(message as never)
    }
  })
})

describe("sessionsRefusal", () => {
  const draining: RunnerUpdateState = {
    _tag: "Draining",
    target,
    since: 0,
    deadline: 1,
    now: false,
    waitingFor: 1,
  }
  const failed: RunnerUpdateState = {
    _tag: "Failed",
    failure: { target, message: "x", rolledBack: true, at: 0 },
  }

  test("refuses a Runner behind the Hub", () => {
    expect(sessionsRefusal("Behind", undefined)).toBe(NeedsUpdateText)
    expect(sessionsRefusal("Behind", failed)).toBe(NeedsUpdateText)
  })

  test("refuses a Runner updating, whatever its version", () => {
    expect(sessionsRefusal("Differs", draining)).toBe(UpdatingText)
    expect(sessionsRefusal("Behind", draining)).toBe(UpdatingText)
  })

  test("lets a current, differing or unknown Runner take Sessions", () => {
    for (const status of ["Current", "Differs", "Unknown"] as const) {
      expect(sessionsRefusal(status, undefined)).toBeUndefined()
      expect(sessionsRefusal(status, failed)).toBeUndefined()
    }
  })
})

test("refusalText says a commit off main as the Runners page does", () => {
  expect(refusalText({ reason: "NotOnMain", message: "" })).toBe("refuses: not on main")
})
