import { describe, expect, test } from "bun:test"
import { describeBuild, runnerVersionStatus } from "./Build.ts"
import { checkoutHolds, readBuildVersion, thisCheckout } from "./Checkout.ts"

const hub = { commit: "a".repeat(40), branch: "main" }
const older = { commit: "b".repeat(40) }

/** A Hub whose history holds every commit, none, or can't say. */
const holds = (held: boolean | undefined) => () => held

describe("a Runner's version against the Hub's", () => {
  test("is Current on the same commit, whatever the branch", () => {
    expect(runnerVersionStatus({ commit: hub.commit }, hub, holds(undefined))).toBe("Current")
  })

  test("is Behind on a commit the Hub's history holds", () => {
    expect(runnerVersionStatus(older, hub, holds(true))).toBe("Behind")
  })

  test("Differs on one it doesn't: newer, or another branch's", () => {
    expect(runnerVersionStatus(older, hub, holds(false))).toBe("Differs")
  })

  test("is Unknown when either side doesn't say, or git can't tell", () => {
    expect(runnerVersionStatus(undefined, hub, holds(true))).toBe("Unknown")
    expect(runnerVersionStatus(older, undefined, holds(true))).toBe("Unknown")
    expect(runnerVersionStatus(older, hub, holds(undefined))).toBe("Unknown")
  })

  test("is described by its short commit and its branch", () => {
    expect(describeBuild(hub)).toBe("aaaaaaaaaaaa (main)")
    expect(describeBuild(older)).toBe("bbbbbbbbbbbb")
  })
})

describe("the checkout's own version", () => {
  test("is its HEAD, which its history holds", () => {
    const own = readBuildVersion(thisCheckout)
    expect(own?.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(checkoutHolds(own?.commit ?? "", thisCheckout)).toBe(true)
  })

  test("doesn't hold a commit it never fetched", () => {
    expect(checkoutHolds("0123456789abcdef0123456789abcdef01234567", thisCheckout)).toBe(false)
  })

  test("is unknown outside a checkout", () => {
    expect(readBuildVersion("/")).toBeUndefined()
    expect(checkoutHolds("0123456789abcdef0123456789abcdef01234567", "/")).toBeUndefined()
  })
})
