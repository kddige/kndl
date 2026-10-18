import { describe, expect, test } from "bun:test"
import type { CredentialRequestId, FetchClaudeCredential, RunnerToHub } from "@kndl/protocol"
import { Effect, Fiber, Layer, Redacted } from "effect"
import { TestClock } from "effect/testing"
import {
  FetchClaudeCredentialAttempts,
  FetchClaudeCredentialTimeout,
  HubClaudeCredential,
  HubClaudeCredentialLive,
  retryingTimeouts,
} from "./HubClaudeCredential.ts"
import { HubLink } from "./HubLink.ts"
import { sessionId } from "./testSupport.ts"

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
    Effect.provide(TestClock.layer()),
    Effect.runPromise,
  )
}

/** Once the fetches have sent `count` requests: the clock is the test's, so it yields, not sleeps. */
const sentAll = (sent: ReadonlyArray<RunnerToHub>, count: number) =>
  Effect.gen(function* () {
    for (let tries = 0; sent.length < count; tries++) {
      if (tries > 10_000) return yield* Effect.die(new Error(`${sent.length} sent, not ${count}`))
      yield* Effect.yieldNow
    }
  })

/** The request the fetch sent, once it has. */
const requested = (sent: ReadonlyArray<RunnerToHub>) =>
  Effect.gen(function* () {
    yield* sentAll(sent, 1)
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
        const error = yield* Fiber.join(fetching)
        expect(error.message).toBe("Ada has no Claude setup token.")
        expect(error.reason).toBe("Refused")
      }),
    ))

  test("fails as timed out when the Hub doesn't answer in time, which isn't a refusal", () =>
    run((sent) =>
      Effect.gen(function* () {
        const credentials = yield* HubClaudeCredential
        const fetching = yield* Effect.forkChild(Effect.flip(credentials.fetch(sessionId("s-1"))))
        yield* requested(sent)
        yield* TestClock.adjust(FetchClaudeCredentialTimeout)
        const error = yield* Fiber.join(fetching)
        expect(error.reason).toBe("TimedOut")
        expect(error.message).toBe("The Hub did not send the Session's Claude credential in time.")
      }),
    ))

  test("a fetch tried again on a timeout asks again, and takes the answer to that", () =>
    run((sent) =>
      Effect.gen(function* () {
        const credentials = yield* HubClaudeCredential
        const fetching = yield* Effect.forkChild(
          retryingTimeouts(credentials.fetch(sessionId("s-1"))),
        )
        yield* requested(sent)
        yield* TestClock.adjust(FetchClaudeCredentialTimeout)
        yield* sentAll(sent, 2)
        const again = (sent[1] as FetchClaudeCredential).requestId as CredentialRequestId
        yield* credentials.receive({
          _tag: "ClaudeCredentialFetched",
          requestId: again,
          credential: { _tag: "OAuthToken", token: Redacted.make(fake) },
        })
        expect(Redacted.value((yield* Fiber.join(fetching)).token)).toBe(fake)
      }),
    ))

  test("a fetch tried again on a timeout takes a refusal at once, and gives up after a few timeouts", () =>
    run((sent) =>
      Effect.gen(function* () {
        const credentials = yield* HubClaudeCredential
        const refused = yield* Effect.forkChild(
          Effect.flip(retryingTimeouts(credentials.fetch(sessionId("s-1")))),
        )
        yield* credentials.receive({
          _tag: "ClaudeCredentialRefused",
          requestId: yield* requested(sent),
          message: "Ada has no Claude setup token.",
        })
        expect((yield* Fiber.join(refused)).reason).toBe("Refused")
        expect(sent).toHaveLength(1)

        const timedOut = yield* Effect.forkChild(
          Effect.flip(retryingTimeouts(credentials.fetch(sessionId("s-2")))),
        )
        for (let asked = 2; asked <= 1 + FetchClaudeCredentialAttempts; asked++) {
          yield* sentAll(sent, asked)
          yield* TestClock.adjust(FetchClaudeCredentialTimeout)
        }
        expect((yield* Fiber.join(timedOut)).reason).toBe("TimedOut")
        expect(sent).toHaveLength(1 + FetchClaudeCredentialAttempts)
      }),
    ))
})
