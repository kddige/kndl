// Helpers for the Runner's tests. Not used by the Runner itself.
import { SessionId } from "@claude-hub/protocol"
import { Effect, Schema } from "effect"

export const sessionId = (id: string) => Schema.decodeSync(SessionId)(id)

/** Re-runs `check` every 20 ms until it returns true, failing after `timeoutMs`. */
export const waitFor = <E, R>(check: Effect.Effect<boolean, E, R>, timeoutMs = 5_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs
    while (!(yield* check)) {
      if (Date.now() > deadline) return yield* Effect.die(new Error("timed out waiting"))
      yield* Effect.sleep("20 millis")
    }
  })
