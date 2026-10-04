import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto"
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { HubConfig, HubConfigError, SecretsKeyBytes } from "./HubConfig.ts"

// Sensitive variable values at rest (ADR 0009): AES-256-GCM under HUB_SECRETS_KEY, with a fresh
// 12-byte IV per value and what the value belongs to as additional data, so a ciphertext can't
// be moved to another variable. Stored as `v1:<iv>:<ciphertext>:<tag>`, each part base64url.
//
// A check value, the encryption of a known text, is stored with them, so a wrong key is caught
// when the Hub starts rather than when a Session first needs a value.

const format = "v1"
const checkText = "claude-hub secrets check"
const checkContext = "secrets-check"

/** Encrypts `plaintext` under `key`, bound to `context`. */
export function encryptValue(key: Uint8Array, plaintext: string, context: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  cipher.setAAD(Buffer.from(context, "utf8"))
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const parts = [iv, ciphertext, cipher.getAuthTag()].map((part) => part.toString("base64url"))
  return [format, ...parts].join(":")
}

/** Decrypts what {@link encryptValue} made, or `undefined` for a wrong key, context or tampering. */
export function decryptValue(key: Uint8Array, stored: string, context: string): string | undefined {
  const [version, iv, ciphertext, tag, ...rest] = stored.split(":")
  if (version !== format || iv === undefined || ciphertext === undefined || tag === undefined) {
    return undefined
  }
  if (rest.length > 0) return undefined
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"))
    decipher.setAAD(Buffer.from(context, "utf8"))
    decipher.setAuthTag(Buffer.from(tag, "base64url"))
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8")
  } catch {
    return undefined
  }
}

/** A new key for HUB_SECRETS_KEY, base64. */
export function generateSecretsKey(): string {
  return randomBytes(SecretsKeyBytes).toString("base64")
}

/** A Sensitive value can't be saved or read: there is no key. */
// oxlint-disable-next-line unicorn/throw-new-error -- Effect makes error classes with a factory call
export class SecretsUnavailable extends Schema.TaggedError<SecretsUnavailable>()(
  "SecretsUnavailable",
  { message: Schema.String },
) {}

const noKey = new SecretsUnavailable({
  message:
    "Sensitive values need HUB_SECRETS_KEY in the Hub's configuration: run `bun run secrets-key`, put the key in packages/hub/.env.local, and restart the Hub.",
})

/** What to do when the key the stored values were saved with is gone. */
const lostKey =
  "If that key is lost, `bun run secrets-reset` (or `claude-hub secrets reset`) clears those values, keeping their variables, so a new key can be used."

/**
 * Encrypts and decrypts Sensitive values with the key from the Hub's config. Building it checks
 * the key against the stored check value, and fails when Sensitive values are stored but the key
 * is missing or wrong, so the Hub refuses to start.
 */
export class Secrets extends Context.Service<
  Secrets,
  {
    /** Whether a key is configured, so Sensitive values can be saved. */
    readonly available: boolean
    readonly encrypt: (
      value: Redacted.Redacted<string>,
      context: string,
    ) => Effect.Effect<string, SecretsUnavailable>
    readonly decrypt: (
      stored: string,
      context: string,
    ) => Effect.Effect<Redacted.Redacted<string>, SecretsUnavailable>
    /**
     * A digest of `text` that reveals nothing of it without the key: an HMAC-SHA256 keyed from
     * the secrets key, or a plain SHA-256-sized HMAC under a fixed key when there is none (and so
     * no Sensitive values to hide).
     */
    readonly digest: (text: string) => string
  }
>()("@claude-hub/hub/Secrets") {
  static readonly layer = Layer.effect(
    Secrets,
    Effect.gen(function* () {
      const config = yield* HubConfig
      const sql = yield* SqlClient.SqlClient
      const key = Option.map(config.secretsKey, Redacted.value)

      const counted = yield* sql<{ readonly count: number }>`
        SELECT
          (SELECT COUNT(*) FROM environment_variables
            WHERE kind = 'Sensitive' AND value IS NOT NULL) +
          (SELECT COUNT(*) FROM shared_variables WHERE kind = 'Sensitive' AND value IS NOT NULL) +
          (SELECT COUNT(*) FROM retired_values) AS count
      `.pipe(Effect.orDie)
      const stored = counted[0]?.count ?? 0
      const checks = yield* sql<{ readonly ciphertext: string }>`
        SELECT ciphertext FROM secrets_check WHERE id = 1
      `.pipe(Effect.orDie)
      const check = checks[0]?.ciphertext

      if (Option.isNone(key)) {
        if (stored > 0) {
          return yield* new HubConfigError({
            message: `The Hub stores ${stored} Sensitive variable value${stored === 1 ? "" : "s"}, encrypted, but HUB_SECRETS_KEY is not set. Set it to the key they were saved with. ${lostKey}`,
          })
        }
      } else {
        const matches =
          check !== undefined && decryptValue(key.value, check, checkContext) === checkText
        if (!matches && stored > 0) {
          return yield* new HubConfigError({
            message: `HUB_SECRETS_KEY is not the key the Hub's ${stored} Sensitive variable value${stored === 1 ? " was" : "s were"} saved with. Set it to that key. ${lostKey}`,
          })
        }
        if (!matches) {
          // Nothing is encrypted yet: this key is the one from now on.
          const ciphertext = encryptValue(key.value, checkText, checkContext)
          yield* sql`
            INSERT INTO secrets_check (id, ciphertext) VALUES (1, ${ciphertext})
            ON CONFLICT (id) DO UPDATE SET ciphertext = excluded.ciphertext
          `.pipe(Effect.orDie)
        }
      }

      const digestKey = Option.match(key, {
        onNone: () => Buffer.from("claude-hub environment digest"),
        onSome: (bytes) =>
          createHmac("sha256", bytes).update("claude-hub environment digest").digest(),
      })

      return Secrets.of({
        available: Option.isSome(key),
        encrypt: (value, context) =>
          Option.match(key, {
            onNone: () => Effect.fail(noKey),
            onSome: (bytes) =>
              Effect.sync(() => encryptValue(bytes, Redacted.value(value), context)),
          }),
        decrypt: (ciphertext, context) =>
          Option.match(key, {
            onNone: () => Effect.fail(noKey),
            onSome: (bytes) => {
              const plaintext = decryptValue(bytes, ciphertext, context)
              // The key was checked at start-up, so this is a damaged or moved row.
              return plaintext === undefined
                ? Effect.fail(
                    new SecretsUnavailable({
                      message: "A stored Sensitive value could not be decrypted.",
                    }),
                  )
                : Effect.succeed(Redacted.make(plaintext))
            },
          }),
        digest: (text) => createHmac("sha256", digestKey).update(text).digest("hex"),
      })
    }),
  )
}
