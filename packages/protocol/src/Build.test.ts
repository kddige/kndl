import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema } from "effect"
import { BuildVersion, CommitId, describeBuild, releaseOf, runnerVersionStatus } from "./Build.ts"
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

  test("on a Release, is described by the Release first", () => {
    expect(describeBuild({ ...older, release: "2026.10.1" })).toBe("2026.10.1 (bbbbbbbbbbbb)")
    expect(describeBuild({ ...hub, release: "2026.10.1" })).toBe("2026.10.1 (aaaaaaaaaaaa, main)")
  })
})

describe("a Release among a commit's tags", () => {
  test("is the newest tag like v2026.10.1, compared by number", () => {
    expect(releaseOf(["v2026.10.9", "v2026.10.10", "v2026.9.12"])).toBe("2026.10.10")
    expect(releaseOf(["v2026.10.1"])).toBe("2026.10.1")
  })

  test("isn't a beta, a zero-padded tag, another version scheme or another tag", () => {
    expect(
      releaseOf(["v2026.10.1-beta.1", "v2026.01.3", "v2026.13.1", "v0.1.0", "2026.10.1"]),
    ).toBeUndefined()
    expect(releaseOf([""])).toBeUndefined()
    expect(releaseOf([])).toBeUndefined()
  })

  test("decodes only as a Release's version", () => {
    expect(Schema.is(BuildVersion)({ ...older, release: "2026.10.1" })).toBe(true)
    expect(Schema.is(BuildVersion)({ ...older, release: "v2026.10.1" })).toBe(false)
    expect(Schema.is(BuildVersion)({ ...older, release: "--upload-pack=x" })).toBe(false)
  })

  test("is ignored by a peer from before it, so the protocol version stays", () => {
    const before = Schema.Struct({
      commit: CommitId,
      branch: Schema.optionalKey(Schema.NonEmptyString),
    })
    const decoded = Schema.decodeUnknownSync(before)({ ...hub, release: "2026.10.1" })
    expect(decoded).toEqual(hub)
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

  test("names the Release tagged on HEAD, and none on a commit after it", () => {
    const dir = mkdtempSync(join(tmpdir(), "kndl-release-"))
    const git = (...args: Array<string>) =>
      execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" })
    try {
      git("init", "--quiet", "--initial-branch=main")
      git(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "1",
      )
      git("tag", "v2026.10.1")
      git("tag", "v2026.10.2-beta.1")
      expect(readBuildVersion(dir)).toMatchObject({ branch: "main", release: "2026.10.1" })
      git(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "2",
      )
      expect(readBuildVersion(dir)?.release).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("is unknown outside a checkout", () => {
    expect(readBuildVersion("/")).toBeUndefined()
    expect(checkoutHolds("0123456789abcdef0123456789abcdef01234567", "/")).toBeUndefined()
  })
})
