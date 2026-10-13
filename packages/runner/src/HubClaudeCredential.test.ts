import { describe, expect, test } from "bun:test"
import type { CredentialRequestId, FetchClaudeCredential, RunnerToHub } from "@kndl/protocol"
import { Effect, Fiber, Layer, Redacted } from "effect"
import { HubClaudeCredential, HubClaudeCredentialLive } from "./HubClaudeCredential.ts"
import { HubLink } from "./HubLink.ts"
import { sessionId, waitFor } from "./testSupport.ts"

const run = (
  body: (sent: Array<RunnerToHub>) => Effect.Effect<void, unknown, HubClaudeCredential>,
) => {
  const sent: Array<RunnerToHub> = []
  const hub = Layer.succeed(
    HubLink,
    HubLink.of({
      send: (message) => Effect.sync(() => void sent.push(message)),
      connect: () => Effect.void,
      disconnect: Effect.void,
    }),
  )
  return body(sent).pipe(
    Effect.provide(HubClaudeCredentialLive.pipe(Layer.provide(hub))),
    Effect.runPromise,
  )
}

/** The request the fetch sent, once it has. */
const requested = (sent: ReadonlyArray<RunnerToHub>) =>
  Effect.gen(function* () {
    yield* waitFor(Effect.sync(() => sent.length === 1))
    return (sent[0] as FetchClaudeCredential).requestId as CredentialRequestId
  })

const fake = "sk-ant-oat01-FAKE_TOKEN_FOR_TESTS_ONLY_77d1"

describe("HubClaudeCredential", () => {
  test("asks the Hub for a Session's Claude credential and returns its answer", () =>
    run((sent) =>
      Effect.gen(function* () {
        const credentials = yield* HubClaudeCredential
        const fetching = yield* Effect.forkChild(credentials.fetch(sessionId("s-1")))
        const requestId = yield* requested(sent)
        expect(sent[0]).toMatchObject({ _tag: "FetchClaudeCredential", sessionId: "s-1" })
        // Another request's answer is not this one's.
        yield* credentials.receive({
          _tag: "ClaudeCredentialRefused",
          requestId: "other" as CredentialRequestId,
          message: "Not this one.",
        })
        yield* credentials.receive({
          _tag: "ClaudeCredentialFetched",
          requestId,
          credential: { _tag: "OAuthToken", token: Redacted.make(fake) },
        })
        const credential = yield* Fiber.join(fetching)
        expect(Redacted.value(credential.token)).toBe(fake)
      }),
    ))

  test("fails with the Hub's own message when it refuses, as for a Creator with none", () =>
    run((sent) =>
      Effect.gen(function* () {
        const credentials = yield* HubClaudeCredential
        const fetching = yield* Effect.forkChild(Effect.flip(credentials.fetch(sessionId("s-1"))))
        const requestId = yield* requested(sent)
        yield* credentials.receive({
          _tag: "ClaudeCredentialRefused",
          requestId,
          message: "Ada has no Claude setup token.",
        })
        expect((yield* Fiber.join(fetching)).message).toBe("Ada has no Claude setup token.")
      }),
    ))
})
