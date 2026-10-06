// Pairing codes (GLOSSARY.md, issue #85): what lets a machine become a Runner without anyone
// touching the Hub's machine. A signed-in person mints one on the Runners page; the machine
// redeems it once, within 15 minutes, with `POST /runner/pair`, for a lasting Runner token.
//
// - The Hub keeps only a code's SHA-256. A code is 100 random bits, so guessing one in its 15
//   minutes is hopeless, and hashing it unsalted loses nothing; there is no rate limit, which
//   would only let a stranger lock everyone out of pairing.
// - Every refused code is refused alike (PairingCodeRefused), whether it never existed, expired,
//   was used or was revoked.
// - A code for a Runner (a Re-pair) replaces that Runner's token, keeping its RunnerId and its
//   Sessions. Any other code registers a new Runner by the name the machine asks for.
// - Revoking or expiring a code changes nothing for a Runner already paired with it: the code is
//   only how the token was handed over.

import { randomBytes } from "node:crypto"
import {
  checkRunnerName,
  formatPairingCode,
  type Paired,
  PairingAlphabet,
  PairingCodeId,
  PairingCodeLength,
  PairingCodeLifetimeMs,
  PairingCodeRefused,
  type Participant,
  ParticipantId,
  type PendingPairingCode,
  RunnerId,
} from "@kndl/protocol"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { hashSecret, mintToken, randomId } from "./Tokens.ts"

/** A new code: {@link PairingCodeLength} characters of the alphabet, each from 5 random bits. */
export function newPairingCode(random: (size: number) => Uint8Array = randomBytes): string {
  // 256 is a multiple of 32, so the low 5 bits of a random byte are uniform.
  return Array.from(random(PairingCodeLength), (byte) => PairingAlphabet[byte & 31]).join("")
}

/** What the Hub keeps of a code: the SHA-256 of its normalized characters. */
export const hashPairingCode = (code: string) => hashSecret(code)

/** Where a code stands, as its row says. */
export type PairingCodeState = "Usable" | "Used" | "Revoked" | "Expired"

export function pairingCodeState(
  row: {
    readonly expiresAt: number
    readonly usedAt: number | null
    readonly revokedAt: number | null
  },
  now: number,
): PairingCodeState {
  if (row.usedAt !== null) return "Used"
  if (row.revokedAt !== null) return "Revoked"
  return now < row.expiresAt ? "Usable" : "Expired"
}

/** A redemption refused: `status` is the HTTP status it is answered with. */
// oxlint-disable-next-line unicorn/throw-new-error -- Effect makes error classes with a factory call
export class PairingRefused extends Schema.TaggedError<PairingRefused>()("PairingRefused", {
  status: Schema.Number,
  message: Schema.String,
}) {}

const refused = (status: number, message: string) => new PairingRefused({ status, message })

/** A mint refused, such as a Re-pair of a Runner that was removed. */
// oxlint-disable-next-line unicorn/throw-new-error -- Effect makes error classes with a factory call
export class MintRefused extends Schema.TaggedError<MintRefused>()("MintRefused", {
  message: Schema.String,
}) {}

/** A code minted: shown to its maker once, never kept. */
export interface MintedPairingCode {
  readonly id: PairingCodeId
  /** The code, in groups of five. */
  readonly code: string
  readonly expiresAt: number
  readonly runnerId?: RunnerId
}

/** A Runner a redemption replaced the token of, or registered. */
export type Redeemed = Paired & {
  /** The id of the code spent. */
  readonly pairingCodeId: PairingCodeId
}

interface CodeRow {
  readonly id: string
  readonly runnerId: string | null
  readonly expiresAt: number
  readonly usedAt: number | null
  readonly revokedAt: number | null
}

export class PairingCodes extends Context.Service<
  PairingCodes,
  {
    /**
     * A new code, by `by`: for a new Runner, or for `runnerId` to Re-pair it. Fails with
     * MintRefused when that Runner isn't one (or was removed).
     */
    readonly mint: (
      by: Participant,
      runnerId?: RunnerId,
    ) => Effect.Effect<MintedPairingCode, SqlError | MintRefused>
    /** Revokes a code not yet used; one used, expired or unknown is left as it is. */
    readonly revoke: (id: PairingCodeId) => Effect.Effect<void, SqlError>
    /** Revokes the codes not yet used for a Runner, as when it is removed. */
    readonly revokeFor: (runnerId: RunnerId) => Effect.Effect<void, SqlError>
    /** The codes not yet used, revoked or expired, oldest first. */
    readonly pending: Effect.Effect<ReadonlyArray<PendingPairingCode>, SqlError>
    /**
     * Spends a code (already normalized; anything else is refused alike): replaces its Runner's
     * token, or registers a Runner called `name`. A refused name leaves the code unspent.
     */
    readonly redeem: (
      code: string,
      name: string,
    ) => Effect.Effect<Redeemed, SqlError | PairingRefused>
  }
>()("@kndl/hub/PairingCodes") {
  static readonly layer = Layer.effect(
    PairingCodes,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const mint = Effect.fn("PairingCodes.mint")(function* (by: Participant, runnerId?: RunnerId) {
        if (runnerId !== undefined) {
          const runner = yield* sql<{ readonly id: string }>`
            SELECT id FROM runners WHERE id = ${runnerId} AND removed_at IS NULL
          `
          if (runner.length === 0) {
            return yield* new MintRefused({ message: "There is no such Runner." })
          }
        }
        const now = yield* Clock.currentTimeMillis
        const code = newPairingCode()
        const id = PairingCodeId.make(randomId())
        const expiresAt = now + PairingCodeLifetimeMs
        yield* sql`
          INSERT INTO pairing_codes (id, code_hash, runner_id, created_by, created_at, expires_at)
          VALUES (${id}, ${hashPairingCode(code)}, ${runnerId ?? null}, ${by.id}, ${now}, ${expiresAt})
        `
        return {
          id,
          code: formatPairingCode(code),
          expiresAt,
          ...(runnerId !== undefined && { runnerId }),
        }
      })

      const revoke = Effect.fn("PairingCodes.revoke")(function* (id: PairingCodeId) {
        const now = yield* Clock.currentTimeMillis
        yield* sql`
          UPDATE pairing_codes SET revoked_at = ${now}
          WHERE id = ${id} AND used_at IS NULL AND revoked_at IS NULL
        `
      })

      const revokeFor = Effect.fn("PairingCodes.revokeFor")(function* (runnerId: RunnerId) {
        const now = yield* Clock.currentTimeMillis
        yield* sql`
          UPDATE pairing_codes SET revoked_at = ${now}
          WHERE runner_id = ${runnerId} AND used_at IS NULL AND revoked_at IS NULL
        `
      })

      const pending = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const rows = yield* sql<{
          readonly id: string
          readonly runnerId: string | null
          readonly createdAt: number
          readonly expiresAt: number
          readonly byId: string
          readonly byLogin: string
          readonly byName: string
          readonly byAvatarUrl: string | null
        }>`
          SELECT c.id, c.runner_id AS runnerId, c.created_at AS createdAt,
                 c.expires_at AS expiresAt, p.id AS byId, p.login AS byLogin,
                 p.name AS byName, p.avatar_url AS byAvatarUrl
          FROM pairing_codes c JOIN participants p ON p.id = c.created_by
          WHERE c.used_at IS NULL AND c.revoked_at IS NULL AND c.expires_at > ${now}
          ORDER BY c.created_at, c.id
        `
        return rows.map((row): PendingPairingCode => ({
          id: PairingCodeId.make(row.id),
          ...(row.runnerId !== null && { runnerId: RunnerId.make(row.runnerId) }),
          createdBy: {
            id: ParticipantId.make(row.byId),
            login: row.byLogin,
            name: row.byName,
            ...(row.byAvatarUrl !== null && { avatarUrl: row.byAvatarUrl }),
          },
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
        }))
      }).pipe(Effect.withSpan("PairingCodes.pending"))

      const redeem = Effect.fn("PairingCodes.redeem")(function* (code: string, name: string) {
        const now = yield* Clock.currentTimeMillis
        const rows = yield* sql<CodeRow>`
            SELECT id, runner_id AS runnerId, expires_at AS expiresAt, used_at AS usedAt,
                   revoked_at AS revokedAt
            FROM pairing_codes WHERE code_hash = ${hashPairingCode(code)}
          `
        const row = rows[0]
        if (row === undefined || pairingCodeState(row, now) !== "Usable") {
          return yield* refused(403, PairingCodeRefused)
        }
        const pairingCodeId = PairingCodeId.make(row.id)

        let runner: { readonly id: string; readonly name: string }
        if (row.runnerId !== null) {
          const [found] = yield* sql<{ readonly id: string; readonly name: string }>`
              SELECT id, name FROM runners WHERE id = ${row.runnerId} AND removed_at IS NULL
            `
          // Removing a Runner revokes its codes, so this is a Runner removed meanwhile.
          if (found === undefined) return yield* refused(403, PairingCodeRefused)
          runner = found
        } else {
          const invalid = checkRunnerName(name)
          if (invalid !== undefined) return yield* refused(400, invalid)
          const [taken] = yield* sql<{ readonly id: string; readonly removedAt: number | null }>`
              SELECT id, removed_at AS removedAt FROM runners WHERE name = ${name}
            `
          if (taken !== undefined && taken.removedAt === null) {
            return yield* refused(
              409,
              `The Hub already has a Runner named ${name}. Choose another name with --name, or, to put this machine in its place, Re-pair ${name} on the Runners page and join with that code.`,
            )
          }
          // A removed Runner's name is free again: the machine takes over its row, and with it
          // its Archived Sessions.
          runner = { id: taken?.id ?? randomId(), name }
        }

        const minted = mintToken("runner", runner.id)
        yield* sql`
            INSERT INTO runners (id, name, secret_hash, created_at)
            VALUES (${runner.id}, ${runner.name}, ${minted.secretHash}, ${now})
            ON CONFLICT (id) DO UPDATE SET secret_hash = excluded.secret_hash, removed_at = NULL
          `
        yield* sql`UPDATE pairing_codes SET used_at = ${now} WHERE id = ${row.id}`
        return {
          pairingCodeId,
          runnerId: RunnerId.make(runner.id),
          name: runner.name,
          token: minted.token,
          repaired: row.runnerId !== null,
        }
      }, sql.withTransaction)

      return PairingCodes.of({ mint, revoke, revokeFor, pending, redeem })
    }),
  )
}
