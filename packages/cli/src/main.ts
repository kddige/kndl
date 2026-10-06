#!/usr/bin/env bun
// The `kndl` CLI. Installed, the wrapper install.sh writes runs it from `<home>/app`; in a
// checkout, `bun packages/cli/src/main.ts <command>`. Either way it manages the installed home,
// `KNDL_HOME` or `~/.kndl`, never a checkout's dev home. A Hub also serves it as one
// binary (issue #178), which first updates itself to the Hub's commit (SelfUpdate.ts).
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, Layer } from "effect"
import { Command } from "effect/cli"
import { build } from "./BuildInfo.ts"
import { cli } from "./Cli.ts"
import { readCliConfig } from "./CliConfig.ts"
import { HubClient } from "./HubClient.ts"
import { selfUpdate } from "./SelfUpdate.ts"
import { Shell } from "./Shell.ts"
import { Ui } from "./Ui.ts"

/** The commit the CLI runs from, as its version: the one it was built at, or the checkout's. */
function version(): string {
  if (build !== undefined) return build.commit.slice(0, 12)
  const git = Bun.spawnSync(["git", "rev-parse", "--short=12", "HEAD"], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "ignore",
  })
  return git.exitCode === 0 ? git.stdout.toString().trim() : "unknown"
}

selfUpdate({ build, env: process.env, config: readCliConfig() }).pipe(
  Effect.andThen(Command.run(cli, { version: version() })),
  // A command that can't go on says why, and exits 1. A question left with Ctrl-C or Esc exits 130,
  // as Ctrl-C anywhere else does (BunRuntime interrupts the command): no stack trace either way.
  Effect.catchTag("CliFailure", (error) =>
    Effect.andThen(
      Console.error(error.message),
      Effect.sync(() => (process.exitCode = 1)),
    ),
  ),
  Effect.catchTag("Cancelled", () =>
    Effect.andThen(
      Console.error("Cancelled."),
      Effect.sync(() => (process.exitCode = 130)),
    ),
  ),
  Effect.provide(
    Layer.mergeAll(Shell.layer, Ui.layer, HubClient.layer).pipe(
      Layer.provideMerge(BunServices.layer),
    ),
  ),
  BunRuntime.runMain,
)
