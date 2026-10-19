import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber } from "effect"
import {
  ensurePiBundle,
  type NodeBuild,
  durableManifestInInstall,
  piPackageDir,
  PinnedNodeBuilds,
  PinnedNodeVersion,
  PinnedPiVersion,
  type RunCommand,
  sandboxNodePath,
  sandboxNodeModulesPath,
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
 * Runs `tar` for real, and stands in for `bun install`: lays Pi Durable's package out as an
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
    await mkdir(join(cwd, durableManifestInInstall, ".."), { recursive: true })
    await writeFile(
      join(cwd, durableManifestInInstall),
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

  test("pins the packages the durable agent loads exactly, in the committed package.json and its lockfile", async () => {
    const packages = ["chord", "pi-ai", "pi-codemode", "pi-durable", "pi-mcp"].map(
      (name) => `@earendil-works/${name}`,
    )
    const manifest = JSON.parse(await readFile(join(piPackageDir, "package.json"), "utf8"))
    expect(manifest.dependencies).toEqual(
      Object.fromEntries(packages.map((name) => [name, PinnedPiVersion])),
    )
    const lockfile = await readFile(join(piPackageDir, "bun.lock"), "utf8")
    for (const name of packages) expect(lockfile).toContain(`"${name}@${PinnedPiVersion}"`)
    // pi's coding agent, its TUI, is no longer run.
    expect(lockfile).not.toContain("@earendil-works/pi-coding-agent")
  })

  test("says where Node.js and the agent's packages are in the Sandbox", () => {
    expect(sandboxNodePath("musl")).toBe(`/opt/kndl/pi/node-v${PinnedNodeVersion}-musl/bin/node`)
    expect(sandboxNodeModulesPath("pi-1.3.0-abc")).toBe("/opt/kndl/pi/pi-1.3.0-abc/node_modules")
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
    expect(await stat(join(cacheDir, ready.appDir, durableManifestInInstall))).toBeTruthy()
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

  test("stops downloading and installing when interrupted, as on a timeout, and keeps nothing of it", async () => {
    const { builds } = await nodeReleases()
    const cacheDir = join(dir, "cache")
    const aborted: Array<string> = []
    const started: Array<string> = []
    /** Stands in for what never ends by itself: it ends when its signal aborts. */
    const hangs = (what: string, signal: AbortSignal | undefined) =>
      new Promise<never>((_, reject) => {
        started.push(what)
        signal?.addEventListener("abort", () => {
          aborted.push(what)
          reject(new Error(`${what} aborted`))
        })
      })
    const preparing = Effect.runFork(
      ensurePiBundle({
        cacheDir,
        arch: "arm64",
        nodeVersion: "24.0.0",
        nodeBuilds: builds,
        fetch: (url, signal) => hangs(url, signal),
        run: (argv, _cwd, signal) => hangs(argv.join(" "), signal),
        bun: "/usr/bin/bun",
      }),
    )
    while (started.length < 3) await Bun.sleep(5)

    await Effect.runPromise(Fiber.interrupt(preparing))
    expect(aborted.toSorted()).toEqual(started.toSorted())
    // Its staging directories go once their work has stopped.
    for (let tries = 0; (await readdir(cacheDir)).length > 0 && tries < 200; tries++)
      await Bun.sleep(5)
    expect(await readdir(cacheDir)).toEqual([])
  })

  test("sweeps away what a preparation cut short left, as by a Runner killed, but not one under way", async () => {
    const { builds, fetch } = await nodeReleases()
    const cacheDir = join(dir, "cache")
    const left = [".download-node-musl-a1b2c3", ".install-pi-d4e5f6"]
    for (const name of [...left, ".install-pi-now"]) {
      await mkdir(join(cacheDir, name, "node_modules"), { recursive: true })
    }
    const anHourAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    for (const name of left) await utimes(join(cacheDir, name), anHourAgo, anHourAgo)

    const ready = await Effect.runPromise(
      ensurePiBundle({
        cacheDir,
        arch: "arm64",
        nodeVersion: "24.0.0",
        nodeBuilds: builds,
        fetch,
        run: host().run,
      }),
    )
    expect((await readdir(cacheDir)).toSorted()).toEqual(
      [".install-pi-now", ready.appDir, "node-v24.0.0-glibc", "node-v24.0.0-musl"].toSorted(),
    )
  })
})
