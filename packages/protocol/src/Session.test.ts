import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Participant, SessionSummary } from "./Session.ts"
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
