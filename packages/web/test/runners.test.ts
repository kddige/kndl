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
  updateAction,
  updateNote,
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

describe("a Runner's update", () => {
  const target = { commit: "824de4a1f0c3b6e2d9a7c5b48e1f02a3c6d7e9b1", branch: "main" }
  const behind: RunnerSummary = {
    ...runner("ci", true),
    versionStatus: "Behind",
    updater: { self: true },
  }

  test("is offered to an online Runner that updates itself and runs another commit", () => {
    expect(updateAction(behind)).toBe("Update")
    expect(updateAction({ ...behind, versionStatus: "Differs" })).toBe("Update")
    expect(updateAction({ ...behind, versionStatus: "Current" })).toBeUndefined()
    expect(updateAction({ ...behind, isOnline: false })).toBeUndefined()
    // Updated by hand: a developer's checkout, or a Runner too old to say.
    expect(updateAction({ ...behind, updater: { self: false, reason: "dev" } })).toBeUndefined()
    const { updater: _, ...old } = behind
    expect(updateAction(old)).toBeUndefined()
    // Tried again after a refusal or a failure.
    expect(
      updateAction({
        ...behind,
        update: { _tag: "Refused", target, at: 0, refusal: { reason: "NotOnMain", message: "" } },
      }),
    ).toBe("Update")
  })

  test("offers to stop running Turns while it waits for them, and nothing once it moves", () => {
    const draining = {
      _tag: "Draining" as const,
      target,
      since: 0,
      deadline: 600_000,
      now: false,
      waitingFor: 2,
    }
    expect(updateAction({ ...behind, update: draining })).toBe("UpdateNow")
    expect(updateAction({ ...behind, update: { ...draining, now: true } })).toBeUndefined()
    expect(
      updateAction({ ...behind, update: { _tag: "Applying", target, since: 0 } }),
    ).toBeUndefined()
  })

  test("says where it is", () => {
    expect(updateNote(undefined, 0)).toBeUndefined()
    expect(updateNote({ _tag: "Checking", target, since: 0 }, 0)?.detail).toBe(
      "Checking it can move to 824de4a1f0c3…",
    )
    const draining = {
      _tag: "Draining" as const,
      target,
      since: 0,
      deadline: 600_000,
      now: false,
      waitingFor: 2,
    }
    expect(updateNote(draining, 0)?.detail).toBe(
      "No new Sessions. Waiting for 2 Sessions to finish their Turn (stopped in 10 min if still running)…",
    )
    expect(updateNote({ ...draining, waitingFor: 1 }, 570_000)?.detail).toContain(
      "1 Session to finish their Turn (stopped in under a minute",
    )
    expect(updateNote({ ...draining, now: true }, 0)?.detail).toContain(
      "Stopping its running Turns",
    )
    expect(updateNote({ _tag: "Applying", target, since: 0, step: "Installing" }, 0)).toMatchObject(
      { label: "updating", detail: "Installing and building…", busy: true },
    )
    expect(updateNote({ _tag: "Restarting", target, since: 0 }, 0)?.label).toBe("restarting")
  })

  test('says it refused, as "refuses: not on main", or failed', () => {
    const refused = updateNote(
      {
        _tag: "Refused",
        target,
        at: 0,
        refusal: { reason: "NotOnMain", message: "824de4a1f0c3 isn't on origin/main." },
      },
      0,
    )
    expect(refused).toMatchObject({ label: "refuses: not on main", intent: "warning", busy: false })
    const failed = updateNote(
      {
        _tag: "Failed",
        failure: { target, message: "bun install failed.", rolledBack: true, at: 0 },
      },
      0,
    )
    expect(failed).toMatchObject({
      label: "update failed",
      intent: "danger",
      detail: "bun install failed.",
    })
  })

  test("the badge says how to bring a Runner behind to the Hub's commit", () => {
    expect(versionNote("Behind", { self: true })?.title).toContain("Update moves it")
    expect(
      versionNote("Behind", { self: false, reason: "it runs from a dev checkout" })?.title,
    ).toContain("It doesn't update itself: it runs from a dev checkout.")
    expect(versionNote("Behind")?.title).toContain("too old to update itself")
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
