// The Hub: the central server people sign in to. It knows every Session, Runner and
// Participant, and relays prompts and events between them. For now it only answers /health.
//
// Env: HOST (127.0.0.1), PORT (7777), HUB_DATABASE (hub.db).

import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Config, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { DatabaseLive } from "./Database.ts"
import { HealthRoute } from "./Health.ts"

const ServerLive = BunHttpServer.layerConfig({
  hostname: Config.String("HOST").pipe(Config.withDefault("127.0.0.1")),
  port: Config.Port("PORT").pipe(Config.withDefault(7777)),
})

const HubLive = HttpRouter.serve(HealthRoute).pipe(
  Layer.provide(DatabaseLive),
  Layer.provide(ServerLive),
)

BunRuntime.runMain(Layer.launch(HubLive))
