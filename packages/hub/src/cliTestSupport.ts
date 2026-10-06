// For the tests of the CLI the Hub serves: a stand-in for `bun build --compile`, and temp dirs.

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CliTarget } from "@claude-hub/protocol"
import { Effect, Layer } from "effect"
import { CliBuilds } from "./CliBuilds.ts"

/** The commit the stand-in builds are at. */
export const commit = "c0ffee".padEnd(40, "0")

const dirs: Array<string> = []

export async function tempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** Removes the dirs `tempDir` made. */
export async function removeTempDirs() {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
}

/** What a stand-in build writes: a script that says its version as the CLI does, and its target. */
export const fakeBinary = (target: string, at: string) =>
  `#!/bin/sh\n# target: ${target}\necho "claude-hub v${at.slice(0, 12)}"\n`

/** CliBuilds with a stand-in for `bun build --compile`, which counts its builds. */
export function fakeBuilds(options: {
  readonly dir: string
  readonly commit?: string | undefined
  readonly checkoutCommit?: string | undefined
  readonly fail?: string
}) {
  const built: Array<CliTarget> = []
  const at = "commit" in options ? options.commit : commit
  const layer = Layer.succeed(
    CliBuilds,
    CliBuilds.make({
      dir: options.dir,
      commit: at,
      checkoutCommit: () => ("checkoutCommit" in options ? options.checkoutCommit : at),
      build: ({ target, commit: builtAt, outfile }) =>
        Effect.gen(function* () {
          built.push(target)
          yield* Effect.sleep("50 millis")
          if (options.fail !== undefined) return yield* Effect.fail(options.fail)
          yield* Effect.promise(() => writeFile(outfile, fakeBinary(target, builtAt)))
        }),
    }),
  )
  return { layer, built }
}
