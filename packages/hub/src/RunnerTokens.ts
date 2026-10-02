import { RunnerId } from "@claude-hub/protocol"
import { Clock, Context, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { mintToken, parseToken, randomId, secretMatches } from "./Tokens.ts"

/** A Runner as its token identifies it. */
export interface RunnerIdentity {
  readonly runnerId: RunnerId
  readonly name: string
}

/**
 * The Runners allowed to connect, each with its own token. The Hub mints the RunnerId when it
 * issues a Runner's first token, and keeps only the token's hash.
 */
export class RunnerTokens extends Context.Service<
  RunnerTokens,
  {
    /**
     * A new token for the Runner of this name, which is registered if it is new. Issuing again
     * replaces the old token, keeping the RunnerId.
     */
    readonly issue: (
      name: string,
    ) => Effect.Effect<RunnerIdentity & { readonly token: string }, SqlError>
    /** The Runner a token belongs to, or none for anything but a current Runner token. */
    readonly authenticate: (token: string) => Effect.Effect<Option.Option<RunnerIdentity>, SqlError>
  }
>()("@claude-hub/hub/RunnerTokens") {
  static readonly layer = Layer.effect(
    RunnerTokens,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const issue = Effect.fn("RunnerTokens.issue")(function* (name: string) {
        const now = yield* Clock.currentTimeMillis
        const existing = yield* sql<{ readonly id: string }>`
          SELECT id FROM runners WHERE name = ${name}
        `
        const minted = mintToken("runner", existing[0]?.id ?? randomId())
        yield* sql`
          INSERT INTO runners (id, name, secret_hash, created_at)
          VALUES (${minted.id}, ${name}, ${minted.secretHash}, ${now})
          ON CONFLICT (id) DO UPDATE SET secret_hash = excluded.secret_hash
        `
        return { runnerId: RunnerId.make(minted.id), name, token: minted.token }
      }, sql.withTransaction)

      const authenticate = Effect.fn("RunnerTokens.authenticate")(function* (token: string) {
        const parsed = parseToken("runner", token)
        if (parsed === undefined) return Option.none<RunnerIdentity>()
        const rows = yield* sql<{ readonly name: string; readonly secretHash: string }>`
          SELECT name, secret_hash AS secretHash FROM runners WHERE id = ${parsed.id}
        `
        const row = rows[0]
        if (row === undefined || !secretMatches(parsed.secret, row.secretHash)) {
          return Option.none<RunnerIdentity>()
        }
        return Option.some({ runnerId: RunnerId.make(parsed.id), name: row.name })
      })

      return RunnerTokens.of({ issue, authenticate })
    }),
  )
}
