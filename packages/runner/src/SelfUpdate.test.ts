import { describe, expect, test } from "bun:test"
import {
  afterWelcome,
  applyPlan,
  bootDecision,
  checkoutArgs,
  checkRefusal,
  failureOf,
  fetchCommitArgs,
  hasCommitArgs,
  isAncestorArgs,
  lastUpdateOf,
  type Marker,
  MaxBootsBeforeWelcome,
  rejectedAdvice,
  updaterOf,
} from "./SelfUpdate.ts"

const app = "/home/alice/.kndl/app"
const installed = {
  devHome: false,
  checkout: app,
  app,
  service: "runner",
  anyCommit: undefined,
}
const old = "a".repeat(40)
const target = { commit: "b".repeat(40), branch: "main" }
const onMain = { fetchError: undefined, exists: true, onMain: true }

describe("who updates itself", () => {
  test("the kndl service, running the installed checkout", () => {
    expect(updaterOf(installed)).toEqual({ self: true })
  })

  test("never a developer's checkout, run with `bun run runner`", () => {
    const updater = updaterOf({
      ...installed,
      devHome: true,
      checkout: "/src/kndl",
      service: undefined,
    })

    expect(updater.self).toBe(false)
    expect(updater.reason).toContain("developer's checkout")
  })

  test("not a Runner run from another checkout than the installed one", () => {
    const updater = updaterOf({ ...installed, checkout: "/src/kndl" })

    expect(updater).toEqual({
      self: false,
      reason: `it runs from /src/kndl, not the installed checkout ${app}`,
    })
  })

  test("not one run by hand, which nothing would start again after it exits", () => {
    expect(updaterOf({ ...installed, service: undefined })).toMatchObject({
      self: false,
      reason: expect.stringContaining("isn't run by the kndl service"),
    })
  })

  test("not one outside a git checkout", () => {
    expect(updaterOf({ ...installed, checkout: undefined }).self).toBe(false)
  })

  test("says when runner.env lets it follow any commit", () => {
    expect(updaterOf({ ...installed, anyCommit: "1" })).toEqual({ self: true, anyCommit: true })
    expect(updaterOf({ ...installed, anyCommit: "yes" })).toEqual({ self: true })
  })
})

describe("whether it moves to the Hub's commit", () => {
  test("a commit on origin/main", () => {
    expect(checkRefusal({ self: true }, target, onMain)).toBeUndefined()
  })

  test("refuses one not reachable from origin/main", () => {
    expect(checkRefusal({ self: true }, target, { ...onMain, onMain: false })).toEqual({
      reason: "NotOnMain",
      message: `${target.commit.slice(0, 12)} isn't on origin/main. To follow any commit, set RUNNER_UPDATE_ANY_COMMIT=1 in the Runner's runner.env.`,
    })
  })

  test("follows one not on main when RUNNER_UPDATE_ANY_COMMIT=1", () => {
    expect(
      checkRefusal({ self: true, anyCommit: true }, target, { ...onMain, onMain: false }),
    ).toBeUndefined()
  })

  test("refuses a commit origin doesn't have, even with RUNNER_UPDATE_ANY_COMMIT=1", () => {
    expect(
      checkRefusal({ self: true, anyCommit: true }, target, {
        fetchError: undefined,
        exists: false,
        onMain: false,
      })?.reason,
    ).toBe("NotFound")
  })

  test("refuses when fetching failed, saying why", () => {
    expect(
      checkRefusal({ self: true }, target, { ...onMain, fetchError: "could not resolve host" }),
    ).toEqual({
      reason: "Failed",
      message: "It couldn't fetch from origin: could not resolve host",
    })
  })

  test("refuses, without asking git, when it updates by hand", () => {
    expect(checkRefusal({ self: false, reason: "a reason" }, target, undefined)).toEqual({
      reason: "Manual",
      message: "It doesn't update itself: a reason.",
    })
  })
})

describe("moving the checkout", () => {
  test("stays on its branch when the commit is on it", () => {
    expect(applyPlan({ commit: old, branch: "main" }, target, true)).toEqual({
      _tag: "Move",
      checkout: ["switch", "--discard-changes", "-C", "main", "--end-of-options", target.commit],
      back: ["switch", "--discard-changes", "-C", "main", "--end-of-options", old],
    })
  })

  test("detaches at a commit not on its branch, and goes back to the branch", () => {
    expect(applyPlan({ commit: old, branch: "main" }, target, false)).toEqual({
      _tag: "Move",
      checkout: ["switch", "--discard-changes", "--detach", "--end-of-options", target.commit],
      back: ["switch", "--discard-changes", "-C", "main", "--end-of-options", old],
    })
  })

  test("never lets git read the commit as an option", () => {
    // What the protocol's CommitId refuses, should it ever get this far.
    const hostile = "--upload-pack=touch /tmp/pwned"
    const lists = [
      fetchCommitArgs(hostile),
      hasCommitArgs(hostile),
      isAncestorArgs(hostile, "origin/main"),
      checkoutArgs({ commit: hostile }),
      checkoutArgs({ commit: hostile, branch: "main" }),
    ]
    for (const args of lists) {
      const at = args.findIndex((arg) => arg.includes(hostile))
      expect(args.indexOf("--end-of-options")).toBeGreaterThan(-1)
      expect(args.indexOf("--end-of-options")).toBeLessThan(at)
    }
  })

  test("goes back to a detached commit detached", () => {
    expect(checkoutArgs({ commit: old })).toEqual([
      "switch",
      "--discard-changes",
      "--detach",
      "--end-of-options",
      old,
    ])
  })

  test("only restarts when the checkout is at the commit already, as on the Hub's machine", () => {
    expect(applyPlan({ commit: target.commit, branch: "main" }, target, true)).toEqual({
      _tag: "Restart",
    })
  })
})

describe("starting after an update", () => {
  const applying: Marker = {
    _tag: "Applying",
    from: { commit: old, branch: "main" },
    target,
    boots: 0,
    at: 1,
  }

  test("counts each start on the new commit until the Hub welcomes it", () => {
    expect(bootDecision(applying, target.commit, 2)).toEqual({
      _tag: "Write",
      marker: { ...applying, boots: 1 },
    })
    expect(afterWelcome({ ...applying, boots: 1 })).toBeUndefined()
  })

  test(`rolls back a commit that started ${MaxBootsBeforeWelcome} times without a welcome`, () => {
    const decision = bootDecision({ ...applying, boots: MaxBootsBeforeWelcome }, target.commit, 9)

    expect(decision).toEqual({
      _tag: "RollBack",
      back: ["switch", "--discard-changes", "-C", "main", "--end-of-options", old],
      failure: {
        target,
        message: `It started on ${target.commit.slice(0, 12)} 3 times without the Hub welcoming it, so it went back to ${old.slice(0, 12)}: see its log.`,
        rolledBack: true,
        at: 9,
      },
    })
  })

  test("forgets an update when the checkout moved elsewhere since", () => {
    expect(bootDecision(applying, old, 2)).toEqual({ _tag: "Clear" })
    expect(bootDecision(applying, "c".repeat(40), 2)).toEqual({ _tag: "Clear" })
  })

  const failed: Marker = {
    _tag: "Failed",
    from: old,
    failure: { target, message: "it broke", rolledBack: true, at: 3 },
  }

  test("keeps a failure to report while it runs the commit it failed from", () => {
    expect(bootDecision(failed, old, 4)).toEqual({ _tag: "Keep" })
    expect(afterWelcome(failed)).toBe(failed)
    expect(lastUpdateOf(failed)).toEqual(failed.failure)
  })

  test("forgets a failure once it runs another commit, as after `kndl update`", () => {
    expect(bootDecision(failed, target.commit, 4)).toEqual({ _tag: "Clear" })
  })

  test("forgets a failure that doesn't say which commit it failed from", () => {
    expect(bootDecision({ _tag: "Failed", failure: failed.failure }, old, 4)).toEqual({
      _tag: "Clear",
    })
  })

  test("has nothing to do without a marker", () => {
    expect(bootDecision(undefined, old, 1)).toEqual({ _tag: "Keep" })
    expect(lastUpdateOf(undefined)).toBeUndefined()
  })
})

describe("reporting a failure", () => {
  test("says where it failed, and that it went back", () => {
    expect(failureOf(target, "Installing", "bun install exited with 1: nope", true, 5)).toEqual({
      target,
      message: `Updating to ${target.commit.slice(0, 12)} failed while installing and building: bun install exited with 1: nope It went back to the commit it ran.`,
      rolledBack: true,
      at: 5,
    })
  })

  test("says when going back failed too", () => {
    const failure = failureOf(target, "CheckingOut", "error", false, 5)

    expect(failure.rolledBack).toBe(false)
    expect(failure.message).toContain("Going back to the commit it ran failed too")
  })

  test("needs no going back when nothing moved", () => {
    expect(failureOf(target, "Checking", "not on main", undefined, 5).rolledBack).toBe(true)
  })

  test("keeps a long error short", () => {
    const failure = failureOf(target, "Installing", "x\n".repeat(50), true, 5)

    expect(failure.message.split("\n")).toHaveLength(4)
  })
})

describe("turned away by the Hub", () => {
  test("updates itself to the commit the Hub says", () => {
    expect(rejectedAdvice({ self: true }, target)).toEqual({
      update: true,
      message: `Updating this Runner to the Hub's commit (the Hub runs ${target.commit.slice(0, 12)} on main).`,
    })
  })

  test("says to pull a developer's checkout, which it never rewrites", () => {
    const advice = rejectedAdvice(updaterOf({ ...installed, devHome: true }), target)

    expect(advice.update).toBe(false)
    expect(advice.message).toContain("pull this checkout to the Hub's commit")
  })

  test("says to run `kndl update` when an older Hub says no commit", () => {
    expect(rejectedAdvice({ self: true }, undefined)).toEqual({
      update: false,
      message:
        "To connect again, this Runner needs the Hub's version: run `kndl update` on this machine. Retrying meanwhile.",
    })
  })
})
