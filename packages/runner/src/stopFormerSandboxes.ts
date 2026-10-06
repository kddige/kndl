// Stops the Sandboxes a Runner made under kndl's former name (ADR 0017), for the CLI's one-time
// move of an install from it (the CLI's Rename.ts), which runs this from the install's checkout:
// `bun --env-file=<home>/runner.env stopFormerSandboxes.ts <runner mark>`. The CLI leaves the
// microsandbox SDK out of its own build, so it doesn't load the backend itself.
//
// It reconciles as a Runner does when it starts knowing none of its Sessions, but under the former
// names and label: every running Sandbox carrying the mark is stopped, and nothing is destroyed.
// A line per Sandbox says what was done and which volumes it leaves, for the CLI to pass on.
import { BunRuntime } from "@effect/platform-bun"
import { FormerName } from "@kndl/protocol/former-name"
import { Console, Effect, Layer, References } from "effect"
import { make } from "./sandbox/MicrosandboxBackend.ts"
import { reconcileSandboxes } from "./sandbox/Reconcile.ts"
import { SandboxBackend } from "./sandbox/SandboxBackend.ts"

const mark = process.argv[2]
if (mark === undefined || !/^[0-9a-f]{16}$/.test(mark)) {
  console.error("Usage: stopFormerSandboxes.ts <runner mark>")
  process.exit(2)
}

const backend = Layer.effect(
  SandboxBackend,
  make({
    runner: mark,
    namePrefix: FormerName.sandboxPrefix,
    markLabel: FormerName.runnerLabel,
  }),
)

reconcileSandboxes([]).pipe(
  Effect.flatMap((report) =>
    Effect.forEach(
      report.unknown,
      (sandbox) =>
        Console.log(
          `${FormerName.sandboxPrefix}${sandbox.sessionId}: ${sandbox.stopped ? "stopped now" : sandbox.state}; volumes: ${sandbox.volumes.join(", ") || "none"}`,
        ),
      { discard: true },
    ),
  ),
  // Its own reports would repeat the lines above, as warnings.
  Effect.provideService(References.MinimumLogLevel, "Error"),
  Effect.provide(backend),
  Effect.catch((error) =>
    Effect.andThen(
      Console.error(`Couldn't list the Sandboxes: ${String(error.message ?? error)}`),
      Effect.sync(() => (process.exitCode = 1)),
    ),
  ),
  BunRuntime.runMain,
)
