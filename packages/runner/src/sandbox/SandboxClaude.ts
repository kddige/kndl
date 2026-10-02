// The Claude Code binary a Sandbox runs `claude mcp serve` from (the tool bridge, ADR 0001).
//
// The Runner keeps Linux builds of Claude Code in a cache directory on its host, one directory
// per version, and mounts that directory read-only into every Sandbox. The version is the host's
// own Claude Code version, so the records `mcp serve` returns have the shapes the host's Claude
// Code expects (spike #2). A build is downloaded from the npm registry the first time a version
// is needed, checked against the registry's integrity hash, and kept.
//
// The musl build is used because it is self-contained: it runs on the default Alpine image
// (`docker:dind`) and on glibc images alike. Nothing here gives the Sandbox Claude credentials,
// and `mcp serve` needs none.

import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Data, Effect } from "effect"

/** Where the cache directory is mounted in every Sandbox. */
export const sandboxClaudeGuestDir = "/opt/claude-hub/claude-code"

export class SandboxClaudeError extends Data.TaggedError("SandboxClaudeError")<{
  readonly message: string
}> {}

/** The npm package holding the Linux musl build for the host's CPU. */
export const linuxPackage = (arch: string = process.arch) => {
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : undefined
  return cpu === undefined ? undefined : `@anthropic-ai/claude-code-linux-${cpu}-musl`
}

/** The binary's path inside a Sandbox. */
export const sandboxClaudePath = (version: string) => `${sandboxClaudeGuestDir}/${version}/claude`

const Version = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** Reads the version out of `claude --version` output, such as `2.1.287 (Claude Code)`. */
export const parseClaudeVersion = (output: string): string | undefined => {
  const version = output.trim().split(/\s+/)[0]
  return version !== undefined && Version.test(version) ? version : undefined
}

/** Asks the host's Claude Code for its version. Makes no model call. */
export const hostClaudeVersion = (claudeBin: string) =>
  Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn([claudeBin, "--version"], { stdout: "pipe", stderr: "pipe" })
      const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
      if (code !== 0) throw new Error(`exited with ${code}`)
      return output
    },
    catch: (error) =>
      new SandboxClaudeError({ message: `could not run ${claudeBin} --version: ${String(error)}` }),
  }).pipe(
    Effect.flatMap((output) => {
      const version = parseClaudeVersion(output)
      return version === undefined
        ? Effect.fail(
            new SandboxClaudeError({ message: `unexpected ${claudeBin} --version: ${output}` }),
          )
        : Effect.succeed(version)
    }),
  )

export interface EnsureOptions {
  /** The cache directory, mounted into Sandboxes at {@link sandboxClaudeGuestDir}. */
  readonly cacheDir: string
  readonly version: string
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
      const target = join(options.cacheDir, options.version)
      const binary = join(target, "claude")
      if (await exists(binary)) return binary

      const pkg = linuxPackage(options.arch)
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

      await mkdir(options.cacheDir, { recursive: true })
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
