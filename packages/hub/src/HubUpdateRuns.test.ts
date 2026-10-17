// The Owner updates the Hub from the web (ADR 0028, #362), end to end on a real Hub that checks:
// who may, what it launches (a stand-in for systemd-run or launchd, which starts nothing), what
// refuses it, and how the update's status file and log reach the Owner as it runs, after a
// restart, and for an update from the CLI too.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type BuildVersion,
  type CommitId,
  type HubFollows,
  hubPinnedMessage,
  hubUpdateStartingMessage,
  hubUpdatesOffMessage,
  ownerOnlyMessage,
  type UpdateLock,
  UpdateLockPath,
  UpdateLogPath,
  updateRunningText,
  type UpdateStatus,
  UpdateStatusPath,
} from "@kndl/protocol"
import { Duration, Layer } from "effect"
import { GitHub } from "./GitHub.ts"
import { HubUpdateLauncher, type UpdateJob, updateCommandLine } from "./HubUpdateLauncher.ts"
import { HubUpdateRuns, logTail, stoppedUnsaidText } from "./HubUpdateRuns.ts"
import { HubUpdates } from "./HubUpdates.ts"
import { HubVersion } from "./HubVersion.ts"
import { openWeb, stopAll } from "./testChannels.ts"
import { cookieFrom, githubSignIn, ownerSignIn, startHub } from "./testSupport.ts"
import { Upstream } from "./Upstream.ts"

const homes: Array<string> = []

afterEach(async () => {
  await stopAll()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const hubCommit = "a".repeat(40) as CommitId
const newCommit = "c".repeat(40) as CommitId
const stableHub: BuildVersion = { commit: hubCommit, release: "2026.10.2", channel: "stable" }

/** A home with `update/` in it, removed after the test. */
function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), "kndl-hub-update-"))
  mkdirSync(join(home, "update"))
  homes.push(home)
  return home
}

const writeStatus = (home: string, status: UpdateStatus) =>
  writeFileSync(join(home, UpdateStatusPath), `${JSON.stringify(status, null, 2)}\n`)

const writeLock = (home: string, lock: UpdateLock) =>
  writeFileSync(join(home, UpdateLockPath), `${JSON.stringify(lock)}\n`)

const writeLog = (home: string, text: string) => writeFileSync(join(home, UpdateLogPath), text)

const running = (step: string, more: Partial<UpdateStatus> = {}): UpdateStatus => ({
  id: "run-1",
  source: "hub",
  startedAt: 1_700_000_000_000,
  from: { commit: hubCommit, version: "2026.10.2" },
  target: { ref: "v2026.10.4" },
  step,
  state: "Running",
  ...more,
})

/** A pid no process has: the highest Linux allows, past any test machine's. */
const deadPid = 4_194_303

const github = GitHub.layerTest({
  users: { "owner-code": { id: 1, login: "octocat", name: "The Octocat" } },
})

/**
 * A Hub that checks, at `version`, in `home`, whose launches go to `launched`: what that returns
 * fails the launch.
 */
function installedHub(
  home: string,
  options: {
    readonly version?: BuildVersion
    readonly launched?: (job: UpdateJob) => string | void
    readonly follows?: () => HubFollows | undefined
  } = {},
) {
  return startHub({
    github,
    // For a Member: dev login's people are never the Owner.
    config: { devLogin: true },
    hubVersion: HubVersion.fixed(options.version ?? stableHub),
    hubUpdates: HubUpdates.layerOn({
      before: undefined,
      ...(options.follows !== undefined && { follows: options.follows }),
    }).pipe(Layer.provide(Upstream.fixed({ releases: [] }))),
    hubUpdateRuns: HubUpdateRuns.layerOn({
      home,
      polls: { running: Duration.millis(20), idle: Duration.millis(40) },
    }).pipe(Layer.provide(HubUpdateLauncher.fake(options.launched ?? (() => undefined)))),
  })
}

async function signInOwner(hub: Awaited<ReturnType<typeof startHub>>, again = false) {
  const signedIn = again
    ? await githubSignIn(hub, { code: "owner-code" })
    : await ownerSignIn(hub, { code: "owner-code" })
  return openWeb(hub, "octocat", cookieFrom(signedIn))
}

describe("updating the Hub from the web", () => {
  test("launches kndl update for the Owner, outside the Hub, with --now and --channel", async () => {
    const home = newHome()
    const jobs: Array<UpdateJob> = []
    const hub = await installedHub(home, { launched: (job) => void jobs.push(job) })
    const owner = await signInOwner(hub)

    owner.send({ _tag: "UpdateHub", requestId: "u-1", now: true, channel: "dev" })
    expect(await owner.take("HubUpdateStarted")).toEqual({
      _tag: "HubUpdateStarted",
      requestId: "u-1",
    })
    const [job] = jobs
    expect(job).toMatchObject({
      home,
      bun: process.execPath,
      cli: join(home, "app", "packages", "cli", "src", "main.ts"),
      now: true,
      channel: "dev",
    })
    expect(job && updateCommandLine(job)).toEqual([
      process.execPath,
      join(home, "app", "packages", "cli", "src", "main.ts"),
      "update",
      "--source",
      "hub",
      "--now",
      "--channel",
      "dev",
    ])
  })

  test("refuses a Member, and a Hub that doesn't check", async () => {
    const home = newHome()
    const jobs: Array<UpdateJob> = []
    const hub = await installedHub(home, { launched: (job) => void jobs.push(job) })
    await signInOwner(hub)
    const member = await openWeb(hub, "bob")
    member.send({ _tag: "UpdateHub", requestId: "u-1", now: false })
    expect(await member.take("CommandFailed")).toEqual({
      _tag: "CommandFailed",
      command: "UpdateHub",
      requestId: "u-1",
      message: ownerOnlyMessage,
    })
    expect(jobs).toEqual([])

    const off = await startHub({ github, hubVersion: HubVersion.fixed(stableHub) })
    const offOwner = await signInOwner(off)
    expect(offOwner.welcome.hubUpdateRun).toBeUndefined()
    offOwner.send({ _tag: "UpdateHub", requestId: "u-2", now: false })
    expect(await offOwner.take("CommandFailed")).toMatchObject({ message: hubUpdatesOffMessage })
  })

  test("refuses while an update holds the lock, from the CLI too, but takes a stale one over", async () => {
    const home = newHome()
    const jobs: Array<UpdateJob> = []
    const hub = await installedHub(home, { launched: (job) => void jobs.push(job) })
    const owner = await signInOwner(hub)
    const lock: UpdateLock = { pid: process.pid, startedAt: Date.now(), source: "cli" }
    writeLock(home, lock)

    owner.send({ _tag: "UpdateHub", requestId: "u-1", now: false })
    expect(await owner.take("CommandFailed")).toMatchObject({
      requestId: "u-1",
      message: updateRunningText(lock),
    })
    expect(jobs).toEqual([])

    // Its process is gone, as after a crash.
    writeLock(home, { ...lock, pid: deadPid })
    owner.send({ _tag: "UpdateHub", requestId: "u-2", now: false })
    expect(await owner.take("HubUpdateStarted")).toMatchObject({ requestId: "u-2" })
    expect(jobs).toHaveLength(1)
  })

  test("refuses a second update while the first hasn't started, and one that failed to launch frees it", async () => {
    const home = newHome()
    const outcome: { failure?: string } = { failure: "systemd-run exited with 1: no bus" }
    const hub = await installedHub(home, { launched: () => outcome.failure })
    const owner = await signInOwner(hub)

    owner.send({ _tag: "UpdateHub", requestId: "u-1", now: false })
    expect(await owner.take("CommandFailed", (m) => m.requestId === "u-1")).toMatchObject({
      message: "Couldn't start the update: systemd-run exited with 1: no bus",
    })

    delete outcome.failure
    owner.send({ _tag: "UpdateHub", requestId: "u-2", now: false })
    await owner.take("HubUpdateStarted", (m) => m.requestId === "u-2")
    owner.send({ _tag: "UpdateHub", requestId: "u-3", now: true })
    expect(await owner.take("CommandFailed", (m) => m.requestId === "u-3")).toMatchObject({
      message: hubUpdateStartingMessage,
    })
  })

  test("on a pinned Hub, needs a Channel, which unpins it", async () => {
    const home = newHome()
    const jobs: Array<UpdateJob> = []
    const hub = await installedHub(home, {
      version: { commit: hubCommit, branch: "fix-login" },
      launched: (job) => void jobs.push(job),
    })
    const owner = await signInOwner(hub)
    owner.send({ _tag: "UpdateHub", requestId: "u-1", now: false })
    expect(await owner.take("CommandFailed")).toMatchObject({
      message: hubPinnedMessage("fix-login"),
    })
    owner.send({ _tag: "UpdateHub", requestId: "u-2", now: false, channel: "stable" })
    await owner.take("HubUpdateStarted")
    expect(jobs.map((job) => job.channel)).toEqual(["stable"])
  })

  test("sends the Owner each step, then how it ended with the end of the log, and a Member nothing", async () => {
    const home = newHome()
    const lock: UpdateLock = { pid: process.pid, startedAt: Date.now(), source: "hub" }
    // As `kndl update` does: the lock first, then the status.
    const hub = await installedHub(home, {
      launched: () => {
        writeLock(home, lock)
        writeStatus(home, running("Starting"))
      },
    })
    const owner = await signInOwner(hub)
    const member = await openWeb(hub, "bob")

    owner.send({ _tag: "UpdateHub", requestId: "u-1", now: false })
    await owner.take("HubUpdateStarted")
    expect(
      (await owner.take("HubUpdateRunChanged", (m) => m.run.status.step === "Starting")).run,
    ).toEqual({ status: running("Starting") })
    writeStatus(home, running("Building the web UI"))
    await owner.take("HubUpdateRunChanged", (m) => m.run.status.step === "Building the web UI")

    // While it runs, a second one is refused, saying who holds the lock.
    owner.send({ _tag: "UpdateHub", requestId: "u-2", now: true })
    expect(await owner.take("CommandFailed", (m) => m.requestId === "u-2")).toMatchObject({
      message: updateRunningText(lock),
    })

    const lines = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`)
    writeLog(home, `${lines.join("\n")}\n`)
    const error = "Building the web UI failed: vite exited with 1."
    writeStatus(
      home,
      running("Rolling back", { state: "RolledBack", finishedAt: 1_700_000_100_000, error }),
    )
    rmSync(join(home, UpdateLockPath))
    const ended = await owner.take("HubUpdateRunChanged", (m) => m.run.status.state !== "Running")
    expect(ended.run.status).toMatchObject({ state: "RolledBack", error })
    expect(ended.run.logTail?.split("\n")).toEqual(lines.slice(-80))

    expect(await member.untaken("HubUpdateRunChanged")).toEqual([])
    expect(member.welcome.hubUpdateRun).toBeUndefined()
  })

  test("after the Hub restarts, its welcome has how the latest update ended, one from the CLI too", async () => {
    const home = newHome()
    const succeeded = running("Checking the Hub's health", {
      source: "cli",
      target: { ref: "v2026.10.4", commit: newCommit },
      state: "Succeeded",
      finishedAt: 1_700_000_100_000,
    })
    writeStatus(home, succeeded)
    writeLog(home, "\n== Fetching\n$ git fetch\n\n")
    const hub = await installedHub(home, {
      version: { commit: newCommit, release: "2026.10.4", channel: "stable" },
    })
    const owner = await signInOwner(hub)
    expect(owner.welcome.hubUpdateRun).toEqual({
      status: succeeded,
      logTail: "== Fetching\n$ git fetch",
    })
  })

  test("shows an update whose process is gone without saying how it ended as Failed", async () => {
    const home = newHome()
    writeStatus(home, running("Installing dependencies"))
    writeLock(home, { pid: deadPid, startedAt: Date.now(), source: "hub" })
    const hub = await installedHub(home)
    const owner = await signInOwner(hub)
    expect(owner.welcome.hubUpdateRun?.status).toMatchObject({
      step: "Installing dependencies",
      state: "Failed",
      error: stoppedUnsaidText,
    })
  })

  test("checks again once an update that recorded a new Channel, without moving the Hub, ends", async () => {
    const home = newHome()
    const follows: { now: HubFollows } = { now: { _tag: "Channel", channel: "dev" } }
    const hub = await installedHub(home, {
      version: { commit: hubCommit, branch: "main", channel: "dev" },
      follows: () => follows.now,
      launched: () => {
        writeLock(home, { pid: process.pid, startedAt: Date.now(), source: "hub" })
        writeStatus(home, running("Asking origin for its branches and tags"))
      },
    })
    const owner = await signInOwner(hub)
    expect(owner.welcome.hubUpdate?.follows).toEqual({ _tag: "Channel", channel: "dev" })
    owner.send({ _tag: "UpdateHub", requestId: "u-1", now: false, channel: "stable" })
    await owner.take("HubUpdateStarted")
    await owner.take("HubUpdateRunChanged", (m) => m.run.status.state === "Running")

    // `kndl update --channel stable` on dev, with no Release past the commit: it records it.
    follows.now = { _tag: "Channel", channel: "stable" }
    const { target: _, ...stayed } = running("Recording the Channel")
    writeStatus(home, { ...stayed, state: "Succeeded", finishedAt: Date.now() })
    rmSync(join(home, UpdateLockPath))
    const checked = await owner.take(
      "HubUpdateChecked",
      (m) => m.update.follows._tag === "Channel" && m.update.follows.channel === "stable",
    )
    expect(checked.update.checked?.found).toEqual({ _tag: "UpToDate" })
  })
})

describe("the end of an update's log", () => {
  test("is its last lines, whole, within the length", () => {
    expect(logTail("one\ntwo\nthree\n")).toBe("one\ntwo\nthree")
    expect(logTail("half a line\nwhole\n", true)).toBe("whole")
    const long = Array.from({ length: 10 }, (_, i) => `${i}`.repeat(1_000)).join("\n")
    const tail = logTail(long) ?? ""
    expect(tail.length).toBeLessThanOrEqual(8_000)
    expect(tail.startsWith("3")).toBe(true)
  })

  test("is nothing for an empty log", () => {
    expect(logTail("")).toBeUndefined()
    expect(logTail("\n\n  \n")).toBeUndefined()
  })
})
