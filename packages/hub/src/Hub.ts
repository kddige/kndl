import { Layer } from "effect"
import { AuthRoutes } from "./AuthRoutes.ts"
import { ChannelRoutes } from "./Channels.ts"
import { HealthRoute } from "./Health.ts"
import { ModTokens } from "./ModTokens.ts"
import { RunnerTokens } from "./RunnerTokens.ts"
import { SignIns } from "./SignIns.ts"

/** Every route the Hub serves. */
export const HubRoutes = Layer.mergeAll(HealthRoute, AuthRoutes, ChannelRoutes)

/** The credential stores the routes use, given a database. */
export const HubServices = Layer.mergeAll(SignIns.layer, RunnerTokens.layer, ModTokens.layer)
