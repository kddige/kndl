import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { UpdatePush } from "@kndl/hub/src/RunnerUpdatePush.ts"
import {
  decodeUpdateStatus,
  UpdateLockPath,
  UpdateLogPath,
  type UpdateStatus,
  UpdateStatusPath,
} from "@kndl/protocol"
import { Effect, Exit, Option } from "effect"
import { type Layout, resolveLayout, type Role } from "./Layout.ts"
import { describeStep, Shell, type Step, StepFailed, type StepResult } from "./Shell.ts"
import { scriptedUi, Ui } from "./Ui.ts"
import { holdUpdateLock, type UpdateEdges, type UpdateOptions, updateInstall } from "./UpdateRun.ts"

const Identity = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
}

/** Runs git in `cwd`: its output, trimmed. Throws when it fails. */
function git(cwd: string, ...args: ReadonlyArray<string>): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, ...Identity } })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

const FakeBun = "/fake/bun"

let scratch: string
let layout: Layout
/** The commits on origin's main: the install starts on the first, and main is at the second. */
let first: string
let second: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "kndl-update-run-"))
  layout = resolveLayout({ KNDL_HOME: join(scratch, ".kndl") }, scratch)
  const origin = join(scratch, "origin")
  git(scratch, "init", "--quiet", "--initial-branch=main", origin)
  git(origin, "commit", "--quiet", "--allow-empty", "-m", "first")
  first = git(origin, "rev-parse", "HEAD")
  git(origin, "tag", "v2026.10.1")
  git(origin, "commit", "--quiet", "--allow-empty", "-m", "second")
  second = git(origin, "rev-parse", "HEAD")
  mkdirSync(layout.home.dir, { recursive: true })
  git(scratch, "clone", "--quiet", origin, layout.app)
  git(layout.app, "reset", "--quiet", "--hard", first)
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/**
 * A Shell that runs git for real, in the scratch checkouts, and stands in for Bun: a Bun Step
 * fails while `broken` says so, as a build that breaks does.
 */
function standInShell(broken: (s: Step) => boolean = () => false) {
  const capture = (s: Step) =>
    Effect.suspend(() => {
      const result: StepResult =
        s.command === "git"
          ? spawned(s)
          : broken(s)
            ? { exitCode: 1, stdout: "", stderr: "error: the build broke" }
            : { exitCode: 0, stdout: `ran ${s.args.join(" ")}\n`, stderr: "" }
      if (result.exitCode !== 0 && !s.mayFail) {
        return Effect.fail(
          new StepFailed({
            message: `${describeStep(s)} exited with ${result.exitCode}: ${result.stderr.trim()}`,
            exitCode: result.exitCode,
          }),
        )
      }
      return Effect.succeed(result)
    })
  return Shell.of({
    dryRun: false,
    capture,
    attached: (s) => Effect.map(capture(s), (result) => result.exitCode),
  })
}

function spawned(s: Step): StepResult {
  const result = Bun.spawnSync([s.command, ...s.args], { cwd: s.cwd ?? layout.app })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

/** The push an earlier update left the Hub. */
const earlierPush: UpdatePush = {
  commit: "e".repeat(40),
  now: false,
  allRunners: true,
  localRunner: undefined,
}

/**
 * Edges that start nothing: the services in `installed` are installed, the Hub answers `/health`
 * while `healthy` says so, and what the update asks of them is recorded.
 */
function standInEdges(
  settings: {
    readonly installed?: ReadonlyArray<Role>
    readonly healthy?: () => boolean
  } = {},
) {
  const restarts: Array<string> = []
  const pushes: Array<string> = []
  const restored: Array<UpdatePush | undefined> = []
  const edges: UpdateEdges = {
    bun: FakeBun,
    serviceInstalled: (role) => Effect.succeed(settings.installed?.includes(role) === true),
    serviceFileChanged: () => Effect.succeed(false),
    leavePush: (options) =>
      Effect.sync(() => {
        pushes.push(options.commit)
        return { localRunner: undefined, replaced: earlierPush }
      }),
    restorePush: (replaced) => Effect.sync(() => void restored.push(replaced)),
    restartServices: (except) =>
      Effect.sync(() => void restarts.push(except === undefined ? "all" : `all but ${except}`)),
    waitForHub: Effect.sync(() => ({
      url: "http://127.0.0.1:7777",
      ok: settings.healthy?.() ?? true,
      detail: "no answer (connection refused)",
    })),
  }
  return { edges, restarts, pushes, restored }
}

const plain: UpdateOptions = {
  ref: undefined,
  channel: undefined,
  updateRunners: true,
  now: false,
  source: "cli",
}

const run = (edges: UpdateEdges, shell = standInShell(), options: Partial<UpdateOptions> = {}) => {
  const { ui, transcript } = scriptedUi([], { interactive: false })
  return Effect.runPromise(
    updateInstall(layout, { ...plain, ...options }, edges).pipe(
      Effect.provideService(Shell, shell),
      Effect.provideService(Ui, ui),
      Effect.exit,
    ),
  ).then((exit) => ({ exit, transcript }))
}

const failure = (exit: Exit.Exit<unknown, { readonly message: string }>) =>
  Exit.isFailure(exit) ? exit.cause.toString() : undefined

const status = (): UpdateStatus | undefined =>
  Option.getOrUndefined(
    decodeUpdateStatus(readFileSync(join(layout.home.dir, UpdateStatusPath), "utf8")),
  )
const log = () => readFileSync(join(layout.home.dir, UpdateLogPath), "utf8")

const head = () => ({
  commit: git(layout.app, "rev-parse", "HEAD"),
  branch: Bun.spawnSync(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd: layout.app,
  })
    .stdout.toString()
    .trim(),
})

/** Sets the install up as a Hub's, with its service installed. */
const asHub = () => writeFileSync(layout.envFile("hub"), "PORT=7777\n")

describe.skipIf(Bun.which("git") === null)("kndl update", () => {
  test("moves along main, and says in the status and the log how it went", async () => {
    const { edges, restarts } = standInEdges()

    const { exit } = await run(edges, standInShell(), { source: "hub" })

    expect(Exit.isSuccess(exit) && exit.value).toBe(true)
    expect(head()).toEqual({ commit: second, branch: "main" })
    expect(status()).toMatchObject({
      source: "hub",
      from: { commit: first },
      target: { ref: "main", commit: second },
      state: "Succeeded",
    })
    expect(status()?.finishedAt).toBeNumber()
    expect(restarts).toEqual(["all"])
    expect(log()).toContain(
      "== Building the hub-link mod\n$ /fake/bun run mod:build\nran run mod:build",
    )
    // The lock goes with the update.
    expect(existsSync(join(layout.home.dir, UpdateLockPath))).toBe(false)
  })

  test("a build failure goes back to the commit and branch it was on: RolledBack", async () => {
    const { edges, restarts } = standInEdges()
    let builds = 0
    const shell = standInShell((s) => s.args[1] === "web:build" && ++builds === 1)

    const { exit } = await run(edges, shell)

    expect(failure(exit)).toContain("The update failed, so the install went back to")
    expect(head()).toEqual({ commit: first, branch: "main" })
    expect(git(layout.app, "rev-parse", "--abbrev-ref", "main@{upstream}")).toBe("origin/main")
    expect(status()).toMatchObject({
      target: { ref: "main", commit: second },
      step: "Rolling back",
      state: "RolledBack",
    })
    expect(status()?.error).toContain("run web:build exited with 1: error: the build broke")
    // Built again on the old commit; the services never restarted, so they don't now.
    expect(builds).toBe(2)
    expect(restarts).toEqual([])
    expect(log()).toContain("== Rolling back\n$ git switch --discard-changes -C main")
  })

  test("a Hub that isn't healthy after restarting is rolled back, and its push taken back", async () => {
    asHub()
    // On stable at the first Release, moving to dev.
    git(layout.app, "switch", "--quiet", "--detach", first)
    git(layout.app, "config", "kndl.channel", "stable")
    let checks = 0
    const { edges, restarts, pushes, restored } = standInEdges({
      installed: ["hub"],
      healthy: () => ++checks > 1,
    })

    const { exit } = await run(edges, standInShell(), { channel: "dev" })

    expect(failure(exit)).toContain("wasn't healthy 30 seconds after it restarted")
    expect(head()).toEqual({ commit: first, branch: "" })
    expect(git(layout.app, "config", "--get", "kndl.channel")).toBe("stable")
    expect(pushes).toEqual([second])
    expect(restored).toEqual([earlierPush])
    expect(restarts).toEqual(["all", "all"])
    expect(status()).toMatchObject({
      from: { commit: first, version: "2026.10.1" },
      state: "RolledBack",
    })
    expect(status()?.error).toContain("no answer (connection refused)")
  })

  test("when going back fails too, the update is Failed, with both errors", async () => {
    const { edges } = standInEdges()

    const { exit } = await run(
      edges,
      standInShell((s) => s.args[1] === "web:build"),
    )

    expect(failure(exit)).toContain(`Going back to ${first.slice(0, 12)} failed too`)
    expect(status()?.state).toBe("Failed")
    expect(status()?.error).toMatch(/the build broke.*Going back.*failed too.*the build broke/s)
  })

  test("a failure before the checkout moved goes nowhere: Failed", async () => {
    const { edges, restarts } = standInEdges()

    const { exit } = await run(edges, standInShell(), { ref: "no-such-branch" })

    expect(failure(exit)).toContain("origin has no branch or tag named no-such-branch")
    expect(head()).toEqual({ commit: first, branch: "main" })
    expect(status()).toMatchObject({
      state: "Failed",
      step: "Asking origin for its branches and tags",
    })
    expect(restarts).toEqual([])
  })

  test("a second update is refused while one runs, and leaves its status alone", async () => {
    const { edges } = standInEdges()

    const { exit } = await Effect.runPromise(
      Effect.scoped(
        Effect.andThen(holdUpdateLock(layout.home.dir, "hub"), () =>
          Effect.promise(() => run(edges)),
        ),
      ),
    )

    expect(failure(exit)).toContain(`An update is already running (pid ${process.pid}, started`)
    expect(existsSync(join(layout.home.dir, UpdateStatusPath))).toBe(false)
    expect(head().commit).toBe(first)
  })
})

const lockPath = () => join(layout.home.dir, UpdateLockPath)

/** Takes the lock as `kndl update` does: what it wrote, while it held it. */
const take = () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.andThen(holdUpdateLock(layout.home.dir, "cli"), () =>
        Effect.sync(() => JSON.parse(readFileSync(lockPath(), "utf8"))),
      ),
    ).pipe(Effect.exit),
  )

describe("the update lock", () => {
  beforeEach(() => mkdirSync(join(layout.home.dir, "update"), { recursive: true }))

  test("is taken over from an update that is gone", async () => {
    const gone = Bun.spawnSync(["true"]).pid
    writeFileSync(lockPath(), JSON.stringify({ pid: gone, startedAt: Date.now(), source: "hub" }))

    const exit = await take()

    expect(Exit.isSuccess(exit) && exit.value).toMatchObject({ pid: process.pid, source: "cli" })
    expect(existsSync(lockPath())).toBe(false)
  })

  test("is taken over from before the machine booted, and when it isn't a lock", async () => {
    writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, startedAt: 0, source: "cli" }))
    expect(Exit.isSuccess(await take())).toBe(true)

    writeFileSync(lockPath(), "half a")
    expect(Exit.isSuccess(await take())).toBe(true)
  })

  test("held by a running update, refuses", async () => {
    const held = { pid: process.pid, startedAt: Date.now(), source: "hub" }
    writeFileSync(lockPath(), JSON.stringify(held))

    const exit = await take()

    expect(failure(exit)).toContain(`An update is already running (pid ${process.pid}`)
    // Not taken, so not removed.
    expect(JSON.parse(readFileSync(lockPath(), "utf8"))).toEqual(held)
  })
})
