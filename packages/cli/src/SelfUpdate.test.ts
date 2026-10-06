import { afterEach, describe, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { chmod, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  commit,
  fakeBinary,
  fakeBuilds,
  removeTempDirs,
  tempDir,
} from "@claude-hub/hub/src/cliTestSupport.ts"
import { startHub, stopHubs } from "@claude-hub/hub/src/testSupport.ts"
import { Effect, Exit } from "effect"
import type { Build } from "./BuildInfo.ts"
import { cliConfigPath, readCliConfig } from "./CliConfig.ts"
import { hubCommit, planSelfUpdate, replaceBinary, updateTo } from "./SelfUpdate.ts"

afterEach(async () => {
  await stopHubs()
  await removeTempDirs()
})

const built: Build = { commit: "a".repeat(40), target: "linux-x64" }
const hub = "https://hub.example.com"

describe("whether the CLI asks its Hub for an update", () => {
  test("a binary the Hub built, with a Hub recorded, asks it", () => {
    expect(planSelfUpdate({ build: built, env: {}, config: { hub } })).toEqual({
      _tag: "Check",
      hub,
      build: built,
    })
  })

  test("never from a checkout, as an install's command runs: the checkout updates with it", () => {
    expect(planSelfUpdate({ build: undefined, env: {}, config: { hub } })).toEqual({
      _tag: "Skip",
      reason: "It runs from a checkout, which `claude-hub update` updates.",
    })
  })

  test("never with CLAUDE_HUB_NO_SELF_UPDATE set", () => {
    const env = { CLAUDE_HUB_NO_SELF_UPDATE: "1" }
    expect(planSelfUpdate({ build: built, env, config: { hub } })._tag).toBe("Skip")
    // Set empty, it isn't set.
    const empty = { CLAUDE_HUB_NO_SELF_UPDATE: "" }
    expect(planSelfUpdate({ build: built, env: empty, config: { hub } })._tag).toBe("Check")
  })

  test("not again in the run it started after updating", () => {
    const env = { CLAUDE_HUB_UPDATED_TO: "b".repeat(40) }
    expect(planSelfUpdate({ build: built, env, config: { hub } })._tag).toBe("Skip")
  })

  test("not without a Hub recorded", () => {
    expect(planSelfUpdate({ build: built, env: {}, config: {} })).toEqual({
      _tag: "Skip",
      reason: "No Hub is recorded to update from.",
    })
  })

  test("updates only to a commit the Hub says, and only when it is another", () => {
    expect(updateTo(built, "b".repeat(40))).toBe("b".repeat(40))
    expect(updateTo(built, built.commit)).toBeUndefined()
    expect(updateTo(built, undefined)).toBeUndefined()
  })
})

describe("the CLI's config", () => {
  test("is cli.json in XDG_CONFIG_HOME, or ~/.config", () => {
    expect(cliConfigPath({}, "/home/ada")).toBe("/home/ada/.config/claude-hub/cli.json")
    expect(cliConfigPath({ XDG_CONFIG_HOME: "/xdg" }, "/home/ada")).toBe("/xdg/claude-hub/cli.json")
  })

  test("reads the Hub the install script recorded, and nothing from a file it can't read", async () => {
    const dir = await tempDir("cli-config-")
    const path = join(dir, "cli.json")
    expect(readCliConfig(path)).toEqual({})
    await writeFile(path, `{"hub":"${hub}"}\n`)
    expect(readCliConfig(path)).toEqual({ hub })
    await writeFile(path, "not json")
    expect(readCliConfig(path)).toEqual({})
    await writeFile(path, `{"hub":7}`)
    expect(readCliConfig(path)).toEqual({})
  })
})

describe("asking the Hub", () => {
  test("says the Hub's commit", async () => {
    const at = await startHub({ cliBuilds: fakeBuilds({ dir: await tempDir("cli-") }).layer })
    expect(await Effect.runPromise(hubCommit(at.url))).toBe(commit)
  })

  test("says nothing when the Hub has no commit, or doesn't answer", async () => {
    const at = await startHub()
    expect(await Effect.runPromise(hubCommit(at.url))).toBeUndefined()
    // Nothing listens on port 9 (discard) here.
    expect(await Effect.runPromise(hubCommit("http://127.0.0.1:9", 500))).toBeUndefined()
  })
})

/** A CLI at the old commit, at `<dir>/bin/claude-hub`. */
async function installed() {
  const dir = await tempDir("cli-exe-")
  await mkdir(join(dir, "bin"))
  const exe = join(dir, "bin", "claude-hub")
  await writeFile(exe, fakeBinary("linux-x64", built.commit))
  await chmod(exe, 0o755)
  return { dir, exe }
}

describe("replacing the binary", () => {
  test("puts the Hub's binary in its place, and leaves nothing beside it", async () => {
    const builds = fakeBuilds({ dir: await tempDir("cli-") })
    const at = await startHub({ cliBuilds: builds.layer })
    const { exe } = await installed()
    const result = await Effect.runPromise(
      replaceBinary({ hub: at.url, target: "linux-x64", commit, exe }),
    )
    expect(result).toBe(realpathSync(exe))
    expect(await readFile(exe, "utf8")).toBe(fakeBinary("linux-x64", commit))
    expect((await stat(exe)).mode & 0o777).toBe(0o755)
    expect(await readdir(join(exe, ".."))).toEqual(["claude-hub"])
  })

  test("replaces the file a symlink points to, keeping the link", async () => {
    const at = await startHub({ cliBuilds: fakeBuilds({ dir: await tempDir("cli-") }).layer })
    const { dir, exe } = await installed()
    const link = join(dir, "claude-hub-link")
    await symlink(exe, link)
    await Effect.runPromise(replaceBinary({ hub: at.url, target: "linux-x64", commit, exe: link }))
    expect(await readFile(exe, "utf8")).toBe(fakeBinary("linux-x64", commit))
  })

  test("keeps the binary it has when the Hub serves another commit than it said", async () => {
    const at = await startHub({ cliBuilds: fakeBuilds({ dir: await tempDir("cli-") }).layer })
    const { exe } = await installed()
    const other = "b".repeat(40)
    const exit = await Effect.runPromiseExit(
      replaceBinary({ hub: at.url, target: "linux-x64", commit: other, exe }),
    )
    expect(exit).toEqual(Exit.fail(`the Hub sent the CLI at ${commit}, not ${other}`))
    expect(await readFile(exe, "utf8")).toBe(fakeBinary("linux-x64", built.commit))
    expect(await readdir(join(exe, ".."))).toEqual(["claude-hub"])
  })

  test("keeps the binary it has when the Hub can't serve one", async () => {
    const builds = fakeBuilds({ dir: await tempDir("cli-"), fail: "no network" })
    const at = await startHub({ cliBuilds: builds.layer })
    const { exe } = await installed()
    const exit = await Effect.runPromiseExit(
      replaceBinary({ hub: at.url, target: "linux-x64", commit, exe }),
    )
    expect(exit).toEqual(
      Exit.fail(
        "the Hub answered 500: The Hub couldn't build the claude-hub CLI for linux-x64: no network",
      ),
    )
    expect(await readFile(exe, "utf8")).toBe(fakeBinary("linux-x64", built.commit))
  })
})
