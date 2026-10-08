// Where the Hub reads Plugin packages from (#220, ADR 0020): a git repo, or an upload. Either way
// it reads only the package's `package.json` and `kndl.json`, and runs nothing of it.
//
// From git, it fetches one ref, shallow, into a bare repo of its own in a temporary folder, and
// reads the two files' blobs from it: no checkout, so no working tree, filters or LFS.
// - Only `https://` (ADR 0020): git's other transports (`file://`, `ssh`, `ext::`, local paths)
//   are refused before git runs, and again by git itself, `protocol.allow=never`.
// - No hooks (an empty template and `core.hooksPath=/dev/null`), no submodules, no credentials or
//   prompts, and none of the Hub's own git config. The ref and subfolder are checked so that git
//   can't take them for options, refspecs or paths outside the repo.
// - A fetch is killed past a timeout, or once the repo it is writing outgrows a size limit, and at
//   most two run at once.
// An upload is an archive (PluginArchive.ts) or the two files of a folder, picked in the browser.

import { lstat, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  gitRefProblem,
  gitUrlProblem,
  iconPathOf,
  manifestIconOf,
  MaxPluginArchiveBytes,
  type PackagedPlugin,
  type PluginPackageFrom,
  PluginManifestFile,
  type PluginSource,
  packagePath,
  packagePathProblem,
  readPluginPackage,
} from "@kndl/protocol"
import { Context, Effect, Layer, Result, Semaphore } from "effect"
import { readPackageArchive, type PackageFiles } from "./PluginArchive.ts"
import { MaxIconBytes } from "./PluginIcons.ts"
import { PluginRefused } from "./Plugins.ts"

export interface PluginSourcesOptions {
  /** The transports git may use: only `https` on a Hub; tests add `file`. */
  readonly protocols: ReadonlyArray<"https" | "file">
  /** How long one fetch may take, in all. */
  readonly timeoutMs: number
  /** How large the repo a fetch writes may grow, in bytes. */
  readonly maxBytes: number
}

const defaults: PluginSourcesOptions = {
  protocols: ["https"],
  timeoutMs: 60_000,
  maxBytes: 20_000_000,
}

/** How often a fetch's size is measured. */
const sizePollMs = 200

const refuse = (message: string) => Effect.fail(new PluginRefused({ message }))

/** Fetches running at once, at most. */
const concurrentFetches = 2

/** Thrown inside a fetch, with what to tell the person. */
class GitRefusal extends Error {}

/** git's environment: none of the Hub's config, no prompts, and only the transports allowed. */
function gitEnvironment(home: string, protocols: ReadonlyArray<string>) {
  const passed = [
    "PATH",
    "http_proxy",
    "https_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "no_proxy",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ]
  const env: Record<string, string> = {}
  for (const name of passed) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return {
    ...env,
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: protocols.join(":"),
  }
}

/** git's config for every command: nothing it could run, ask or recurse into. */
const gitConfig = (protocols: ReadonlyArray<string>) =>
  [
    "protocol.allow=never",
    ...protocols.map((protocol) => `protocol.${protocol}.allow=always`),
    "core.hooksPath=/dev/null",
    "core.fsmonitor=false",
    "credential.helper=",
    "core.askPass=",
    "fetch.recurseSubmodules=false",
    "submodule.recurse=false",
    "transfer.fsckObjects=true",
    "gc.auto=0",
    "maintenance.auto=false",
    "http.lowSpeedLimit=1024",
    "http.lowSpeedTime=30",
  ].flatMap((setting) => ["-c", setting])

/** The bytes the files in `dir` take, recursively, not following links. */
async function sizeOf(dir: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) total += await sizeOf(path)
    else
      total += await lstat(path).then(
        (stat) => stat.size,
        () => 0,
      )
  }
  return total
}

const lastLine = (stderr: string) =>
  stderr
    .trim()
    .split("\n")
    .map((line) => line.replace(/^(?:fatal|error): /, "").trim())
    .filter((line) => line !== "")
    .at(-1)
    ?.slice(0, 300) ?? "it failed"

/** Fetches the source's ref into a new bare repo and reads the package's two files from it. */
async function fetchFiles(
  source: Extract<PluginSource, { _tag: "Git" }>,
  options: PluginSourcesOptions,
  signal: AbortSignal,
): Promise<{ readonly files: PackageFiles; readonly commit: string }> {
  const dir = await mkdtemp(join(tmpdir(), "kndl-plugin-"))
  const repo = join(dir, "repo.git")
  const deadline = Date.now() + options.timeoutMs
  const env = gitEnvironment(dir, options.protocols)
  const config = gitConfig(options.protocols)
  const tooSlow = `Fetching the repo took longer than ${options.timeoutMs / 1000} s.`
  const run = async (args: ReadonlyArray<string>, watchSize = false) => {
    const left = deadline - Date.now()
    if (left <= 0) throw new GitRefusal(tooSlow)
    const child = Bun.spawn(["git", ...config, ...args], {
      cwd: dir,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal,
      timeout: left,
    })
    let tooLarge = false
    const measure = async () => {
      if ((await sizeOf(dir)) > options.maxBytes) {
        tooLarge = true
        child.kill()
      }
    }
    const poll = watchSize ? setInterval(() => void measure(), sizePollMs) : undefined
    try {
      const [out, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).bytes(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      if (watchSize) await measure()
      if (tooLarge) {
        throw new GitRefusal(
          `The repo is larger than ${options.maxBytes / 1_000_000} MB at that ref; the Hub fetches at most that.`,
        )
      }
      if (child.signalCode !== null || Date.now() >= deadline) throw new GitRefusal(tooSlow)
      return { stdout: new TextDecoder().decode(out), bytes: out, stderr, exitCode }
    } finally {
      if (poll !== undefined) clearInterval(poll)
    }
  }
  try {
    const init = await run(["init", "--quiet", "--bare", "--template=", repo])
    if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr}`)
    const ref = source.ref ?? "HEAD"
    const fetched = await run(
      [
        "--git-dir",
        repo,
        "fetch",
        "--quiet",
        "--depth=1",
        "--no-tags",
        "--no-recurse-submodules",
        "--no-write-commit-graph",
        "--end-of-options",
        source.url,
        ref,
      ],
      true,
    )
    if (fetched.exitCode !== 0) {
      throw new GitRefusal(
        `git couldn't fetch ${source.ref ?? "the default branch"} from ${source.url}: ${lastLine(fetched.stderr)}`,
      )
    }
    const commit = (
      await run([
        "--git-dir",
        repo,
        "rev-parse",
        "--verify",
        "--end-of-options",
        "FETCH_HEAD^{commit}",
      ])
    ).stdout.trim()
    if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new GitRefusal(`${ref} isn't a commit.`)
    const folder = packagePath(source.path ?? "")
    const where = folder === "" ? "at its root" : `in ${folder}/`
    const read = async (name: string, limit = 64 * 1024) => {
      const path = folder === "" ? name : `${folder}/${name}`
      const listed = await run([
        "--git-dir",
        repo,
        "ls-tree",
        "-l",
        "--full-tree",
        commit,
        "--",
        path,
      ])
      // `<mode> <type> <object> <size>\t<path>`, for the one path asked about.
      const match = /^(\d+) (\w+) ([0-9a-f]+)\s+(-|\d+)\t(.*)$/.exec(listed.stdout.trim())
      if (listed.exitCode !== 0 || match === null || match[5] !== path) {
        throw new GitRefusal(`The repo has no ${name} ${where} at that ref.`)
      }
      const [, mode, , object, size] = match
      if (mode === "120000") throw new GitRefusal(`The repo's ${name} is a symlink, not a file.`)
      if (mode !== "100644" && mode !== "100755") {
        throw new GitRefusal(`The repo's ${name} isn't a file.`)
      }
      if (Number(size) > limit) {
        throw new GitRefusal(`The repo's ${name} is larger than ${limit / 1024} KiB.`)
      }
      const blob = await run(["--git-dir", repo, "cat-file", "blob", object as string])
      if (blob.exitCode !== 0) throw new Error(`git cat-file failed: ${blob.stderr}`)
      return blob
    }
    // Both missing names package.json first.
    const packageJson = (await read("package.json")).stdout
    const manifest = (await read(PluginManifestFile)).stdout
    // A broken icon never refuses the package: its file is read if it is there, else left out.
    const iconPath = iconPathOf(manifestIconOf(manifest) ?? "")
    const iconFile =
      iconPath === undefined
        ? undefined
        : await read(iconPath, MaxIconBytes).then(
            (blob) => blob.bytes,
            () => undefined,
          )
    return {
      files: { packageJson, manifest, ...(iconFile !== undefined && { iconFile }) },
      commit,
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** An uploaded file's or folder's name, without the folders a browser may put before it. */
const uploadName = (name: string) =>
  name
    .split(/[/\\]/)
    .at(-1)
    // oxlint-disable-next-line no-control-regex
    ?.replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, 200) || "upload"

/** A package as the Hub read it, with its icon file's bytes if it has one. */
export interface PackageRead {
  readonly plugin: PackagedPlugin
  readonly iconFile?: Uint8Array
}

const readOf = (files: PackageFiles, source: PluginSource, commit?: string) =>
  readPluginPackage(files, source, commit).pipe(
    Result.match({
      onSuccess: (plugin): Effect.Effect<PackageRead> =>
        Effect.succeed({
          plugin,
          ...(files.iconFile !== undefined && { iconFile: files.iconFile }),
        }),
      onFailure: refuse,
    }),
  )

export class PluginSources extends Context.Service<
  PluginSources,
  {
    /**
     * Reads a package from git or an upload: the Plugin it would be, or why it is refused, in
     * words to show the person.
     */
    readonly read: (from: PluginPackageFrom) => Effect.Effect<PackagedPlugin, PluginRefused>
    /**
     * Reads a package as {@link read} does, with the bytes of the file in it that the manifest's
     * `icon` names, if it names one the Hub could read (#230).
     */
    readonly readWithIcon: (from: PluginPackageFrom) => Effect.Effect<PackageRead, PluginRefused>
  }
>()("@kndl/hub/PluginSources") {
  static readonly layerWith = (overrides: Partial<PluginSourcesOptions> = {}) =>
    Layer.effect(
      PluginSources,
      Effect.gen(function* () {
        const options = { ...defaults, ...overrides }
        const fetches = yield* Semaphore.make(concurrentFetches)

        const urlProblem = (url: string) =>
          options.protocols.includes("file") && url.startsWith("file://")
            ? undefined
            : gitUrlProblem(url)

        const fromGit = Effect.fn("PluginSources.fromGit")(function* (
          from: Extract<PluginPackageFrom, { _tag: "Git" }>,
        ) {
          const url = from.url.trim()
          const ref = from.ref?.trim() || undefined
          const path = packagePath(from.path?.trim() ?? "")
          const problem =
            urlProblem(url) ??
            (ref === undefined ? undefined : gitRefProblem(ref)) ??
            packagePathProblem(from.path?.trim() ?? "")
          if (problem !== undefined) return yield* refuse(problem)
          const source: PluginSource = {
            _tag: "Git",
            url,
            ...(ref !== undefined && { ref }),
            ...(path !== "" && { path }),
          }
          const { files, commit } = yield* fetches.withPermits(1)(
            Effect.tryPromise({
              try: (signal) => fetchFiles(source, options, signal),
              catch: (error) =>
                error instanceof GitRefusal
                  ? new PluginRefused({ message: error.message })
                  : new PluginRefused({
                      message: `The Hub couldn't fetch the repo: ${error instanceof Error ? error.message : String(error)}`,
                    }),
            }),
          )
          return yield* readOf(files, source, commit)
        })

        const readWithIcon = Effect.fn("PluginSources.read")(function* (from: PluginPackageFrom) {
          switch (from._tag) {
            case "Git":
              return yield* fromGit(from)
            // A folder is its two files only: a manifest icon that is a path has no file here.
            case "Folder":
              return yield* readOf(from, {
                _tag: "Upload",
                fileName: uploadName(from.folderName),
              })
            case "Archive": {
              const bytes = Buffer.from(from.data, "base64")
              if (bytes.length > MaxPluginArchiveBytes) {
                return yield* refuse(
                  `The archive is larger than ${MaxPluginArchiveBytes / 1024 / 1024} MiB.`,
                )
              }
              const files = readPackageArchive(bytes)
              if (Result.isFailure(files)) return yield* refuse(files.failure)
              return yield* readOf(files.success, {
                _tag: "Upload",
                fileName: uploadName(from.fileName),
              })
            }
          }
        })

        return PluginSources.of({
          read: (from) => Effect.map(readWithIcon(from), ({ plugin }) => plugin),
          readWithIcon,
        })
      }),
    )

  /** Reads packages from `https://` git repos and uploads. */
  static readonly layer = PluginSources.layerWith()
}
