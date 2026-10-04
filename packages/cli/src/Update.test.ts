import { describe, expect, test } from "bun:test"
import { describeStep } from "./Shell.ts"
import {
  buildSteps,
  describeCheckout,
  gitSteps,
  parseLsRemote,
  pinnedNotice,
  RefNotFound,
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
})

const gitCommands = (target: Parameters<typeof gitSteps>[1]) =>
  gitSteps("/h/app", target).map((s) => describeStep(s))
const buildCommands = (roles: ReadonlyArray<"hub" | "runner">) =>
  buildSteps("/h/app", "bun", roles).map((s) => describeStep(s))

describe("the git Steps", () => {
  test("following a branch tracks origin's", () => {
    expect(gitCommands({ _tag: "Branch", name: "main" })).toEqual([
      "git fetch --prune --tags --force origin",
      "git checkout --force -B main --track origin/main",
    ])
  })

  test("a tag or commit detaches", () => {
    expect(gitCommands({ _tag: "Tag", name: "v0.1.0" })[1]).toBe(
      "git checkout --force --detach refs/tags/v0.1.0",
    )
    expect(gitCommands({ _tag: "Commit", sha: "abcdef1" })[1]).toBe(
      "git checkout --force --detach abcdef1",
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
