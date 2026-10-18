// The pi a pi Session runs, in its Sandbox (ADR 0029), beside the Claude Code it bridges to.
//
// pi is a Node.js program, so the bundle is two things, both kept in a cache directory on the
// Runner's host and mounted read-only into every Sandbox at {@link sandboxPiGuestDir}, as Claude
// Code's builds are (SandboxClaude.ts):
//
// - A pinned Node.js ({@link PinnedNodeVersion}), one build per libc: the glibc builds from
//   nodejs.org, the musl ones from unofficial-builds.nodejs.org. Each is checked against the
//   SHA-256 pinned here, from the release's SHASUMS256.txt, and only its `bin/node` is kept. A
//   Sandbox runs the build its image's libc needs, picked as Claude Code's is.
// - A pinned pi install ({@link PinnedPiVersion}): the committed `packages/runner/pi/package.json`
//   and `bun.lock`, installed with `bun install --frozen-lockfile --ignore-scripts`. pi is
//   JavaScript, so one install serves both libcs. Its directory is named after the lockfile's
//   hash, so a changed lockfile installs anew beside the old one.
//
// Everything lands under a temporary name and is renamed into place, so preparing it is safe to
// run concurrently, and a cut-short download is tried again. A preparation that takes too long is
// stopped, its download and install with it, and what one cut short by a killed Runner left is
// swept away by the next.
//
// Upgrading pi: change the version in packages/runner/pi/package.json and here, run
// `bun install --ignore-scripts` in a copy of that directory outside the repository (inside it,
// Bun would take the root's workspace) and commit its bun.lock. Upgrading Node.js: change
// PinnedNodeVersion and the SHA-256 of each build from its SHASUMS256.txt.

import { createHash } from "node:crypto"
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { join, posix, resolve } from "node:path"
import { Data, Duration, Effect } from "effect"
import type { Libc } from "./SandboxClaude.ts"

/** The pi version pi Sessions run, as packages/runner/pi/package.json pins it. */
export const PinnedPiVersion = "1.3.0"

/** The Node.js pi runs on: an LTS release, as pi needs 22.19 or later. */
export const PinnedNodeVersion = "24.22.0"

/** Where the cache directory is mounted in every Sandbox. */
export const sandboxPiGuestDir = "/opt/kndl/pi"

/** The committed package.json and bun.lock of the pi install. */
export const piPackageDir = resolve(import.meta.dir, "../../pi")

/** pi's CLI in its install: the package's `pi` bin. */
export const piCliInInstall = "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"

/** A Node.js build for one CPU and libc, and its SHA-256 from the release's SHASUMS256.txt. */
export interface NodeBuild {
  readonly url: string
  readonly sha256: string
}

const nodeBuild = (cpu: "arm64" | "x64", libc: Libc, sha256: string): NodeBuild => {
  const name = `node-v${PinnedNodeVersion}-linux-${cpu}${libc === "musl" ? "-musl" : ""}`
  const host =
    libc === "musl"
      ? "https://unofficial-builds.nodejs.org/download/release"
      : "https://nodejs.org/dist"
  return { url: `${host}/v${PinnedNodeVersion}/${name}.tar.gz`, sha256 }
}

/** The Linux builds of {@link PinnedNodeVersion}, by {@link nodeBuildKey}. */
export const PinnedNodeBuilds: Readonly<Record<string, NodeBuild>> = {
  "arm64-glibc": nodeBuild(
    "arm64",
    "glibc",
    "b7e7991d5407815adfa74a2a9cd4db683552c8ce32ff4a295c22e972849c3f5d",
  ),
  "x64-glibc": nodeBuild(
    "x64",
    "glibc",
    "28ea0a438de9a13bd7891fd758eee6c7819ee8af5442dfd8d45bd65e56d4228c",
  ),
  "arm64-musl": nodeBuild(
    "arm64",
    "musl",
    "6812a53e5b37fbc32476d6c3511038d2bc3bbd1b3bb348d6c04dd2c70a1c8f4a",
  ),
  "x64-musl": nodeBuild(
    "x64",
    "musl",
    "72cd253fbe0c2539d52208ed098d47b78ff2c32ba76295d8e6b5b0ce067dcba5",
  ),
}

/** The key of a Node.js build for a CPU, as Node names it (`process.arch`), and a libc. */
export const nodeBuildKey = (arch: string, libc: Libc) => `${arch}-${libc}`

/** The cache's directory for a Node.js build. */
const nodeDir = (version: string, libc: Libc) => `node-v${version}-${libc}`

/** Node.js's executable inside a Sandbox whose image needs `libc`. */
export const sandboxNodePath = (libc: Libc, version: string = PinnedNodeVersion) =>
  posix.join(sandboxPiGuestDir, nodeDir(version, libc), "bin", "node")

/** pi's CLI inside every Sandbox, in the install named `appDir`. */
export const sandboxPiCliPath = (appDir: string) =>
  posix.join(sandboxPiGuestDir, appDir, piCliInInstall)

/**
 * Readies a Sandbox to run pi: Node.js runs there, with musl's images given the one library its
 * build links (`libgcc`, which the default `docker:dind` lacks), and pi's state directory exists.
 * Prints nothing when both are so.
 */
export const piNeedsScript = (node: string, stateDir: string) => `set -e
if ! '${node}' --version >/dev/null 2>&1; then
  if command -v apk >/dev/null 2>&1; then
    echo "Installing libgcc for pi..."
    apk add --no-cache -q libgcc
  fi
  '${node}' --version >/dev/null || { echo "pi's Node.js doesn't run in this image." >&2; exit 1; }
fi
mkdir -p '${stateDir}'`

export class SandboxPiError extends Data.TaggedError("SandboxPiError")<{
  readonly message: string
}> {}

/** What the cache holds once the bundle is ready. */
export interface PiBundleReady {
  /** The directory of the pi install, under the cache, as {@link sandboxPiCliPath} takes it. */
  readonly appDir: string
}

/**
 * Runs a command on the host: its exit code and what it printed to stderr. One whose `signal`
 * aborts is stopped.
 */
export type RunCommand = (
  argv: ReadonlyArray<string>,
  cwd: string,
  signal?: AbortSignal,
) => Promise<{ readonly exitCode: number; readonly stderr: string }>

export interface EnsurePiOptions {
  /** The cache directory, mounted into Sandboxes at {@link sandboxPiGuestDir}. */
  readonly cacheDir: string
  /** The libcs to have Node.js for. Defaults to both. */
  readonly libcs?: ReadonlyArray<Libc>
  readonly arch?: string
  /** For tests. */
  readonly nodeVersion?: string
  readonly nodeBuilds?: Readonly<Record<string, NodeBuild>>
  readonly packageDir?: string
  /** Gets a URL, stopping when `signal` aborts; defaults to `fetch`. */
  readonly fetch?: (url: string, signal?: AbortSignal) => Promise<Response>
  /** Runs `bun install` and `tar`; defaults to spawning them. */
  readonly run?: RunCommand
  /** The Bun that installs pi: the one the Runner runs on. */
  readonly bun?: string
}

/** The names of the temporary directories a preparation works in, under the cache. */
const stagingPrefixes = [".download-node-", ".install-pi-"]

/**
 * How old a temporary directory in the cache is when no preparation can still be working in it:
 * the Runner gives one 5 minutes, and stops it then (PiBundle.ts).
 */
export const StaleStagingAge = Duration.hours(1)

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )

const spawnCommand: RunCommand = async (argv, cwd, signal) => {
  const child = Bun.spawn([...argv], {
    cwd,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    ...(signal === undefined ? {} : { signal }),
  })
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited])
  return { exitCode, stderr }
}

/**
 * Removes the temporary directories of preparations that were cut short and never cleaned up, as
 * by a Runner killed while it prepared: those older than {@link StaleStagingAge}, so another
 * Runner's on the same cache, still under way, is left be.
 */
const sweepStaging = async (cacheDir: string) => {
  const before = Date.now() - Duration.toMillis(StaleStagingAge)
  for (const name of await readdir(cacheDir)) {
    if (!stagingPrefixes.some((prefix) => name.startsWith(prefix))) continue
    const path = join(cacheDir, name)
    const modified = await stat(path).then(
      (found) => found.mtimeMs,
      () => undefined,
    )
    if (modified !== undefined && modified < before)
      await rm(path, { recursive: true, force: true })
  }
}

/** Moves a finished `staging` into place at `target`, unless someone else finished first. */
const settle = async (staging: string, target: string, done: string) => {
  await chmod(staging, 0o755)
  // Someone else may have finished first; theirs is as good as ours.
  await rename(staging, target).catch(async (error: unknown) => {
    if (!(await exists(done))) throw error
  })
}

/** Makes sure the cache holds Node.js's executable for `libc`, downloading it if not. */
const ensureNode = async (
  options: EnsurePiOptions,
  libc: Libc,
  run: RunCommand,
  signal: AbortSignal,
) => {
  const version = options.nodeVersion ?? PinnedNodeVersion
  const target = join(options.cacheDir, nodeDir(version, libc))
  const binary = join(target, "bin", "node")
  if (await exists(binary)) return
  const arch = options.arch ?? process.arch
  const build = (options.nodeBuilds ?? PinnedNodeBuilds)[nodeBuildKey(arch, libc)]
  if (build === undefined) throw new Error(`no ${libc} build of Node.js for ${arch}`)
  const get =
    options.fetch ?? ((url: string, stop?: AbortSignal) => fetch(url, { signal: stop ?? null }))

  const tarball = await get(build.url, signal)
  if (!tarball.ok) throw new Error(`downloading ${build.url}: ${tarball.status}`)
  const bytes = new Uint8Array(await tarball.arrayBuffer())
  if (createHash("sha256").update(bytes).digest("hex") !== build.sha256)
    throw new Error(`${build.url} failed its checksum`)
  signal.throwIfAborted()

  const staging = await mkdtemp(join(options.cacheDir, `${stagingPrefixes[0]}${libc}-`))
  try {
    await writeFile(join(staging, "node.tar.gz"), bytes)
    // The tarball's one top directory is named as the file is.
    const top = posix.basename(new URL(build.url).pathname).replace(/\.tar\.gz$/, "")
    const tar = await run(
      ["tar", "-xzf", "node.tar.gz", "--strip-components", "1", `${top}/bin/node`],
      staging,
      signal,
    )
    if (tar.exitCode !== 0) throw new Error(`unpacking ${build.url}: ${tar.stderr.trim()}`)
    signal.throwIfAborted()
    await rm(join(staging, "node.tar.gz"))
    await chmod(join(staging, "bin", "node"), 0o755)
    await chmod(join(staging, "bin"), 0o755)
    await settle(staging, target, binary)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/** Makes sure the cache holds the pi install of the committed lockfile, installing it if not. */
const ensureApp = async (options: EnsurePiOptions, run: RunCommand, signal: AbortSignal) => {
  const packageDir = options.packageDir ?? piPackageDir
  const manifest = await readFile(join(packageDir, "package.json"))
  const lockfile = await readFile(join(packageDir, "bun.lock"))
  const hash = createHash("sha256").update(manifest).update(lockfile).digest("hex").slice(0, 12)
  const appDir = `pi-${PinnedPiVersion}-${hash}`
  const target = join(options.cacheDir, appDir)
  const cli = join(target, piCliInInstall)
  if (await exists(cli)) return appDir

  const staging = await mkdtemp(join(options.cacheDir, stagingPrefixes[1] ?? ".install-pi-"))
  try {
    await copyFile(join(packageDir, "package.json"), join(staging, "package.json"))
    await copyFile(join(packageDir, "bun.lock"), join(staging, "bun.lock"))
    // Exactly what the lockfile says, and none of the packages' own install scripts.
    const install = await run(
      [options.bun ?? process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"],
      staging,
      signal,
    )
    signal.throwIfAborted()
    if (install.exitCode !== 0)
      throw new Error(`installing pi: ${install.stderr.trim() || `exit ${install.exitCode}`}`)
    const installed = JSON.parse(
      await readFile(
        join(staging, "node_modules/@earendil-works/pi-coding-agent/package.json"),
        "utf8",
      ),
    ) as { version?: unknown }
    if (installed.version !== PinnedPiVersion)
      throw new Error(`installed pi ${String(installed.version)}, not ${PinnedPiVersion}`)
    if (!(await exists(join(staging, piCliInInstall))))
      throw new Error(`the pi install has no ${piCliInInstall}`)
    await settle(staging, target, cli)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return appDir
}

/**
 * Makes sure the cache holds Node.js for each libc and the pinned pi install, getting what it
 * lacks, and says where the install is. What earlier preparations cut short left behind goes
 * first. Interrupted, as when it takes too long, it stops its downloads and installs, and
 * removes what they had made.
 */
export const ensurePiBundle = (options: EnsurePiOptions) =>
  Effect.tryPromise({
    try: async (signal): Promise<PiBundleReady> => {
      const run = options.run ?? spawnCommand
      await mkdir(options.cacheDir, { recursive: true, mode: 0o700 })
      await sweepStaging(options.cacheDir)
      const [appDir] = await Promise.all([
        ensureApp(options, run, signal),
        ...(options.libcs ?? (["musl", "glibc"] as const)).map((libc) =>
          ensureNode(options, libc, run, signal),
        ),
      ])
      return { appDir }
    },
    catch: (error) =>
      new SandboxPiError({
        message: `could not get pi ${PinnedPiVersion} for the Sandbox: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }),
  })
