// The Runner's side of fetching an Environment's variable values from the Hub (ADR 0009). The
// values are kept in memory only, by whoever asked, and passed to the processes the Runner
// starts in a Sandbox; they are never written to the Runner's disk. A restarted Runner asks again.

import { randomUUID } from "node:crypto"
import {
  FetchVariables,
  type VariablesFetched,
  type VariablesFor,
  type VariablesRefused,
  VariablesRequestId,
  type VariableValue,
} from "@kndl/protocol"
import { Context, Data, Deferred, Duration, Effect, Exit, Layer, Redacted, Schema } from "effect"
import { HubLink } from "./HubLink.ts"

/** How long the Runner waits for the Hub to answer a FetchVariables. */
export const FetchVariablesTimeout = Duration.seconds(30)

export class VariablesError extends Data.TaggedError("VariablesError")<{
  readonly message: string
}> {}

const newRequestId = () => Schema.decodeSync(VariablesRequestId)(randomUUID())

export class HubVariables extends Context.Service<
  HubVariables,
  {
    /** Asks the Hub for the variable values of a Session or Test build this Runner runs. */
    readonly fetch: (
      target: VariablesFor,
    ) => Effect.Effect<ReadonlyArray<VariableValue>, VariablesError>
    /** Hands the Hub's answer to the request waiting for it. */
    readonly receive: (reply: VariablesFetched | VariablesRefused) => Effect.Effect<void>
  }
>()("@kndl/runner/HubVariables") {}

export const HubVariablesLive = Layer.effect(
  HubVariables,
  Effect.gen(function* () {
    const hub = yield* HubLink
    const pending = new Map<
      string,
      Deferred.Deferred<ReadonlyArray<VariableValue>, VariablesError>
    >()

    const fetch = (target: VariablesFor) =>
      Effect.gen(function* () {
        const requestId = newRequestId()
        const answer = yield* Deferred.make<ReadonlyArray<VariableValue>, VariablesError>()
        pending.set(requestId, answer)
        // While the Runner is offline the request waits in the HubLink, and the timeout runs.
        return yield* hub.send(FetchVariables.make({ requestId, for: target })).pipe(
          Effect.andThen(Deferred.await(answer)),
          Effect.timeoutOrElse({
            duration: FetchVariablesTimeout,
            orElse: () =>
              Effect.fail(
                new VariablesError({
                  message: "The Hub did not send the Environment's variables in time.",
                }),
              ),
          }),
          Effect.ensuring(Effect.sync(() => pending.delete(requestId))),
        )
      })

    return HubVariables.of({
      fetch,
      receive: (reply) =>
        Effect.suspend(() => {
          const waiting = pending.get(reply.requestId)
          pending.delete(reply.requestId)
          if (waiting === undefined)
            return Effect.logDebug(`Ignored variables for ${reply.requestId}, no longer waited for`)
          return Deferred.done(
            waiting,
            reply._tag === "VariablesFetched"
              ? Exit.succeed(reply.variables)
              : Exit.fail(
                  new VariablesError({
                    message: `The Hub refused the Environment's variables: ${reply.message}`,
                  }),
                ),
          )
        }),
    })
  }),
)

/** No Hub to ask: every Environment has no variables. For tests and Runners without Sandboxes. */
export const NoHubVariables = Layer.succeed(
  HubVariables,
  HubVariables.of({ fetch: () => Effect.succeed([]), receive: () => Effect.void }),
)

/** The values as environment variables, for one process. */
export const variablesEnv = (
  values: ReadonlyArray<VariableValue>,
  only?: (value: VariableValue) => boolean,
): Record<string, string> =>
  Object.fromEntries(
    values
      .filter((value) => only === undefined || only(value))
      .map((value) => [value.name, Redacted.value(value.value)]),
  )
