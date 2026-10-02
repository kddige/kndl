import { RunnerId, type RunnerLogin } from "@claude-hub/protocol"
import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"

/** A Runner that has connected at least once, so its Runner login is known. */
export interface KnownRunner {
  readonly id: RunnerId
  readonly name: string
  readonly login: RunnerLogin
}

/**
 * What the Hub remembers about Runners beyond their tokens (RunnerTokens.ts): the Runner login
 * each last said hello with, so the web UI can list Runners that are offline too.
 */
export class Runners extends Context.Service<
  Runners,
  {
    readonly recordLogin: (id: RunnerId, login: RunnerLogin) => Effect.Effect<void, SqlError>
    /** Every Runner that has said hello at least once, by name. */
    readonly list: Effect.Effect<ReadonlyArray<KnownRunner>, SqlError>
  }
>()("@claude-hub/hub/Runners") {
  static readonly layer = Layer.effect(
    Runners,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const recordLogin = Effect.fn("Runners.recordLogin")(function* (
        id: RunnerId,
        login: RunnerLogin,
      ) {
        yield* sql`UPDATE runners SET login_account = ${login.account} WHERE id = ${id}`
      })

      const list = sql<{ readonly id: string; readonly name: string; readonly account: string }>`
        SELECT id, name, login_account AS account FROM runners
        WHERE login_account IS NOT NULL ORDER BY name
      `.pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            id: RunnerId.make(row.id),
            name: row.name,
            login: { account: row.account },
          })),
        ),
        Effect.withSpan("Runners.list"),
      )

      return Runners.of({ recordLogin, list })
    }),
  )
}
