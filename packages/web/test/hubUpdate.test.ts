import { expect, test } from "bun:test"
import type { HubUpdateRun, HubUpdateState, RunnerSummary } from "@kndl/protocol"
import {
  bannerTarget,
  bannerText,
  channelChangeText,
  drainingRunners,
  followsText,
  runTitle,
  versionText,
} from "../src/hubpage/hubUpdate.ts"

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
    description: "This Hub runs 2026.10.2, 2 Releases behind.",
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

const runOf = (status: Partial<HubUpdateRun["status"]>): HubUpdateRun => ({
  status: {
    id: "u-1",
    source: "hub",
    startedAt: 1,
    from: { commit },
    step: "Fetching",
    state: "Running",
    ...status,
  },
})

test("the latest update says its step, or how it ended (#362)", () => {
  expect(runTitle(runOf({}))).toBe("Updating… Fetching")
  expect(runTitle(runOf({ state: "Succeeded", target: { ref: "v2026.10.4", commit: head } }))).toBe(
    "Updated to 2026.10.4",
  )
  expect(runTitle(runOf({ state: "Succeeded", target: { ref: "main", commit: head } }))).toBe(
    "Updated to ffffffffffff",
  )
  expect(runTitle(runOf({ state: "Succeeded" }))).toBe(
    "Nothing to move to: the Hub stayed where it was",
  )
  expect(runTitle(runOf({ state: "Failed", error: "no" }))).toBe("Update failed")
  expect(runTitle(runOf({ state: "RolledBack", error: "no" }))).toBe("Update rolled back")
})

const runner = (name: string, update?: RunnerSummary["update"]) =>
  ({ id: name, name, update }) as unknown as RunnerSummary

const draining = (target: string, now: boolean): RunnerSummary["update"] => ({
  _tag: "Draining",
  target: { commit: target },
  since: 1,
  deadline: 2,
  now,
  waitingFor: 1,
})

test("Update now stops the Turns of the Runners still waiting to follow the Hub", () => {
  const hub = { commit: head, branch: "main" }
  const runners = [
    runner("studio", draining(head, false)),
    runner("laptop", draining(head, true)),
    runner("old", draining(commit, false)),
    runner("idle"),
  ]
  expect(drainingRunners(runners, hub).map((r) => r.name)).toEqual(["studio"])
  expect(drainingRunners(runners, null)).toEqual([])
  expect(drainingRunners(null, hub)).toEqual([])
})

test("the Channel picker says what a pick does: dev updates now, stable waits for a Release", () => {
  expect(channelChangeText(stable.follows, "dev")).toMatchObject({
    title: "Follow dev?",
    action: "Follow dev",
    description: expect.stringContaining("moves to the head of main now"),
  })
  expect(channelChangeText(dev.follows, "stable").description).toContain(
    "stays on this commit until a newer Release is out",
  )
  expect(channelChangeText({ _tag: "Pinned", ref: "fix-login" }, "stable")).toMatchObject({
    title: "Unpin the Hub, and follow stable?",
    action: "Unpin and follow stable",
    description: expect.stringContaining("The Hub leaves fix-login"),
  })
})
