// The web channel's client: opens the socket, says hello, decodes what the Hub sends into the
// store, and reconnects. On reconnect it joins each joined Session again with `afterSeq`, so the
// Hub sends only the entries it missed, and opens each open terminal again, which redraws it from
// a fresh Snapshot.

import {
  checkHandshake,
  type CommandFailed,
  HubToWeb,
  ProtocolVersion,
  RequestId,
  type RunnerId,
  type PromptId,
  type SessionId,
  type SessionSummary,
  type TerminalFrame,
  type TerminalSize,
  WebToHub,
} from "@claude-hub/protocol"
import { Schema } from "effect"
import {
  acceptsFrame,
  type HubAction,
  type HubState,
  initialState,
  lastSeq,
  reduce,
} from "./store.ts"
import type { HubSocket, HubTransport } from "./transport.ts"

export interface HubClientOptions {
  /** How long to wait before reconnect attempt `attempt` (1, 2, ...), in milliseconds. */
  retryDelay?: (attempt: number) => number
}

export interface NewSession {
  readonly repo: string
  readonly baseBranch: string
  readonly runnerId?: RunnerId
}

/** A command the Hub refused, or that couldn't be sent. */
export class CommandError extends Error {
  override readonly name = "CommandError"
}

const backoff = [500, 1_000, 2_000, 5_000, 10_000]

function defaultRetryDelay(attempt: number): number {
  return backoff[Math.min(attempt, backoff.length) - 1] ?? 10_000
}

const decodeHubToWeb = Schema.decodeUnknownSync(HubToWeb)
const encodeWebToHub = Schema.encodeSync(WebToHub)

/** Draws a terminal's frames: a Snapshot resets it and draws the screen; Output writes on. */
export type TerminalWriter = (frame: TerminalFrame) => void

interface PendingRequest {
  resolve(session: SessionSummary): void
  reject(error: CommandError): void
}

export class HubClient {
  readonly transport: HubTransport
  #state: HubState = initialState
  readonly #listeners = new Set<() => void>()
  readonly #failureListeners = new Set<(failure: CommandFailed) => void>()
  readonly #retryDelay: (attempt: number) => number
  readonly #requests = new Map<string, PendingRequest>()
  readonly #terminals = new Map<SessionId, Set<TerminalWriter>>()
  #socket: HubSocket | null = null
  /** Whether the current socket was welcomed. */
  #welcomed = false
  #running = false
  #retryTimer: ReturnType<typeof setTimeout> | undefined
  #requestCount = 0

  constructor(transport: HubTransport, options: HubClientOptions = {}) {
    this.transport = transport
    this.#retryDelay = options.retryDelay ?? defaultRetryDelay
  }

  /** The current state; a new object whenever anything changed. */
  getState = (): HubState => this.#state

  /** Calls `listener` after every change; returns the unsubscribe. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Calls `listener` when the Hub refuses a command that has no request to answer. */
  onCommandFailed(listener: (failure: CommandFailed) => void): () => void {
    this.#failureListeners.add(listener)
    return () => this.#failureListeners.delete(listener)
  }

  /** Connects, and keeps reconnecting until {@link stop}. */
  start(): void {
    if (this.#running) return
    this.#running = true
    this.#connect(0)
  }

  stop(): void {
    this.#running = false
    clearTimeout(this.#retryTimer)
    const socket = this.#socket
    this.#socket = null
    socket?.close()
    this.#failRequests("Disconnected from the Hub.")
  }

  /** Connects again now, such as after signing in. */
  retry(): void {
    this.stop()
    this.start()
  }

  // ── Commands ─────────────────────────────────────────────────────────────

  /** Starts following a Session: its log, presence and Prompt queue. */
  join(sessionId: SessionId): void {
    this.#dispatch({ _tag: "Joined", sessionId })
    if (this.#welcomed) this.#sendJoin(sessionId)
  }

  leave(sessionId: SessionId): void {
    if (!this.#state.joined[sessionId]) return
    this.#dispatch({ _tag: "Left", sessionId })
    if (this.#welcomed) this.#send({ _tag: "LeaveSession", sessionId })
  }

  /**
   * Shows a Session's terminal: `write` gets its frames, starting with a Snapshot, now and again
   * after every reconnect, and never Output that doesn't follow the screen it was given. Returns
   * the close.
   */
  openTerminal(sessionId: SessionId, write: TerminalWriter): () => void {
    let writers = this.#terminals.get(sessionId)
    if (!writers) {
      writers = new Set()
      this.#terminals.set(sessionId, writers)
    }
    writers.add(write)
    // Even when it's already open: the new view needs a screen to start from.
    this.#sendOpenTerminal(sessionId)
    return () => {
      const open = this.#terminals.get(sessionId)
      if (!open?.delete(write) || open.size > 0) return
      this.#terminals.delete(sessionId)
      this.#dispatch({ _tag: "TerminalClosed", sessionId })
      this.#send({ _tag: "CloseTerminal", sessionId })
    }
  }

  /** Types into a Session's terminal, as the terminal sends keystrokes. */
  sendTerminalInput(sessionId: SessionId, data: string): boolean {
    if (data === "") return false
    return this.#send({ _tag: "TerminalInput", sessionId, data })
  }

  /** Resizes a Session's terminal for everyone watching it. */
  resizeTerminal(sessionId: SessionId, size: TerminalSize): boolean {
    return this.#send({ _tag: "TerminalResize", sessionId, size })
  }

  /** Queues a prompt. False if it couldn't be sent because the Hub isn't connected. */
  sendPrompt(sessionId: SessionId, text: string): boolean {
    const trimmed = text.trim()
    if (trimmed === "") return false
    return this.#send({ _tag: "SendPrompt", sessionId, text: trimmed })
  }

  cancelPrompt(sessionId: SessionId, promptId: PromptId): boolean {
    return this.#send({ _tag: "CancelPrompt", sessionId, promptId })
  }

  stopTurn(sessionId: SessionId): boolean {
    return this.#send({ _tag: "StopTurn", sessionId })
  }

  /** Puts an Active Session to sleep now, rather than when it has been idle long enough. */
  sleepSession(sessionId: SessionId): boolean {
    return this.#send({ _tag: "SleepSession", sessionId })
  }

  /** Wakes an Asleep Session without sending it a prompt. */
  wakeSession(sessionId: SessionId): boolean {
    return this.#send({ _tag: "WakeSession", sessionId })
  }

  /** Creates a Session; resolves with it once the Hub has, or rejects with the Hub's reason. */
  createSession(input: NewSession): Promise<SessionSummary> {
    const requestId = RequestId.make(`req-${Date.now().toString(36)}-${++this.#requestCount}`)
    return new Promise((resolve, reject) => {
      const sent = this.#send({
        _tag: "CreateSession",
        requestId,
        repo: input.repo,
        baseBranch: input.baseBranch,
        ...(input.runnerId !== undefined && { runnerId: input.runnerId }),
      })
      if (!sent) reject(new CommandError("Not connected to the Hub."))
      else this.#requests.set(requestId, { resolve, reject })
    })
  }

  // ── The socket ───────────────────────────────────────────────────────────

  #connect(attempt: number): void {
    if (!this.#running) return
    this.#welcomed = false
    if (this.#state.connection.status !== "reconnecting") {
      this.#dispatch({
        _tag: "ConnectionChanged",
        connection: { status: "connecting", attempt },
      })
    }
    let closed = false
    const socket = this.transport.open({
      onOpen: () => {
        if (this.#socket !== socket) return
        socket.send(JSON.stringify({ _tag: "WebHello", protocolVersion: ProtocolVersion }))
      },
      onMessage: (text) => {
        if (this.#socket === socket) this.#receive(socket, text)
      },
      onClose: () => {
        if (closed) return
        closed = true
        if (this.#socket !== socket) return
        this.#socket = null
        this.#closed(attempt)
      },
    })
    this.#socket = socket
  }

  #receive(socket: HubSocket, text: string): void {
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      console.warn("Ignored a message from the Hub that isn't JSON")
      return
    }
    // A welcome from a Hub of another version wouldn't decode: check its version first.
    if (isTagged(raw, "WebWelcome")) {
      const rejection = checkHandshake(raw)
      if (rejection) {
        this.#reject(socket, rejection.message)
        return
      }
    }
    let message: HubToWeb
    try {
      message = decodeHubToWeb(raw)
    } catch (error) {
      console.warn("Ignored a message from the Hub that didn't decode", error)
      return
    }
    if (message._tag === "TerminalFrame") {
      this.#receiveFrame(message)
      return
    }
    this.#dispatch(message)
    switch (message._tag) {
      case "WebWelcome":
        this.#welcomed = true
        for (const sessionId of Object.keys(this.#state.joined) as Array<SessionId>) {
          this.#sendJoin(sessionId)
        }
        for (const sessionId of this.#terminals.keys()) this.#sendOpenTerminal(sessionId)
        break
      case "HandshakeRejected":
        this.#reject(socket, message.message)
        break
      case "SessionCreated": {
        const request = this.#requests.get(message.requestId)
        this.#requests.delete(message.requestId)
        request?.resolve(message.session)
        break
      }
      case "CommandFailed": {
        const request =
          message.requestId === undefined ? undefined : this.#requests.get(message.requestId)
        if (request && message.requestId !== undefined) {
          this.#requests.delete(message.requestId)
          request.reject(new CommandError(message.message))
        } else {
          for (const listener of this.#failureListeners) listener(message)
        }
        break
      }
    }
  }

  /** The Hub refused the hello: stay disconnected, since trying again would be refused too. */
  #reject(socket: HubSocket, message: string): void {
    this.#running = false
    this.#socket = null
    socket.close()
    this.#dispatch({ _tag: "ConnectionChanged", connection: { status: "rejected", message } })
    this.#failRequests(message)
  }

  #closed(attempt: number): void {
    const wasWelcomed = this.#welcomed
    this.#welcomed = false
    this.#failRequests("Lost the connection to the Hub.")
    if (!this.#running) return
    if (wasWelcomed) {
      this.#scheduleRetry(1)
      return
    }
    // Turned away before the welcome: most likely no one is signed in. Ask the Hub.
    this.transport.signInStatus().then(
      (status) => {
        if (!this.#running || this.#socket !== null) return
        if (status.signedIn) this.#scheduleRetry(attempt + 1)
        else {
          this.#dispatch({
            _tag: "ConnectionChanged",
            connection: { status: "signedOut", options: status.options },
          })
        }
      },
      () => {
        if (this.#running && this.#socket === null) this.#scheduleRetry(attempt + 1)
      },
    )
  }

  #scheduleRetry(attempt: number): void {
    this.#dispatch({ _tag: "ConnectionChanged", connection: { status: "reconnecting", attempt } })
    clearTimeout(this.#retryTimer)
    this.#retryTimer = setTimeout(() => this.#connect(attempt), this.#retryDelay(attempt))
  }

  #receiveFrame(frame: TerminalFrame): void {
    const terminal = this.#state.terminals[frame.sessionId]
    const writers = this.#terminals.get(frame.sessionId)
    if (!terminal || !writers || !acceptsFrame(terminal, frame)) return
    this.#dispatch(frame)
    for (const write of writers) write(frame)
  }

  /** Asks for the terminal's frames, from a Snapshot on: anything until then would be partial. */
  #sendOpenTerminal(sessionId: SessionId): void {
    this.#dispatch({ _tag: "TerminalOpened", sessionId })
    this.#send({ _tag: "OpenTerminal", sessionId })
  }

  #sendJoin(sessionId: SessionId): void {
    const joined = this.#state.joined[sessionId]
    const afterSeq = joined ? lastSeq(joined.log) : undefined
    this.#send({ _tag: "JoinSession", sessionId, ...(afterSeq !== undefined && { afterSeq }) })
  }

  #send(message: WebToHub): boolean {
    if (!this.#socket || !this.#welcomed) return false
    this.#socket.send(JSON.stringify(encodeWebToHub(message)))
    return true
  }

  #failRequests(reason: string): void {
    for (const request of this.#requests.values()) request.reject(new CommandError(reason))
    this.#requests.clear()
  }

  #dispatch(action: HubAction): void {
    const next = reduce(this.#state, action)
    if (next === this.#state) return
    this.#state = next
    for (const listener of this.#listeners) listener()
  }
}

function isTagged(value: unknown, tag: string): boolean {
  return typeof value === "object" && value !== null && (value as { _tag?: unknown })._tag === tag
}
