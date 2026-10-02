// Shutting the Hub down promptly (#39). When the HTTP server stops, it waits for every open
// request and WebSocket to finish. The mod's long poll of `GET /mod/commands` and the Runner and
// web channels never finish on their own, so a Hub with any of them open would wait out its
// graceful-shutdown timeout. Instead the Hub tells them first: a waiting poll is answered with no
// commands, and each channel is closed with 1001 (going away). Then the server stops at once.

import { Context, Deferred, Effect, Layer } from "effect"

export class HubShutdown extends Context.Service<
  HubShutdown,
  {
    /** Completes once the Hub has begun shutting down; never before. */
    readonly started: Effect.Effect<void>
    /** Begins shutting down. Doing it again changes nothing. */
    readonly start: Effect.Effect<void>
  }
>()("@claude-hub/hub/HubShutdown") {
  static readonly layer = Layer.sync(HubShutdown, () => {
    const begun = Deferred.makeUnsafe<void>()
    return HubShutdown.of({
      started: Deferred.await(begun),
      start: Effect.asVoid(Deferred.succeed(begun, undefined)),
    })
  })

  /**
   * Begins the shutdown when its scope closes. Build it on top of the served routes, as
   * `drainFirst(HttpRouter.serve(...))` does, so it is released before the server is.
   */
  static readonly onClose = Layer.effectDiscard(
    Effect.gen(function* () {
      const shutdown = yield* HubShutdown
      yield* Effect.addFinalizer(() => shutdown.start)
    }),
  )
}

/**
 * The served Hub, with long polls answered and channels closed before the server stops. Layers
 * are released in the reverse of the order they were built, and {@link HubShutdown.onClose} is
 * built after the server it is given.
 */
export const drainFirst = <E, R>(served: Layer.Layer<never, E, R>) =>
  HubShutdown.onClose.pipe(Layer.provide(served))
