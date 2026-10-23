// Each Member's live voice connection (spike, ADR 0033): the Codex CLI's ChatGPT sign-in, which
// GPT-Live through ChatGPT's backend takes, and which no Connected provider is. kndl's own ChatGPT
// sign-in (ConnectedProviders.ts) is OpenAI's Sign in with ChatGPT for apps, whose tokens are for
// the Responses API alone: GPT-Live refuses them. So live voice gets a sign-in of its own, apart.
//
// - It runs pi-ai's `openai-codex` sign-in, by device code, since the Hub's loopback can't be
//   reached from the Member's browser, through the same steps as a Connected provider's
//   (ProviderRelay.ts). It runs no Models and reaches no Gateway: only `LiveVoiceRoutes.ts` uses it.
// - Its tokens are encrypted with HUB_SECRETS_KEY, write-only, and redacted from every Session.
//   One that expires within 5 minutes is refreshed before use, and the rotated tokens kept.
// - Using the Codex CLI's client is unofficial: OpenAI may stop it. Its Member opts in by signing in.

import type { OAuthCredential } from "@earendil-works/pi-ai"
import { type LiveVoiceConnection, type ParticipantId } from "@kndl/protocol"
import { Context, Effect, Layer, Redacted, Schema, Semaphore } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { ProviderApis, ProviderRefusal, type SignInInteraction } from "./ConnectedProviders.ts"
import { accountOf, chatgptAccountOf, reasonOf } from "./PiProviders.ts"
import { Secrets } from "./Secrets.ts"

/** The Codex login method pi-ai asks to choose: the one a remote Hub can finish. */
const deviceCode = "device_code"

/** How long before a sign-in expires it is refreshed. */
const refreshAhead = 5 * 60 * 1000

/** What the encryption of a credential is bound to. */
const contextOf = (participantId: ParticipantId) => `live-voice:${participantId}`

const StoredCredential = Schema.fromJsonString(
  Schema.Struct({
    access: Schema.String,
    refresh: Schema.String,
    expires: Schema.Number,
  }),
)
const decodeCredential = Schema.decodeUnknownEffect(StoredCredential)

/** What a live voice call goes with: the access token, and the ChatGPT account it is for. */
export interface CodexAccess {
  readonly token: string
  readonly accountId: string | undefined
}

/** The Member has no live voice connection, or it can't be used: `message` says why. */
// oxlint-disable-next-line unicorn/throw-new-error -- Effect makes error classes with a factory call
export class LiveVoiceUnusable extends Schema.TaggedError<LiveVoiceUnusable>()(
  "LiveVoiceUnusable",
  { message: Schema.String },
) {}

const notConnected = new LiveVoiceUnusable({
  message:
    "Sign in with ChatGPT (Codex) under Live voice on the Account page to talk with your Sessions.",
})

interface Held {
  readonly credential: OAuthCredential
  readonly label: string
  readonly connectedAt: number
}

export class LiveVoiceConnections extends Context.Service<
  LiveVoiceConnections,
  {
    /** The Member's live voice connection, as the Account page shows it; none before they sign in. */
    readonly info: (participantId: ParticipantId) => LiveVoiceConnection | undefined
    /**
     * Runs the Codex sign-in, asking the Member through `interaction`, and keeps it as their live
     * voice connection, replacing any before.
     */
    readonly signIn: (
      participantId: ParticipantId,
      interaction: SignInInteraction,
    ) => Effect.Effect<void, ProviderRefusal | SqlError>
    /** Forgets it: whether there was one. */
    readonly disconnect: (participantId: ParticipantId) => Effect.Effect<boolean, SqlError>
    /** Its access, refreshed first when it expires soon, or forced. */
    readonly access: (
      participantId: ParticipantId,
      options?: { readonly force?: boolean },
    ) => Effect.Effect<CodexAccess, LiveVoiceUnusable>
    /** Every token held, for redaction. */
    readonly values: () => ReadonlyArray<string>
  }
>()("@kndl/hub/LiveVoiceConnections") {
  static readonly layer = Layer.effect(
    LiveVoiceConnections,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const secrets = yield* Secrets
      const apis = yield* ProviderApis
      const held = new Map<ParticipantId, Held>()
      /** Every token held, or held before: a rotated one is still masked. */
      const seen = new Set<string>()
      const lock = yield* Semaphore.make(1)

      const remember = (participantId: ParticipantId, kept: Held) => {
        held.set(participantId, kept)
        seen.add(kept.credential.access)
        seen.add(kept.credential.refresh)
      }

      const rows = yield* sql<{
        readonly participantId: ParticipantId
        readonly credential: string
        readonly label: string
        readonly connectedAt: number
      }>`
        SELECT participant_id AS participantId, credential, label, connected_at AS connectedAt
        FROM live_voice_connections
      `.pipe(Effect.orDie)
      for (const row of rows) {
        const opened = yield* secrets.decrypt(row.credential, contextOf(row.participantId)).pipe(
          Effect.flatMap((value) => decodeCredential(Redacted.value(value))),
          Effect.option,
        )
        if (opened._tag === "None") {
          yield* Effect.logWarning("Could not read a live voice connection: it is forgotten")
          continue
        }
        remember(row.participantId, {
          credential: { type: "oauth", ...opened.value },
          label: row.label,
          connectedAt: row.connectedAt,
        })
      }

      const store = Effect.fn("LiveVoiceConnections.store")(function* (
        participantId: ParticipantId,
        kept: Held,
      ) {
        const { access, refresh, expires } = kept.credential
        const sealed = yield* secrets
          .encrypt(
            Redacted.make(JSON.stringify({ access, refresh, expires })),
            contextOf(participantId),
          )
          .pipe(Effect.orDie)
        yield* sql`
          INSERT INTO live_voice_connections (participant_id, credential, label, connected_at)
          VALUES (${participantId}, ${sealed}, ${kept.label}, ${kept.connectedAt})
          ON CONFLICT (participant_id) DO UPDATE SET
            credential = excluded.credential, label = excluded.label,
            connected_at = excluded.connected_at
        `
        remember(participantId, kept)
      })

      const signIn = Effect.fn("LiveVoiceConnections.signIn")(function* (
        participantId: ParticipantId,
        interaction: SignInInteraction,
      ) {
        if (!secrets.available) {
          return yield* new ProviderRefusal({
            message:
              "This Hub can't store a live voice connection: it needs HUB_SECRETS_KEY in its configuration.",
          })
        }
        const signedIn = yield* Effect.tryPromise({
          try: (signal) =>
            apis.codexSignIn(
              {
                signal,
                notify: interaction.notify,
                // The Hub's loopback can't be reached from the Member's browser: by device code.
                prompt: (prompt) =>
                  prompt.type === "select" &&
                  prompt.options.some((option) => option.id === deviceCode)
                    ? Promise.resolve(deviceCode)
                    : interaction.prompt(
                        prompt,
                        prompt.signal === undefined
                          ? signal
                          : AbortSignal.any([signal, prompt.signal]),
                      ),
              },
              { agentName: "kndl" } as never,
            ),
          catch: (error) => new ProviderRefusal({ message: reasonOf(error) }),
        }).pipe(
          Effect.timeoutOrElse({
            duration: "15 minutes",
            orElse: () =>
              Effect.fail(
                new ProviderRefusal({ message: "The sign-in took too long; start again." }),
              ),
          }),
        )
        yield* store(participantId, {
          credential: { ...signedIn, type: "oauth" },
          label: accountOf(signedIn.access) ?? "ChatGPT (Codex)",
          connectedAt: Date.now(),
        })
      })

      const disconnect = Effect.fn("LiveVoiceConnections.disconnect")(function* (
        participantId: ParticipantId,
      ) {
        const had = held.delete(participantId)
        yield* sql`DELETE FROM live_voice_connections WHERE participant_id = ${participantId}`
        return had
      })

      const access = (participantId: ParticipantId, options: { readonly force?: boolean } = {}) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const kept = held.get(participantId)
            if (kept === undefined) return yield* notConnected
            let credential = kept.credential
            if (options.force === true || credential.expires - Date.now() < refreshAhead) {
              const refreshed = yield* Effect.tryPromise({
                try: (signal) => apis.codexRefresh(credential, signal),
                catch: (error) =>
                  new LiveVoiceUnusable({
                    message: `ChatGPT refused the live voice sign-in (${reasonOf(error)}): sign in with ChatGPT (Codex) again on the Account page.`,
                  }),
              })
              credential = { ...refreshed, type: "oauth" }
              yield* store(participantId, { ...kept, credential }).pipe(
                Effect.catchTag("SqlError", (error) =>
                  Effect.logError("Could not keep a refreshed live voice sign-in", error),
                ),
              )
            }
            return { token: credential.access, accountId: chatgptAccountOf(credential.access) }
          }),
        )

      return LiveVoiceConnections.of({
        info: (participantId) => {
          const kept = held.get(participantId)
          return kept === undefined
            ? undefined
            : { label: kept.label, connectedAt: kept.connectedAt }
        },
        signIn,
        disconnect,
        access,
        values: () => [...seen],
      })
    }),
  )
}
