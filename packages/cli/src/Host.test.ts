// Doctor's check of the GitHub App, with hub.env's App, against the stand-in GitHub; and its read
// of a tmux server, on a socket of the test's own.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appId, appKeyPair, StandInGitHub } from "@claude-hub/hub/src/testGitHubApi.ts"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { appPermissionsFact, tmuxServerFact } from "./Host.ts"
import { type Layout, resolveLayout } from "./Layout.ts"
import { Shell } from "./Shell.ts"

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

/** A hub.env with the stand-in's App or none, and with GitHub sign-in or not. */
function hubEnv(app: boolean, signIn = false) {
  const key = join(layout.home.dir, "github-app.pem")
  writeFileSync(key, keys.privateKeyPem, { mode: 0o600 })
  writeFileSync(
    layout.envFile("hub"),
    [
      "HUB_PUBLIC_URL=http://127.0.0.1:7777",
      ...(app ? [`GITHUB_APP_ID=${appId}`, `GITHUB_APP_PRIVATE_KEY_PATH=${key}`] : []),
      ...(signIn ? ["GITHUB_CLIENT_ID=Iv23liTest", "GITHUB_CLIENT_SECRET=client-secret"] : []),
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

  test("GitHub sign-in without an App is found, without asking GitHub", async () => {
    hubEnv(false, true)

    expect(await fact()).toEqual({ _tag: "SignInWithoutApp" })
    expect(github.requests).toEqual([])
  })
})

describe.skipIf(Bun.which("tmux") === null)("doctor's read of the Runner's tmux server", () => {
  const socket = `claude-hub-test-${process.pid}-doctor`
  afterAll(() => {
    Bun.spawnSync(["tmux", "-L", socket, "kill-server"])
  })

  const read = (servicePath: string | undefined) =>
    Effect.runPromise(
      tmuxServerFact(socket, servicePath).pipe(
        Effect.provide(Shell.layer),
        Effect.provide(BunServices.layer),
      ),
    )

  test("finds none when no server runs on the socket", async () => {
    expect(await read(undefined)).toBeUndefined()
  })

  test("a server started from a checkout since deleted: its directory, PWD and PATH (#105)", async () => {
    const deleted = realpathSync(mkdtempSync(join(tmpdir(), "claude-hub-deleted-checkout-")))
    const env: Record<string, string | undefined> = {
      ...process.env,
      PWD: deleted,
      PATH: `${deleted}/bin:/usr/bin:/bin`,
    }
    delete env.TMUX
    const tmux = Bun.which("tmux") ?? "tmux"
    const started = Bun.spawnSync(
      [tmux, "-L", socket, "-f", "/dev/null", "new-session", "-d", "sleep 600"],
      { cwd: deleted, env },
    )
    expect(started.exitCode).toBe(0)
    rmSync(deleted, { recursive: true })

    expect(await read("/usr/bin:/bin")).toEqual({
      socket,
      sessions: 1,
      cwd: { path: deleted, exists: false },
      pwd: { path: deleted, exists: false },
      path: `${deleted}/bin:/usr/bin:/bin`,
      servicePath: "/usr/bin:/bin",
    })
  }, 15_000)
})
