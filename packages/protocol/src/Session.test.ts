import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  MaxSessionNameLength,
  Participant,
  SessionName,
  SessionSummary,
  sessionNameFrom,
  sessionTitle,
} from "./Session.ts"
import { alice, expectRejected, expectRoundTrips, sessionSummary } from "./testSupport.ts"

const avatarUrl = "https://avatars.githubusercontent.com/u/583231?v=4"

describe("Participant", () => {
  test("round-trips with and without an avatar", () => {
    expectRoundTrips(Participant, [alice, { ...alice, avatarUrl }])
  })

  test("leaves the avatar out when there is none", () => {
    const decoded = Schema.decodeUnknownSync(Participant)(alice)

    expect("avatarUrl" in decoded).toBe(false)
  })

  test("rejects an empty or non-string avatar", () => {
    expectRejected(Participant, { ...alice, avatarUrl: "" })
    expectRejected(Participant, { ...alice, avatarUrl: 7 })
  })

  test("carries the avatar inside a Session summary", () => {
    expectRoundTrips(SessionSummary, [
      sessionSummary,
      { ...sessionSummary, creator: { ...alice, avatarUrl } },
    ])
  })
})

describe("SessionSummary", () => {
  test("round-trips the last output of a Claude Code that exited on its own", () => {
    expectRoundTrips(SessionSummary, [
      {
        ...sessionSummary,
        state: "Asleep",
        lastOutput: "error: The current working directory was deleted",
      },
    ])
  })
})

describe("Session names", () => {
  test("a summary round-trips with a name, and is shown by it", () => {
    const named = { ...sessionSummary, name: "Health check" }
    expectRoundTrips(SessionSummary, [named])
    expect(sessionTitle(Schema.decodeUnknownSync(SessionSummary)(named))).toBe("Health check")
  })

  test("a summary without one is shown by its Work branch", () => {
    expect(sessionTitle(Schema.decodeUnknownSync(SessionSummary)(sessionSummary))).toBe(
      "claude/s-1",
    )
  })

  test("a name is trimmed, not empty and at most the maximum length", () => {
    expectRoundTrips(SessionName, ["a", "x".repeat(MaxSessionNameLength)])
    expectRejected(SessionName, "")
    expectRejected(SessionName, " padded ")
    expectRejected(SessionName, "x".repeat(MaxSessionNameLength + 1))
  })

  test("a rename is trimmed, clears the name when nothing is left, and says why one is too long", () => {
    expect(sessionNameFrom("  Health check ")).toEqual({ name: "Health check" })
    expect(sessionNameFrom("   ")).toEqual({ name: null })
    expect(sessionNameFrom(` ${"x".repeat(MaxSessionNameLength)} `)).toEqual({
      name: "x".repeat(MaxSessionNameLength),
    })
    expect(sessionNameFrom("x".repeat(MaxSessionNameLength + 1))).toBe(
      `A Session name can be at most ${MaxSessionNameLength} characters; this one is ${MaxSessionNameLength + 1}.`,
    )
  })
})
