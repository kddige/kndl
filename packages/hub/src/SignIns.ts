import { Participant, ParticipantId } from "@kndl/protocol"
import { Clock, Context, Duration, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { mintToken, parseToken, secretMatches } from "./Tokens.ts"

/** How long a sign-in lasts before the person has to sign in again. */
export const signInDuration = Duration.days(30)

/** A new sign-in: the cookie value to hand the browser once, and when it expires. */
export interface NewSignIn {
  readonly participant: Participant
  readonly token: string
  readonly expiresAt: Date
}

/**
 * People signed in to the Hub. A sign-in is the token in a browser's cookie; the Hub keeps only
 * its hash. Signing in records the person as a Participant, or updates their login, name and avatar.
 *
 * Only a Member is signed in (ADR 0019): whoever signs someone in has let them in first (Members),
 * and a sign-in stops working the moment its Member is removed. Someone the Hub first records
 * here is admitted with it; someone removed stays removed.
 */
export class SignIns extends Context.Service<
  SignIns,
  {
    readonly signIn: (participant: Participant) => Effect.Effect<NewSignIn, SqlError>
    /** The signed-in person, or none for a missing, unknown, expired or signed-out token. */
    readonly authenticate: (token: string) => Effect.Effect<Option.Option<Participant>, SqlError>
    readonly signOut: (token: string) => Effect.Effect<void, SqlError>
    /** Signs a person out everywhere, as when they are removed. */
    readonly signOutAll: (participantId: ParticipantId) => Effect.Effect<void, SqlError>
  }
>()("@kndl/hub/SignIns") {
  static readonly layer = Layer.effect(
    SignIns,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const signIn = Effect.fn("SignIns.signIn")(function* (participant: Participant) {
        const now = yield* Clock.currentTimeMillis
        const expiresAt = now + Duration.toMillis(signInDuration)
        const minted = mintToken("signIn")
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO participants (
                id, login, name, avatar_url, created_at, updated_at, admitted_at
              )
              VALUES (
                ${participant.id}, ${participant.login}, ${participant.name},
                ${participant.avatarUrl ?? null}, ${now}, ${now}, ${now}
              )
              ON CONFLICT (id) DO UPDATE SET
                login = excluded.login, name = excluded.name, avatar_url = excluded.avatar_url,
                updated_at = excluded.updated_at
            `
            yield* sql`DELETE FROM sign_ins WHERE expires_at <= ${now}`
            yield* sql`
              INSERT INTO sign_ins (id, secret_hash, participant_id, created_at, expires_at)
              VALUES (${minted.id}, ${minted.secretHash}, ${participant.id}, ${now}, ${expiresAt})
            `
          }),
        )
        return { participant, token: minted.token, expiresAt: new Date(expiresAt) }
      })

      const authenticate = Effect.fn("SignIns.authenticate")(function* (token: string) {
        const parsed = parseToken("signIn", token)
        if (parsed === undefined) return Option.none<Participant>()
        const now = yield* Clock.currentTimeMillis
        const rows = yield* sql<{
          readonly secretHash: string
          readonly expiresAt: number
          readonly id: string
          readonly login: string
          readonly name: string
          readonly avatarUrl: string | null
        }>`
          SELECT s.secret_hash AS secretHash, s.expires_at AS expiresAt, p.id, p.login, p.name,
            p.avatar_url AS avatarUrl
          FROM sign_ins s JOIN participants p ON p.id = s.participant_id
          WHERE s.id = ${parsed.id} AND p.admitted_at IS NOT NULL
        `
        const row = rows[0]
        if (
          row === undefined ||
          row.expiresAt <= now ||
          !secretMatches(parsed.secret, row.secretHash)
        ) {
          return Option.none<Participant>()
        }
        return Option.some(
          Participant.make({
            id: ParticipantId.make(row.id),
            login: row.login,
            name: row.name,
            ...(row.avatarUrl !== null && { avatarUrl: row.avatarUrl }),
          }),
        )
      })

      const signOut = Effect.fn("SignIns.signOut")(function* (token: string) {
        const parsed = parseToken("signIn", token)
        if (parsed === undefined) return
        const rows = yield* sql<{ readonly secretHash: string }>`
          SELECT secret_hash AS secretHash FROM sign_ins WHERE id = ${parsed.id}
        `
        const row = rows[0]
        if (row !== undefined && secretMatches(parsed.secret, row.secretHash)) {
          yield* sql`DELETE FROM sign_ins WHERE id = ${parsed.id}`
        }
      })

      const signOutAll = Effect.fn("SignIns.signOutAll")(function* (participantId: ParticipantId) {
        yield* sql`DELETE FROM sign_ins WHERE participant_id = ${participantId}`
      })

      return SignIns.of({ signIn, authenticate, signOut, signOutAll })
    }),
  )
}
