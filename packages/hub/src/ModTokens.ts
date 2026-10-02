import { RunnerId, SessionId } from "@claude-hub/protocol"
import { Clock, Context, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { mintToken, parseToken, secretMatches } from "./Tokens.ts"

/** What a mod token allows: speaking for one Session, started on one Runner. */
export interface ModGrant {
  readonly sessionId: SessionId
  readonly runnerId: RunnerId
}

/**
 * The tokens Sessions' mods authenticate with. Each is scoped to one Session: the Hub issues it
 * for `StartSession.modToken`, the Runner passes it to Claude Code's environment on the host, and
 * it never enters the Sandbox (ADR 0004). The Hub keeps only its hash.
 */
export class ModTokens extends Context.Service<
  ModTokens,
  {
    /** A new token for the Session's mod, replacing any earlier one for the Session. */
    readonly issue: (grant: ModGrant) => Effect.Effect<string, SqlError>
    /** The Session a token speaks for, or none for anything but a current mod token. */
    readonly authenticate: (token: string) => Effect.Effect<Option.Option<ModGrant>, SqlError>
    /** Invalidates the Session's mod token, as when its Claude Code stops. */
    readonly revoke: (sessionId: SessionId) => Effect.Effect<void, SqlError>
  }
>()("@claude-hub/hub/ModTokens") {
  static readonly layer = Layer.effect(
    ModTokens,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const issue = Effect.fn("ModTokens.issue")(function* (grant: ModGrant) {
        const now = yield* Clock.currentTimeMillis
        const minted = mintToken("mod")
        yield* sql`DELETE FROM mod_tokens WHERE session_id = ${grant.sessionId}`
        yield* sql`
          INSERT INTO mod_tokens (id, session_id, runner_id, secret_hash, created_at)
          VALUES (${minted.id}, ${grant.sessionId}, ${grant.runnerId}, ${minted.secretHash}, ${now})
        `
        return minted.token
      }, sql.withTransaction)

      const authenticate = Effect.fn("ModTokens.authenticate")(function* (token: string) {
        const parsed = parseToken("mod", token)
        if (parsed === undefined) return Option.none<ModGrant>()
        const rows = yield* sql<{
          readonly sessionId: string
          readonly runnerId: string
          readonly secretHash: string
        }>`
          SELECT session_id AS sessionId, runner_id AS runnerId, secret_hash AS secretHash
          FROM mod_tokens WHERE id = ${parsed.id}
        `
        const row = rows[0]
        if (row === undefined || !secretMatches(parsed.secret, row.secretHash)) {
          return Option.none<ModGrant>()
        }
        return Option.some({
          sessionId: SessionId.make(row.sessionId),
          runnerId: RunnerId.make(row.runnerId),
        })
      })

      const revoke = Effect.fn("ModTokens.revoke")(function* (sessionId: SessionId) {
        yield* sql`DELETE FROM mod_tokens WHERE session_id = ${sessionId}`
      })

      return ModTokens.of({ issue, authenticate, revoke })
    }),
  )
}
