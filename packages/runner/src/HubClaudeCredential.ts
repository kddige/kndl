// The Runner's side of fetching a Session's Claude credential from the Hub (ADR 0015): its
// Creator's, asked for just before its Claude Code starts or wakes, and handed to the credential
// proxy. It is kept in memory only, never written to the Runner's disk, and never logged. A
// restarted Runner asks again.

import { randomUUID } from "node:crypto"
import {
  type ClaudeCredential,
  type ClaudeCredentialFetched,
  type ClaudeCredentialRefused,
  CredentialRequestId,
  FetchClaudeCredential,
  type SessionId,
} from "@claude-hub/protocol"
import { Context, Data, Deferred, Duration, Effect, Exit, Layer, Schema } from "effect"
import { HubLink } from "./HubLink.ts"

/** How long the Runner waits for the Hub to answer a FetchClaudeCredential. */
export const FetchClaudeCredentialTimeout = Duration.seconds(30)

export class ClaudeCredentialError extends Data.TaggedError("ClaudeCredentialError")<{
  readonly message: string
}> {}

const newRequestId = () => Schema.decodeSync(CredentialRequestId)(randomUUID())

export class HubClaudeCredential extends Context.Service<
  HubClaudeCredential,
  {
    /**
     * Asks the Hub for the Claude credential of a Session this Runner runs: its Creator's, or
     * undefined when they have stored none, and the Runner's own is used.
     */
    readonly fetch: (
      sessionId: SessionId,
    ) => Effect.Effect<ClaudeCredential | undefined, ClaudeCredentialError>
    /** Hands the Hub's answer to the request waiting for it. */
    readonly receive: (
      reply: ClaudeCredentialFetched | ClaudeCredentialRefused,
    ) => Effect.Effect<void>
  }
>()("@claude-hub/runner/HubClaudeCredential") {}

export const HubClaudeCredentialLive = Layer.effect(
  HubClaudeCredential,
  Effect.gen(function* () {
    const hub = yield* HubLink
    const pending = new Map<
      string,
      Deferred.Deferred<ClaudeCredential | undefined, ClaudeCredentialError>
    >()

    const fetch = (sessionId: SessionId) =>
      Effect.gen(function* () {
        const requestId = newRequestId()
        const answer = yield* Deferred.make<ClaudeCredential | undefined, ClaudeCredentialError>()
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
              : Exit.fail(
                  new ClaudeCredentialError({
                    message: `The Hub refused the Session's Claude credential: ${reply.message}`,
                  }),
                ),
          )
        }),
    })
  }),
)

/** No Hub to ask: every Session runs on the Runner's own credential. For tests. */
export const NoHubClaudeCredential = Layer.succeed(
  HubClaudeCredential,
  HubClaudeCredential.of({ fetch: () => Effect.succeed(undefined), receive: () => Effect.void }),
)
