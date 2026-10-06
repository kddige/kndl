import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { ensureSandboxClaude, linuxPackage, sandboxClaudePath } from "./SandboxClaude.ts"

let dir = ""
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kndl-sandbox-claude-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A package tarball laid out like npm's, holding `package/claude`. */
const tarball = async () => {
  const source = join(dir, "source")
  await mkdir(join(source, "package"), { recursive: true })
  await writeFile(join(source, "package", "claude"), "#!/bin/sh\necho linux claude\n")
  await writeFile(join(source, "package", "package.json"), "{}")
  const tar = Bun.spawn(["tar", "-czf", "out.tgz", "package"], { cwd: source })
  expect(await tar.exited).toBe(0)
  const bytes = new Uint8Array(await readFile(join(source, "out.tgz")))
  return { bytes, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` }
}

/** A registry serving one package version, counting what it is asked for. */
const registry = (bytes: Uint8Array, integrity: string) => {
  const requests: Array<string> = []
  const fetch = async (url: string) => {
    requests.push(url)
    if (
      url === "https://registry.test/@anthropic-ai/claude-code-linux-arm64-musl/2.1.287" ||
      url === "https://registry.test/@anthropic-ai/claude-code-linux-arm64/2.1.287"
    )
      return Response.json({ dist: { tarball: "https://registry.test/claude.tgz", integrity } })
    if (url === "https://registry.test/claude.tgz") return new Response(bytes)
    return new Response("not found", { status: 404 })
  }
  return { fetch, requests }
}

describe("the Sandbox's Claude Code", () => {
  test("is downloaded once per version, checked, and kept executable", async () => {
    const { bytes, integrity } = await tarball()
    const { fetch, requests } = registry(bytes, integrity)
    const cacheDir = join(dir, "cache")
    const options = {
      cacheDir,
      version: "2.1.287",
      arch: "arm64",
      registry: "https://registry.test",
      fetch,
    }

    const binary = await Effect.runPromise(ensureSandboxClaude(options))
    expect(binary).toBe(join(cacheDir, "2.1.287", "claude"))
    expect(await readFile(binary, "utf8")).toContain("linux claude")
    expect((await stat(binary)).mode & 0o777).toBe(0o755)
    expect(await readdir(join(cacheDir, "2.1.287"))).toEqual(["claude"])

    expect(await Effect.runPromise(ensureSandboxClaude(options))).toBe(binary)
    expect(requests.length).toBe(2)
  })

  test("keeps the glibc build beside the musl one, each in its own directory", async () => {
    const { bytes, integrity } = await tarball()
    const { fetch, requests } = registry(bytes, integrity)
    const cacheDir = join(dir, "cache")
    const options = {
      cacheDir,
      version: "2.1.287",
      arch: "arm64",
      registry: "https://registry.test",
      fetch,
    }

    const musl = await Effect.runPromise(ensureSandboxClaude(options))
    const glibc = await Effect.runPromise(ensureSandboxClaude({ ...options, libc: "glibc" }))
    expect(glibc).toBe(join(cacheDir, "2.1.287-glibc", "claude"))
    expect(musl).toBe(join(cacheDir, "2.1.287", "claude"))
    expect(requests).toContain(
      "https://registry.test/@anthropic-ai/claude-code-linux-arm64/2.1.287",
    )
    expect(sandboxClaudePath("2.1.287", "glibc")).toBe("/opt/kndl/claude-code/2.1.287-glibc/claude")
  })

  test("refuses a download that fails its integrity check, leaving nothing behind", async () => {
    const { bytes } = await tarball()
    const { fetch } = registry(bytes, `sha512-${Buffer.alloc(64).toString("base64")}`)
    const cacheDir = join(dir, "cache")
    const error = await Effect.runPromise(
      Effect.flip(
        ensureSandboxClaude({
          cacheDir,
          version: "2.1.287",
          arch: "arm64",
          registry: "https://registry.test",
          fetch,
        }),
      ),
    )
    expect(error.message).toContain("integrity")
    expect(await readdir(cacheDir).catch(() => [])).toEqual([])
  })

  test("refuses versions that aren't versions", async () => {
    const error = await Effect.runPromise(
      Effect.flip(ensureSandboxClaude({ cacheDir: dir, version: "../../etc" })),
    )
    expect(error.message).toContain("not a version")
  })

  test("names the package for its CPU", () => {
    expect(linuxPackage("arm64")).toBe("@anthropic-ai/claude-code-linux-arm64-musl")
    expect(linuxPackage("x64")).toBe("@anthropic-ai/claude-code-linux-x64-musl")
    expect(linuxPackage("ia32")).toBeUndefined()
    expect(linuxPackage("x64", "glibc")).toBe("@anthropic-ai/claude-code-linux-x64")
    expect(sandboxClaudePath("2.1.287")).toBe("/opt/kndl/claude-code/2.1.287/claude")
  })
})
