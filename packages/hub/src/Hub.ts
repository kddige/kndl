import { MaxCommandWaitMs } from "@claude-hub/protocol"
import { Layer } from "effect"
import { AuthRoutes } from "./AuthRoutes.ts"
import { ChannelRoutes } from "./Channels.ts"
import { HealthRoute } from "./Health.ts"
import { ModOutbox } from "./ModOutbox.ts"
import { ModRoutes } from "./ModRoutes.ts"
import { ModTokens } from "./ModTokens.ts"
import { RunnerTokens } from "./RunnerTokens.ts"
import { SignIns } from "./SignIns.ts"

/** Every route the Hub serves. */
export const HubRoutes = Layer.mergeAll(HealthRoute, AuthRoutes, ChannelRoutes, ModRoutes)

/** The credential stores and the mod outbox the routes use, given a database. */
export const HubServices = Layer.mergeAll(
  SignIns.layer,
  RunnerTokens.layer,
  ModTokens.layer,
  ModOutbox.layer,
)

/**
 * How long Bun keeps a quiet connection open, in seconds. Bun's default of 10 would cut off the
 * mod's long poll of `GET /mod/commands`, which can be quiet for MaxCommandWaitMs.
 */
export const idleTimeoutSeconds = Math.ceil(MaxCommandWaitMs / 1000) + 10
