import type { RunnerToHub } from "@claude-hub/protocol"
import { Context, Effect, Layer, Semaphore } from "effect"

/** Writes one message on the current connection to the Hub. */
export type HubWriter = (message: RunnerToHub) => Effect.Effect<void, unknown>

/**
 * The Runner's way to send the Hub a message, whether or not it is connected right now.
 *
 * While disconnected, Session lifecycle messages wait and are sent, in order, right after the
 * next welcome. Terminal frames are dropped instead, because every reconnect sends a fresh
 * snapshot of each terminal.
 */
export class HubLink extends Context.Service<
  HubLink,
  {
    readonly send: (message: RunnerToHub) => Effect.Effect<void>
    /** Starts sending through `write`, after whatever waited. Called once the Hub welcomed us. */
    readonly connect: (write: HubWriter) => Effect.Effect<void>
    readonly disconnect: Effect.Effect<void>
  }
>()("@claude-hub/runner/HubLink") {}

export const HubLinkLive = Layer.effect(
  HubLink,
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1)
    let writer: HubWriter | undefined
    const waiting: Array<RunnerToHub> = []

    // Called with the lock held. A failed write means the connection is going away; a lifecycle
    // message is kept for the next one.
    const deliver = (message: RunnerToHub) =>
      Effect.suspend(() => {
        if (writer === undefined) {
          if (message._tag !== "TerminalFrame") waiting.push(message)
          return Effect.void
        }
        return writer(message).pipe(
          Effect.catchCause(() =>
            Effect.sync(() => {
              writer = undefined
              if (message._tag !== "TerminalFrame") waiting.push(message)
            }),
          ),
        )
      })

    return HubLink.of({
      send: (message) => lock.withPermit(deliver(message)),
      connect: (write) =>
        lock.withPermit(
          Effect.suspend(() => {
            writer = write
            return Effect.forEach(waiting.splice(0), deliver, { discard: true })
          }),
        ),
      disconnect: Effect.sync(() => {
        writer = undefined
      }),
    })
  }),
)
