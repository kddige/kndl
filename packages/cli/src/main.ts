#!/usr/bin/env bun
// The `claude-hub` CLI. Installed, the wrapper install.sh writes runs it from `<home>/app`; in a
// checkout, `bun packages/cli/src/main.ts <command>`. Either way it manages the installed home,
// `CLAUDE_HUB_HOME` or `~/.claude-hub`, never a checkout's dev home.
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, Layer } from "effect"
import { Command } from "effect/cli"
import { cli } from "./Cli.ts"
import { Shell } from "./Shell.ts"
import { Ui } from "./Ui.ts"

/** The commit the CLI runs from, as its version. */
function version(): string {
  const git = Bun.spawnSync(["git", "rev-parse", "--short=12", "HEAD"], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "ignore",
  })
  return git.exitCode === 0 ? git.stdout.toString().trim() : "unknown"
}

Command.run(cli, { version: version() }).pipe(
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
  Effect.provide(Layer.mergeAll(Shell.layer, Ui.layer).pipe(Layer.provideMerge(BunServices.layer))),
  BunRuntime.runMain,
)
