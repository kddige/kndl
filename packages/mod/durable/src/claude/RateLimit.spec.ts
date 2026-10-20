// Claude Code's rate_limit_event, as a notice in the agent's log, and as the name of the failure it
// causes. Ported from pi-claude-bridge 0.9.3's unit-rate-limit test (MIT, Copyright (c) 2026 Eli
// Dickinson): see THIRD_PARTY_NOTICES.md.

import { describe, expect, test } from "bun:test"
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai"
import { QueryContext } from "./QueryState.ts"
import type { RateLimitInfo } from "./RateLimit.ts"
import { consume, fakeStream, testModel } from "./testing/StreamHarness.ts"

/** The notices a turn's rate-limit events give. */
const reports = (infos: ReadonlyArray<RateLimitInfo>) => {
  const notices: Array<string> = []
  const c = new QueryContext(undefined, (text, level) => notices.push(`${level}: ${text}`))
  const stream = fakeStream()
  c.currentStream = stream as unknown as AssistantMessageEventStream
  c.resetTurnState(testModel())
  return consume(
    c,
    infos.map((info) => ({ type: "rate_limit_event", rate_limit_info: info })),
    new Map(),
  ).then(() => notices)
}

describe("rate limits reached or near", () => {
  test("are told, once a 5% step", async () => {
    expect(
      await reports([
        { status: "allowed_warning", utilization: 0.81, rateLimitType: "five_hour" },
        { status: "allowed_warning", utilization: 0.83, rateLimitType: "five_hour" },
        { status: "allowed_warning", utilization: 0.86, rateLimitType: "five_hour" },
      ]),
    ).toEqual([
      "warning: Claude rate limit warning: 81% used (five_hour)",
      "warning: Claude rate limit warning: 86% used (five_hour)",
    ])
  })

  test("a rejection is told with when it resets", async () => {
    const [notice] = await reports([{ status: "rejected", rateLimitType: "five_hour" }])
    expect(notice).toBe(
      "warning: Claude subscription rate limit reached (five_hour) — resets at unknown",
    )
  })
})
