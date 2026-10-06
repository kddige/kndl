import { describe, expect, test } from "bun:test"
import type { FetchVariables, RunnerToHub, VariablesRequestId } from "@kndl/protocol"
import { Effect, Fiber, Layer, Redacted } from "effect"
import { HubLink } from "./HubLink.ts"
import { HubVariables, HubVariablesLive, variablesEnv } from "./HubVariables.ts"
import { sessionId, variable, waitFor } from "./testSupport.ts"

const run = (body: (sent: Array<RunnerToHub>) => Effect.Effect<void, unknown, HubVariables>) => {
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
    Effect.provide(HubVariablesLive.pipe(Layer.provide(hub))),
    Effect.runPromise,
  )
}

/** The request the fetch sent, once it has. */
const requested = (sent: ReadonlyArray<RunnerToHub>) =>
  Effect.gen(function* () {
    yield* waitFor(Effect.sync(() => sent.length === 1))
    return (sent[0] as FetchVariables).requestId as VariablesRequestId
  })

describe("HubVariables", () => {
  test("asks the Hub for a Session's variables and returns its answer", () =>
    run((sent) =>
      Effect.gen(function* () {
        const variables = yield* HubVariables
        const fetching = yield* Effect.forkChild(
          variables.fetch({ _tag: "Session", sessionId: sessionId("s-1") }),
        )
        const requestId = yield* requested(sent)
        expect(sent[0]).toMatchObject({
          _tag: "FetchVariables",
          for: { _tag: "Session", sessionId: "s-1" },
        })
        // Another request's answer is not this one's.
        yield* variables.receive({
          _tag: "VariablesFetched",
          requestId: "other" as VariablesRequestId,
          variables: [],
        })
        yield* variables.receive({
          _tag: "VariablesFetched",
          requestId,
          variables: [variable("API_KEY", "k-1")],
        })
        const values = yield* Fiber.join(fetching)
        expect(values.map((value) => [value.name, Redacted.value(value.value)])).toEqual([
          ["API_KEY", "k-1"],
        ])
      }),
    ))

  test("fails with the Hub's reason when it refuses", () =>
    run((sent) =>
      Effect.gen(function* () {
        const variables = yield* HubVariables
        const fetching = yield* Effect.forkChild(
          Effect.flip(variables.fetch({ _tag: "Session", sessionId: sessionId("s-1") })),
        )
        const requestId = yield* requested(sent)
        yield* variables.receive({ _tag: "VariablesRefused", requestId, message: "not active" })
        expect((yield* Fiber.join(fetching)).message).toContain("not active")
      }),
    ))

  test("gives each process its values, or only those available at build", () => {
    const values = [variable("NPM_TOKEN", "n", true), variable("API_KEY", "k")]
    expect(variablesEnv(values)).toEqual({ NPM_TOKEN: "n", API_KEY: "k" })
    expect(variablesEnv(values, (value) => value.availableAtBuild)).toEqual({ NPM_TOKEN: "n" })
  })
})
