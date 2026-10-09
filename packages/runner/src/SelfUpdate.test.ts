import { describe, expect, test } from "bun:test"
import {
  afterWelcome,
  bootDecision,
  checkoutArgs,
  checkRefusal,
  failureOf,
  fetchCommitArgs,
  hasCommitArgs,
  isAncestorArgs,
  lastUpdateOf,
  type Marker,
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
  test("the kndl service, running the installed checkout, which may follow any commit", () => {
    expect(updaterOf(installed)).toEqual({ self: true })
    expect(updaterOf({ ...installed, anyCommit: "1" })).toEqual({ self: true, anyCommit: true })
    expect(updaterOf({ ...installed, anyCommit: "yes" })).toEqual({ self: true })
  })

  test("never a developer's checkout, another checkout, one run by hand or one outside git", () => {
    const cases = [
      // Run with `bun run runner`.
      [{ devHome: true, checkout: "/src/kndl", service: undefined }, "developer's checkout"],
      [{ checkout: "/src/kndl" }, `it runs from /src/kndl, not the installed checkout ${app}`],
      // Nothing would start it again after it exits.
      [{ service: undefined }, "isn't run by the kndl service"],
      [{ checkout: undefined }, ""],
    ] as const
    for (const [differs, reason] of cases) {
      expect(updaterOf({ ...installed, ...differs })).toMatchObject({
        self: false,
        reason: expect.stringContaining(reason),
      })
    }
  })
})

describe("whether it moves to the Hub's commit", () => {
  test("refuses saying why: fetching failed, the commit isn't on main, or it updates by hand", () => {
    expect(
      checkRefusal({ self: true }, target, { ...onMain, fetchError: "could not resolve host" }),
    ).toEqual({
      reason: "Failed",
      message: "It couldn't fetch from origin: could not resolve host",
    })
    expect(checkRefusal({ self: true }, target, { ...onMain, onMain: false })).toEqual({
      reason: "NotOnMain",
      message: `${target.commit.slice(0, 12)} isn't on origin/main. To follow any commit, set RUNNER_UPDATE_ANY_COMMIT=1 in the Runner's runner.env.`,
    })
    // Without asking git.
    expect(checkRefusal({ self: false, reason: "a reason" }, target, undefined)).toEqual({
      reason: "Manual",
      message: "It doesn't update itself: a reason.",
    })
  })
})

describe("moving the checkout", () => {
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
})

describe("starting after an update", () => {
  test("forgets an update or a failure once the checkout moved elsewhere, and keeps a failure to report", () => {
    const applying: Marker = {
      _tag: "Applying",
      from: { commit: old, branch: "main" },
      target,
      boots: 0,
      at: 1,
    }
    const failed: Marker = {
      _tag: "Failed",
      from: old,
      failure: { target, message: "it broke", rolledBack: true, at: 3 },
    }
    const cases: ReadonlyArray<readonly [Marker | undefined, string, "Clear" | "Keep"]> = [
      // The checkout moved elsewhere since the update.
      [applying, old, "Clear"],
      [applying, "c".repeat(40), "Clear"],
      // It runs the commit it failed from: there's a failure to report.
      [failed, old, "Keep"],
      // It runs another commit, as after `kndl update`.
      [failed, target.commit, "Clear"],
      // A failure that doesn't say which commit it failed from.
      [{ _tag: "Failed", failure: failed.failure }, old, "Clear"],
      [undefined, old, "Keep"],
    ]
    for (const [marker, head, decision] of cases) {
      expect(bootDecision(marker, head, 4)).toEqual({ _tag: decision })
    }
    expect(afterWelcome(failed)).toBe(failed)
    expect(lastUpdateOf(failed)).toEqual(failed.failure)
    expect(lastUpdateOf(undefined)).toBeUndefined()
  })
})

describe("reporting a failure", () => {
  test("says where it failed and that it went back, needing none when nothing moved, kept short", () => {
    expect(failureOf(target, "Installing", "bun install exited with 1: nope", true, 5)).toEqual({
      target,
      message: `Updating to ${target.commit.slice(0, 12)} failed while installing and building: bun install exited with 1: nope It went back to the commit it ran.`,
      rolledBack: true,
      at: 5,
    })
    expect(failureOf(target, "Checking", "not on main", undefined, 5).rolledBack).toBe(true)
    const long = failureOf(target, "Installing", "x\n".repeat(50), true, 5)
    expect(long.message.split("\n")).toHaveLength(4)
  })

  test("says when going back failed too", () => {
    const failure = failureOf(target, "CheckingOut", "error", false, 5)

    expect(failure.rolledBack).toBe(false)
    expect(failure.message).toContain("Going back to the commit it ran failed too")
  })
})

describe("turned away by the Hub", () => {
  test("updates itself to the Hub's commit, or says what to do by hand", () => {
    expect(rejectedAdvice({ self: true }, target)).toEqual({
      update: true,
      message: `Updating this Runner to the Hub's commit (the Hub runs ${target.commit.slice(0, 12)} on main).`,
    })
    // A developer's checkout, which it never rewrites.
    const advice = rejectedAdvice(updaterOf({ ...installed, devHome: true }), target)
    expect(advice.update).toBe(false)
    expect(advice.message).toContain("pull this checkout to the Hub's commit")
    // An older Hub says no commit.
    expect(rejectedAdvice({ self: true }, undefined)).toEqual({
      update: false,
      message:
        "To connect again, this Runner needs the Hub's version: run `kndl update` on this machine. Retrying meanwhile.",
    })
  })
})
