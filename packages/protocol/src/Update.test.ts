import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { CommitId } from "./Build.ts"
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
    if (rejected === undefined) throw new Error("expected a rejection")
    const encoded = JSON.parse(JSON.stringify(Schema.encodeSync(HandshakeRejected)(rejected)))
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

  test("a minimal one from a Runner from before decodes, with no version and no updater", () => {
    const decoded = Schema.decodeUnknownSync(RunnerHello)(hello)
    expect(decoded).not.toHaveProperty("version")
    expect(decoded).not.toHaveProperty("updater")
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

/** Every message that carries a commit, each carrying `commit`: from the Hub, and from a Runner. */
const carrying = (commit: string) => {
  const version = { commit, branch: "main" }
  return {
    hub: [
      { _tag: "CheckUpdate", target: version },
      { _tag: "ApplyUpdate", target: version },
      {
        _tag: "HandshakeRejected",
        reason: "ProtocolVersionMismatch",
        protocolVersion: ProtocolVersion,
        message: "Update the peer.",
        hubVersion: version,
      },
    ],
    runner: [
      {
        _tag: "RunnerHello",
        protocolVersion: ProtocolVersion,
        name: "studio",
        login: runnerLogin,
        sessions: [],
        version,
      },
      { _tag: "UpdateChecked", target: version },
      { _tag: "UpdateProgress", target: version, step: "Fetching" },
      {
        _tag: "UpdateFailed",
        failure: { target: version, message: "x", rolledBack: true, at: 1 },
      },
    ],
  }
}

describe("a commit on the wire", () => {
  // A Runner hands the Hub's commit to git: anything but a full commit id must not decode.
  const hostile = [
    "--upload-pack=touch /tmp/pwned",
    "-c",
    "abcdef1",
    "A".repeat(40),
    "a".repeat(41),
    `${"a".repeat(39)}g`,
    `${"a".repeat(40)}\n`,
    "",
  ]

  test("is a full commit id: SHA-1 or SHA-256, lowercase", () => {
    for (const commit of ["0123456789abcdef0123456789abcdef01234567", "f".repeat(64)]) {
      expect(Schema.decodeUnknownSync(CommitId)(commit)).toBe(commit)
      const { hub, runner } = carrying(commit)
      for (const message of hub)
        expect(() => Schema.decodeUnknownSync(HubToRunner)(message)).not.toThrow()
      for (const message of runner) {
        expect(() => Schema.decodeUnknownSync(RunnerToHub)(message)).not.toThrow()
      }
    }
  })

  test("refuses anything git could read as an option, a short id, or another case", () => {
    for (const commit of hostile) {
      expect(() => Schema.decodeUnknownSync(CommitId)(commit)).toThrow()
      const { hub, runner } = carrying(commit)
      for (const message of hub)
        expect(() => Schema.decodeUnknownSync(HubToRunner)(message)).toThrow()
      for (const message of runner) {
        expect(() => Schema.decodeUnknownSync(RunnerToHub)(message)).toThrow()
      }
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
