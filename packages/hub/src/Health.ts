import { HubHealth } from "@kndl/protocol"
import { Effect } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { SqlClient } from "effect/sql"

/** `GET /health`: 200 with a `HubHealth` once the database answers, 503 otherwise. */
export const HealthRoute = HttpRouter.use(
  Effect.fn(function* (router) {
    const sql = yield* SqlClient.SqlClient

    yield* router.add(
      "GET",
      "/health",
      sql`select 1`.pipe(
        Effect.flatMap(() => HttpServerResponse.schemaJson(HubHealth)({ status: "ok" })),
        Effect.catchTag("SqlError", () =>
          Effect.succeed(HttpServerResponse.text("database unavailable", { status: 503 })),
        ),
      ),
    )
  }),
)
