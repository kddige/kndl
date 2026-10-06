import { Schema } from "effect"
import type { SessionId } from "./Ids.ts"
import { SessionSummary } from "./Session.ts"
import { CurrentProtocolVersion } from "./Version.ts"

// `kndl forward` (#180, ADR 0016): a Session's Open ports on the machine the CLI runs on.
// The CLI, signed in with a CLI token, keeps one WebSocket to the Hub per Session it forwards:
//
// - `GET /ws/forward/<session id>`, with the CLI token as `Authorization: Bearer`, checked with
//   the caller's access to the Session's Repo like a tunnel (ADR 0003). A missing or wrong token
//   is answered `401` with no socket; every other refusal comes after the upgrade, as a close with
//   a ForwardCloseCode and a message.
// - The CLI says ForwardHello; the Hub answers ForwardWelcome, or HandshakeRejected, then sends
//   a ForwardSession with the Session as the web sees it, and another whenever it changes: its
//   Open ports come and go there. The CLI sends nothing more.
// - While it is connected the forward is presence: it keeps the Session awake like a Participant
//   in it, and the Session's presence names the machine, from the CLI token. Connecting to an
//   Asleep Session wakes it. If the Session goes to sleep anyway, the Hub closes the forward with
//   WentAsleep. Each forwarded connection is its own tunnel (Tunnel.ts).
//
// `GET /auth/cli/sessions`, with the CLI token, lists the Sessions `forward` can pick from.

/** Where the CLI opens a Session's forward. */
export const forwardPath = (sessionId: SessionId) => `/ws/forward/${encodeURIComponent(sessionId)}`

/** CLI to Hub, first: the protocol version it speaks. */
export const ForwardHello = Schema.TaggedStruct("ForwardHello", {
  protocolVersion: CurrentProtocolVersion,
})
export type ForwardHello = typeof ForwardHello.Type

/** Hub to CLI: the forward is accepted. A ForwardSession follows. */
export const ForwardWelcome = Schema.TaggedStruct("ForwardWelcome", {
  protocolVersion: CurrentProtocolVersion,
})
export type ForwardWelcome = typeof ForwardWelcome.Type

/** Hub to CLI: the Session as the web sees it, now and whenever it changes. */
export const ForwardSession = Schema.TaggedStruct("ForwardSession", {
  session: SessionSummary,
})
export type ForwardSession = typeof ForwardSession.Type

/** What the Hub sends on a forward, after the hello. */
export const HubToForward = Schema.Union([ForwardWelcome, ForwardSession]).pipe(
  Schema.toTaggedUnion("_tag"),
)
export type HubToForward = typeof HubToForward.Type

/** The CLI sends nothing after its hello. */
export const ForwardToHub = Schema.Never

/**
 * How the Hub closes a forward, and why it refused one. The CLI reconnects after `GoingAway` or a
 * dropped connection, and stops after the rest, saying why.
 */
export const ForwardCloseCode = {
  /** The Hub is shutting down. */
  GoingAway: 1001,
  /** The CLI token was revoked: on the Account page, or by `kndl logout`. */
  SignedOut: 4401,
  /**
   * No such Session, or none the caller may reach: alike, as for joining one (ADR 0003). Also once
   * the caller loses access to its Repo, or it is purged.
   */
  NoSuchSession: 4404,
  /** The Session went asleep, or couldn't be woken: the reason says why. */
  WentAsleep: 4409,
  /** The Session was archived. */
  Archived: 4410,
  /** GitHub couldn't say whether the caller has access to the Session's Repo; try again. */
  AccessUnknown: 4424,
} as const

/** What `GET /auth/cli/sessions` answers: the caller's Sessions that aren't Archived, newest first. */
export const CliSessionList = Schema.Struct({
  sessions: Schema.Array(SessionSummary),
})
export type CliSessionList = typeof CliSessionList.Type
