// Whether a newer kndl is out (ADR 0028, #361): which Hubs check, what a check finds on each
// Channel against a stand-in kddige/kndl, and, end to end on a real Hub, that only its Owner hears
// of it, that a failed check keeps the last result, and that a restart shows the last one at once.

import { afterEach, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { join } from "node:path"
import {
  type BuildVersion,
  type CommitId,
  hubUpdatesOffMessage,
  ownerOnlyMessage,
} from "@kndl/protocol"
import { Effect, Layer } from "effect"
import { databaseAt } from "./Database.ts"
import { GitHub } from "./GitHub.ts"
import { findUpdate, HubUpdates, hubUpdatesOf, newerReleases } from "./HubUpdates.ts"
import { HubVersion } from "./HubVersion.ts"
import { openWeb, stopAll } from "./testChannels.ts"
import { cookieFrom, githubSignIn, ownerSignIn, startHub, testDatabaseDir } from "./testSupport.ts"
import { type Comparison, Upstream, type UpstreamRelease } from "./Upstream.ts"

afterEach(stopAll)

const commit = (digit: string) => digit.repeat(40) as CommitId
const hubCommit = commit("a")
const mainHead = commit("f")

/** A Release of kndl as GitHub lists it, at `v<version>`. */
const release = (version: string, notes = `## Highlights\n\n- What ${version} brings.`) =>
  ({
    tag: `v${version}`,
    notes,
    url: `https://github.com/kddige/kndl/releases/tag/v${version}`,
    publishedAt: 1_700_000_000_000,
    prerelease: false,
  }) satisfies UpstreamRelease

/** A Release's notes, as the Hub page gets them. */
const notesOf = (version: string) => {
  const { notes, url, publishedAt } = release(version)
  return { version, notes, url, publishedAt }
}

const released = [
  release("2026.10.10"),
  release("2026.10.9"),
  release("2026.10.2"),
  release("2026.9.4"),
]

/** `count` commits, oldest first, as GitHub's compare lists them. */
const commits = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    commit: commit("b").slice(0, 36).concat(String(i).padStart(4, "0")) as CommitId,
    title: `web: change ${i + 1} (#${i + 1})`,
  }))

const ahead = (count: number): Comparison => ({
  status: "ahead",
  aheadBy: count,
  commits: commits(count),
})

const find = (
  version: BuildVersion,
  channel: "stable" | "dev",
  upstream: Parameters<typeof Upstream.fixed>[0],
  before?: string,
) =>
  Effect.runPromise(
    findUpdate(version, channel, before).pipe(Effect.provide(Upstream.fixed(upstream))),
  )

describe("which Hubs check for a newer kndl", () => {
  const installed = { devHome: false, checkout: "/home/k/.kndl/app", app: "/home/k/.kndl/app" }

  test("one the kndl service runs from the install's own checkout", () => {
    expect(hubUpdatesOf({ ...installed, service: "hub" })).toEqual({ on: true })
  })

  test("not one run by hand, from a developer's checkout, or outside a checkout", () => {
    expect(hubUpdatesOf({ ...installed, service: undefined })).toMatchObject({ on: false })
    expect(
      hubUpdatesOf({ ...installed, devHome: true, checkout: "/src/kndl", service: "hub" }),
    ).toEqual({ on: false, reason: "it runs from a developer's checkout (bun run hub)" })
    expect(hubUpdatesOf({ ...installed, checkout: "/src/kndl", service: "hub" })).toEqual({
      on: false,
      reason: "it runs from /src/kndl, not the installed checkout",
    })
    expect(hubUpdatesOf({ ...installed, checkout: undefined, service: "hub" })).toMatchObject({
      on: false,
    })
  })
})

describe("the Releases newer than the Hub's", () => {
  test("are newest first, by number, prereleases and other tags left out", () => {
    const found = newerReleases(
      [
        release("2026.10.9"),
        { ...release("2026.10.11"), prerelease: true },
        { ...release("2026.10.10"), tag: "v2026.10.10-beta.1" },
        release("2026.10.10"),
        release("2026.10.2"),
      ],
      "2026.10.2",
    )
    expect(found.map((notes) => notes.version)).toEqual(["2026.10.10", "2026.10.9"])
    expect(found[0]?.notes).toContain("## Highlights")
  })
})

describe("a check on stable", () => {
  const on = { commit: hubCommit, release: "2026.10.2", channel: "stable" } as const

  test("finds every Release since the Hub's, with their notes", async () => {
    const found = await find(on, "stable", { releases: released })
    expect(found).toEqual({
      _tag: "NewerRelease",
      releases: [notesOf("2026.10.10"), notesOf("2026.10.9")],
      compareUrl: "https://github.com/kddige/kndl/compare/v2026.10.2...v2026.10.10",
    })
  })

  test("finds nothing on the newest Release", async () => {
    expect(await find({ ...on, release: "2026.10.10" }, "stable", { releases: released })).toEqual({
      _tag: "UpToDate",
    })
  })

  test("on a commit after a Release, offers only a newer Release that holds it", async () => {
    // As after moving from dev: the Hub is past 2026.10.9, and 2026.10.10 was cut after it.
    const between = { commit: hubCommit, channel: "stable" } as const
    const holding = await find(
      between,
      "stable",
      {
        releases: released,
        compare: (base, head) =>
          base === hubCommit && head === "v2026.10.10" ? ahead(4) : undefined,
      },
      "2026.10.9",
    )
    expect(holding).toMatchObject({
      _tag: "NewerRelease",
      releases: [{ version: "2026.10.10" }],
      compareUrl: `https://github.com/kddige/kndl/compare/${hubCommit}...v2026.10.10`,
    })
    // The stable Channel never moves an install back: a Release that doesn't hold it isn't newer.
    const older = await find(
      between,
      "stable",
      { releases: released, compare: () => ({ status: "diverged", aheadBy: 2, commits: [] }) },
      "2026.10.9",
    )
    expect(older).toEqual({ _tag: "UpToDate" })
  })
})

describe("a check on dev", () => {
  const on = { commit: hubCommit, branch: "main", channel: "dev" } as const

  test("finds how far main is past the Hub, with the newest commits' titles first", async () => {
    const found = await find(on, "dev", {
      heads: { main: mainHead },
      compare: (base, head) => (base === hubCommit && head === mainHead ? ahead(60) : undefined),
    })
    if (found._tag !== "NewerCommits") throw new Error(`found ${found._tag}`)
    expect(found.head).toBe(mainHead)
    expect(found.behindBy).toBe(60)
    expect(found.commits).toHaveLength(50)
    expect(found.commits[0]?.title).toBe("web: change 60 (#60)")
    expect(found.commits.at(-1)?.title).toBe("web: change 11 (#11)")
    expect(found.compareUrl).toBe(
      `https://github.com/kddige/kndl/compare/${hubCommit}...${mainHead}`,
    )
  })

  test("finds nothing on main's head, or ahead of it", async () => {
    expect(await find(on, "dev", { heads: { main: hubCommit } })).toEqual({ _tag: "UpToDate" })
    expect(
      await find(on, "dev", {
        heads: { main: mainHead },
        compare: () => ({ status: "behind", aheadBy: 0, commits: [] }),
      }),
    ).toEqual({ _tag: "UpToDate" })
  })
})

// ── End to end ─────────────────────────────────────────────────────────────

/** The Owner, octocat, by the code the stand-in GitHub sends them back with. */
const github = GitHub.layerTest({
  users: { "owner-code": { id: 1, login: "octocat", name: "The Octocat" } },
})

/** A Hub that checks, at `version`, against kddige/kndl as `upstream` has it. */
const installedHub = (
  version: BuildVersion,
  upstream: Parameters<typeof Upstream.fixed>[0],
  options: { readonly database?: ReturnType<typeof databaseAt> } = {},
) =>
  startHub({
    github,
    // For a Member: dev login's people are never the Owner.
    config: { devLogin: true },
    hubVersion: HubVersion.fixed(version),
    hubUpdates: HubUpdates.layerOn({ before: undefined }).pipe(
      Layer.provide(Upstream.fixed(upstream)),
    ),
    ...(options.database !== undefined && { database: options.database }),
  })

const stableHub = { commit: hubCommit, release: "2026.10.2", channel: "stable" } as const

/** The Owner's web client: they become the Owner with the Setup link, or sign in again as it. */
async function signInOwner(hub: Awaited<ReturnType<typeof startHub>>, again = false) {
  const signedIn = again
    ? await githubSignIn(hub, { code: "owner-code" })
    : await ownerSignIn(hub, { code: "owner-code" })
  const cookie = cookieFrom(signedIn)
  return openWeb(hub, "octocat", cookie)
}

describe("the update check on a Hub", () => {
  test("tells its Owner of a newer Release, in the welcome and after each check", async () => {
    const hub = await installedHub(stableHub, { releases: released })
    const owner = await signInOwner(hub)
    expect(owner.welcome.hubUpdate?.follows).toEqual({ _tag: "Channel", channel: "stable" })

    owner.send({ _tag: "CheckHubUpdate", requestId: "check" })
    const checked = await owner.take("HubUpdateChecked", (m) => m.requestId === "check")
    expect(checked.update.checked?.found).toMatchObject({
      _tag: "NewerRelease",
      releases: [{ version: "2026.10.10" }, { version: "2026.10.9" }],
    })
    expect(checked.update.failed).toBeUndefined()
  })

  test("tells a Member nothing, and refuses their Check now", async () => {
    const hub = await installedHub(stableHub, { releases: released })
    await signInOwner(hub)
    const member = await openWeb(hub, "bob")
    expect(member.welcome.owner).toBeUndefined()
    expect(member.welcome.hubUpdate).toBeUndefined()

    member.send({ _tag: "CheckHubUpdate", requestId: "check" })
    expect(await member.take("CommandFailed", (m) => m.requestId === "check")).toEqual({
      _tag: "CommandFailed",
      command: "CheckHubUpdate",
      requestId: "check",
      message: ownerOnlyMessage,
    })
    expect(await member.untaken("HubUpdateChecked")).toEqual([])
  })

  test("is off on a Hub the kndl service doesn't run from its install", async () => {
    const hub = await startHub({ github, hubVersion: HubVersion.fixed(stableHub) })
    const owner = await signInOwner(hub)
    expect(owner.welcome.owner).toBe(true)
    expect(owner.welcome.hubUpdate).toBeUndefined()

    owner.send({ _tag: "CheckHubUpdate", requestId: "check" })
    expect(await owner.take("CommandFailed", (m) => m.requestId === "check")).toMatchObject({
      message: hubUpdatesOffMessage,
    })
    expect(await owner.untaken("HubUpdateChecked")).toEqual([])
  })

  test("on a pinned Hub, says what it is pinned to, and checks nothing", async () => {
    const hub = await installedHub({ commit: hubCommit, branch: "fix-login" }, { down: () => "no" })
    const owner = await signInOwner(hub)
    expect(owner.welcome.hubUpdate).toEqual({ follows: { _tag: "Pinned", ref: "fix-login" } })
    owner.send({ _tag: "CheckHubUpdate", requestId: "check" })
    const checked = await owner.take("HubUpdateChecked", (m) => m.requestId === "check")
    expect(checked.update).toEqual({ follows: { _tag: "Pinned", ref: "fix-login" } })
  })

  test("that fails keeps the last result, with the error and when, and a restart shows it", async () => {
    const dir = testDatabaseDir("kndl-update-check-")
    try {
      const outage: { message?: string } = {}
      const upstream = { releases: released, down: () => outage.message }
      const database = () => databaseAt(join(dir, "hub.db"))
      const hub = await installedHub(stableHub, upstream, { database: database() })
      const owner = await signInOwner(hub)
      owner.send({ _tag: "CheckHubUpdate", requestId: "first" })
      const first = await owner.take("HubUpdateChecked", (m) => m.requestId === "first")
      expect(first.update.checked?.found._tag).toBe("NewerRelease")

      const down = "Could not list kndl's Releases: GitHub answered 503"
      outage.message = down
      owner.send({ _tag: "CheckHubUpdate", requestId: "second" })
      const second = await owner.take("HubUpdateChecked", (m) => m.requestId === "second")
      expect(second.update.checked).toEqual(first.update.checked)
      expect(second.update.failed?.message).toBe(down)
      expect(second.update.failed?.at).toBeGreaterThanOrEqual(first.update.checked?.at ?? 0)
      await owner.close()
      await hub.stop()

      // Back with GitHub still down: the welcome has what the last check that worked found.
      const again = await installedHub(stableHub, upstream, { database: database() })
      const back = await signInOwner(again, true)
      expect(back.welcome.hubUpdate?.checked).toEqual(first.update.checked)
      await back.close()
      await again.stop()

      // On another commit, what was found for the one before is dropped.
      const moved = await installedHub(
        { ...stableHub, commit: commit("c"), release: "2026.10.10" },
        upstream,
        { database: database() },
      )
      const after = await signInOwner(moved, true)
      expect(after.welcome.hubUpdate?.checked).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
