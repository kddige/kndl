// Tunnels (#177, ADR 0016): one TCP connection to an Open port of a Session, carried client →
// Hub → Runner → Sandbox, as two WebSockets the Hub pipes together. See Tunnel.ts in the protocol
// for the framing.
//
// - `GET /tunnel/<session id>/<port>`, the client's: by the caller's credential, checked with
//   their access to the Session's Repo on every connection (SessionAccess.ts). A missing or wrong
//   credential is answered `401` or `403` with no socket; every other refusal comes after the
//   upgrade, as a close with a TunnelCloseCode and a message, so any WebSocket client can read
//   why. A caller without access is refused before the Runner is asked anything. Then the
//   SessionRelay sends the Runner an OpenTunnel, and the Hub waits TunnelDialTimeoutMs for it to
//   dial back.
// - `GET /runner/tunnel/<tunnel id>`, the Runner's: by its Runner token, for a tunnel the Hub
//   sent it and no other Runner.
//
// The Hub relays the messages as they are, and keeps each side to the window: it counts the
// bytes it passed toward a side less what that side acknowledged, and closes a tunnel past
// TunnelWindow, or with a frame past TunnelMaxFrame or text that isn't TunnelControl, with
// ProtocolError. As neither side may have more than the window unacknowledged, the Hub holds at
// most that much for a tunnel, and a slow reader slows its own sender and nothing else. One side
// closing closes the other with its code.

import {
  SessionId,
  TunnelCloseCode,
  TunnelControl,
  TunnelDialTimeoutMs,
  TunnelMaxFrame,
  TunnelWindow,
} from "@kndl/protocol"
import { Deferred, Duration, Effect, Fiber, Option, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Socket } from "effect/socket"
import { authenticateRunner } from "./Auth.ts"
import { closeReason } from "./CloseReason.ts"
import { HubShutdown } from "./HubShutdown.ts"
import { authorizeSessionAccess } from "./SessionAccess.ts"
import { SessionRelay } from "./SessionRelay.ts"
import { TunnelRefused, Tunnels } from "./Tunnels.ts"

/** How a tunnel's socket is closed: a code, and a reason short enough for a close frame. */
interface Close {
  readonly code: number
  readonly reason: string
}

const closeWith = (socket: Socket.Socket, close: Close) =>
  Effect.scoped(
    Effect.flatMap(socket.writer, (writer) =>
      writer.write(new Socket.CloseEvent(close.code, closeReason(close.reason))),
    ),
  ).pipe(Effect.ignore)

/**
 * The code to close one side with when the other closed with `code`: an application's own code
 * as it is, a normal close as one, and a close no one sent (1005, 1006) as PeerLost.
 */
export const passedOnClose = (code: number) =>
  code === 1000 || code === 1001 || code === 1005
    ? TunnelCloseCode.Closed
    : code >= 3000 && code <= 4999
      ? code
      : TunnelCloseCode.PeerLost

const decodeControl = Schema.decodeUnknownOption(Schema.fromJsonString(TunnelControl))

/** A side broke the protocol: the tunnel is closed on both. */
class Violation {
  readonly _tag = "Violation"
  constructor(readonly reason: string) {}
}

/**
 * Pipes two tunnel sockets together until one closes, keeping each to the window, then closes
 * the other as it closed.
 */
const pipeTunnel = (client: Socket.Socket, runner: Socket.Socket) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sides = {
        client: { socket: client, reader: yield* client.reader, writer: yield* client.writer },
        runner: { socket: runner, reader: yield* runner.reader, writer: yield* runner.writer },
      }
      /** The bytes passed toward each side and not yet acknowledged by it. */
      const unacked = { client: 0, runner: 0 }
      type Name = keyof typeof sides

      /** Passes what `from` sends to `to`, until `from` closes: how it closed, as an error. */
      const forward = (from: Name, to: Name) =>
        Effect.gen(function* () {
          const { reader } = sides[from]
          const { writer } = sides[to]
          while (true) {
            const chunks = yield* reader.pull
            for (const chunk of chunks) {
              if (typeof chunk === "string") {
                const control = decodeControl(chunk)
                if (Option.isNone(control)) {
                  return yield* Effect.fail(
                    new Violation(`The ${from} sent text that isn't control.`),
                  )
                }
                if (control.value._tag === "Ack") {
                  unacked[from] -= control.value.bytes
                  if (unacked[from] < 0) {
                    return yield* Effect.fail(
                      new Violation(`The ${from} acknowledged bytes it wasn't sent.`),
                    )
                  }
                }
              } else {
                if (chunk.byteLength > TunnelMaxFrame) {
                  return yield* Effect.fail(new Violation(`The ${from} sent a frame too large.`))
                }
                unacked[to] += chunk.byteLength
                if (unacked[to] > TunnelWindow) {
                  return yield* Effect.fail(new Violation(`The ${from} sent past the window.`))
                }
              }
              yield* writer.write(chunk)
            }
          }
        }).pipe(
          Effect.catchTag("SocketError", (error) =>
            Effect.succeed<{ readonly to: Name; readonly close: Close }>({
              to,
              close:
                error.reason._tag === "SocketCloseError"
                  ? {
                      code: passedOnClose(error.reason.code),
                      reason: error.reason.closeReason ?? "",
                    }
                  : { code: TunnelCloseCode.PeerLost, reason: "The other side went away." },
            }),
          ),
          Effect.catch((violation: Violation) =>
            Effect.succeed<{ readonly to: Name | "both"; readonly close: Close }>({
              to: "both",
              close: { code: TunnelCloseCode.ProtocolError, reason: violation.reason },
            }),
          ),
        )

      const ended = yield* Effect.raceFirst(
        forward("client", "runner"),
        forward("runner", "client"),
      )
      if (ended.to === "both") {
        yield* closeWith(client, ended.close)
        yield* closeWith(runner, ended.close)
      } else {
        yield* closeWith(sides[ended.to].socket, ended.close)
      }
    }),
  )

/** A WebSocket upgrade, or `426` for a request that isn't one. */
const isUpgrade = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.upgrade?.toLowerCase() === "websocket"

const notAnUpgrade = HttpServerResponse.jsonUnsafe(
  { error: "Open a WebSocket here." },
  { status: 426, headers: { upgrade: "websocket" } },
)

export const TunnelRoutes = HttpRouter.use(
  Effect.fn(function* (router) {
    const relay = yield* SessionRelay
    const tunnels = yield* Tunnels
    const shutdown = yield* HubShutdown
    // Pipes run here, not in the client's request: that is interrupted as soon as the client's
    // socket closes, before the close could be passed on to the Runner's.
    const routesScope = yield* Effect.scope

    // A client, to a port of a Session it has access to.
    yield* router.add(
      "GET",
      "/tunnel/:sessionId/:port",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (!isUpgrade(request)) return notAnUpgrade
        const params = yield* HttpRouter.params
        const sessionId = SessionId.make(params.sessionId ?? "-")
        // A credential that won't do fails here, as 401 or 403, before the upgrade.
        const access = yield* authorizeSessionAccess(sessionId).pipe(
          Effect.map(() => undefined),
          Effect.catchTag("SessionAccessRefused", (refused) =>
            Effect.succeed<Close>({
              code:
                refused.reason === "AccessUnknown"
                  ? TunnelCloseCode.AccessUnknown
                  : TunnelCloseCode.NoSuchSession,
              reason: refused.message,
            }),
          ),
        )
        const client = yield* request.upgrade
        if (access !== undefined) {
          yield* closeWith(client, access)
          return HttpServerResponse.empty()
        }
        const port = Number(params.port)
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          yield* closeWith(client, {
            code: TunnelCloseCode.PortNotOpen,
            reason: `${params.port} is not a port.`,
          })
          return HttpServerResponse.empty()
        }

        yield* Effect.gen(function* () {
          const tunnel = yield* relay.openTunnel(sessionId, port)
          yield* Effect.gen(function* () {
            const runner = yield* Deferred.await(tunnel.dialed).pipe(
              Effect.timeoutOrElse({
                duration: Duration.millis(TunnelDialTimeoutMs),
                orElse: () => {
                  const refused = new TunnelRefused({
                    code: TunnelCloseCode.RunnerTimeout,
                    message: "The Session's Runner didn't connect to the port in time.",
                  })
                  return Effect.andThen(Deferred.fail(tunnel.dialed, refused), Effect.fail(refused))
                },
              }),
            )
            yield* pipeTunnel(client, runner).pipe(
              Effect.forkIn(routesScope),
              Effect.flatMap(Fiber.join),
            )
          }).pipe(
            Effect.ensuring(
              Effect.andThen(
                tunnels.forget(tunnel.tunnelId),
                Deferred.succeed(tunnel.over, undefined),
              ),
            ),
          )
        }).pipe(
          Effect.catchTag("TunnelRefused", (refused) =>
            closeWith(client, { code: refused.code, reason: refused.message }),
          ),
          Effect.raceFirst(
            Effect.andThen(
              shutdown.started,
              closeWith(client, {
                code: TunnelCloseCode.GoingAway,
                reason: "The Hub is shutting down.",
              }),
            ),
          ),
          Effect.catchCause(Effect.logDebug),
        )
        return HttpServerResponse.empty()
      }),
    )

    // A Runner, dialing back for a tunnel it was asked to open, by its Runner token.
    yield* router.add(
      "GET",
      "/runner/tunnel/:tunnelId",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (!isUpgrade(request)) return notAnUpgrade
        const identity = yield* authenticateRunner
        const { tunnelId } = yield* HttpRouter.params
        const tunnel = yield* tunnels.claim(tunnelId ?? "", identity.runnerId)
        if (Option.isNone(tunnel)) {
          return HttpServerResponse.jsonUnsafe(
            { error: "No such tunnel: it was never asked for, or no one waits for it any more." },
            { status: 404 },
          )
        }
        const socket = yield* request.upgrade
        if (!(yield* Deferred.succeed(tunnel.value.dialed, socket))) {
          // The client stopped waiting.
          yield* closeWith(socket, {
            code: TunnelCloseCode.RunnerTimeout,
            reason: "No one waits for this tunnel any more.",
          })
          return HttpServerResponse.empty()
        }
        // The client's request pipes it, and closes it; this one waits for that.
        yield* Deferred.await(tunnel.value.over).pipe(
          Effect.raceFirst(
            Effect.andThen(
              shutdown.started,
              closeWith(socket, {
                code: TunnelCloseCode.GoingAway,
                reason: "The Hub is shutting down.",
              }),
            ),
          ),
        )
        return HttpServerResponse.empty()
      }),
    )
  }),
)
