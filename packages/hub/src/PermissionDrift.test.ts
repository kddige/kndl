// The GitHub App's permission check, as the web UI sees it: a real Hub with the App, a stand-in
// GitHub API, and web clients over WebSockets.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Option, Redacted } from "effect"
import { PermissionDrift } from "./PermissionDrift.ts"
import { openWeb, stopAll } from "./testChannels.ts"
import { appId, appKeyPair, appSlug, StandInGitHub } from "./testGitHubApi.ts"
import { startHub } from "./testSupport.ts"

afterEach(stopAll)

const keys = appKeyPair()
let github: StandInGitHub

beforeAll(() => {
  github = StandInGitHub.start(keys.publicKey)
})
afterAll(() => github.stop())

/** A Hub with the GitHub App, once it has checked the App's permissions. */
async function appHub() {
  const hub = await startHub({
    config: {
      devLogin: true,
      githubAppId: Option.some(appId),
      githubAppPrivateKey: Option.some(Redacted.make(keys.privateKeyPem)),
      githubApiUrl: github.url,
    },
  })
  // The check it starts with.
  await hub.run(Effect.flatMap(PermissionDrift, (drift) => drift.check))
  return hub
}

const lackingIssues = () => {
  github.reset()
  github.appPermissions = { contents: "write", pull_requests: "write", metadata: "read" }
}

describe("the permission check", () => {
  test("is sent to a web client as it connects, with what is missing", async () => {
    lackingIssues()
    const hub = await appHub()
    const web = await openWeb(hub, "alice")
    const { check } = await web.take("AppPermissionsChecked")
    expect(check).toMatchObject({
      slug: appSlug,
      settingsUrl: `https://github.com/settings/apps/${appSlug}/permissions`,
      missing: [{ name: "issues", title: "Issues", access: "write" }],
      installed: 1,
    })
    // The installation was made with them all: it isn't behind.
    expect(check.installations).toEqual([])
  })

  test("is checked again when asked, and the news goes to everyone", async () => {
    lackingIssues()
    const hub = await appHub()
    const alice = await openWeb(hub, "alice")
    const bob = await openWeb(hub, "bob")
    await alice.take("AppPermissionsChecked")
    await bob.take("AppPermissionsChecked")

    // Fixed on GitHub.
    github.appPermissions = { ...github.appPermissions, issues: "write" }
    alice.send({ _tag: "CheckAppPermissions", requestId: "q-1" })
    const answered = await alice.take("AppPermissionsChecked", (m) => m.requestId === "q-1")
    expect(answered.check.missing).toEqual([])
    const told = await bob.take("AppPermissionsChecked")
    expect(told.check.missing).toEqual([])
  })

  test("asked for while one is under way, is that one", async () => {
    github.reset()
    const hub = await appHub()
    const asked = github.requests.length
    const checks = await hub.run(
      Effect.flatMap(PermissionDrift, (drift) =>
        Effect.all([drift.check, drift.check, drift.check], { concurrency: "unbounded" }),
      ),
    )
    expect(new Set(checks.map((check) => check.checkedAt)).size).toBe(1)
    // One `GET /app` and one page of installations.
    expect(github.requests.length - asked).toBe(2)
  })

  test("that fails is refused with why, and keeps the last one", async () => {
    github.reset()
    const hub = await appHub()
    github.appDown = true
    const failed = await hub.run(
      Effect.flatMap(PermissionDrift, (drift) => Effect.flip(drift.check)),
    )
    expect(failed.message).toContain("GitHub answered 503")
    const web = await openWeb(hub, "alice")
    expect((await web.take("AppPermissionsChecked")).check.missing).toEqual([])
  })

  test("isn't made, or sent, without the App", async () => {
    const hub = await startHub({ config: { devLogin: true } })
    const web = await openWeb(hub, "alice")
    web.send({ _tag: "CheckAppPermissions", requestId: "q-1" })
    const failed = await web.take("CommandFailed")
    expect(failed).toMatchObject({ command: "CheckAppPermissions", requestId: "q-1" })
    expect(failed.message).toContain("GITHUB_APP_ID")
    expect(await web.untaken("AppPermissionsChecked")).toEqual([])
  })
})
