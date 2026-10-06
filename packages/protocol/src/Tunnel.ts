import { Schema } from "effect"
import type { SessionId } from "./Ids.ts"

// Tunnels (#177, ADR 0016): one TCP connection to an Open port of a Session, carried client → Hub
// → Runner → Sandbox. Each connection is its own pair of WebSockets, never the Runner's channel:
//
// - The client opens a WebSocket to `/tunnel/<session id>/<port>` on the Hub, with a CLI token as
//   `Authorization: Bearer`, or a browser's sign-in cookie. The Hub checks its access to the
//   Session on every connection, sends the Session's Runner an OpenTunnel on its channel, and
//   waits for the Runner to dial `/runner/tunnel/<tunnel id>` back with its Runner token. Then it
//   pipes the two together; or it closes the client's socket with a TunnelCloseCode saying why
//   not.
// - On both sockets, binary messages are the connection's bytes, each at most TunnelMaxFrame,
//   and text messages are TunnelControl, as JSON. A side that has delivered bytes it received
//   says so with an Ack; one that sends no more says Eof, a half-close. Neither side has more
//   than TunnelWindow bytes sent and not yet acknowledged, and the Hub closes a tunnel that does:
//   that is the backpressure, end to end, which a WebSocket alone doesn't give.

/** A tunnel, minted by the Hub for one connection. */
export const TunnelId = Schema.NonEmptyString.pipe(Schema.brand("TunnelId"))
export type TunnelId = typeof TunnelId.Type

/** The largest binary message on a tunnel's sockets, in bytes. */
export const TunnelMaxFrame = 64 * 1024

/** The most bytes a side of a tunnel may have sent and not had acknowledged. */
export const TunnelWindow = 1024 * 1024

/** The bytes the side sending it has received and delivered, since its last Ack. */
export const TunnelAck = Schema.TaggedStruct("Ack", {
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})
export type TunnelAck = typeof TunnelAck.Type

/** The side sending it sends no more bytes, as a TCP half-close: it still reads. */
export const TunnelEof = Schema.TaggedStruct("Eof", {})
export type TunnelEof = typeof TunnelEof.Type

/** A text message on a tunnel's sockets. */
export const TunnelControl = Schema.Union([TunnelAck, TunnelEof]).pipe(Schema.toTaggedUnion("_tag"))
export type TunnelControl = typeof TunnelControl.Type

/**
 * How a tunnel's sockets close, and why the Hub refused to open one. A refusal comes after the
 * upgrade, as a close with one of these codes and a message, so any WebSocket client can read why;
 * only a missing or wrong credential is answered before it, with `401` or `403`. The Hub closes one
 * side of a tunnel as the other closed it, with its code.
 */
export const TunnelCloseCode = {
  /** The connection ended: the server or the client closed it. */
  Closed: 1000,
  /** The Hub is shutting down. */
  GoingAway: 1001,
  /** A side broke the protocol: past the window, a frame too large, or text that isn't control. */
  ProtocolError: 4400,
  /** No such Session, or none the caller may reach: alike, as for joining one (ADR 0003). */
  NoSuchSession: 4404,
  /** The Session isn't Active: it is Asleep, Archived, or going to sleep. */
  NotActive: 4409,
  /** Nothing listens on the port in the Session's Sandbox. */
  PortNotOpen: 4410,
  /** GitHub couldn't say whether the caller has access to the Session's Repo; try again. */
  AccessUnknown: 4424,
  /** The Session's Runner runs a version from before tunnels: update it. */
  RunnerTooOld: 4426,
  /**
   * The client read too slowly: it took nothing for a long while, or left the Runner holding more
   * than its cap for it. The Runner holds back that connection's server alone meanwhile, so other
   * connections don't wait on this one.
   */
  TooSlow: 4429,
  /** The other side went away without closing: its Runner, or its network, dropped. */
  PeerLost: 4500,
  /** The Runner couldn't connect to the port in the Sandbox. */
  PortUnreachable: 4502,
  /** The Session's Runner is offline: the Session is Frozen. */
  RunnerOffline: 4503,
  /** The Runner didn't connect to the port and dial back in time. */
  RunnerTimeout: 4504,
} as const
export type TunnelCloseCode = (typeof TunnelCloseCode)[keyof typeof TunnelCloseCode]

/** How long the Hub waits for a Runner to dial back for a tunnel. */
export const TunnelDialTimeoutMs = 10_000

/** Where a client opens a tunnel to a Session's port. */
export const tunnelPath = (sessionId: SessionId, port: number) =>
  `/tunnel/${encodeURIComponent(sessionId)}/${port}`

/** Where a Runner dials back for a tunnel the Hub asked it to open. */
export const runnerTunnelPath = (tunnelId: TunnelId) =>
  `/runner/tunnel/${encodeURIComponent(tunnelId)}`

/**
 * The loopback address a Runner connects to for an Open port that listens on `addresses`, in
 * their address family (ADR 0016): `127.0.0.1` for any IPv4 address, `::1` otherwise. `localhost`
 * binds only `::1` under Node 22 and Bun, and `0.0.0.0` reaches neither.
 */
export const loopbackFor = (addresses: ReadonlyArray<string>): "127.0.0.1" | "::1" =>
  addresses.length === 0 ||
  addresses.some((address) => !address.includes(":") || /^::ffff:/i.test(address))
    ? "127.0.0.1"
    : "::1"

/** The addresses a Runner connects tunnels to: loopback only. */
export const TunnelAddress = Schema.Literals(["127.0.0.1", "::1"])
export type TunnelAddress = typeof TunnelAddress.Type
