// The Runner's Updater with real git, against a bare origin and a clone it makes in a temp
// directory: the clone stands for the installed checkout. Installing, building, checking the
// Runner loads and restarting are faked. Skipped when git isn't installed.
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BuildVersion, RunnerToHub, RunnerUpdater } from "@claude-hub/protocol"
import { BunServices } from "@effect/platform-bun"
import { Effect, Exit, Layer, References, Scope } from "effect"
import { HubLink } from "./HubLink.ts"
import { CommandFailed, hostEnvironment, runCommand } from "./Process.ts"
import type { Marker } from "./SelfUpdate.ts"
import { eventually } from "./testSupport.ts"
import { makeUpdater, type Updater, type UpdaterEdge } from "./Updater.ts"

const testIdentity = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
}

function git(cwd: string, ...args: Array<string>): string {
  const started = Date.now()
  const result = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: { ...process.env, ...testIdentity, GIT_TERMINAL_PROMPT: "0" },
    stdin: "ignore",
  })
  if (result.exitCode !== 0) {
    // Killed (by the test's timeout, say) it exits with no code and nothing on stderr.
    const ended = result.signalCode
      ? `was killed by ${result.signalCode}`
      : `exited ${result.exitCode}`
    throw new Error(
      `git ${args[0]} ${ended} after ${Date.now() - started}ms: ${result.stderr.toString().trim()}`,
    )
  }
  return result.stdout.toString().trim()
}

/** Commits a change to `file` in `cwd` and returns the commit. */
function commit(cwd: string, file: string): string {
  writeFileSync(join(cwd, file), `${file} ${Math.random()}\n`)
  git(cwd, "add", file)
  git(cwd, "commit", "--quiet", "-m", file)
  return git(cwd, "rev-parse", "HEAD")
}

const failing = (what: string) =>
  Effect.fail(new CommandFailed({ message: `${what} exited with 1: it broke` }))
const target = (sha: string, branch = "main"): BuildVersion => ({ commit: sha, branch })
const run = <A>(effect: Effect.Effect<A>) =>
  Effect.runPromise(effect.pipe(Effect.provideService(References.MinimumLogLevel, "None")))
const tags = (h: Harness) => h.sent.map((message) => message._tag)

interface Harness {
  readonly clone: string
  readonly sent: Array<RunnerToHub>
  readonly calls: Array<string>
  /** The git commands that have finished, in the order they did. */
  readonly ran: Array<string>
  marker: Marker | undefined
  /** Make the next build, or the load checks, fail. */
  failBuild: boolean
  failLoad: boolean
  readonly updater: Updater["Service"]
  readonly close: () => Promise<void>
}

describe.skipIf(Bun.which("git") === null)("the Runner's Updater", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-hub-updater-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  let counter = 0
  let origin: string
  let work: string
  /** Commits on origin/main: the clone's, then a newer one. */
  let first: string
  let second: string
  /** A commit only on origin/feature. */
  let feature: string

  beforeEach(() => {
    counter++
    origin = join(dir, `origin-${counter}.git`)
    work = join(dir, `work-${counter}`)
    git(dir, "init", "--quiet", "--bare", "--initial-branch=main", origin)
    git(dir, "init", "--quiet", "--initial-branch=main", work)
    git(work, "remote", "add", "origin", origin)
    first = commit(work, "a.txt")
    git(work, "push", "--quiet", "origin", "main")
  })

  /** Clones origin now (at `first`), then pushes `second` to main and `feature` to a branch. */
  async function start(updater: RunnerUpdater = { self: true }): Promise<Harness> {
    const clone = join(dir, `app-${counter}`)
    git(dir, "clone", "--quiet", origin, clone)
    second = commit(work, "b.txt")
    git(work, "push", "--quiet", "origin", "main")
    git(work, "checkout", "--quiet", "-b", "feature")
    feature = commit(work, "c.txt")
    git(work, "push", "--quiet", "origin", "feature")
    git(work, "checkout", "--quiet", "main")

    const sent: Array<RunnerToHub> = []
    const calls: Array<string> = []
    const ran: Array<string> = []
    const scope = Effect.runSync(Scope.make())
    const h = {
      clone,
      sent,
      calls,
      ran,
      marker: undefined as Marker | undefined,
      failBuild: false,
      failLoad: false,
    }
    const edge: UpdaterEdge = {
      git: (args) => {
        calls.push(`git ${args.join(" ")}`)
        return runCommand("git", args, {
          cwd: clone,
          env: { ...hostEnvironment(), ...testIdentity },
        }).pipe(
          Effect.map((result) => result.stdout),
          Effect.ensuring(Effect.sync(() => void ran.push(`git ${args.join(" ")}`))),
          Effect.provide(BunServices.layer),
        )
      },
      build: Effect.suspend(() => {
        calls.push("build")
        // Only the new commit's build fails: rebuilding the old one, rolling back, works.
        if (!h.failBuild) return Effect.void
        h.failBuild = false
        return failing("bun install")
      }),
      loadCheck: Effect.suspend(() => {
        calls.push("load check")
        return h.failLoad ? failing("bun") : Effect.void
      }),
      readMarker: Effect.sync(() => h.marker),
      writeMarker: (marker) =>
        Effect.sync(() => {
          h.marker = marker
        }),
      restart: Effect.sync(() => void calls.push("restart")),
    }
    const service = await Effect.runPromise(
      makeUpdater(updater, edge).pipe(
        Scope.provide(scope),
        Effect.provideService(
          HubLink,
          HubLink.of({
            send: (message) => Effect.sync(() => void sent.push(message)),
            connect: () => Effect.void,
            disconnect: Effect.void,
          }),
        ),
        Effect.provide(Layer.succeed(References.MinimumLogLevel, "None")),
      ),
    )
    return Object.assign(h, {
      updater: service,
      close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    })
  }

  test("agrees to move to a commit on origin/main", async () => {
    const h = await start()
    await run(h.updater.handle({ _tag: "CheckUpdate", target: target(second) }))
    await eventually(() => h.sent.length === 1)

    expect(h.sent).toEqual([{ _tag: "UpdateChecked", target: target(second) }])
    await h.close()
  })

  test("refuses a commit only on another branch: not on main", async () => {
    const h = await start()
    await run(h.updater.handle({ _tag: "CheckUpdate", target: target(feature, "feature") }))
    await eventually(() => h.sent.length === 1)

    expect(h.sent[0]).toMatchObject({ _tag: "UpdateChecked", refusal: { reason: "NotOnMain" } })
    await h.close()
  })

  test("follows a commit on another branch with RUNNER_UPDATE_ANY_COMMIT=1", async () => {
    const h = await start({ self: true, anyCommit: true })
    await run(h.updater.handle({ _tag: "CheckUpdate", target: target(feature, "feature") }))
    await eventually(() => h.sent.length === 1)

    expect(h.sent[0]).toEqual({ _tag: "UpdateChecked", target: target(feature, "feature") })
    await h.close()
  })

  test("refuses a commit origin hasn't got", async () => {
    const h = await start({ self: true, anyCommit: true })
    await run(h.updater.handle({ _tag: "CheckUpdate", target: target("e".repeat(40)) }))
    await eventually(() => h.sent.length === 1)

    expect(h.sent[0]).toMatchObject({ refusal: { reason: "NotFound" } })
    await h.close()
  })

  test("git never reads a commit as an option, even one the protocol would have refused", async () => {
    const h = await start({ self: true, anyCommit: true })
    const pwned = join(dir, `pwned-${counter}`)
    // Not a CommitId: this skips the protocol's check to test the Updater's own guard.
    const hostile = { commit: `--upload-pack=touch ${pwned}` } as unknown as BuildVersion
    await run(h.updater.handle({ _tag: "CheckUpdate", target: hostile }))
    // The fetch by id, the call that would run the command, has been and gone.
    await eventually(() => h.ran.some((call) => call.startsWith("git fetch --quiet")))

    expect(existsSync(pwned)).toBe(false)
    expect(h.ran).toContain(
      `git fetch --quiet --end-of-options origin --upload-pack=touch ${pwned}`,
    )
    await h.close()
    // No reply either: UpdateChecked can't carry a target that isn't a commit id.
    expect(h.sent).toEqual([])
  })

  test("a Runner that updates by hand refuses without running git", async () => {
    const h = await start({ self: false, reason: "it runs from a developer's checkout" })
    await run(h.updater.handle({ _tag: "CheckUpdate", target: target(second) }))
    await eventually(() => h.sent.length === 1)

    expect(h.sent[0]).toMatchObject({ refusal: { reason: "Manual" } })
    expect(h.calls).toEqual([])
    await h.close()
  })

  test("moves along its branch, builds, checks it loads, and restarts", async () => {
    const h = await start()
    await run(h.updater.handle({ _tag: "ApplyUpdate", target: target(second) }))
    await eventually(() => h.calls.includes("restart"))

    expect(git(h.clone, "rev-parse", "HEAD")).toBe(second)
    // Still on main, following origin's, for a later `claude-hub update`.
    expect(git(h.clone, "symbolic-ref", "--short", "HEAD")).toBe("main")
    expect(git(h.clone, "rev-parse", "--abbrev-ref", "main@{upstream}")).toBe("origin/main")
    expect(h.calls.filter((call) => !call.startsWith("git"))).toEqual([
      "build",
      "load check",
      "restart",
    ])
    expect(h.sent).toEqual(
      (["Fetching", "CheckingOut", "Installing", "Restarting"] as const).map((step) => ({
        _tag: "UpdateProgress",
        target: target(second),
        step,
      })),
    )
    expect(h.marker).toMatchObject({
      _tag: "Applying",
      from: { commit: first, branch: "main" },
      target: target(second),
      boots: 0,
    })

    // It starts on the new commit; the Hub's welcome ends the update.
    await run(h.updater.boot)
    expect(h.marker).toMatchObject({ _tag: "Applying", boots: 1 })
    await run(h.updater.welcomed)
    expect(h.marker).toBeUndefined()
    await h.close()
  })

  test("rolls back when the build fails, reports it, and keeps running", async () => {
    const h = await start()
    h.failBuild = true
    await run(h.updater.handle({ _tag: "ApplyUpdate", target: target(second) }))
    await eventually(() => tags(h).includes("UpdateFailed"))

    expect(git(h.clone, "rev-parse", "HEAD")).toBe(first)
    expect(git(h.clone, "symbolic-ref", "--short", "HEAD")).toBe("main")
    expect(h.calls).not.toContain("restart")
    const failed = h.sent.at(-1)
    expect(failed).toMatchObject({
      _tag: "UpdateFailed",
      failure: {
        target: target(second),
        rolledBack: true,
        message: expect.stringContaining(
          "failed while installing and building: bun install exited with 1: it broke",
        ),
      },
    })
    // The next hello tells a restarted Hub, while it runs the commit it failed from.
    expect(h.marker).toMatchObject({ _tag: "Failed", from: first })
    expect((await run(h.updater.hello)).lastUpdate).toMatchObject({ target: target(second) })
    await h.close()
  })

  test("rolls back when the Runner doesn't load on the new commit", async () => {
    const h = await start()
    h.failLoad = true
    await run(h.updater.handle({ _tag: "ApplyUpdate", target: target(second) }))
    await eventually(() => tags(h).includes("UpdateFailed"))

    expect(git(h.clone, "rev-parse", "HEAD")).toBe(first)
    expect(h.sent.at(-1)).toMatchObject({
      failure: { message: expect.stringContaining("checking the Runner loads on it") },
    })
    await h.close()
  })

  test("refuses to apply a commit not on main, moving nothing", async () => {
    const h = await start()
    await run(h.updater.handle({ _tag: "ApplyUpdate", target: target(feature, "feature") }))
    await eventually(() => tags(h).includes("UpdateFailed"))

    expect(git(h.clone, "rev-parse", "HEAD")).toBe(first)
    expect(h.calls.filter((call) => call.startsWith("git checkout"))).toEqual([])
    await h.close()
  })

  test("detaches at a commit not on its branch, with RUNNER_UPDATE_ANY_COMMIT=1", async () => {
    const h = await start({ self: true, anyCommit: true })
    await run(h.updater.handle({ _tag: "ApplyUpdate", target: target(feature, "feature") }))
    await eventually(() => h.calls.includes("restart"))

    expect(git(h.clone, "rev-parse", "HEAD")).toBe(feature)
    expect(git(h.clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD")
    await h.close()
  })

  test("only restarts when the checkout is at the commit already, as on the Hub's machine", async () => {
    const h = await start()
    git(h.clone, "pull", "--quiet", "--ff-only")
    await run(h.updater.handle({ _tag: "ApplyUpdate", target: target(second) }))
    await eventually(() => h.calls.includes("restart"))

    expect(h.calls.filter((call) => !call.startsWith("git"))).toEqual(["load check", "restart"])
    expect(h.calls.filter((call) => call.startsWith("git checkout"))).toEqual([])
    expect(h.marker).toBeUndefined()
    await h.close()
  })

  test("rolls back a commit that keeps starting without the Hub's welcome", async () => {
    const h = await start()
    await run(h.updater.handle({ _tag: "ApplyUpdate", target: target(second) }))
    await eventually(() => h.calls.includes("restart"))
    h.calls.length = 0

    for (let boot = 0; boot < 3; boot++) await run(h.updater.boot)
    expect(h.calls).not.toContain("restart")
    await run(h.updater.boot)

    expect(git(h.clone, "rev-parse", "HEAD")).toBe(first)
    expect(h.calls).toContain("restart")
    expect(h.marker).toMatchObject({
      _tag: "Failed",
      from: first,
      failure: { rolledBack: true, target: target(second) },
    })
    await h.close()
  })

  test("a Runner that updates by hand never touches its checkout as it starts", async () => {
    const h = await start({ self: false, reason: "a developer's checkout" })
    h.marker = {
      _tag: "Applying",
      from: { commit: first, branch: "main" },
      target: target(second),
      boots: 9,
      at: 1,
    }
    await run(h.updater.boot)

    expect(h.calls).toEqual([])
    expect(git(h.clone, "rev-parse", "HEAD")).toBe(first)
    await h.close()
  })

  test("turned away, updates to the Hub's commit once, without the Hub", async () => {
    const h = await start()
    h.failBuild = true
    await run(h.updater.rejected(target(second)))
    expect(tags(h)).toContain("UpdateFailed")
    h.calls.length = 0

    // The same commit again: it doesn't loop on an update that failed.
    await run(h.updater.rejected(target(second)))
    expect(h.calls).toEqual([])
    await h.close()
  })
})
