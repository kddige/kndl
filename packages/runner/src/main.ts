// The Runner: a host machine connected to the Hub that runs Sessions in Sandboxes, each on its
// Creator's Claude credential.
// Configured from the environment; see RunnerConfig.ts and the README.

import { resolve } from "node:path"
import { BunRuntime, BunServices, BunSocket } from "@effect/platform-bun"
import { FormerName, formerServiceRole, moveFromFormerService } from "@kndl/protocol/former-name"
import { Effect, Layer } from "effect"
import { RelayConfigLive } from "./relay/RelayConfig.ts"
import { runRunner, SessionsHost } from "./Runner.ts"
import { missingModBundle, RunnerConfigLive } from "./RunnerConfig.ts"
import { LoadCheckVariable } from "./SelfUpdate.ts"
import { UpdaterLive } from "./Updater.ts"

const RunnerLive = UpdaterLive.pipe(
  Layer.provideMerge(SessionsHost),
  Layer.provideMerge(Layer.mergeAll(RunnerConfigLive, RelayConfigLive)),
  Layer.provideMerge(Layer.mergeAll(BunServices.layer, BunSocket.layerWebSocketConstructor)),
)

// A Runner of the former name, updating itself to this commit, checks it loads under its own
// variable (ADR 0017), which it sets beside its service's: so this comes first.
if (process.env[LoadCheckVariable] === "1" || process.env[FormerName.loadCheckVariable] === "1") {
  // Started by an update, on the commit it moves to, only to check the Runner loads: every module
  // above was imported. The mod must be built too, which the Runner refuses to start without.
  const missing = missingModBundle(resolve(import.meta.dir, "../../mod"))
  if (missing !== undefined) {
    console.error(`The mod isn't built: ${missing} is missing.`)
    process.exit(1)
  }
  console.log("The Runner loads.")
  process.exit(0)
}

// Started by a service of the former name, the Runner moves the install to kndl's names first.
if (formerServiceRole(process.env) === "runner") moveFromFormerService("runner")

BunRuntime.runMain(runRunner().pipe(Effect.provide(RunnerLive)))
