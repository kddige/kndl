// The Runner's side of fetching a Session's Claude credential from the Hub (ADR 0026): its
// Creator's setup token, asked for just before its Harness starts or wakes, and set on that
// Harness's process alone. It is kept in memory only, never written to the Runner's disk or the
// Sandbox's, and never logged. There is no fallback: Claude Code runs on it, so a fetch the Hub
// refuses, or doesn't answer in time, fails its start. pi starts without it, without Claude's
// Models for its Claude bridge (ADR 0029), and asks again when the Hub was only slow
// ({@link retryingTimeouts}).

import { randomUUID } from "node:crypto"
import {
  type ClaudeCredential,
  type ClaudeCredentialFetched,
  type ClaudeCredentialRefused,
  CredentialRequestId,
  FetchClaudeCredential,
  type SessionId,
} from "@kndl/protocol"
import { Context, Data, Deferred, Duration, Effect, Exit, Layer, Schema } from "effect"
import { HubLink } from "./HubLink.ts"

/** How long the Runner waits for the Hub to answer a FetchClaudeCredential. */
export const FetchClaudeCredentialTimeout = Duration.seconds(30)

/** How many times {@link retryingTimeouts} asks, before a timeout is the answer. */
export const FetchClaudeCredentialAttempts = 3

export class ClaudeCredentialError extends Data.TaggedError("ClaudeCredentialError")<{
  readonly message: string
  /**
   * Why: the Hub refused, with its reason as the message, as for a Creator with none; or it
   * didn't answer in time, which asking again may mend.
   */
  readonly reason: "Refused" | "TimedOut"
}> {}

/**
 * `fetch`, asked again when the Hub doesn't answer in time, up to
 * {@link FetchClaudeCredentialAttempts} times in all; a refusal is the answer at once.
 */
export const retryingTimeouts = <A>(fetch: Effect.Effect<A, ClaudeCredentialError>) =>
  fetch.pipe(
    Effect.retry({
      while: (error) => error.reason === "TimedOut",
      times: FetchClaudeCredentialAttempts - 1,
    }),
  )

const newRequestId = () => Schema.decodeSync(CredentialRequestId)(randomUUID())

export class HubClaudeCredential extends Context.Service<
  HubClaudeCredential,
  {
    /**
     * Asks the Hub for the Claude credential of a Session this Runner runs: its Creator's. Fails
     * with the Hub's own message when it refuses, as for a Creator with none, and as timed out
     * when it doesn't answer in time.
     */
    readonly fetch: (sessionId: SessionId) => Effect.Effect<ClaudeCredential, ClaudeCredentialError>
    /** Hands the Hub's answer to the request waiting for it. */
    readonly receive: (
      reply: ClaudeCredentialFetched | ClaudeCredentialRefused,
    ) => Effect.Effect<void>
  }
>()("@kndl/runner/HubClaudeCredential") {}

export const HubClaudeCredentialLive = Layer.effect(
  HubClaudeCredential,
  Effect.gen(function* () {
    const hub = yield* HubLink
    const pending = new Map<string, Deferred.Deferred<ClaudeCredential, ClaudeCredentialError>>()

    const fetch = (sessionId: SessionId) =>
      Effect.gen(function* () {
        const requestId = newRequestId()
        const answer = yield* Deferred.make<ClaudeCredential, ClaudeCredentialError>()
        pending.set(requestId, answer)
        // While the Runner is offline the request waits in the HubLink, and the timeout runs.
        return yield* hub.send(FetchClaudeCredential.make({ requestId, sessionId })).pipe(
          Effect.andThen(Deferred.await(answer)),
          Effect.timeoutOrElse({
            duration: FetchClaudeCredentialTimeout,
            orElse: () =>
              Effect.fail(
                new ClaudeCredentialError({
                  message: "The Hub did not send the Session's Claude credential in time.",
                  reason: "TimedOut",
                }),
              ),
          }),
          Effect.ensuring(Effect.sync(() => pending.delete(requestId))),
        )
      })

    return HubClaudeCredential.of({
      fetch,
      receive: (reply) =>
        Effect.suspend(() => {
          const waiting = pending.get(reply.requestId)
          pending.delete(reply.requestId)
          if (waiting === undefined)
            return Effect.logDebug(
              `Ignored a Claude credential for ${reply.requestId}, no longer waited for`,
            )
          return Deferred.done(
            waiting,
            reply._tag === "ClaudeCredentialFetched"
              ? Exit.succeed(reply.credential)
              : Exit.fail(new ClaudeCredentialError({ message: reply.message, reason: "Refused" })),
          )
        }),
    })
  }),
)

/** No Hub to ask: every fetch is refused, so no Session starts. For tests. */
export const NoHubClaudeCredential = Layer.succeed(
  HubClaudeCredential,
  HubClaudeCredential.of({
    fetch: () =>
      Effect.fail(
        new ClaudeCredentialError({ message: "No Hub in this test.", reason: "Refused" }),
      ),
    receive: () => Effect.void,
  }),
)
