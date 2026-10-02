import { MaxCommandWaitMs } from "@claude-hub/protocol"
import { Layer } from "effect"
import { AuthRoutes } from "./AuthRoutes.ts"
import { ChannelRoutes } from "./Channels.ts"
import { HealthRoute } from "./Health.ts"
import { ModOutbox } from "./ModOutbox.ts"
import { ModRoutes } from "./ModRoutes.ts"
import { ModTokens } from "./ModTokens.ts"
import { PromptQueue } from "./PromptQueue.ts"
import { Runners } from "./Runners.ts"
import { RunnerTokens } from "./RunnerTokens.ts"
import { SessionLog } from "./SessionLog.ts"
import { SessionRelay } from "./SessionRelay.ts"
import { Sessions } from "./Sessions.ts"
import { SignIns } from "./SignIns.ts"

/** Every route the Hub serves. */
export const HubRoutes = Layer.mergeAll(HealthRoute, AuthRoutes, ChannelRoutes, ModRoutes)

/** The credential stores, the mod outbox and the Session relay the routes use, given a database. */
export const HubServices = SessionRelay.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      SignIns.layer,
      RunnerTokens.layer,
      ModTokens.layer,
      ModOutbox.layer,
      Sessions.layer,
      SessionLog.layer,
      PromptQueue.layer,
      Runners.layer,
    ),
  ),
)

/**
 * How long Bun keeps a quiet connection open, in seconds. Bun's default of 10 would cut off the
 * mod's long poll of `GET /mod/commands`, which can be quiet for MaxCommandWaitMs.
 */
export const idleTimeoutSeconds = Math.ceil(MaxCommandWaitMs / 1000) + 10
