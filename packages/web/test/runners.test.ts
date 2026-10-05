import { describe, expect, test } from "bun:test"
import {
  PairingCodeId,
  type PendingPairingCode,
  RunnerId,
  type RunnerSummary,
} from "@claude-hub/protocol"
import {
  codeOutcome,
  sortRunners,
  timeLeft,
  versionNote,
  waitingCodes,
} from "../src/runners/runners.ts"

const runner = (name: string, isOnline: boolean): RunnerSummary => ({
  id: RunnerId.make(`r-${name}`),
  name,
  login: { account: "alice@example.com" },
  isOnline,
  version: null,
  versionStatus: "Unknown",
  lastSeenAt: null,
  openSessions: 0,
})

const pending = (id: string, expiresAt: number): PendingPairingCode => ({
  id: PairingCodeId.make(id),
  createdBy: { id: "u-1", login: "alice", name: "Alice" } as PendingPairingCode["createdBy"],
  createdAt: 0,
  expiresAt,
})

describe("the Runners list", () => {
  test("puts online Runners first, then goes by name", () => {
    const sorted = sortRunners([runner("b", false), runner("c", true), runner("a", false)])
    expect(sorted.map((r) => r.name)).toEqual(["c", "a", "b"])
  })

  test("badges a Runner behind the Hub, or on a commit the Hub doesn't have", () => {
    expect(versionNote("Behind")?.label).toBe("behind the Hub")
    expect(versionNote("Differs")?.label).toBe("not the Hub's commit")
    expect(versionNote("Current")).toBeUndefined()
    expect(versionNote("Unknown")).toBeUndefined()
  })
})

describe("Pairing codes on the page", () => {
  test("leave the waiting list once expired, without waiting for the Hub", () => {
    const codes = [pending("pc-1", 1_000), pending("pc-2", 5_000)]
    expect(waitingCodes(codes, 2_000).map((code) => String(code.id))).toEqual(["pc-2"])
    expect(waitingCodes(null, 0)).toEqual([])
  })

  test("say how long they have left", () => {
    expect(timeLeft(15 * 60_000, 0)).toBe("15 min")
    expect(timeLeft(15 * 60_000 - 500, 0)).toBe("15 min")
    expect(timeLeft(80_000, 0)).toBe("1 min")
    expect(timeLeft(30_000, 0)).toBe("under a minute")
  })

  test("are followed until used, expired or revoked", () => {
    const shown = { id: PairingCodeId.make("pc-1"), expiresAt: 10_000 }
    const studio = runner("studio", true)
    const listed = { pairingCodes: [pending("pc-1", 10_000)], redeemedCodes: {}, runners: [] }
    expect(codeOutcome(shown, listed, 5_000)._tag).toBe("Waiting")
    expect(codeOutcome(shown, listed, 10_000)._tag).toBe("Expired")
    // Not listed any more, and not redeemed: someone revoked it.
    expect(codeOutcome(shown, { ...listed, pairingCodes: [] }, 5_000)._tag).toBe("Revoked")
    // Before the first list, it's waiting.
    expect(codeOutcome(shown, { ...listed, pairingCodes: null }, 5_000)._tag).toBe("Waiting")
    // Redeemed: used, by the Runner the Hub said, even for a Re-pair of a Runner listed before.
    const redeemed = {
      pairingCodes: [],
      redeemedCodes: { [shown.id]: studio.id },
      runners: [studio],
    }
    expect(codeOutcome(shown, redeemed, 20_000)).toEqual({ _tag: "Used", runner: studio })
  })
})
