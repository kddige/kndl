// Tunnels (#177, ADR 0016): the Runner's leg of one TCP connection to an Open port of a Session.
// For each OpenTunnel the Hub sends, the Runner connects to the port from inside the Session's
// Sandbox (SandboxBackend.connectTcp), then dials the Hub back at `/runner/tunnel/<tunnel id>` with
// its Runner token and joins the two, as Tunnel.ts in the protocol describes. One it can't open is
// answered with a TunnelFailed, and the Hub closes the client's socket with PortUnreachable.
//
// - Only loopback: the Runner connects to 127.0.0.1 or ::1 alone, whatever the Hub asks, and only
//   in a Sandbox of a Session it runs.
// - The Runner never holds the guest's server back: agentd can't hold one connection back without
//   holding up every other into the Sandbox (AgentTcp.ts). So what the client hasn't room for yet,
//   past the tunnel's window, waits on the Runner, per connection. A client that leaves more than
//   TunnelBufferCap waiting, or takes nothing for TunnelStallMs while bytes wait for it, is closed
//   with TooSlow, alone (ADR 0016). Toward the Sandbox, the client's bytes are acknowledged only
//   once the backend has taken them, so a slow server holds back its own client and nothing else.
// - Each tunnel runs on its own callbacks once set up; nothing waits on it.

import {
  type OpenTunnel,
  RunnerToHub,
  TunnelAddress,
  TunnelCloseCode,
  type TunnelId,
} from "@claude-hub/protocol"
import { TunnelEnd } from "@claude-hub/protocol/tunnel-end"
import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { Socket } from "effect/socket"
import { HubLink } from "./HubLink.ts"
import { RunnerConfig, runnerTunnelUrl } from "./RunnerConfig.ts"
import { SandboxBackend, type SandboxError } from "./sandbox/SandboxBackend.ts"
import { Sessions } from "./Sessions.ts"

/** The most bytes from the Sandbox the Runner keeps waiting for one connection's client. */
export const TunnelBufferCap = 8 * 1024 * 1024

/** How long a client may take nothing while bytes wait for it on the Runner. */
export const TunnelStallMs = 30_000

export class Tunnels extends Context.Service<
  Tunnels,
  {
    /** Opens the tunnel the Hub asked for, in the background. */
    readonly open: (request: OpenTunnel) => Effect.Effect<void>
    /** How many tunnels are open now. */
    readonly openCount: Effect.Effect<number>
  }
>()("@claude-hub/runner/Tunnels") {
  /** A Runner that opens no tunnels: it answers each with a TunnelFailed. For tests. */
  static readonly refusing = Layer.effect(
    Tunnels,
    Effect.gen(function* () {
      const hub = yield* HubLink
      return Tunnels.of({
        open: (request) =>
          hub.send(
            RunnerToHub.cases.TunnelFailed.make({
              tunnelId: request.tunnelId,
              message: "This Runner opens no tunnels.",
            }),
          ),
        openCount: Effect.succeed(0),
      })
    }),
  )
}

const isTunnelAddress = Schema.is(TunnelAddress)

const describe = (error: SandboxError): string => {
  switch (error._tag) {
    case "SandboxNotFound":
      return "the Session has no Sandbox"
    case "SandboxNotRunning":
      return `its Sandbox is ${error.state}`
    case "SandboxAlreadyExists":
      return "its Sandbox is in an unexpected state"
    default:
      return error.message
  }
}

/** Closes the client's side as the guest's closed: after every byte, unless it broke. */
const closeClient = (end: TunnelEnd, lost: boolean) =>
  lost
    ? end.close(TunnelCloseCode.PeerLost, "The connection into the Sandbox was lost.")
    : end.close()

export const TunnelsLive = Layer.effect(
  Tunnels,
  Effect.gen(function* () {
    const config = yield* RunnerConfig
    const backend = yield* SandboxBackend
    const hub = yield* HubLink
    const sessions = yield* Sessions
    const makeWebSocket = yield* Socket.WebSocketConstructor
    const scope = yield* Effect.scope
    /** How to close each open tunnel, for when the Runner stops. */
    const live = new Set<() => void>()
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const close of live) close()
      }),
    )

    const failed = (tunnelId: TunnelId, message: string) =>
      hub.send(RunnerToHub.cases.TunnelFailed.make({ tunnelId, message }))

    const run = Effect.fnUntraced(function* (request: OpenTunnel) {
      const { tunnelId, sessionId, port, address } = request
      if (!isTunnelAddress(address)) {
        return yield* failed(
          tunnelId,
          `The Runner connects tunnels to 127.0.0.1 or ::1 only, not ${address}.`,
        )
      }
      if (!(yield* sessions.running).includes(sessionId)) {
        return yield* failed(tunnelId, "The Session isn't running on this Runner.")
      }

      // The Sandbox's side, held until the tunnel's socket is made just below.
      // oxlint-disable-next-line prefer-const -- set once its socket is made, read by the callbacks before
      let end: TunnelEnd | undefined
      const early: Array<Uint8Array> = []
      let earlyEof = false
      let earlyClosed: boolean | undefined
      // oxlint-disable-next-line prefer-const -- set once connected, read by the callbacks before
      let closeGuest: (() => void) | undefined
      /** Runs while bytes wait for the client: it must take some before it ends. */
      let stall: ReturnType<typeof setTimeout> | undefined
      const stopStall = () => {
        clearTimeout(stall)
        stall = undefined
      }
      const tooSlow = (reason: string) => {
        stopStall()
        end?.close(TunnelCloseCode.TooSlow, reason)
        closeGuest?.()
      }
      const watchStall = () => {
        if (stall !== undefined || end === undefined || end.waiting === 0) return
        stall = setTimeout(
          () => tooSlow(`The client took nothing for ${TunnelStallMs / 1000} s.`),
          TunnelStallMs,
        )
      }
      const toClient = (bytes: Uint8Array): void => {
        if (end === undefined) {
          early.push(bytes)
          return
        }
        if (end.closed) return
        end.send(bytes)
        if (end.waiting > TunnelBufferCap) {
          return tooSlow("The client read too slowly: the Runner held too much for it.")
        }
        watchStall()
      }
      const guest = yield* backend
        .connectTcp(sessionId, address, port, {
          data: toClient,
          eof: () => {
            if (end === undefined) earlyEof = true
            else end.end()
          },
          closed: (lost) => {
            if (end === undefined) earlyClosed = lost
            else closeClient(end, lost)
          },
        })
        .pipe(
          Effect.catch((error) =>
            Effect.as(
              failed(tunnelId, `Could not connect to port ${port}: ${describe(error)}`),
              undefined,
            ),
          ),
        )
      if (guest === undefined) return
      closeGuest = () => Effect.runFork(guest.close)

      const socket = yield* Effect.try(() =>
        makeWebSocket(runnerTunnelUrl(config.hubUrl, tunnelId), {
          headers: { authorization: `Bearer ${Redacted.value(config.token)}` },
        }),
      ).pipe(
        Effect.tapError(() => guest.close),
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (socket === undefined) return
      const close = () => end?.close(TunnelCloseCode.GoingAway, "The Runner is stopping.")
      live.add(close)
      end = new TunnelEnd(socket, {
        data: (bytes) => Effect.runPromise(guest.write(bytes)),
        eof: () => Effect.runFork(guest.end),
        closed: () => {
          live.delete(close)
          stopStall()
          closeGuest?.()
        },
        drained: stopStall,
        acknowledged: () => {
          stopStall()
          watchStall()
        },
      })
      for (const bytes of early.splice(0)) toClient(bytes)
      if (earlyEof) end.end()
      if (earlyClosed !== undefined) closeClient(end, earlyClosed)
    })

    return Tunnels.of({
      open: (request) => Effect.asVoid(Effect.forkIn(run(request), scope)),
      openCount: Effect.sync(() => live.size),
    })
  }),
)
