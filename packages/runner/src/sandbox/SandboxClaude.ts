// The Claude Code a Session runs, in its Sandbox (ADR 0013).
//
// The Runner keeps Linux builds of Claude Code in a cache directory on its host, one directory
// per version and libc, and mounts that directory read-only into every Sandbox. The version is
// pinned ({@link PinnedClaudeVersion}), so every Session runs the Claude Code the mod and the
// launch were tested with; `RUNNER_SANDBOX_CLAUDE_VERSION` overrides it. A build is downloaded
// from the npm registry the first time it is needed, checked against the registry's integrity
// hash, and kept.
//
// There are two Linux builds, and each needs its own libc: the musl build runs only where the
// image has musl's loader (`/lib/ld-musl-*`, as on Alpine and the default `docker:dind`), and the
// glibc build everywhere else, such as on Debian (spike #46). An Environment's build checks its
// image and records which one its Sandboxes use; Sandboxes without an Environment boot the
// default Alpine image and use the musl build. Nothing here gives the Sandbox Claude credentials:
// Claude Code reaches Anthropic through the credential proxy, with a Session token.

import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Data, Effect } from "effect"

/**
 * The Claude Code version Sessions run. Upgrading it: change it here, then run the smoke test,
 * `CLAUDE_HUB_SANDBOX_IT=1 bun test src/SandboxClaude.integration.test.ts` in packages/runner,
 * which runs it in a Sandbox through the credential proxy: its banner, `/status`, and a Turn
 * with Bash.
 */
export const PinnedClaudeVersion = "2.1.289"

/** Where the cache directory is mounted in every Sandbox. */
export const sandboxClaudeGuestDir = "/opt/claude-hub/claude-code"

export class SandboxClaudeError extends Data.TaggedError("SandboxClaudeError")<{
  readonly message: string
}> {}

/** Which C library a Linux build of Claude Code needs. */
export type Libc = "musl" | "glibc"

/** The npm package holding the Linux build for the host's CPU and the given libc. */
export const linuxPackage = (arch: string = process.arch, libc: Libc = "musl") => {
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : undefined
  if (cpu === undefined) return undefined
  return `@anthropic-ai/claude-code-linux-${cpu}${libc === "musl" ? "-musl" : ""}`
}

/** The cache's directory for a build: the musl one keeps the plain version, as it always had. */
const buildDir = (version: string, libc: Libc) => (libc === "musl" ? version : `${version}-glibc`)

/** The binary's path inside a Sandbox. */
export const sandboxClaudePath = (version: string, libc: Libc = "musl") =>
  `${sandboxClaudeGuestDir}/${buildDir(version, libc)}/claude`

/** A shell command that prints the {@link Libc} an image needs: `musl` if it has musl's loader. */
export const detectLibcScript =
  "if ls /lib/ld-musl-* >/dev/null 2>&1; then echo musl; else echo glibc; fi"

const Version = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export interface EnsureOptions {
  /** The cache directory, mounted into Sandboxes at {@link sandboxClaudeGuestDir}. */
  readonly cacheDir: string
  readonly version: string
  /** Defaults to musl. */
  readonly libc?: Libc
  /** The npm registry. Defaults to the public one. */
  readonly registry?: string
  readonly arch?: string
  /** For tests. */
  readonly fetch?: (url: string) => Promise<Response>
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )

/**
 * Makes sure the cache holds `version`'s Linux binary, downloading it if not, and returns its
 * host path. Safe to run concurrently: a download lands under a temporary name and is renamed
 * into place.
 */
export const ensureSandboxClaude = (options: EnsureOptions) =>
  Effect.tryPromise({
    try: async () => {
      if (!Version.test(options.version)) throw new Error(`not a version: ${options.version}`)
      const libc = options.libc ?? "musl"
      const target = join(options.cacheDir, buildDir(options.version, libc))
      const binary = join(target, "claude")
      if (await exists(binary)) return binary

      const pkg = linuxPackage(options.arch, libc)
      if (pkg === undefined) throw new Error(`no Linux build of Claude Code for ${process.arch}`)
      const get = options.fetch ?? ((url: string) => fetch(url))
      const registry = (options.registry ?? "https://registry.npmjs.org").replace(/\/$/, "")

      const metadata = await get(`${registry}/${pkg}/${options.version}`)
      if (!metadata.ok)
        throw new Error(`${pkg}@${options.version}: registry said ${metadata.status}`)
      const { dist } = (await metadata.json()) as {
        dist?: { tarball?: string; integrity?: string }
      }
      const integrity = dist?.integrity
      if (dist?.tarball === undefined || integrity?.startsWith("sha512-") !== true)
        throw new Error(`${pkg}@${options.version}: no tarball with a sha512 integrity`)

      const tarball = await get(dist.tarball)
      if (!tarball.ok) throw new Error(`downloading ${dist.tarball}: ${tarball.status}`)
      const bytes = new Uint8Array(await tarball.arrayBuffer())
      const digest = `sha512-${createHash("sha512").update(bytes).digest("base64")}`
      if (digest !== integrity) throw new Error(`${dist.tarball} failed its integrity check`)

      await mkdir(options.cacheDir, { recursive: true, mode: 0o700 })
      const staging = await mkdtemp(join(options.cacheDir, `.download-${options.version}-`))
      try {
        await writeFile(join(staging, "package.tgz"), bytes)
        const tar = Bun.spawn(
          ["tar", "-xzf", "package.tgz", "--strip-components", "1", "package/claude"],
          { cwd: staging, stdout: "ignore", stderr: "pipe" },
        )
        const [stderr, code] = await Promise.all([new Response(tar.stderr).text(), tar.exited])
        if (code !== 0) throw new Error(`unpacking ${pkg}: ${stderr.trim()}`)
        await rm(join(staging, "package.tgz"))
        await chmod(join(staging, "claude"), 0o755)
        await chmod(staging, 0o755)
        // Someone else may have finished first; theirs is as good as ours.
        await rename(staging, target).catch(async (error: unknown) => {
          if (!(await exists(binary))) throw error
        })
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
      return binary
    },
    catch: (error) =>
      new SandboxClaudeError({
        message: `could not get Claude Code ${options.version} for the Sandbox: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }),
  })
