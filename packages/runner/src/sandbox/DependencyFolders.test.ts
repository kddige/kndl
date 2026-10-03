import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { matchDependencyFolders } from "./DependencyFolders.ts"

let root = ""
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "claude-hub-deps-"))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const file = async (path: string) => {
  await mkdir(join(root, path, ".."), { recursive: true })
  await writeFile(join(root, path), "")
}

const defaults = [
  { pattern: "**/node_modules", nextTo: "package.json" },
  { pattern: "**/.venv", nextTo: "pyproject.toml" },
  { pattern: "**/target", nextTo: "Cargo.toml" },
]

describe("dependency folders", () => {
  test("match next to their files on a fresh clone, and where they already are", async () => {
    await file("package.json")
    await file("packages/web/package.json")
    await file("tools/py/pyproject.toml")
    await mkdir(join(root, "crates/x/target"), { recursive: true })
    await file("README.md")

    expect(await Effect.runPromise(matchDependencyFolders(root, defaults))).toEqual([
      "crates/x/target",
      "node_modules",
      "packages/web/node_modules",
      "tools/py/.venv",
    ])
  })

  test("don't look inside a match, .git or symlinks", async () => {
    await file("package.json")
    await file("node_modules/left-pad/package.json")
    await file(".git/package.json")
    await mkdir(join(root, "elsewhere"))
    await file("elsewhere/inner/package.json")
    await symlink(join(root, "elsewhere"), join(root, "link"))

    expect(await Effect.runPromise(matchDependencyFolders(root, defaults))).toEqual([
      "elsewhere/inner/node_modules",
      "node_modules",
    ])
  })

  test("a pattern without a next-to file matches only folders that exist", async () => {
    await file("app/Gemfile")
    await mkdir(join(root, "app/vendor/bundle"), { recursive: true })
    await mkdir(join(root, "other/vendor"), { recursive: true })

    expect(
      await Effect.runPromise(matchDependencyFolders(root, [{ pattern: "*/vendor/bundle" }])),
    ).toEqual(["app/vendor/bundle"])
  })

  test("nothing to match in a missing directory", async () => {
    expect(await Effect.runPromise(matchDependencyFolders(join(root, "gone"), defaults))).toEqual(
      [],
    )
  })
})
