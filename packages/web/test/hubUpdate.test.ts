import { expect, test } from "bun:test"
import type { HubUpdateState } from "@kndl/protocol"
import { bannerTarget, bannerText, followsText, versionText } from "../src/hubpage/hubUpdate.ts"

const commit = "824de4a1f0c3b6e2d9a7c5b48e1f02a3c6d7e9b1"
const head = "f".repeat(40)
const release = (version: string) => ({ version, notes: "", url: "" })

const stable: HubUpdateState = {
  follows: { _tag: "Channel", channel: "stable" },
  checked: {
    at: 1,
    found: {
      _tag: "NewerRelease",
      releases: [release("2026.10.4"), release("2026.10.3")],
      compareUrl: "",
    },
  },
}

const dev: HubUpdateState = {
  follows: { _tag: "Channel", channel: "dev" },
  checked: {
    at: 1,
    found: { _tag: "NewerCommits", head, behindBy: 1, commits: [], compareUrl: "" },
  },
}

test("the banner tells of the newest Release, or main's head, until it is dismissed", () => {
  expect(bannerTarget(stable, null)).toBe("v2026.10.4")
  expect(bannerTarget(stable, "v2026.10.3")).toBe("v2026.10.4")
  expect(bannerTarget(stable, "v2026.10.4")).toBeNull()
  expect(bannerTarget(dev, null)).toBe(head)
  expect(bannerTarget(dev, "e".repeat(40))).toBe(head)
  expect(bannerTarget({ follows: stable.follows }, null)).toBeNull()
  expect(bannerTarget(null, null)).toBeNull()
})

test("the banner says how far behind the Hub is", () => {
  expect(bannerText(stable, { commit, release: "2026.10.2", channel: "stable" })).toEqual({
    title: "kndl 2026.10.4 is out",
    description: "This Hub runs 2026.10.2, 2 Releases behind. See what changed on the Hub page.",
  })
  expect(bannerText(dev, { commit, branch: "main", channel: "dev" })?.title).toBe(
    "main is 1 commit ahead of this Hub",
  )
  expect(
    bannerText({ ...stable, checked: { at: 1, found: { _tag: "UpToDate" } } }, null),
  ).toBeNull()
})

test("the Hub page names the version, by its commit on dev, and the Channel or the pin", () => {
  expect(versionText({ commit, release: "2026.10.2" }, stable.follows)).toBe(
    "2026.10.2 (824de4a1f0c3)",
  )
  expect(versionText({ commit, branch: "main" }, dev.follows)).toBe("824de4a1f0c3")
  expect(followsText(stable.follows)).toBe("stable")
  expect(followsText({ _tag: "Pinned", ref: "fix-login" })).toBe("Pinned to fix-login")
})
