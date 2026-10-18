import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import {
  ensurePiBundle,
  type NodeBuild,
  piCliInInstall,
  piPackageDir,
  PinnedNodeBuilds,
  PinnedNodeVersion,
  PinnedPiVersion,
  type RunCommand,
  sandboxNodePath,
  sandboxPiCliPath,
} from "./SandboxPi.ts"

let dir = ""
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kndl-sandbox-pi-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A Node.js release tarball, laid out as nodejs.org's, named `name`. */
const nodeTarball = async (name: string) => {
  const source = join(dir, "source", name)
  await mkdir(join(source, name, "bin"), { recursive: true })
  await writeFile(join(source, name, "bin", "node"), `#!/bin/sh\necho ${name}\n`)
  await writeFile(join(source, name, "README.md"), "node")
  const tar = Bun.spawn(["tar", "-czf", "out.tgz", name], { cwd: source })
  expect(await tar.exited).toBe(0)
  const bytes = new Uint8Array(await readFile(join(source, "out.tgz")))
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") }
}

/** Builds of both libcs for arm64, served by `fetch`, which counts what it is asked for. */
const nodeReleases = async () => {
  const musl = await nodeTarball("node-v24.0.0-linux-arm64-musl")
  const glibc = await nodeTarball("node-v24.0.0-linux-arm64")
  const builds: Record<string, NodeBuild> = {
    "arm64-musl": {
      url: "https://unofficial.test/v24.0.0/node-v24.0.0-linux-arm64-musl.tar.gz",
      sha256: musl.sha256,
    },
    "arm64-glibc": {
      url: "https://nodejs.test/v24.0.0/node-v24.0.0-linux-arm64.tar.gz",
      sha256: glibc.sha256,
    },
  }
  const requests: Array<string> = []
  const fetch = async (url: string) => {
    requests.push(url)
    if (url === builds["arm64-musl"]?.url) return new Response(musl.bytes)
    if (url === builds["arm64-glibc"]?.url) return new Response(glibc.bytes)
    return new Response("not found", { status: 404 })
  }
  return { builds, fetch, requests }
}

/**
 * Runs `tar` for real, and stands in for `bun install`: lays pi's package and CLI out as an
 * install would, at `version`, or fails with `failure`.
 */
const host = (options: { version?: string; failure?: string } = {}) => {
  const installs: Array<{ argv: ReadonlyArray<string>; files: Array<string> }> = []
  const run: RunCommand = async (argv, cwd) => {
    if (argv[0] === "tar") {
      const child = Bun.spawn([...argv], { cwd, stderr: "pipe" })
      return { exitCode: await child.exited, stderr: await new Response(child.stderr).text() }
    }
    installs.push({ argv, files: (await readdir(cwd)).toSorted() })
    if (options.failure !== undefined) return { exitCode: 1, stderr: options.failure }
    const pkg = join(cwd, "node_modules/@earendil-works/pi-coding-agent")
    await mkdir(join(cwd, piCliInInstall, ".."), { recursive: true })
    await writeFile(join(cwd, piCliInInstall), "#!/usr/bin/env node\n")
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({ version: options.version ?? PinnedPiVersion }),
    )
    return { exitCode: 0, stderr: "" }
  }
  return { run, installs }
}

describe("the Sandbox's pi", () => {
  test("pins an LTS Node.js, glibc builds from nodejs.org and musl ones from unofficial-builds", () => {
    expect(Number(PinnedNodeVersion.split(".")[0]) % 2).toBe(0)
    expect(Object.keys(PinnedNodeBuilds).toSorted()).toEqual([
      "arm64-glibc",
      "arm64-musl",
      "x64-glibc",
      "x64-musl",
    ])
    const v = PinnedNodeVersion
    expect(PinnedNodeBuilds["arm64-glibc"]?.url).toBe(
      `https://nodejs.org/dist/v${v}/node-v${v}-linux-arm64.tar.gz`,
    )
    expect(PinnedNodeBuilds["x64-musl"]?.url).toBe(
      `https://unofficial-builds.nodejs.org/download/release/v${v}/node-v${v}-linux-x64-musl.tar.gz`,
    )
    for (const build of Object.values(PinnedNodeBuilds))
      expect(build.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  test("pins pi exactly, in the committed package.json and its lockfile", async () => {
    const manifest = JSON.parse(await readFile(join(piPackageDir, "package.json"), "utf8"))
    expect(manifest.dependencies).toEqual({ "@earendil-works/pi-coding-agent": PinnedPiVersion })
    const lockfile = await readFile(join(piPackageDir, "bun.lock"), "utf8")
    expect(lockfile).toContain(`"@earendil-works/pi-coding-agent@${PinnedPiVersion}"`)
  })

  test("says where Node.js and pi are in the Sandbox", () => {
    expect(sandboxNodePath("musl")).toBe(`/opt/kndl/pi/node-v${PinnedNodeVersion}-musl/bin/node`)
    expect(sandboxPiCliPath("pi-1.3.0-abc")).toBe(
      "/opt/kndl/pi/pi-1.3.0-abc/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    )
  })

  test("gets Node.js for each libc, checked, and installs pi from the lockfile, once", async () => {
    const { builds, fetch, requests } = await nodeReleases()
    const { run, installs } = host()
    const cacheDir = join(dir, "cache")
    const options = {
      cacheDir,
      arch: "arm64",
      nodeVersion: "24.0.0",
      nodeBuilds: builds,
      fetch,
      run,
    }

    const ready = await Effect.runPromise(ensurePiBundle({ ...options, bun: "/usr/bin/bun" }))
    expect(ready.appDir).toMatch(new RegExp(`^pi-${PinnedPiVersion}-[0-9a-f]{12}$`))
    expect(requests.toSorted()).toEqual([
      "https://nodejs.test/v24.0.0/node-v24.0.0-linux-arm64.tar.gz",
      "https://unofficial.test/v24.0.0/node-v24.0.0-linux-arm64-musl.tar.gz",
    ])

    // Only Node.js's executable is kept, runnable by anyone in the Sandbox.
    const musl = join(cacheDir, "node-v24.0.0-musl", "bin", "node")
    expect(await readFile(musl, "utf8")).toContain("node-v24.0.0-linux-arm64-musl")
    expect((await stat(musl)).mode & 0o777).toBe(0o755)
    expect(await readdir(join(cacheDir, "node-v24.0.0-musl"))).toEqual(["bin"])
    const glibc = join(cacheDir, "node-v24.0.0-glibc", "bin", "node")
    expect(await readFile(glibc, "utf8")).toContain("node-v24.0.0-linux-arm64\n")

    // Exactly what the lockfile says, without install scripts, from the committed files.
    expect(installs).toEqual([
      {
        argv: ["/usr/bin/bun", "install", "--frozen-lockfile", "--ignore-scripts"],
        files: ["bun.lock", "package.json"],
      },
    ])
    expect(await readFile(join(cacheDir, ready.appDir, "bun.lock"), "utf8")).toBe(
      await readFile(join(piPackageDir, "bun.lock"), "utf8"),
    )
    expect(await stat(join(cacheDir, ready.appDir, piCliInInstall))).toBeTruthy()
    // Nothing left of the work.
    expect((await readdir(cacheDir)).toSorted()).toEqual(
      [ready.appDir, "node-v24.0.0-glibc", "node-v24.0.0-musl"].toSorted(),
    )

    // The cache is used as it is from then on.
    expect(await Effect.runPromise(ensurePiBundle(options))).toEqual(ready)
    expect(requests).toHaveLength(2)
    expect(installs).toHaveLength(1)
  })

  test("refuses a Node.js build that fails its checksum, keeping nothing of it", async () => {
    const { builds, fetch } = await nodeReleases()
    const cacheDir = join(dir, "cache")
    const tampered = {
      ...builds,
      "arm64-musl": { url: builds["arm64-musl"]?.url ?? "", sha256: "0".repeat(64) },
    }

    const failure = await Effect.runPromise(
      Effect.flip(
        ensurePiBundle({
          cacheDir,
          arch: "arm64",
          libcs: ["musl"],
          nodeVersion: "24.0.0",
          nodeBuilds: tampered,
          fetch,
          run: host().run,
        }),
      ),
    )
    expect(failure.message).toContain("failed its checksum")
    expect((await readdir(cacheDir)).filter((name) => name.startsWith("node"))).toEqual([])
  })

  test("fails for a CPU Node.js has no build for", async () => {
    const { builds, fetch } = await nodeReleases()
    const failure = await Effect.runPromise(
      Effect.flip(
        ensurePiBundle({
          cacheDir: join(dir, "cache"),
          arch: "ppc64",
          nodeBuilds: builds,
          fetch,
          run: host().run,
        }),
      ),
    )
    expect(failure.message).toMatch(/no (musl|glibc) build of Node.js for ppc64/)
  })

  test("fails when installing pi fails, saying why, and keeps no install", async () => {
    const { builds, fetch } = await nodeReleases()
    const cacheDir = join(dir, "cache")
    const options = { cacheDir, arch: "arm64", nodeVersion: "24.0.0", nodeBuilds: builds, fetch }

    const failed = await Effect.runPromise(
      Effect.flip(
        ensurePiBundle({ ...options, run: host({ failure: "lockfile had changes" }).run }),
      ),
    )
    expect(failed.message).toContain("installing pi: lockfile had changes")
    const other = await Effect.runPromise(
      Effect.flip(ensurePiBundle({ ...options, run: host({ version: "1.2.0" }).run })),
    )
    expect(other.message).toContain(`installed pi 1.2.0, not ${PinnedPiVersion}`)
    expect((await readdir(cacheDir)).filter((name) => name.startsWith("pi-"))).toEqual([])
  })
})
