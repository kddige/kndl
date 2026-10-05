// The Runner: a host machine connected to the Hub that runs Sessions on its own Runner login.
// Configured from the environment; see RunnerConfig.ts and the README.

import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { BunRuntime, BunServices, BunSocket } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { runRunner, SessionsHost } from "./Runner.ts"
import { ModBundle, RunnerConfigLive } from "./RunnerConfig.ts"
import { LoadCheckVariable } from "./SelfUpdate.ts"
import { UpdaterLive } from "./Updater.ts"

const RunnerLive = UpdaterLive.pipe(
  Layer.provideMerge(SessionsHost),
  Layer.provideMerge(RunnerConfigLive),
  Layer.provideMerge(Layer.mergeAll(BunServices.layer, BunSocket.layerWebSocketConstructor)),
)

if (process.env[LoadCheckVariable] === "1") {
  // Started by an update, on the commit it moves to, only to check the Runner loads: every module
  // above was imported. The mod must be built too, which the Runner refuses to start without.
  const bundle = join(resolve(import.meta.dir, "../../mod"), ModBundle)
  if (!existsSync(bundle)) {
    console.error(`The hub-link mod isn't built: ${bundle} is missing.`)
    process.exit(1)
  }
  console.log("The Runner loads.")
  process.exit(0)
}

BunRuntime.runMain(runRunner().pipe(Effect.provide(RunnerLive)))
