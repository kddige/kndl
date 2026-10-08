import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import type { PluginPackageFrom } from "@kndl/protocol"
import { Effect, Layer } from "effect"
import { PluginSources, type PluginSourcesOptions } from "./PluginSources.ts"
import { manifest, packageJson, pluginRepo, removePluginRepos } from "./testPluginRepo.ts"

afterAll(removePluginRepos)

const testOptions: Partial<PluginSourcesOptions> = { protocols: ["https", "file"] }

const reading = (from: PluginPackageFrom, options: Partial<PluginSourcesOptions> = testOptions) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* PluginSources).read(from)
    }).pipe(Effect.result, Effect.provide(Layer.fresh(PluginSources.layerWith(options)))),
  )

const read = async (from: PluginPackageFrom, options?: Partial<PluginSourcesOptions>) => {
  const result = await reading(from, options)
  if (result._tag === "Failure") throw new Error(result.failure.message)
  return result.success
}

const refusal = async (from: PluginPackageFrom, options?: Partial<PluginSourcesOptions>) => {
  const result = await reading(from, options)
  if (result._tag === "Success") throw new Error("expected a refusal")
  return result.failure.message
}

describe("a package from git", () => {
  test("is read at the default branch, pinned to its commit", async () => {
    const repo = pluginRepo({ "package.json": packageJson("1.0.0"), "kndl.json": manifest() })
    expect(await read({ _tag: "Git", url: repo.url })).toEqual({
      id: "@acme/linear-mcp" as never,
      name: "Linear",
      url: "https://mcp.linear.app/mcp",
      auth: { _tag: "None" },
      package: { version: "1.0.0", commit: repo.first, source: { _tag: "Git", url: repo.url } },
    })
  })

  test("is read at a tag, a branch or a commit, in a subfolder", async () => {
    const repo = pluginRepo({
      "packages/linear/package.json": packageJson("1.0.0"),
      "packages/linear/kndl.json": manifest(),
    })
    repo.tag("v1.0.0")
    const second = repo.commit(
      {
        "packages/linear/package.json": packageJson("2.0.0"),
        "packages/linear/kndl.json": manifest("https://mcp.linear.app/v2"),
      },
      "Second",
    )
    const at = (ref: string) =>
      read({ _tag: "Git", url: repo.url, ref, path: "./packages/linear/" })
    const tagged = await at("v1.0.0")
    expect([tagged.package.version, tagged.package.commit, tagged.url]).toEqual([
      "1.0.0",
      repo.first,
      "https://mcp.linear.app/mcp",
    ])
    expect(tagged.package.source).toEqual({
      _tag: "Git",
      url: repo.url,
      ref: "v1.0.0",
      path: "packages/linear",
    })
    expect((await at("main")).package.commit).toBe(second)
    expect((await at(repo.first)).package.version).toBe("1.0.0")
  })

  test("is refused a ref the repo doesn't have, saying so", async () => {
    const repo = pluginRepo({ "package.json": packageJson("1.0.0"), "kndl.json": manifest() })
    expect(await refusal({ _tag: "Git", url: repo.url, ref: "v9" })).toStartWith(
      `git couldn't fetch v9 from ${repo.url}:`,
    )
  })

  test("is refused without its files, or with a symlink for one", async () => {
    const missing = pluginRepo({ "package.json": packageJson("1.0.0") })
    expect(await refusal({ _tag: "Git", url: missing.url })).toBe(
      "The repo has no kndl.json at its root at that ref.",
    )
    const nested = pluginRepo({ "a/package.json": packageJson("1.0.0"), "a/kndl.json": manifest() })
    expect(await refusal({ _tag: "Git", url: nested.url, path: "b" })).toBe(
      "The repo has no package.json in b/ at that ref.",
    )
    const linked = pluginRepo({
      "package.json": packageJson("1.0.0"),
      "kndl.json": { symlink: "/etc/hosts" },
    })
    expect(await refusal({ _tag: "Git", url: linked.url })).toBe(
      "The repo's kndl.json is a symlink, not a file.",
    )
  })

  test("is refused a manifest that breaks the format, naming the field", async () => {
    const repo = pluginRepo({ "package.json": packageJson("1.0.0"), "kndl.json": "{}" })
    expect(await refusal({ _tag: "Git", url: repo.url })).toBe(
      "kndl.json: displayName is missing.\nkndl.json: mcp is missing.",
    )
  })

  test("is refused a repo over the size limit, or one that takes too long", async () => {
    const repo = pluginRepo({
      "package.json": packageJson("1.0.0"),
      "kndl.json": manifest(),
      "noise.bin": crypto.getRandomValues(new Uint8Array(60_000)).toString(),
    })
    expect(
      await refusal({ _tag: "Git", url: repo.url }, { ...testOptions, maxBytes: 50_000 }),
    ).toBe("The repo is larger than 0.05 MB at that ref; the Hub fetches at most that.")
    expect(await refusal({ _tag: "Git", url: repo.url }, { ...testOptions, timeoutMs: 1 })).toBe(
      "Fetching the repo took longer than 0.001 s.",
    )
  })

  test("is fetched only over https://, at a plain ref, inside the repo", async () => {
    const repo = pluginRepo({ "package.json": packageJson("1.0.0"), "kndl.json": manifest() })
    expect(await refusal({ _tag: "Git", url: repo.url }, {})).toBe(
      "The git URL must start with https://.",
    )
    expect(await refusal({ _tag: "Git", url: repo.url, ref: "--upload-pack=touch /tmp/x" })).toBe(
      "--upload-pack=touch /tmp/x isn't a branch, tag or commit.",
    )
    expect(await refusal({ _tag: "Git", url: repo.url, path: "../.." })).toBe(
      "../.. isn't a folder inside the repo, such as packages/linear.",
    )
  })
})

describe("an uploaded package", () => {
  test("is read from its folder's two files, named by the folder", async () => {
    expect(
      (
        await read({
          _tag: "Folder",
          folderName: "linear-mcp",
          packageJson: packageJson("1.0.0"),
          manifest: manifest(),
        })
      ).package,
    ).toEqual({ version: "1.0.0", source: { _tag: "Upload", fileName: "linear-mcp" } })
  })

  test("is read from an archive, named by its file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kndl-plugin-archive-"))
    afterAll(() => rmSync(dir, { recursive: true, force: true }))
    mkdirSync(join(dir, "package"))
    writeFileSync(join(dir, "package", "package.json"), packageJson("1.0.0"))
    writeFileSync(join(dir, "package", "kndl.json"), manifest())
    const tar = Bun.spawnSync(["tar", "-cf", "-", "package"], { cwd: dir }).stdout
    expect(
      (
        await read({
          _tag: "Archive",
          fileName: "C:\\fakepath\\linear-mcp-1.0.0.tgz",
          data: gzipSync(tar).toString("base64"),
        })
      ).package,
    ).toEqual({ version: "1.0.0", source: { _tag: "Upload", fileName: "linear-mcp-1.0.0.tgz" } })
    expect(await refusal({ _tag: "Archive", fileName: "x.tgz", data: "aGVsbG8=" })).toBe(
      "That isn't a .tgz or .zip archive, such as npm pack or GitHub's Download ZIP makes.",
    )
  })
})
