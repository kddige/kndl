// The Hub's side of a Runner's update (RunnerUpdates.ts), as pure functions: what each message
// does to the update, the drain plan, and when `claude-hub update`'s push applies.

import { describe, expect, test } from "bun:test"
import {
  RunnerId,
  type RunnerUpdateState,
  SessionId,
  UpdateDrainMillis,
} from "@claude-hub/protocol"
import {
  afterChecked,
  afterDisconnect,
  afterHello,
  afterProgress,
  drainPlan,
  pushApplies,
  updateRequestRefusal,
} from "./RunnerUpdates.ts"

const hub = { commit: "a".repeat(40), branch: "main" }
const older = { commit: "b".repeat(40) }
const other = { commit: "c".repeat(40) }
const studio = RunnerId.make("r-studio")
const laptop = RunnerId.make("r-laptop")

const checking: RunnerUpdateState = { _tag: "Checking", target: hub, since: 1 }
const applying: RunnerUpdateState = { _tag: "Applying", target: hub, since: 1 }
const restarting: RunnerUpdateState = { _tag: "Restarting", target: hub, since: 1 }
const failure = { target: hub, message: "bun install failed", rolledBack: true, at: 5 }

describe("asking a Runner to update", () => {
  const candidate = {
    name: "studio",
    isOnline: true,
    updater: { self: true },
    versionStatus: "Behind" as const,
    update: undefined,
  }

  test("is allowed for an online Runner that updates itself and doesn't run the Hub's commit", () => {
    expect(updateRequestRefusal(candidate, hub)).toBeUndefined()
    expect(updateRequestRefusal({ ...candidate, versionStatus: "Differs" }, hub)).toBeUndefined()
    expect(updateRequestRefusal({ ...candidate, versionStatus: "Unknown" }, hub)).toBeUndefined()
  })

  test("is refused, saying why, otherwise", () => {
    expect(updateRequestRefusal(candidate, undefined)).toContain("doesn't run from a git checkout")
    expect(updateRequestRefusal({ ...candidate, isOnline: false }, hub)).toBe(
      "studio is offline: it can update once it is back.",
    )
    expect(updateRequestRefusal({ ...candidate, updater: undefined }, hub)).toContain(
      "too old to update itself",
    )
    expect(
      updateRequestRefusal(
        { ...candidate, updater: { self: false, reason: "it runs from a developer's checkout" } },
        hub,
      ),
    ).toBe("studio doesn't update itself: it runs from a developer's checkout.")
    expect(updateRequestRefusal({ ...candidate, versionStatus: "Current" }, hub)).toBe(
      "studio already runs the Hub's commit.",
    )
  })
})

describe("an update's state", () => {
  test("drains once the Runner says it will move, with a deadline, or refuses", () => {
    expect(afterChecked(checking, { _tag: "UpdateChecked", target: hub }, 100, false)).toEqual({
      _tag: "Draining",
      target: hub,
      since: 100,
      deadline: 100 + UpdateDrainMillis,
      now: false,
      waitingFor: 0,
    })
    const refusal = { reason: "NotOnMain" as const, message: "not on origin/main" }
    expect(
      afterChecked(checking, { _tag: "UpdateChecked", target: hub, refusal }, 100, true),
    ).toEqual({ _tag: "Refused", target: hub, at: 100, refusal })
  })

  test("ignores answers about another commit, or that come when not asked", () => {
    expect(afterChecked(checking, { _tag: "UpdateChecked", target: other }, 1, false)).toBe(
      checking,
    )
    expect(afterChecked(undefined, { _tag: "UpdateChecked", target: hub }, 1, false)).toBe(
      undefined,
    )
    expect(
      afterProgress(checking, { _tag: "UpdateProgress", target: hub, step: "Installing" }),
    ).toBe(checking)
    expect(
      afterProgress(applying, { _tag: "UpdateProgress", target: hub, step: "Installing" }),
    ).toEqual({ ...applying, step: "Installing" })
  })

  test("a disconnect while applying is the restart; before that, the update is abandoned", () => {
    expect(afterDisconnect(applying, 9)).toEqual({ _tag: "Restarting", target: hub, since: 9 })
    expect(afterDisconnect(checking, 9)).toBeUndefined()
    const refused: RunnerUpdateState = {
      _tag: "Refused",
      target: hub,
      at: 1,
      refusal: { reason: "NotOnMain", message: "" },
    }
    expect(afterDisconnect(refused, 9)).toBe(refused)
  })

  test("is done when the Runner says hello on the commit", () => {
    expect(afterHello(restarting, { version: hub, lastUpdate: undefined }, 9)).toBeUndefined()
    // Even a failure shown before, once it is there after all.
    expect(
      afterHello({ _tag: "Failed", failure }, { version: hub, lastUpdate: undefined }, 9),
    ).toBeUndefined()
  })

  test("failed, as the Runner says, when it comes back on its old commit", () => {
    expect(afterHello(restarting, { version: older, lastUpdate: failure }, 9)).toEqual({
      _tag: "Failed",
      failure,
    })
    // A Hub that restarted meanwhile hears it too.
    expect(afterHello(undefined, { version: older, lastUpdate: failure }, 9)).toEqual({
      _tag: "Failed",
      failure,
    })
    // Back without saying why.
    expect(afterHello(restarting, { version: older, lastUpdate: undefined }, 9)).toMatchObject({
      _tag: "Failed",
      failure: { target: hub, rolledBack: true, at: 9 },
    })
  })

  test("a failure at an older target doesn't count once the Hub asks for another", () => {
    const old = { ...failure, target: other }
    expect(afterHello(restarting, { version: older, lastUpdate: old }, 9)).toMatchObject({
      _tag: "Failed",
      failure: { target: hub },
    })
  })
})

const ids = (...names: ReadonlyArray<string>) => names.map((name) => SessionId.make(name))
const session = (id: string, state: "Active" | "Asleep", turn = false, settling = false) => ({
  id: SessionId.make(id),
  state,
  turn,
  settling,
})

describe("draining a Runner", () => {
  test("puts idle Sessions to sleep, and waits for Turns", () => {
    const plan = drainPlan(
      [
        session("idle", "Active"),
        session("busy", "Active", true),
        session("stopping", "Active", false, true),
        session("asleep", "Asleep"),
      ],
      { stopTurns: false, stopped: new Set() },
    )
    expect(plan).toEqual({ sleep: ids("idle"), stopTurns: [], waitingFor: 3, drained: false })
  })

  test("stops running Turns when told to, each once", () => {
    const sessions = [session("busy", "Active", true), session("other", "Active", true)]
    expect(drainPlan(sessions, { stopTurns: true, stopped: new Set() }).stopTurns).toEqual(
      ids("busy", "other"),
    )
    expect(
      drainPlan(sessions, { stopTurns: true, stopped: new Set([SessionId.make("busy")]) })
        .stopTurns,
    ).toEqual(ids("other"))
  })

  test("is drained once no Session is Active", () => {
    expect(
      drainPlan([session("asleep", "Asleep")], { stopTurns: false, stopped: new Set() }),
    ).toEqual({ sleep: [], stopTurns: [], waitingFor: 0, drained: true })
  })
})

describe("claude-hub update's push", () => {
  const push = { commit: hub.commit, now: false, allRunners: true, localRunner: undefined }
  const runner = {
    id: studio,
    version: older,
    updater: { self: true },
    lastUpdate: undefined,
  }

  test("applies to a Runner that updates itself and runs another commit, once", () => {
    expect(pushApplies(push, runner, new Set())).toBe(true)
    expect(pushApplies(push, runner, new Set([studio]))).toBe(false)
    expect(pushApplies(push, { ...runner, version: hub }, new Set())).toBe(false)
    expect(pushApplies(push, { ...runner, updater: { self: false } }, new Set())).toBe(false)
    expect(pushApplies(push, { ...runner, updater: undefined }, new Set())).toBe(false)
    expect(pushApplies(undefined, runner, new Set())).toBe(false)
  })

  test("with --no-update-runners, applies to the Runner on the Hub's machine only", () => {
    const local = { ...push, allRunners: false, localRunner: studio }
    expect(pushApplies(local, runner, new Set())).toBe(true)
    expect(pushApplies(local, { ...runner, id: laptop }, new Set())).toBe(false)
  })

  test("doesn't retry a commit the Runner already failed to move to", () => {
    expect(pushApplies(push, { ...runner, lastUpdate: failure }, new Set())).toBe(false)
    expect(
      pushApplies(push, { ...runner, lastUpdate: { ...failure, target: other } }, new Set()),
    ).toBe(true)
  })
})
