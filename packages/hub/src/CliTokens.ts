// CLI tokens (GLOSSARY.md, issue #179, ADR 0016): what `claude-hub login` leaves on a machine, so
// the CLI can act for the person who approved it.
//
// - Signing in is two steps. On the `/cli-login` page a signed-in person approves the machine,
//   which mints a Login code bound to them, the machine's name and the PKCE challenge the CLI
//   sent. The CLI then trades the code, with the verifier only it knows, for a CLI token. So a
//   code read over someone's shoulder, or off a redirect, is no use without the CLI that asked.
// - Login codes live in memory: each lasts 10 minutes and is spent by its first trade, right or
//   wrong. A Hub restart drops them, and the CLI asks for a new one.
// - A CLI token is long-lived, as a Runner token is. The Hub keeps only its hash, checks it on
//   every request, and revoking it deletes its row, so a revoked token is refused at once.
// - Each CLI token records when it was last used, to the minute: often enough for the Account page,
//   rarely enough not to write on every request.

import { createHash, randomBytes } from "node:crypto"
import {
  CliLoginCodeLength,
  CliLoginCodeLifetimeMs,
  CliTokenId,
  type CliTokenInfo,
  formatCliLoginCode,
  normalizeCliLoginCode,
  PairingAlphabet,
  Participant,
  ParticipantId,
} from "@claude-hub/protocol"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { constantTimeEqual, hashSecret, mintToken, parseToken, secretMatches } from "./Tokens.ts"

/** How stale a CLI token's `lastUsedAt` may get before a request records it again. */
export const lastUsedResolutionMs = 60 * 1000

/** The CLI a token signs in, and for whom. */
export interface CliIdentity {
  readonly participant: Participant
  readonly id: CliTokenId
  readonly machine: string
  readonly createdAt: number
}

/** A Login code minted: shown once, by the page or the redirect, never kept. */
export interface ApprovedLogin {
  /** The code, in groups of four. */
  readonly code: string
  readonly expiresAt: number
}

/** A Login code refused: unknown, expired, spent, or traded with the wrong verifier. */
// oxlint-disable-next-line unicorn/throw-new-error -- Effect makes error classes with a factory call
export class LoginRefused extends Schema.TaggedError<LoginRefused>()("LoginRefused", {
  message: Schema.String,
}) {}

/** Every refused Login code is refused alike. */
export const loginRefusedMessage =
  "That code isn't valid: it may have expired or been used. Run claude-hub login again."

/** A new Login code: {@link CliLoginCodeLength} characters of the alphabet, 5 random bits each. */
export function newCliLoginCode(random: (size: number) => Uint8Array = randomBytes): string {
  return Array.from(random(CliLoginCodeLength), (byte) => PairingAlphabet[byte & 31]).join("")
}

/** The PKCE S256 challenge of a verifier (RFC 7636): its SHA-256, in base64url. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url")
}

interface PendingLogin {
  readonly participantId: ParticipantId
  readonly machine: string
  readonly challenge: string
  readonly expiresAt: number
}

interface TokenRow {
  readonly id: string
  readonly machine: string
  readonly createdAt: number
  readonly lastUsedAt: number | null
}

export class CliTokens extends Context.Service<
  CliTokens,
  {
    /** A Login code for `participant` to sign in the CLI on `machine` that sent `challenge`. */
    readonly approve: (
      participant: Participant,
      machine: string,
      challenge: string,
    ) => Effect.Effect<ApprovedLogin>
    /**
     * Spends a Login code: a new CLI token if `verifier` is the one its challenge was made from.
     * The code is spent either way.
     */
    readonly redeem: (
      code: string,
      verifier: string,
    ) => Effect.Effect<CliIdentity & { readonly token: string }, SqlError | LoginRefused>
    /**
     * The CLI a token signs in, or none for anything but a current CLI token. Records that it was
     * used.
     */
    readonly authenticate: (token: string) => Effect.Effect<Option.Option<CliIdentity>, SqlError>
    /** A person's CLI tokens, newest first. */
    readonly list: (
      participantId: ParticipantId,
    ) => Effect.Effect<ReadonlyArray<CliTokenInfo>, SqlError>
    /** Revokes one of a person's CLI tokens. False when they have no such token. */
    readonly revoke: (
      participantId: ParticipantId,
      id: CliTokenId,
    ) => Effect.Effect<boolean, SqlError>
  }
>()("@claude-hub/hub/CliTokens") {
  static readonly layer = Layer.effect(
    CliTokens,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      /** Pending Login codes, by the hash of the normalized code. */
      const pending = new Map<string, PendingLogin>()

      const forgetExpired = (now: number) => {
        for (const [hash, login] of pending) if (login.expiresAt <= now) pending.delete(hash)
      }

      const approve = Effect.fn("CliTokens.approve")(function* (
        participant: Participant,
        machine: string,
        challenge: string,
      ) {
        const now = yield* Clock.currentTimeMillis
        forgetExpired(now)
        const code = newCliLoginCode()
        const expiresAt = now + CliLoginCodeLifetimeMs
        pending.set(hashSecret(code), {
          participantId: participant.id,
          machine,
          challenge,
          expiresAt,
        })
        return { code: formatCliLoginCode(code), expiresAt }
      })

      const redeem = Effect.fn("CliTokens.redeem")(function* (code: string, verifier: string) {
        const now = yield* Clock.currentTimeMillis
        forgetExpired(now)
        const normalized = normalizeCliLoginCode(code)
        const hash = normalized === undefined ? undefined : hashSecret(normalized)
        const login = hash === undefined ? undefined : pending.get(hash)
        if (hash !== undefined) pending.delete(hash)
        if (login === undefined || !constantTimeEqual(pkceChallenge(verifier), login.challenge)) {
          return yield* new LoginRefused({ message: loginRefusedMessage })
        }
        const rows = yield* sql<{
          readonly id: string
          readonly login: string
          readonly name: string
          readonly avatarUrl: string | null
        }>`
          SELECT id, login, name, avatar_url AS avatarUrl FROM participants
          WHERE id = ${login.participantId}
        `
        const row = rows[0]
        if (row === undefined) return yield* new LoginRefused({ message: loginRefusedMessage })
        const minted = mintToken("cli")
        yield* sql`
          INSERT INTO cli_tokens (id, participant_id, machine, secret_hash, created_at)
          VALUES (${minted.id}, ${login.participantId}, ${login.machine}, ${minted.secretHash}, ${now})
        `
        return {
          participant: participantOf(row),
          id: CliTokenId.make(minted.id),
          machine: login.machine,
          createdAt: now,
          token: minted.token,
        }
      })

      const authenticate = Effect.fn("CliTokens.authenticate")(function* (token: string) {
        const parsed = parseToken("cli", token)
        if (parsed === undefined) return Option.none<CliIdentity>()
        const rows = yield* sql<{
          readonly secretHash: string
          readonly machine: string
          readonly createdAt: number
          readonly lastUsedAt: number | null
          readonly id: string
          readonly login: string
          readonly name: string
          readonly avatarUrl: string | null
        }>`
          SELECT t.secret_hash AS secretHash, t.machine, t.created_at AS createdAt,
            t.last_used_at AS lastUsedAt, p.id, p.login, p.name, p.avatar_url AS avatarUrl
          FROM cli_tokens t JOIN participants p ON p.id = t.participant_id
          WHERE t.id = ${parsed.id}
        `
        const row = rows[0]
        if (row === undefined || !secretMatches(parsed.secret, row.secretHash)) {
          return Option.none<CliIdentity>()
        }
        const now = yield* Clock.currentTimeMillis
        if (row.lastUsedAt === null || now - row.lastUsedAt >= lastUsedResolutionMs) {
          yield* sql`UPDATE cli_tokens SET last_used_at = ${now} WHERE id = ${parsed.id}`
        }
        return Option.some({
          participant: participantOf(row),
          id: CliTokenId.make(parsed.id),
          machine: row.machine,
          createdAt: row.createdAt,
        })
      })

      const list = Effect.fn("CliTokens.list")(function* (participantId: ParticipantId) {
        const rows = yield* sql<TokenRow>`
          SELECT id, machine, created_at AS createdAt, last_used_at AS lastUsedAt
          FROM cli_tokens WHERE participant_id = ${participantId}
          ORDER BY created_at DESC, id
        `
        return rows.map((row): CliTokenInfo => ({
          id: CliTokenId.make(row.id),
          machine: row.machine,
          createdAt: row.createdAt,
          ...(row.lastUsedAt !== null && { lastUsedAt: row.lastUsedAt }),
        }))
      })

      const revoke = Effect.fn("CliTokens.revoke")(function* (
        participantId: ParticipantId,
        id: CliTokenId,
      ) {
        const deleted = yield* sql<{ readonly id: string }>`
          DELETE FROM cli_tokens WHERE id = ${id} AND participant_id = ${participantId}
          RETURNING id
        `
        return deleted.length > 0
      })

      return CliTokens.of({ approve, redeem, authenticate, list, revoke })
    }),
  )
}

function participantOf(row: {
  readonly id: string
  readonly login: string
  readonly name: string
  readonly avatarUrl: string | null
}): Participant {
  return Participant.make({
    id: ParticipantId.make(row.id),
    login: row.login,
    name: row.name,
    ...(row.avatarUrl !== null && { avatarUrl: row.avatarUrl }),
  })
}
