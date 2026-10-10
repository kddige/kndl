// How the HubClient reaches a Hub: a socket for the web channel, the sign-in routes, and the
// attachments' uploads (#276). The browser's transport talks to the real Hub on the page's own
// origin; the fake Hub implements the same interface in-process.

import {
  type AttachmentId,
  AttachmentNameHeader,
  AttachmentUploaded,
  type CliLoginApproval,
  CliLoginApproved,
  Participant,
  type SessionId,
} from "@kndl/protocol"
import { Schema } from "effect"
import {
  attachmentPath,
  attachmentsPath,
  hubPaths,
  type SignInOptions,
  webSocketUrl,
} from "./config.ts"

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

/** How an upload goes: the bytes sent so far, and a way to give it up. */
export interface UploadOptions {
  readonly onProgress: (sent: number) => void
  readonly signal: AbortSignal
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
  /**
   * Uploads a file to attach to a prompt in the Session (#276), saying how far it got as it goes:
   * the Hub's id for it. Throws with the Hub's reason when it refuses, as for a file too large.
   */
  uploadAttachment(sessionId: SessionId, file: File, options: UploadOptions): Promise<AttachmentId>
  /** Where the browser loads one of the Session's attachments from. */
  attachmentUrl(sessionId: SessionId, attachmentId: AttachmentId): string
}

const decodeParticipant = Schema.decodeUnknownSync(Participant)
const decodeApproved = Schema.decodeUnknownSync(CliLoginApproved)
const decodeUploaded = Schema.decodeUnknownSync(Schema.fromJsonString(AttachmentUploaded))

/** Why the Hub refused an upload, from its `{ error }`. */
function uploadRefusal(status: number, body: string): Error {
  try {
    const { error } = JSON.parse(body) as { error?: unknown }
    if (typeof error === "string") return new Error(error)
  } catch {
    // Said below.
  }
  return new Error(status === 0 ? "The upload was cut off." : `The Hub answered ${status}.`)
}

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

    // XMLHttpRequest, not fetch, which can't tell how far an upload got.
    uploadAttachment(sessionId, file, { onProgress, signal }) {
      return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest()
        request.open("POST", attachmentsPath(sessionId))
        request.setRequestHeader(AttachmentNameHeader, encodeURIComponent(file.name))
        request.upload.addEventListener("progress", (event) => onProgress(event.loaded))
        request.addEventListener("load", () => {
          if (request.status !== 201)
            return reject(uploadRefusal(request.status, request.responseText))
          try {
            resolve(decodeUploaded(request.responseText).id)
          } catch {
            reject(new Error("The Hub's answer to the upload was not one."))
          }
        })
        request.addEventListener("error", () => reject(uploadRefusal(0, "")))
        request.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
        signal.addEventListener("abort", () => request.abort(), { once: true })
        request.send(file)
      })
    },

    attachmentUrl: attachmentPath,
  }
}
