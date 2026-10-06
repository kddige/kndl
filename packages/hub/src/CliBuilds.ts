// The `kndl` CLI binaries the Hub serves (issue #178, ADR 0016): built with
// `bun build --compile` from the checkout the Hub runs from, at its commit, so the CLI follows the
// Hub's commit as Runners do (ADR 0011).
//
// A binary is built the first time someone asks for it, not when the Hub is installed or updated:
// each is about 65 MB, a target other than the Hub's own platform downloads that platform's Bun
// first, and most Hubs only ever serve one or two of the four. It is kept in
// `<cliDir>/<commit>/kndl-<target>`, and builds of other commits are removed once one of
// this commit's is made. One build runs at a time: a request for a binary another request is
// building waits for it and is served the same file.

import { existsSync } from "node:fs"
import { mkdir, readdir, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { CommitIdPattern, type CliTarget } from "@kndl/protocol"
import { readBuildVersion, thisCheckout } from "@kndl/protocol/checkout"
import { Context, Data, Effect, Layer, Semaphore } from "effect"
import { HubConfig } from "./HubConfig.ts"
import { HubVersion } from "./HubVersion.ts"

/** Why the Hub can't serve a binary now, with the status to answer. */
export class CliBuildError extends Data.TaggedError("CliBuildError")<{
  readonly status: number
  readonly message: string
}> {}

/** Builds the CLI for `target` at `commit` into `outfile`; fails with what the build said. */
export type CliBuilder = (options: {
  readonly target: CliTarget
  readonly commit: string
  readonly outfile: string
}) => Effect.Effect<void, string>

export class CliBuilds extends Context.Service<
  CliBuilds,
  {
    /** The commit the CLI is built at, the Hub's; `undefined` when it runs from no git checkout. */
    readonly commit: string | undefined
    /** The path of the binary for `target`, built first if it isn't yet. */
    readonly binary: (target: CliTarget) => Effect.Effect<string, CliBuildError>
  }
>()("@kndl/hub/CliBuilds") {
  static readonly make = (options: {
    /** Where binaries are kept, by commit. */
    readonly dir: string
    readonly commit: string | undefined
    readonly build: CliBuilder
    /**
     * The commit the checkout is at now. A checkout `kndl update` has moved since the Hub
     * started would build other code than the Hub runs, so nothing is built until it restarts.
     */
    readonly checkoutCommit: () => string | undefined
  }) => {
    const lock = Semaphore.makeUnsafe(1)
    const { commit, dir } = options
    const pathOf = (target: CliTarget, at: string) => join(dir, at, `kndl-${target}`)

    const build = (target: CliTarget, at: string) =>
      Effect.gen(function* () {
        const path = pathOf(target, at)
        // Another request may have built it while this one waited.
        if (existsSync(path)) return path
        if (options.checkoutCommit() !== at) {
          return yield* new CliBuildError({
            status: 503,
            message:
              "The Hub's checkout has moved to another commit since the Hub started: it serves the CLI again once it restarts.",
          })
        }
        const started = Date.now()
        const partial = `${path}.partial-${process.pid}`
        yield* Effect.promise(() => mkdir(join(dir, at), { recursive: true }))
        yield* options.build({ target, commit: at, outfile: partial }).pipe(
          Effect.mapError(
            (detail) =>
              new CliBuildError({
                status: 500,
                message: `The Hub couldn't build the kndl CLI for ${target}: ${detail}`,
              }),
          ),
          Effect.flatMap(() => Effect.promise(() => rename(partial, path))),
          Effect.ensuring(Effect.promise(() => rm(partial, { force: true }))),
          Effect.tapError((error) => Effect.logError(error.message)),
        )
        yield* Effect.logInfo(
          `Built the kndl CLI for ${target} at ${at.slice(0, 12)} in ${((Date.now() - started) / 1000).toFixed(1)} s.`,
        )
        yield* pruneOtherCommits(dir, at)
        return path
      })

    return CliBuilds.of({
      commit,
      binary: (target) => {
        if (commit === undefined) {
          return Effect.fail(
            new CliBuildError({
              status: 503,
              message:
                "This Hub doesn't run from a git checkout, so it has no commit to build the kndl CLI at.",
            }),
          )
        }
        const path = pathOf(target, commit)
        return existsSync(path) ? Effect.succeed(path) : lock.withPermit(build(target, commit))
      },
    })
  }

  /** The Hub's own: its commit and checkout, `bun build --compile` with the Bun running it. */
  static readonly layer = Layer.effect(
    CliBuilds,
    Effect.gen(function* () {
      const { cliDir } = yield* HubConfig
      const { version } = yield* HubVersion
      return CliBuilds.make({
        dir: cliDir,
        commit: version?.commit,
        build: compileCli(thisCheckout),
        checkoutCommit: () => readBuildVersion(thisCheckout)?.commit,
      })
    }),
  )

  /** For tests that never ask for the CLI: a Hub with no commit to build it at. */
  static readonly unused = Layer.succeed(
    CliBuilds,
    CliBuilds.make({
      dir: "/nonexistent/kndl/cli",
      commit: undefined,
      build: () => Effect.die(new Error("CliBuilds: no builds in this test")),
      checkoutCommit: () => undefined,
    }),
  )
}

/** How long a build may take, the target's Bun downloaded included. */
const BuildTimeoutMs = 5 * 60_000

/** The CLI's entry point in a checkout. */
export const cliEntryPoint = (checkout: string) =>
  join(checkout, "packages", "cli", "src", "main.ts")

/**
 * `bun build --compile` of the CLI in `checkout`, with its commit and target compiled in
 * (BuildInfo.ts in the CLI), using the Bun that runs the Hub.
 */
export const compileCli =
  (checkout: string): CliBuilder =>
  ({ target, commit, outfile }) =>
    Effect.tryPromise({
      try: async (signal) => {
        const child = Bun.spawn(
          [
            process.execPath,
            "build",
            "--compile",
            `--target=bun-${target}`,
            "--define",
            `KNDL_BUILD_COMMIT=${JSON.stringify(commit)}`,
            "--define",
            `KNDL_BUILD_TARGET=${JSON.stringify(target)}`,
            "--outfile",
            outfile,
            cliEntryPoint(checkout),
          ],
          {
            cwd: checkout,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            signal,
            timeout: BuildTimeoutMs,
          },
        )
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        if (exitCode !== 0) {
          throw new Error(
            (stderr.trim() || stdout.trim() || `bun build exited with ${exitCode}`).slice(-2000),
          )
        }
      },
      catch: (error) => (error instanceof Error ? error.message : String(error)),
    })

/** Removes the builds of commits other than `keep`: a Hub serves only its own. */
const pruneOtherCommits = (dir: string, keep: string) =>
  Effect.promise(async () => {
    const entries = await readdir(dir).catch(() => [])
    await Promise.all(
      entries
        .filter((entry) => entry !== keep && CommitIdPattern.test(entry))
        .map((entry) => rm(join(dir, entry), { recursive: true, force: true })),
    )
  })
