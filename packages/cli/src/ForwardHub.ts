// What `kndl forward` (#180) asks of the Hub, as the CLI token's person: the Sessions it can
// forward, and a Session's forward, the WebSocket that keeps it in the Session's presence and
// sends the Session as it changes (Forward.ts in the protocol).
import {
  CliSessionList,
  ForwardHello,
  forwardPath,
  HandshakeRejected,
  HubToForward,
  ProtocolVersion,
  type SessionId,
  type SessionSummary,
} from "@kndl/protocol"
import { Option, Schema } from "effect"

const HubTimeoutMs = 15_000

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** What became of asking the Hub for the Sessions. */
export type SessionListing =
  | { readonly _tag: "Listed"; readonly sessions: ReadonlyArray<SessionSummary> }
  | { readonly _tag: "SignedOut" }
  | { readonly _tag: "Failed"; readonly message: string }

const decodeList = Schema.decodeUnknownOption(CliSessionList)

/** The Sessions the CLI token's person can forward: every one not Archived, newest first. */
export async function listSessions(hub: string, token: string): Promise<SessionListing> {
  let response: Response
  try {
    response = await fetch(new URL("/auth/cli/sessions", hub), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(HubTimeoutMs),
    })
  } catch (error) {
    return { _tag: "Failed", message: `Couldn't reach the Hub at ${hub} (${messageOf(error)}).` }
  }
  if (response.status === 401) return { _tag: "SignedOut" }
  const body: unknown = await response.json().catch(() => undefined)
  const list = response.status === 200 ? decodeList(body) : Option.none()
  if (Option.isSome(list)) return { _tag: "Listed", sessions: list.value.sessions }
  return {
    _tag: "Failed",
    message: `${hub} answered ${response.status} when asked for the Sessions; is it older than this CLI?`,
  }
}

/** The WebSocket URL of a Hub path. */
export const socketUrl = (hub: string, path: string) => {
  const url = new URL(path, hub)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.href
}

/** What a {@link ForwardLink} hands on. */
export interface ForwardLinkEvents {
  /** The Session, as soon as the Hub accepts the forward, and whenever it changes. */
  readonly session: (session: SessionSummary) => void
  /**
   * The forward ended: closed by the Hub with a ForwardCloseCode and why, or dropped (1006), or
   * refused: at the upgrade (1002, as Bun says a status other than 101), or at the handshake,
   * when `rejected` says why. Called once.
   */
  readonly closed: (code: number, reason: string, rejected: string | undefined) => void
}

const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(HubToForward))
const decodeRejected = Schema.decodeUnknownOption(Schema.fromJsonString(HandshakeRejected))

/** A Session's forward: open while the CLI forwards it. */
export class ForwardLink {
  private readonly socket: WebSocket
  private done = false
  private rejected: string | undefined

  constructor(hub: string, token: string, sessionId: SessionId, events: ForwardLinkEvents) {
    this.socket = new WebSocket(socketUrl(hub, forwardPath(sessionId)), {
      headers: { authorization: `Bearer ${token}` },
    })
    this.socket.addEventListener("open", () => {
      this.socket.send(JSON.stringify(ForwardHello.make({ protocolVersion: ProtocolVersion })))
    })
    this.socket.addEventListener("message", (event) => {
      const text = String(event.data)
      const message = decodeMessage(text)
      if (Option.isSome(message)) {
        if (message.value._tag === "ForwardSession") events.session(message.value.session)
        return
      }
      const rejected = decodeRejected(text)
      if (Option.isSome(rejected)) this.rejected = rejected.value.message
    })
    this.socket.addEventListener("close", (event) => {
      if (this.done) return
      this.done = true
      events.closed(event.code, event.reason, this.rejected)
    })
  }

  /** Ends the forward: the Hub takes it out of the Session's presence. */
  close(): void {
    this.done = true
    this.socket.close(1000)
  }
}
