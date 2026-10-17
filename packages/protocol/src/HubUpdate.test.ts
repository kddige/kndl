import { describe, expect, test } from "bun:test"
import { type HubUpdateState, hubFollows, hubUpdateTarget } from "./index.ts"

const commit = "a".repeat(40)
const head = "b".repeat(40)
const release = (version: string) => ({ version, notes: "", url: "" })

describe("what a Hub follows (ADR 0028)", () => {
  test("is the Channel its install recorded", () => {
    expect(hubFollows({ commit, release: "2026.10.1", channel: "stable" })).toEqual({
      _tag: "Channel",
      channel: "stable",
    })
    expect(hubFollows({ commit, branch: "main", channel: "dev" })).toEqual({
      _tag: "Channel",
      channel: "dev",
    })
  })

  test("is dev on main with no Channel recorded, as an install from before Channels", () => {
    expect(hubFollows({ commit, branch: "main" })).toEqual({ _tag: "Channel", channel: "dev" })
  })

  test("is pinned to another branch, a Release's tag or a commit, with no Channel", () => {
    expect(hubFollows({ commit, branch: "fix-login" })).toEqual({
      _tag: "Pinned",
      ref: "fix-login",
    })
    expect(hubFollows({ commit, release: "2026.10.1" })).toEqual({
      _tag: "Pinned",
      ref: "v2026.10.1",
    })
    expect(hubFollows({ commit })).toEqual({ _tag: "Pinned", ref: "aaaaaaaaaaaa" })
  })
})

describe("the update a check offers", () => {
  const stable = { _tag: "Channel", channel: "stable" } as const

  test("is the newest Release on stable, by its tag", () => {
    const state: HubUpdateState = {
      follows: stable,
      checked: {
        at: 1,
        found: {
          _tag: "NewerRelease",
          releases: [release("2026.10.4"), release("2026.10.3")],
          compareUrl: "",
        },
      },
    }
    expect(hubUpdateTarget(state)).toBe("v2026.10.4")
  })

  test("is main's head on dev", () => {
    expect(
      hubUpdateTarget({
        follows: { _tag: "Channel", channel: "dev" },
        checked: {
          at: 1,
          found: { _tag: "NewerCommits", head, behindBy: 3, commits: [], compareUrl: "" },
        },
      }),
    ).toBe(head)
  })

  test("is none when up to date, before any check, or without the Hub page", () => {
    expect(
      hubUpdateTarget({ follows: stable, checked: { at: 1, found: { _tag: "UpToDate" } } }),
    ).toBeUndefined()
    expect(hubUpdateTarget({ follows: stable, failed: { at: 1, message: "down" } })).toBeUndefined()
    expect(hubUpdateTarget(undefined)).toBeUndefined()
  })
})
