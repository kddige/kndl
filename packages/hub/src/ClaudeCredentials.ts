// Each person's Claude credential, stored on the Hub (ADR 0015, issue #150).
//
// - One per person: a subscription token (`claude setup-token`) with the plan it is on, or an
//   Anthropic API key. Encrypted at rest like Sensitive values (Secrets.ts), bound to its owner,
//   and cleared by `secrets-reset` (SecretsReset.ts).
// - Checked with Anthropic before it is stored (ClaudeCheck): one free `count_tokens` request.
//   A credential Anthropic rejects is refused; one it can't be asked about is stored with a
//   warning, so a slow or unreachable Anthropic never blocks saving.
// - Write-only: its owner is shown its kind, last 4 characters, plan and when it was added, never
//   the value. Only the Runner a Session runs on is sent it, to keep in memory (SessionRelay.ts).
// - Every value, and every one replaced or removed since the Hub started, is masked in what
//   Sessions print (Redaction.ts), though Claude Code in the Sandbox never holds one.
import {
  type ClaudeCredential,
  type ClaudeCredentialInfo,
  type ClaudePlanChoice,
  ClaudePlanChoice as ClaudePlanChoiceSchema,
  claudeCredentialKindOf,
  claudeCredentialOf,
  claudeCredentialProblem,
  type EpochMillis,
  type ParticipantId,
} from "@kndl/protocol"
import { Clock, Context, Duration, Effect, Layer, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { Secrets } from "./Secrets.ts"

// ── Checking with Anthropic ────────────────────────────────────────────────

/** What Anthropic said of a credential. */
export type ClaudeCheckResult =
  | { readonly _tag: "Valid" }
  /** Anthropic refused it: `message` says why, for its owner. */
  | { readonly _tag: "Rejected"; readonly message: string }
  /** Anthropic couldn't be asked, or gave no clear answer: `warning` says so, for its owner. */
  | { readonly _tag: "Unconfirmed"; readonly warning: string }

const countTokensUrl = "https://api.anthropic.com/v1/messages/count_tokens"
/** Any model takes a count; counting is free and spends no rate limit worth noting. */
const checkModel = "claude-opus-5-5"
/** What Anthropic needs to take a subscription token on its API, as Claude Code sends. */
const oauthBeta = "oauth-2025-04-20"
const checkTimeout = Duration.seconds(10)

/** A check Anthropic gave no clear answer to, and why, for the credential's owner. */
function unconfirmed(why: string): ClaudeCheckResult {
  return {
    _tag: "Unconfirmed",
    warning: `Saved without checking it: ${why}. If it is wrong, Sessions on it can't run a Turn; replace it here.`,
  }
}

const AnthropicError = Schema.Struct({
  error: Schema.Struct({ type: Schema.String, message: Schema.String }),
})
const decodeAnthropicError = Schema.decodeUnknownOption(AnthropicError)

const whatItIs = (credential: ClaudeCredential) =>
  credential._tag === "ApiKey" ? "API key" : "token"

/** How long a reason from Anthropic is kept, so a strange answer can't flood the page. */
const reasonLimit = 200

/**
 * Asks Anthropic whether a Claude credential is valid. The live layer sends one
 * `POST /v1/messages/count_tokens`; the test layer asks no one.
 */
export class ClaudeCheck extends Context.Service<
  ClaudeCheck,
  { readonly check: (credential: ClaudeCredential) => Effect.Effect<ClaudeCheckResult> }
>()("@kndl/hub/ClaudeCheck") {
  static readonly layer = Layer.effect(
    ClaudeCheck,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const check = Effect.fn("ClaudeCheck.check")(function* (credential: ClaudeCredential) {
        const auth =
          credential._tag === "ApiKey"
            ? { "x-api-key": Redacted.value(credential.key) }
            : {
                authorization: `Bearer ${Redacted.value(credential.token)}`,
                "anthropic-beta": oauthBeta,
              }
        const request = HttpClientRequest.post(countTokensUrl).pipe(
          HttpClientRequest.setHeaders({
            ...auth,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          }),
          HttpClientRequest.bodyJsonUnsafe({
            model: checkModel,
            messages: [{ role: "user", content: "hi" }],
          }),
        )
        const answer = yield* client.execute(request).pipe(
          Effect.flatMap((response) =>
            response.status >= 200 && response.status < 300
              ? Effect.succeed<ClaudeCheckResult>({ _tag: "Valid" })
              : response.text.pipe(
                  Effect.map((body): ClaudeCheckResult => {
                    const error = decodeAnthropicError(safeJson(body))
                    const type = error._tag === "Some" ? error.value.error.type : undefined
                    const reason = error._tag === "Some" ? error.value.error.message : undefined
                    const refused =
                      response.status === 401 ||
                      (response.status === 403 &&
                        (type === "authentication_error" || type === "permission_error"))
                    if (refused) {
                      const said = reason === undefined ? "" : `: ${reason.slice(0, reasonLimit)}`
                      return {
                        _tag: "Rejected",
                        message: `Anthropic rejected this ${whatItIs(credential)}${said}`,
                      }
                    }
                    return unconfirmed(`Anthropic answered ${response.status}`)
                  }),
                ),
          ),
          Effect.timeoutOrElse({
            duration: checkTimeout,
            orElse: () => Effect.succeed(unconfirmed("Anthropic didn't answer in time")),
          }),
          Effect.catch(() => Effect.succeed(unconfirmed("Anthropic couldn't be reached"))),
        )
        return answer
      })
      return ClaudeCheck.of({ check })
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer))

  /**
   * Asks no one, for tests: a secret with `REJECTED` in it is rejected, one with `UNREACHABLE`
   * can't be checked, and any other is valid.
   */
  static readonly layerTest = Layer.succeed(
    ClaudeCheck,
    ClaudeCheck.of({
      check: (credential) => {
        const value = Redacted.value(
          credential._tag === "ApiKey" ? credential.key : credential.token,
        )
        if (value.includes("REJECTED")) {
          return Effect.succeed({
            _tag: "Rejected",
            message: `Anthropic rejected this ${whatItIs(credential)}: it is invalid.`,
          })
        }
        if (value.includes("UNREACHABLE")) {
          return Effect.succeed({
            _tag: "Unconfirmed",
            warning: "Saved without checking it: Anthropic couldn't be reached.",
          })
        }
        return Effect.succeed({ _tag: "Valid" })
      },
    }),
  )
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// ── Storing ────────────────────────────────────────────────────────────────

/** A credential can't be stored: `message` says why, for its owner. */
// oxlint-disable-next-line unicorn/throw-new-error -- Effect makes error classes with a factory call
export class ClaudeCredentialRefusal extends Schema.TaggedError<ClaudeCredentialRefusal>()(
  "ClaudeCredentialRefusal",
  { message: Schema.String },
) {}

interface Stored {
  readonly info: ClaudeCredentialInfo
  readonly secret: Redacted.Redacted<string>
}

interface Row {
  readonly participantId: string
  readonly kind: string
  readonly ciphertext: string
  readonly last4: string
  readonly plan: string | null
  readonly addedAt: number
}

const isPlanChoice = Schema.is(ClaudePlanChoiceSchema)

/** What a credential is encrypted with, so a ciphertext can't be moved to another person. */
const contextOf = (participantId: ParticipantId) => `claude-credential:${participantId}`

const infoOf = (
  secret: string,
  plan: ClaudePlanChoice | undefined,
  addedAt: EpochMillis,
): ClaudeCredentialInfo => {
  const kind = claudeCredentialKindOf(secret) ?? "OAuthToken"
  return {
    kind,
    last4: secret.slice(-4),
    ...(kind === "OAuthToken" && plan !== undefined && { plan }),
    addedAt,
  }
}

/** Each person's Claude credential (ADR 0015). */
export class ClaudeCredentials extends Context.Service<
  ClaudeCredentials,
  {
    /** The person's credential as they see it, or undefined when they have stored none. */
    readonly info: (participantId: ParticipantId) => ClaudeCredentialInfo | undefined
    /**
     * Checks the secret's shape, then with Anthropic, and stores it as the person's credential,
     * replacing any before: what they see of it, and a warning when Anthropic couldn't confirm it.
     */
    readonly set: (
      participantId: ParticipantId,
      secret: Redacted.Redacted<string>,
      plan: ClaudePlanChoice | undefined,
    ) => Effect.Effect<
      { readonly info: ClaudeCredentialInfo; readonly warning?: string },
      ClaudeCredentialRefusal | SqlError
    >
    /** Removes the person's credential, if they have one. */
    readonly remove: (participantId: ParticipantId) => Effect.Effect<void, SqlError>
    /** The person's credential, to send to the Runner of a Session they created. */
    readonly credentialOf: (participantId: ParticipantId) => ClaudeCredential | undefined
    /** Every value stored, and every one replaced or removed since the Hub started: to redact. */
    readonly values: () => ReadonlyArray<string>
  }
>()("@kndl/hub/ClaudeCredentials") {
  static readonly layer = Layer.effect(
    ClaudeCredentials,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const secrets = yield* Secrets
      const claude = yield* ClaudeCheck

      const stored = new Map<ParticipantId, Stored>()
      const retired = new Set<string>()

      // Secrets.ts refuses to start without the key they were stored with, so each decrypts.
      const rows = yield* sql<Row>`
        SELECT participant_id AS participantId, kind, ciphertext, last4, plan,
          added_at AS addedAt
        FROM claude_credentials
      `.pipe(Effect.orDie)
      for (const row of rows) {
        const participantId = row.participantId as ParticipantId
        const secret = yield* secrets
          .decrypt(row.ciphertext, contextOf(participantId))
          .pipe(
            Effect.catchTag("SecretsUnavailable", (error) =>
              Effect.as(
                Effect.logError(`The Claude credential of ${participantId} can't be read`, error),
                undefined,
              ),
            ),
          )
        if (secret === undefined) continue
        const plan = row.plan !== null && isPlanChoice(row.plan) ? row.plan : undefined
        stored.set(participantId, {
          info: infoOf(Redacted.value(secret), plan, row.addedAt as EpochMillis),
          secret,
        })
      }

      const retire = (participantId: ParticipantId) => {
        const before = stored.get(participantId)
        if (before !== undefined) retired.add(Redacted.value(before.secret))
      }

      const set = Effect.fn("ClaudeCredentials.set")(function* (
        participantId: ParticipantId,
        secret: Redacted.Redacted<string>,
        plan: ClaudePlanChoice | undefined,
      ) {
        const value = Redacted.value(secret).trim()
        const problem = claudeCredentialProblem(value, plan)
        if (problem !== undefined) return yield* new ClaudeCredentialRefusal({ message: problem })
        if (!secrets.available) {
          return yield* new ClaudeCredentialRefusal({
            message:
              "This Hub can't store a Claude credential: it needs HUB_SECRETS_KEY in its configuration. Ask whoever runs it to set one.",
          })
        }
        const kind = claudeCredentialKindOf(value)
        // A plan is a token's alone.
        const keptPlan = kind === "OAuthToken" ? plan : undefined
        const credential = claudeCredentialOf(value, keptPlan)
        if (credential === undefined) {
          return yield* new ClaudeCredentialRefusal({ message: "Paste a token or an API key." })
        }
        const checked = yield* claude.check(credential)
        if (checked._tag === "Rejected") {
          return yield* new ClaudeCredentialRefusal({ message: checked.message })
        }
        const kept = Redacted.make(value)
        const ciphertext = yield* secrets
          .encrypt(kept, contextOf(participantId))
          .pipe(
            Effect.catchTag("SecretsUnavailable", (error) =>
              Effect.fail(new ClaudeCredentialRefusal({ message: error.message })),
            ),
          )
        const addedAt = (yield* Clock.currentTimeMillis) as EpochMillis
        const info = infoOf(value, keptPlan, addedAt)
        yield* sql`
          INSERT INTO claude_credentials (participant_id, kind, ciphertext, last4, plan, added_at)
          VALUES (${participantId}, ${info.kind}, ${ciphertext}, ${info.last4},
            ${keptPlan ?? null}, ${addedAt})
          ON CONFLICT (participant_id) DO UPDATE SET kind = excluded.kind,
            ciphertext = excluded.ciphertext, last4 = excluded.last4, plan = excluded.plan,
            added_at = excluded.added_at
        `
        retire(participantId)
        retired.delete(value)
        stored.set(participantId, { info, secret: kept })
        return {
          info,
          ...(checked._tag === "Unconfirmed" && { warning: checked.warning }),
        }
      })

      const remove = Effect.fn("ClaudeCredentials.remove")(function* (
        participantId: ParticipantId,
      ) {
        yield* sql`DELETE FROM claude_credentials WHERE participant_id = ${participantId}`
        retire(participantId)
        stored.delete(participantId)
      })

      return ClaudeCredentials.of({
        info: (participantId) => stored.get(participantId)?.info,
        set,
        remove,
        credentialOf: (participantId) => {
          const known = stored.get(participantId)
          if (known === undefined) return undefined
          return claudeCredentialOf(Redacted.value(known.secret), known.info.plan)
        },
        values: () => [
          ...[...stored.values()].map((known) => Redacted.value(known.secret)),
          ...retired,
        ],
      })
    }),
  )
}
