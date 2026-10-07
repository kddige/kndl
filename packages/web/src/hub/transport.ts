// How the HubClient reaches a Hub: a socket for the web channel, and the sign-in routes. The
// browser's transport talks to the real Hub on the page's own origin; the fake Hub implements the
// same interface in-process.

import { type CliLoginApproval, CliLoginApproved, Participant } from "@kndl/protocol"
import { Schema } from "effect"
import { hubPaths, type SignInOptions, webSocketUrl } from "./config.ts"

/** An open (or opening) web channel. Text frames only: every message is JSON. */
export interface HubSocket {
  send(text: string): void
  close(): void
}

export interface SocketHandlers {
  onOpen(): void
  onMessage(text: string): void
  /** The socket closed, or never opened. Called once. */
  onClose(): void
}

export type SignInStatus =
  | { readonly signedIn: true; readonly you: Participant }
  | { readonly signedIn: false; readonly options: SignInOptions }

export interface HubTransport {
  open(handlers: SocketHandlers): HubSocket
  /** Whether someone is signed in, and if not, how they can. Throws if the Hub can't be reached. */
  signInStatus(): Promise<SignInStatus>
  /** Dev login. Throws with the Hub's reason when it refuses. */
  devSignIn(login?: string): Promise<void>
  signOut(): Promise<void>
  /**
   * Approves `kndl login` on a machine, as whoever is signed in: the Login code the CLI
   * trades for its token (issue #179). Throws with the Hub's reason when it refuses.
   */
  approveCli(request: CliLoginApproval): Promise<CliLoginApproved>
  /**
   * Hands the Hub a Setup link's or Invite's secret, for the GitHub sign-in that follows to admit
   * the person by (issue #209). Throws with the Hub's reason when it refuses.
   */
  admit(ticket: string): Promise<void>
}

const decodeParticipant = Schema.decodeUnknownSync(Participant)
const decodeApproved = Schema.decodeUnknownSync(CliLoginApproved)

/** The Hub's `{ error }`, or what it answered. */
async function refusal(response: Response, what: string): Promise<Error> {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown }
  return new Error(
    typeof body.error === "string" ? body.error : `The Hub answered ${response.status} to ${what}`,
  )
}

/** The real Hub, same-origin: `/ws/web` and the `/auth` routes. */
export function browserTransport(): HubTransport {
  return {
    open(handlers) {
      const socket = new WebSocket(webSocketUrl(window.location))
      socket.addEventListener("open", () => handlers.onOpen())
      socket.addEventListener("message", (event: MessageEvent<unknown>) => {
        if (typeof event.data === "string") handlers.onMessage(event.data)
      })
      // A refused upgrade (no sign-in cookie) fires "error" then "close"; only "close" matters.
      socket.addEventListener("close", () => handlers.onClose())
      return {
        send: (text) => socket.send(text),
        close: () => socket.close(),
      }
    },

    async signInStatus() {
      const response = await fetch(hubPaths.me, { credentials: "same-origin" })
      if (response.ok) return { signedIn: true, you: decodeParticipant(await response.json()) }
      if (response.status === 401) {
        const body = (await response.json().catch(() => ({}))) as Partial<SignInOptions>
        return {
          signedIn: false,
          options: { github: body.github === true, dev: body.dev === true },
        }
      }
      throw new Error(`The Hub answered ${response.status} to ${hubPaths.me}`)
    },

    async devSignIn(login) {
      const response = await fetch(hubPaths.devSignIn, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(login === undefined || login === "" ? {} : { login }),
      })
      if (!response.ok) {
        const reason = await response.text().catch(() => "")
        throw new Error(reason || `Dev login failed (${response.status})`)
      }
    },

    async signOut() {
      await fetch(hubPaths.signOut, { method: "POST", credentials: "same-origin" })
    },

    async approveCli(request) {
      const response = await fetch(hubPaths.cliApprove, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      })
      if (!response.ok) throw await refusal(response, hubPaths.cliApprove)
      return decodeApproved(await response.json())
    },

    async admit(ticket) {
      const response = await fetch(hubPaths.admission, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket }),
      })
      if (!response.ok) {
        const reason = await response.text().catch(() => "")
        throw new Error(reason || `The Hub answered ${response.status} to ${hubPaths.admission}`)
      }
    },
  }
}
