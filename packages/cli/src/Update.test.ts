import { describe, expect, test } from "bun:test"
import { describeStep } from "./Shell.ts"
import {
  buildSteps,
  describeCheckout,
  gitSteps,
  localRunnerRestart,
  parseLsRemote,
  pinnedNotice,
  RefNotFound,
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

describe("reading origin's refs", () => {
  test("lists branches and tags, without peeled tags", () => {
    expect(remote).toEqual({ branches: ["main", "84-cli-core"], tags: ["v0.1.0"] })
  })
})

describe("where update goes", () => {
  test("plain update follows the branch the checkout is on", () => {
    expect(updateTarget(onMain, undefined, remote)).toEqual({ _tag: "Branch", name: "main" })
  })

  test("plain update on a pinned checkout stays, and says how to follow main", () => {
    const target = updateTarget(pinned, undefined, remote)

    expect(target).toEqual({ _tag: "Pinned", at: "v0.1.0" })
    expect(pinnedNotice({ _tag: "Pinned", at: "v0.1.0" })).toContain("claude-hub update --ref main")
  })

  test("a pinned commit with no tag names the commit", () => {
    const at = { branch: undefined, commit: "abcdef0123456789abcd", tag: undefined }

    expect(updateTarget(at, undefined, remote)).toEqual({ _tag: "Pinned", at: "abcdef012345" })
  })

  test("--ref <branch> follows it", () => {
    expect(updateTarget(pinned, "84-cli-core", remote)).toEqual({
      _tag: "Branch",
      name: "84-cli-core",
    })
  })

  test("--ref <tag> pins to it", () => {
    expect(updateTarget(onMain, "v0.1.0", remote)).toEqual({ _tag: "Tag", name: "v0.1.0" })
  })

  test("--ref <sha> pins to the commit", () => {
    expect(updateTarget(onMain, "ABCDEF1", remote)).toEqual({ _tag: "Commit", sha: "abcdef1" })
  })

  test("--ref naming nothing on origin fails", () => {
    expect(updateTarget(onMain, "no-such-branch", remote)).toBeInstanceOf(RefNotFound)
  })

  test("--ref that git would read as an option fails, even if origin lists it", () => {
    const listed = { branches: ["--upload-pack=touch pwned"], tags: ["-f"] }
    expect(updateTarget(onMain, "--upload-pack=touch pwned", listed)).toBeInstanceOf(RefNotFound)
    expect(updateTarget(onMain, "-f", listed)).toBeInstanceOf(RefNotFound)
  })
})

const gitCommands = (target: Parameters<typeof gitSteps>[1]) =>
  gitSteps("/h/app", target).map((s) => describeStep(s))
const buildCommands = (roles: ReadonlyArray<"hub" | "runner">) =>
  buildSteps("/h/app", "bun", roles).map((s) => describeStep(s))

describe("the git Steps", () => {
  test("following a branch tracks origin's", () => {
    expect(gitCommands({ _tag: "Branch", name: "main" })).toEqual([
      "git fetch --prune --tags --force origin",
      "git checkout --force -B main --track --end-of-options origin/main",
    ])
  })

  test("a tag or commit detaches", () => {
    expect(gitCommands({ _tag: "Tag", name: "v0.1.0" })[1]).toBe(
      "git checkout --force --detach --end-of-options refs/tags/v0.1.0",
    )
    expect(gitCommands({ _tag: "Commit", sha: "abcdef1" })[1]).toBe(
      "git checkout --force --detach --end-of-options abcdef1",
    )
  })

  test("run in the installed checkout", () => {
    expect(
      gitSteps("/h/app", { _tag: "Branch", name: "main" }).every((s) => s.cwd === "/h/app"),
    ).toBe(true)
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
