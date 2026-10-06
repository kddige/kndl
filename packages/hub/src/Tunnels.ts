// Tunnels waiting for their Runner (#177, ADR 0016). For each connection to a Session's port the
// Hub sends the Runner an OpenTunnel with a fresh tunnel id, and the Runner dials back at
// `/runner/tunnel/<tunnel id>` with its own token: this pairs the two. A tunnel is claimed once,
// by the Runner it was sent to; one never claimed fails, when the Runner says it couldn't open it
// (TunnelFailed), goes offline, or the client stops waiting. See TunnelRoutes.ts.

import { type RunnerId, TunnelCloseCode, TunnelId } from "@kndl/protocol"
import { Context, Data, Deferred, Effect, Layer, Option } from "effect"
import type { Socket } from "effect/socket"

/** Why a tunnel isn't opened, as the client's socket is closed with. */
export class TunnelRefused extends Data.TaggedError("TunnelRefused")<{
  readonly code: TunnelCloseCode
  readonly message: string
}> {}

/** A tunnel the Hub asked a Runner to open. */
export interface PendingTunnel {
  readonly tunnelId: TunnelId
  readonly runnerId: RunnerId
  /** The Runner's socket once it dials back, or why it won't. */
  readonly dialed: Deferred.Deferred<Socket.Socket, TunnelRefused>
  /** Done once the tunnel is over, which lets the Runner's request end. */
  readonly over: Deferred.Deferred<void>
}

export class Tunnels extends Context.Service<
  Tunnels,
  {
    /** A new tunnel for the Runner to dial back for. */
    readonly register: (runnerId: RunnerId) => Effect.Effect<PendingTunnel>
    /** Takes the tunnel, for the Runner it was sent to: once only. */
    readonly claim: (
      tunnelId: string,
      runnerId: RunnerId,
    ) => Effect.Effect<Option.Option<PendingTunnel>>
    /** The Runner says it couldn't open the tunnel. */
    readonly fail: (
      tunnelId: TunnelId,
      runnerId: RunnerId,
      refused: TunnelRefused,
    ) => Effect.Effect<void>
    /** The Runner went offline: none of its tunnels will be dialed. */
    readonly runnerGone: (runnerId: RunnerId) => Effect.Effect<void>
    /** The client stopped waiting, or the tunnel is over. */
    readonly forget: (tunnelId: TunnelId) => Effect.Effect<void>
  }
>()("@kndl/hub/Tunnels") {
  static readonly layer = Layer.sync(Tunnels, () => {
    const pending = new Map<string, PendingTunnel>()
    const failWith = (tunnel: PendingTunnel, refused: TunnelRefused) => {
      pending.delete(tunnel.tunnelId)
      Deferred.doneUnsafe(tunnel.dialed, Effect.fail(refused))
    }
    return Tunnels.of({
      register: (runnerId) =>
        Effect.sync(() => {
          const tunnel: PendingTunnel = {
            tunnelId: TunnelId.make(crypto.randomUUID()),
            runnerId,
            dialed: Deferred.makeUnsafe(),
            over: Deferred.makeUnsafe(),
          }
          pending.set(tunnel.tunnelId, tunnel)
          return tunnel
        }),
      claim: (tunnelId, runnerId) =>
        Effect.sync(() => {
          const tunnel = pending.get(tunnelId)
          if (tunnel === undefined || tunnel.runnerId !== runnerId) return Option.none()
          pending.delete(tunnelId)
          return Option.some(tunnel)
        }),
      fail: (tunnelId, runnerId, refused) =>
        Effect.sync(() => {
          const tunnel = pending.get(tunnelId)
          if (tunnel !== undefined && tunnel.runnerId === runnerId) failWith(tunnel, refused)
        }),
      runnerGone: (runnerId) =>
        Effect.sync(() => {
          for (const tunnel of pending.values()) {
            if (tunnel.runnerId !== runnerId) continue
            failWith(
              tunnel,
              new TunnelRefused({
                code: TunnelCloseCode.RunnerOffline,
                message: "The Session's Runner went offline.",
              }),
            )
          }
        }),
      forget: (tunnelId) =>
        Effect.sync(() => {
          pending.delete(tunnelId)
        }),
    })
  })
}
