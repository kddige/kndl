import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describeStep, type Step } from "./Shell.ts"
import {
  buildSteps,
  type Channel,
  channelAfter,
  channelStep,
  containsCheckoutStep,
  describeCheckout,
  gitSteps,
  latestRelease,
  localRunnerRestart,
  needsRemote,
  parseLsRemote,
  pinnedNotice,
  RefNotFound,
  releaseVersion,
  rollbackSteps,
  runnersNotice,
  updateTarget,
} from "./Update.ts"

const remote = parseLsRemote(
  [
    "1111111111111111111111111111111111111111\tHEAD",
    "1111111111111111111111111111111111111111\trefs/heads/main",
    "2222222222222222222222222222222222222222\trefs/heads/84-cli-core",
    "3333333333333333333333333333333333333333\trefs/tags/v0.1.0",
    "4444444444444444444444444444444444444444\trefs/tags/v0.1.0^{}",
  ].join("\n"),
)

const onMain = { branch: "main", commit: "1111111111111111", tag: undefined }
const pinned = { branch: undefined, commit: "3333333333333333", tag: "v0.1.0" }

const plain = { ref: undefined, channel: undefined }
const ref = (name: string) => ({ ref: name, channel: undefined })
const channel = (name: Channel) => ({ ref: undefined, channel: name })

const released = parseLsRemote(
  [
    "1111111111111111111111111111111111111111\trefs/heads/main",
    "5555555555555555555555555555555555555555\trefs/tags/v2026.9.12",
    "6666666666666666666666666666666666666666\trefs/tags/v2026.10.9",
    "7777777777777777777777777777777777777777\trefs/tags/v2026.10.10",
    "8888888888888888888888888888888888888888\trefs/tags/v2026.10.11-beta.1",
    "9999999999999999999999999999999999999999\trefs/tags/v2027.0.1",
    "3333333333333333333333333333333333333333\trefs/tags/v0.1.0",
  ].join("\n"),
)

describe("Releases", () => {
  test("a Release's tag is v<year>.<month>.<n>, and nothing else is", () => {
    expect(releaseVersion("v2026.10.1")).toEqual([2026, 10, 1])
    for (const tag of ["2026.10.1", "v2026.10.1-beta.1", "v2026.10.01", "v2026.13.1", "v0.1.0"]) {
      expect(releaseVersion(tag)).toBeUndefined()
    }
  })

  test("the latest is compared by number: 2026.10.10 > 2026.10.9 > 2026.9.12, betas ignored", () => {
    expect(latestRelease(released.tags)).toBe("v2026.10.10")
    expect(latestRelease(["v2026.9.12", "v2026.10.9"])).toBe("v2026.10.9")
    expect(latestRelease(["v2026.10.11-beta.1", "v0.1.0"])).toBeUndefined()
  })
})

describe("Channels", () => {
  test("an install with no Channel recorded follows its branch, as before Channels", () => {
    expect(updateTarget(onMain, plain, released)).toEqual({ _tag: "Branch", name: "main" })
    expect(needsRemote(onMain, plain)).toBe(false)
  })

  test("stable moves to the latest Release; dev follows main", () => {
    const onStable = { ...pinned, channel: "stable" as const }

    expect(needsRemote(onStable, plain)).toBe(true)
    expect(updateTarget(onStable, plain, released)).toEqual({
      _tag: "Release",
      name: "v2026.10.10",
    })
    expect(updateTarget(onStable, channel("dev"), released)).toEqual({
      _tag: "Branch",
      name: "main",
    })
  })

  test("stable stays when origin has no Release yet", () => {
    expect(updateTarget(onMain, channel("stable"), remote)).toEqual({ _tag: "NoRelease" })
  })

  test("--channel records the Channel, --ref clears it, and plain update keeps it", () => {
    const onStable = { ...onMain, channel: "stable" as const }

    expect(channelAfter(onMain, channel("stable"))).toBe("stable")
    expect(channelAfter(onStable, ref("main"))).toBeUndefined()
    expect(channelAfter(onStable, plain)).toBe("stable")
  })

  test("--ref and --channel together fail", () => {
    expect(updateTarget(onMain, { ref: "main", channel: "dev" }, remote)).toBeInstanceOf(
      RefNotFound,
    )
  })

  test("says where an install on stable is", () => {
    const at = { ...pinned, tag: "v2026.10.10", channel: "stable" as const }

    expect(describeCheckout(at)).toBe("333333333333, on stable at v2026.10.10")
  })
})

describe("reading origin's refs", () => {
  test("lists branches and tags, without peeled tags", () => {
    expect(remote).toEqual({ branches: ["main", "84-cli-core"], tags: ["v0.1.0"] })
  })
})

describe("where update goes", () => {
  test("plain update follows the branch the checkout is on", () => {
    expect(updateTarget(onMain, plain, remote)).toEqual({ _tag: "Branch", name: "main" })
  })

  test("plain update on a pinned checkout stays, and says how to follow main", () => {
    const target = updateTarget(pinned, plain, remote)

    expect(target).toEqual({ _tag: "Pinned", at: "v0.1.0" })
    expect(pinnedNotice({ _tag: "Pinned", at: "v0.1.0" })).toContain("kndl update --channel dev")
  })

  test("a pinned commit with no tag names the commit", () => {
    const at = { branch: undefined, commit: "abcdef0123456789abcd", tag: undefined }

    expect(updateTarget(at, plain, remote)).toEqual({ _tag: "Pinned", at: "abcdef012345" })
  })

  test("--ref <branch> follows it", () => {
    expect(updateTarget(pinned, ref("84-cli-core"), remote)).toEqual({
      _tag: "Branch",
      name: "84-cli-core",
    })
  })

  test("--ref <tag> pins to it", () => {
    expect(updateTarget(onMain, ref("v0.1.0"), remote)).toEqual({ _tag: "Tag", name: "v0.1.0" })
  })

  test("--ref <sha> pins to the commit", () => {
    expect(updateTarget(onMain, ref("ABCDEF1"), remote)).toEqual({ _tag: "Commit", sha: "abcdef1" })
  })

  test("--ref naming nothing on origin fails", () => {
    expect(updateTarget(onMain, ref("no-such-branch"), remote)).toBeInstanceOf(RefNotFound)
  })

  test("--ref that git would read as an option fails, even if origin lists it", () => {
    const listed = { branches: ["--upload-pack=touch pwned"], tags: ["-f"] }
    expect(updateTarget(onMain, ref("--upload-pack=touch pwned"), listed)).toBeInstanceOf(
      RefNotFound,
    )
    expect(updateTarget(onMain, ref("-f"), listed)).toBeInstanceOf(RefNotFound)
  })
})

const gitCommands = (target: Parameters<typeof gitSteps>[1]) =>
  gitSteps("/h/app", target).map((s) => describeStep(s))
const back = (checkout: Parameters<typeof rollbackSteps>[1]) =>
  rollbackSteps("/h/app", checkout).map((s) => describeStep(s))
const buildCommands = (roles: ReadonlyArray<"hub" | "runner">) =>
  buildSteps("/h/app", "bun", roles).map((s) => describeStep(s))

describe("the git Steps", () => {
  test("following a branch tracks origin's", () => {
    expect(gitCommands({ _tag: "Branch", name: "main" })).toEqual([
      "git fetch --prune --tags --force origin",
      "git switch --discard-changes -C main --track --end-of-options origin/main",
    ])
  })

  test("a tag or commit detaches", () => {
    expect(gitCommands({ _tag: "Tag", name: "v0.1.0" })[1]).toBe(
      "git switch --discard-changes --detach --end-of-options refs/tags/v0.1.0",
    )
    expect(gitCommands({ _tag: "Commit", sha: "abcdef1" })[1]).toBe(
      "git switch --discard-changes --detach --end-of-options abcdef1",
    )
  })

  test("going back puts a branch back at the commit, or detaches, and restores the Channel", () => {
    expect(back(onMain)).toEqual([
      "git switch --discard-changes -C main --end-of-options 1111111111111111",
      "git config --unset kndl.channel",
    ])
    expect(back({ ...pinned, channel: "stable" })).toEqual([
      "git switch --discard-changes --detach --end-of-options 3333333333333333",
      "git config kndl.channel stable",
    ])
  })

  test("run in the installed checkout", () => {
    expect(
      gitSteps("/h/app", { _tag: "Branch", name: "main" }).every((s) => s.cwd === "/h/app"),
    ).toBe(true)
  })
})

/** Runs git in `cwd`, as a test identity: its output, trimmed. Throws when it fails. */
function git(cwd: string, ...args: ReadonlyArray<string>): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

// With this machine's git, against a clone of a local origin: git before 2.43 reads checkout's
// `--end-of-options` as `--`, so what the Steps name must still be read as a commit there.
describe.skipIf(Bun.which("git") === null)("the git Steps, run by git", () => {
  const dir = mkdtempSync(join(tmpdir(), "kndl-update-"))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const origin = join(dir, "origin")
  const app = join(dir, "app")
  let first: string
  let second: string
  beforeAll(() => {
    git(dir, "init", "--quiet", "--initial-branch=main", origin)
    git(origin, "commit", "--quiet", "--allow-empty", "-m", "first")
    first = git(origin, "rev-parse", "HEAD")
    git(origin, "tag", "v0.1.0")
    git(origin, "commit", "--quiet", "--allow-empty", "-m", "second")
    second = git(origin, "rev-parse", "HEAD")
    git(dir, "clone", "--quiet", origin, app)
  })

  const run = (target: Parameters<typeof gitSteps>[1]) => {
    for (const s of gitSteps(app, target)) git(s.cwd ?? app, ...s.args)
  }
  const head = () => ({
    commit: git(app, "rev-parse", "HEAD"),
    branch: Bun.spawnSync(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: app })
      .stdout.toString()
      .trim(),
  })
  /** Runs a Step that may fail, and says whether it exited 0. */
  const succeeds = (s: Step) =>
    Bun.spawnSync([s.command, ...s.args], { cwd: s.cwd ?? app }).exitCode === 0
  const recordedChannel = () =>
    Bun.spawnSync(["git", "config", "--get", "kndl.channel"], { cwd: app }).stdout.toString().trim()

  test("pins to a tag or a commit, detached, and follows a branch again", () => {
    run({ _tag: "Tag", name: "v0.1.0" })
    expect(head()).toEqual({ commit: first, branch: "" })
    run({ _tag: "Commit", sha: second })
    expect(head()).toEqual({ commit: second, branch: "" })
    run({ _tag: "Branch", name: "main" })
    expect(head()).toEqual({ commit: second, branch: "main" })
    expect(git(app, "rev-parse", "--abbrev-ref", "main@{upstream}")).toBe("origin/main")
  })

  test("stable never moves back: a Release older than the checkout doesn't include it", () => {
    run({ _tag: "Branch", name: "main" })
    expect(succeeds(containsCheckoutStep(app, "v0.1.0"))).toBe(false)
    run({ _tag: "Release", name: "v0.1.0" })
    expect(succeeds(containsCheckoutStep(app, "v0.1.0"))).toBe(true)
  })

  test("install.sh picks the same latest Release as update", () => {
    const script = readFileSync(join(import.meta.dir, "../../../install.sh"), "utf8")
    const fn = /^latest_release\(\) \{[\s\S]*?^\}$/m.exec(script)?.[0]
    if (fn === undefined) throw new Error("install.sh has no latest_release")
    const latest = (repo: string) =>
      Bun.spawnSync(["sh", "-c", `${fn}\nlatest_release "$1"`, "sh", repo])
        .stdout.toString()
        .trim()
    const tagged = join(dir, "tagged")
    git(dir, "init", "--quiet", "--initial-branch=main", tagged)
    expect(latest(tagged)).toBe("")
    for (const tag of released.tags) {
      git(tagged, "commit", "--quiet", "--allow-empty", "-m", tag)
      git(tagged, "tag", tag)
    }

    expect(latest(tagged)).toBe("v2026.10.10")
    expect(latestRelease(released.tags)).toBe("v2026.10.10")
  })

  test("records the Channel in the checkout, and clears it", () => {
    expect(succeeds(channelStep(app, "stable"))).toBe(true)
    expect(recordedChannel()).toBe("stable")
    expect(succeeds(channelStep(app, undefined))).toBe(true)
    expect(recordedChannel()).toBe("")
    // Clearing again: git exits 5, which the Step may.
    expect(channelStep(app, undefined).mayFail).toBe(true)
    expect(recordedChannel()).toBe("")
  })
})

describe("the build Steps", () => {
  test("a Hub builds the web UI, a Runner the mod", () => {
    expect(buildCommands(["hub"])).toEqual(["bun install", "bun run web:build"])
    expect(buildCommands(["runner"])).toEqual(["bun install", "bun run mod:build"])
  })

  test("with no role set up yet, both", () => {
    expect(buildCommands([])).toEqual(["bun install", "bun run mod:build", "bun run web:build"])
  })
})

describe("describing the checkout", () => {
  test("following a branch, or pinned", () => {
    expect(describeCheckout(onMain)).toBe("111111111111, following main")
    expect(describeCheckout(pinned)).toBe("333333333333, pinned at v0.1.0")
  })
})

describe("restarting the Runner on this machine", () => {
  const facts = {
    installed: true,
    hubRestarts: true,
    serviceFileChanged: false,
    updatesItself: true,
  }

  test("a Runner that updates itself, beside the Hub, is drained by the Hub", () => {
    expect(localRunnerRestart(facts)).toBe("Hub")
  })

  test("otherwise its service restarts at once, as before", () => {
    // No Hub here: a Runner's machine, updated by hand.
    expect(localRunnerRestart({ ...facts, hubRestarts: false })).toBe("Service")
    // Too old to update itself, or the Hub doesn't know it.
    expect(localRunnerRestart({ ...facts, updatesItself: false })).toBe("Service")
    // Only reinstalling the service loads its new file.
    expect(localRunnerRestart({ ...facts, serviceFileChanged: true })).toBe("Service")
  })

  test("no Runner service, nothing to restart", () => {
    expect(localRunnerRestart({ ...facts, installed: false })).toBe("None")
  })
})

describe("what update says of the Runners", () => {
  const commit = "abcdef0123456789abcdef0123456789abcdef01"

  test("the Hub asks every Runner, and the one here follows by the Hub", () => {
    const lines = runnersNotice({
      commit,
      updateRunners: true,
      now: false,
      local: "Hub",
      localName: "studio",
    })
    expect(lines[0]).toContain("asks its Runners to follow abcdef012345")
    expect(lines[0]).toContain("letting running Turns end first")
    expect(lines[1]).toContain("studio, on this machine, follows")
  })

  test("--no-update-runners leaves the others; --now stops Turns", () => {
    const lines = runnersNotice({
      commit,
      updateRunners: false,
      now: true,
      local: "Service",
      localName: undefined,
    })
    expect(lines[0]).toContain("--no-update-runners")
    expect(lines[1]).toBe(
      "The Runner here, on this machine, restarts now, under any Sessions it runs.",
    )
  })

  test("no Runner here, nothing said of one", () => {
    expect(
      runnersNotice({
        commit,
        updateRunners: true,
        now: false,
        local: "None",
        localName: undefined,
      }),
    ).toHaveLength(1)
  })
})
