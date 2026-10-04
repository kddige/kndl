// Doctor's check of the GitHub App, with hub.env's App, against the stand-in GitHub.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appId, appKeyPair, StandInGitHub } from "@claude-hub/hub/src/testGitHubApi.ts"
import { Effect } from "effect"
import { appPermissionsFact } from "./Host.ts"
import { type Layout, resolveLayout } from "./Layout.ts"

const keys = appKeyPair()
const github = StandInGitHub.start(keys.publicKey)
afterAll(() => github.stop())

let scratch: string
let layout: Layout

beforeEach(async () => {
  github.reset()
  scratch = await mkdtemp(join(tmpdir(), "claude-hub-host-"))
  layout = resolveLayout({ CLAUDE_HUB_HOME: join(scratch, ".claude-hub") }, scratch)
  mkdirSync(layout.home.dir, { recursive: true })
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

/** A hub.env with the stand-in's App, or none. */
function hubEnv(app: boolean) {
  const key = join(layout.home.dir, "github-app.pem")
  writeFileSync(key, keys.privateKeyPem, { mode: 0o600 })
  writeFileSync(
    layout.envFile("hub"),
    [
      "HUB_PUBLIC_URL=http://127.0.0.1:7777",
      ...(app ? [`GITHUB_APP_ID=${appId}`, `GITHUB_APP_PRIVATE_KEY_PATH=${key}`] : []),
      "",
    ].join("\n"),
    { mode: 0o600 },
  )
}

const fact = () => Effect.runPromise(appPermissionsFact(layout, github.url))

describe("doctor's GitHub App check", () => {
  test("asks GitHub, as the App, for its permissions and its installations'", async () => {
    hubEnv(true)
    const [installation] = github.installations
    if (installation === undefined) throw new Error("The stand-in has no installation")
    github.installations[0] = {
      ...installation,
      permissions: { contents: "write", metadata: "read" },
    }

    const found = await fact()

    expect(found).toMatchObject({
      _tag: "Checked",
      check: {
        missing: [],
        installed: 1,
        installations: [
          { account: "kddige", missing: [{ name: "pull_requests" }, { name: "issues" }] },
        ],
      },
    })
    expect(github.requests.map((request) => request.path)).toEqual(["/app", "/app/installations"])
  })

  test("GitHub refusing says why, and isn't a failure", async () => {
    hubEnv(true)
    github.appDown = true

    expect(await fact()).toEqual({
      _tag: "Unchecked",
      detail:
        "Could not read the GitHub App's permissions: GitHub answered 503: Service Unavailable",
    })
  })

  test("no App: nothing to check, and GitHub isn't asked", async () => {
    hubEnv(false)

    expect(await fact()).toBeUndefined()
    expect(github.requests).toEqual([])
  })
})
