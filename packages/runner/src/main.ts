// The Runner: a host machine connected to the Hub that runs Sessions on its own Runner login.
// Configured from the environment; see RunnerConfig.ts and the README.

import { BunRuntime, BunServices, BunSocket } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { runRunner, SessionsHost } from "./Runner.ts"
import { RunnerConfigLive } from "./RunnerConfig.ts"

const RunnerLive = SessionsHost.pipe(
  Layer.provideMerge(RunnerConfigLive),
  Layer.provideMerge(Layer.mergeAll(BunServices.layer, BunSocket.layerWebSocketConstructor)),
)

BunRuntime.runMain(runRunner().pipe(Effect.provide(RunnerLive)))
