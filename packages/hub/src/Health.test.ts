import { afterAll, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { Layer } from "effect"
import { HttpRouter } from "effect/http"
import { HealthRoute } from "./Health.ts"

const { handler, dispose } = HttpRouter.toWebHandler(
  HealthRoute.pipe(Layer.provide(SqliteClient.layer({ filename: ":memory:" }))),
  { disableLogger: true },
)
afterAll(dispose)

test("GET /health answers ok once the database answers", async () => {
  const response = await handler(new Request("http://hub.test/health"))

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ status: "ok" })
})
