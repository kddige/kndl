// The Runner: a host machine connected to the Hub that runs Sessions in Sandboxes, each on its
// Creator's Claude credential or else on the Runner's own, if it has one.
// Configured from the environment; see RunnerConfig.ts and the README.

import { resolve } from "node:path"
import { BunRuntime, BunServices, BunSocket } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { ProxyConfigLive } from "./proxy/ProxyConfig.ts"
import { runRunner, SessionsHost } from "./Runner.ts"
import { missingModBundle, RunnerConfigLive } from "./RunnerConfig.ts"
import { LoadCheckVariable } from "./SelfUpdate.ts"
import { UpdaterLive } from "./Updater.ts"

const RunnerLive = UpdaterLive.pipe(
  Layer.provideMerge(SessionsHost),
  Layer.provideMerge(Layer.mergeAll(RunnerConfigLive, ProxyConfigLive)),
  Layer.provideMerge(Layer.mergeAll(BunServices.layer, BunSocket.layerWebSocketConstructor)),
)

if (process.env[LoadCheckVariable] === "1") {
  // Started by an update, on the commit it moves to, only to check the Runner loads: every module
  // above was imported. The mod must be built too, which the Runner refuses to start without.
  const missing = missingModBundle(resolve(import.meta.dir, "../../mod"))
  if (missing !== undefined) {
    console.error(`The hub-link mod isn't built: ${missing} is missing.`)
    process.exit(1)
  }
  console.log("The Runner loads.")
  process.exit(0)
}

BunRuntime.runMain(runRunner().pipe(Effect.provide(RunnerLive)))
