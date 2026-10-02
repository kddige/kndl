// An in-process stand-in for the Hub's web channel, until the real one (issues #7 and #8) is
// done. It speaks the protocol over a fake socket, so the HubClient can't tell the difference,
// and plays a scripted Session: streamed text, tool calls, a subagent, a second Participant
// joining and queueing a prompt. `VITE_FAKE_HUB=1` runs the UI against it; tests use it too.
//
// It keeps its data in the wire (encoded) shapes and decodes what the client sends, so a client
// message the real Hub would refuse fails here too.

import { checkHandshake, ProtocolVersion, WebToHub } from "@claude-hub/protocol"
import { Schema } from "effect"
import type { SignInOptions } from "../config.ts"
import type { HubSocket, HubTransport, SignInStatus, SocketHandlers } from "../transport.ts"
import {
  bob,
  demoSessionId,
  type ReplyStep,
  replyTo,
  scriptedTurn,
  seedRunners,
  seedSessions,
  you as defaultYou,
} from "./script.ts"
import type {
  HubMessage,
  LogEntryWire,
  ParticipantWire,
  QueuedPromptWire,
  RunnerSummaryWire,
  SessionEventWire,
  SessionSummaryWire,
} from "./wire.ts"

export interface FakeHubOptions {
  /** Milliseconds per step of the script; text streams a few words a step. Default 120. */
  stepMs?: number
  /** Whether someone is signed in. Default true. */
  signedIn?: boolean
  /** Which sign-in methods the signed-out screen offers. Default both. */
  signInOptions?: SignInOptions
  /** Start the demo Session's script when it's first joined. Default true. */
  autoplay?: boolean
}

interface FakeSession {
  summary: SessionSummaryWire
  log: Array<LogEntryWire>
  queue: Array<QueuedPromptWire>
  /** People the script puts in the Session, besides whoever is connected. */
  guests: Array<ParticipantWire>
  /** Cancels the running Turn's remaining steps. */
  stopTurn: (() => void) | null
}

class FakeSocket implements HubSocket {
  welcomed = false
  readonly joined = new Set<string>()
  closed = false

  constructor(
    readonly hub: FakeHub,
    readonly handlers: SocketHandlers,
  ) {}

  send(text: string): void {
    if (this.closed) return
    // The network is asynchronous; so is the fake.
    queueMicrotask(() => this.hub.receive(this, text))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.hub.disconnected(this)
    setTimeout(() => this.handlers.onClose(), 0)
  }

  deliver(message: HubMessage): void {
    if (this.closed) return
    const text = JSON.stringify(message)
    setTimeout(() => {
      if (!this.closed) this.handlers.onMessage(text)
    }, 0)
  }
}

const decodeWebToHub = Schema.decodeUnknownSync(WebToHub)

export class FakeHub implements HubTransport {
  readonly stepMs: number
  readonly sessions = new Map<string, FakeSession>()
  readonly runners: Array<RunnerSummaryWire>
  /** Every message each client sent, decoded, for tests to inspect. */
  readonly received: Array<WebToHub> = []
  #signedIn: boolean
  #signInOptions: SignInOptions
  #you: ParticipantWire = defaultYou
  #autoplay: boolean
  #scriptStarted = false
  readonly #sockets = new Set<FakeSocket>()
  readonly #timers = new Set<ReturnType<typeof setTimeout>>()
  /** The scripted reply each queued prompt gets when it's delivered. */
  readonly #replies = new Map<string, ReadonlyArray<ReplyStep>>()
  #ids = 0

  constructor(options: FakeHubOptions = {}) {
    this.stepMs = options.stepMs ?? 120
    this.#signedIn = options.signedIn ?? true
    this.#signInOptions = options.signInOptions ?? { github: true, dev: true }
    this.#autoplay = options.autoplay ?? true
    this.runners = seedRunners()
    for (const seed of seedSessions()) {
      this.sessions.set(seed.summary.id, {
        summary: seed.summary,
        log: seed.events.map((event, seq) => ({ seq, at: seed.at + seq * 1_000, event })),
        queue: [],
        guests: [],
        stopTurn: null,
      })
    }
  }

  // ── HubTransport ─────────────────────────────────────────────────────────

  open(handlers: SocketHandlers): HubSocket {
    const socket = new FakeSocket(this, handlers)
    if (!this.#signedIn) {
      // The real Hub refuses the upgrade without a sign-in cookie: the socket never opens.
      socket.closed = true
      setTimeout(() => handlers.onClose(), 0)
      return socket
    }
    this.#sockets.add(socket)
    setTimeout(() => {
      if (!socket.closed) handlers.onOpen()
    }, 0)
    return socket
  }

  async signInStatus(): Promise<SignInStatus> {
    return this.#signedIn ? { signedIn: true } : { signedIn: false, options: this.#signInOptions }
  }

  async devSignIn(login?: string): Promise<void> {
    if (!this.#signInOptions.dev) throw new Error("Dev login is off.")
    this.#signedIn = true
    if (login) this.#you = { id: `dev:${login}`, login, name: login }
  }

  async signOut(): Promise<void> {
    this.#signedIn = false
    this.#closeAll()
  }

  // ── Test controls ────────────────────────────────────────────────────────

  /** Drops every connection, as a network blip would. */
  dropConnections(): void {
    this.#closeAll()
  }

  /** Stops every timer, so a test leaves nothing running. */
  dispose(): void {
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers.clear()
    this.#closeAll()
  }

  #closeAll(): void {
    // Closing a socket takes it out of the set, so iterate over a copy.
    for (const socket of Array.from(this.#sockets)) socket.close()
  }

  /** Starts the demo Session's script now, rather than on the first join. */
  play(): void {
    if (this.#scriptStarted) return
    this.#scriptStarted = true
    const session = this.sessions.get(demoSessionId)
    if (!session) return
    this.#after(4, () => {
      session.guests.push(bob)
      this.#presence(session)
    })
    this.#after(6, () =>
      this.#prompt(session, bob, "Can you make tool calls collapse by default?", scriptedTurn),
    )
  }

  // ── The channel ──────────────────────────────────────────────────────────

  receive(socket: FakeSocket, text: string): void {
    if (socket.closed) return
    const raw: unknown = JSON.parse(text)
    if (!socket.welcomed) {
      const rejection = checkHandshake(raw)
      if (rejection) {
        socket.deliver(rejection)
        socket.close()
        return
      }
    }
    let message: WebToHub
    try {
      message = decodeWebToHub(raw)
    } catch (error) {
      throw new Error(`The fake Hub got a message the protocol refuses: ${text}`, { cause: error })
    }
    this.received.push(message)
    if (!socket.welcomed && message._tag !== "WebHello") return
    switch (message._tag) {
      case "WebHello":
        socket.welcomed = true
        socket.deliver({ _tag: "WebWelcome", protocolVersion: ProtocolVersion, you: this.#you })
        socket.deliver({ _tag: "RunnerList", runners: this.runners })
        socket.deliver({
          _tag: "SessionList",
          sessions: [...this.sessions.values()].map((session) => session.summary),
        })
        break
      case "CreateSession":
        this.#create(socket, message.requestId, message.repo, message.baseBranch, message.runnerId)
        break
      case "JoinSession": {
        const session = this.sessions.get(message.sessionId)
        if (!session) {
          this.#fail(socket, "JoinSession", "No such Session.", message.sessionId)
          break
        }
        socket.joined.add(message.sessionId)
        const after = message.afterSeq ?? -1
        socket.deliver({
          _tag: "SessionHistory",
          sessionId: message.sessionId,
          entries: session.log.filter((entry) => entry.seq > after),
        })
        socket.deliver({
          _tag: "PromptQueueChanged",
          sessionId: message.sessionId,
          queue: session.queue,
        })
        this.#presence(session)
        if (message.sessionId === demoSessionId && this.#autoplay) this.play()
        break
      }
      case "LeaveSession": {
        socket.joined.delete(message.sessionId)
        const session = this.sessions.get(message.sessionId)
        if (session) this.#presence(session)
        break
      }
      case "SendPrompt": {
        const session = this.sessions.get(message.sessionId)
        if (!session) break
        if (session.summary.state === "Frozen" || session.summary.state === "Archived") {
          this.#fail(
            socket,
            "SendPrompt",
            `This Session is ${session.summary.state}: it can't take prompts.`,
            message.sessionId,
          )
          break
        }
        this.#prompt(session, this.#you, message.text, replyTo(message.text))
        break
      }
      case "CancelPrompt": {
        const session = this.sessions.get(message.sessionId)
        if (!session) break
        session.queue = session.queue.filter((prompt) => prompt.id !== message.promptId)
        this.#queueChanged(session)
        break
      }
      case "StopTurn": {
        const session = this.sessions.get(message.sessionId)
        if (!session?.stopTurn) break
        this.#append(session, { _tag: "TurnStopRequested", by: this.#you })
        session.stopTurn()
        break
      }
      case "OpenTerminal":
      case "CloseTerminal":
      case "TerminalInput":
      case "TerminalResize":
        // The terminal is issue #17's.
        break
    }
  }

  disconnected(socket: FakeSocket): void {
    this.#sockets.delete(socket)
    for (const sessionId of socket.joined) {
      const session = this.sessions.get(sessionId)
      if (session) this.#presence(session)
    }
  }

  // ── What the Hub does ────────────────────────────────────────────────────

  #create(
    socket: FakeSocket,
    requestId: string,
    repo: string,
    baseBranch: string,
    runnerId: string | undefined,
  ): void {
    const runner =
      runnerId === undefined
        ? this.runners.find((candidate) => candidate.isOnline)
        : this.runners.find((candidate) => candidate.id === runnerId)
    if (!runner || !runner.isOnline) {
      const message = runner ? `${runner.name} is offline.` : "No Runner is online."
      socket.deliver({ _tag: "CommandFailed", command: "CreateSession", requestId, message })
      return
    }
    const id = `s-new-${++this.#ids}`
    const summary: SessionSummaryWire = {
      id,
      repo,
      baseBranch,
      workBranch: `claude/${id}`,
      state: "Active",
      runnerId: runner.id,
      runnerLogin: runner.login,
      creator: this.#you,
      createdAt: Date.now(),
      currentTurn: null,
    }
    this.sessions.set(id, { summary, log: [], queue: [], guests: [], stopTurn: null })
    socket.deliver({ _tag: "SessionCreated", requestId, session: summary })
    for (const other of this.#sockets) {
      if (other !== socket && other.welcomed)
        other.deliver({ _tag: "SessionUpdated", session: summary })
    }
  }

  /** A prompt arrives: it runs now if the Session is idle, or waits in the Prompt queue. */
  #prompt(
    session: FakeSession,
    sender: ParticipantWire,
    text: string,
    reply: ReadonlyArray<ReplyStep>,
  ): void {
    const prompt: QueuedPromptWire = {
      id: `p-${++this.#ids}`,
      text,
      sender,
      queuedAt: Date.now(),
    }
    this.#replies.set(prompt.id, reply)
    session.queue.push(prompt)
    this.#queueChanged(session)
    if (session.stopTurn === null) this.#next(session)
  }

  /** Delivers the next queued prompt, waking the Session first if it's Asleep. */
  #next(session: FakeSession): void {
    const prompt = session.queue.shift()
    if (!prompt) return
    this.#queueChanged(session)
    if (session.summary.state === "Asleep") {
      this.#setState(session, "Active", "Woken by a prompt.")
    }
    this.#runTurn(session, prompt, this.#replies.get(prompt.id) ?? replyTo(prompt.text))
    this.#replies.delete(prompt.id)
  }

  #runTurn(session: FakeSession, prompt: QueuedPromptWire, steps: ReadonlyArray<ReplyStep>): void {
    const turnId = `t-${++this.#ids}`
    const started = Date.now()
    const timers: Array<ReturnType<typeof setTimeout>> = []
    const openTools = new Map<string, { tool: string; agentId?: string }>()
    const openAgents = new Set<string>()
    let ended = false

    const end = (reason: "Answered" | "Stopped") => {
      if (ended) return
      ended = true
      for (const timer of timers) {
        clearTimeout(timer)
        this.#timers.delete(timer)
      }
      for (const [toolCallId, open] of openTools) {
        this.#append(session, {
          _tag: "ToolCallEnded",
          turnId,
          ...(open.agentId !== undefined && { agentId: open.agentId }),
          toolCallId,
          tool: open.tool,
          outcome: "Failed",
          output: "Interrupted: the Turn was stopped.",
        })
      }
      for (const agentId of openAgents) {
        this.#append(session, {
          _tag: "TurnEnded",
          turnId,
          agentId,
          reason,
          durationMs: Date.now() - started,
        })
      }
      this.#append(session, {
        _tag: "TurnEnded",
        turnId,
        reason,
        durationMs: Date.now() - started,
        ...(reason === "Answered" && {
          usage: {
            model: "claude-opus-4-1",
            inputTokens: 1_200 + steps.length * 300,
            outputTokens: 180 + steps.length * 40,
            cacheReadInputTokens: 24_000,
            cacheCreationInputTokens: 900,
          },
        }),
      })
      session.stopTurn = null
      session.summary = { ...session.summary, currentTurn: null }
      this.#summaryChanged(session)
      this.#after(2, () => this.#next(session))
    }

    session.stopTurn = () => end("Stopped")
    session.summary = { ...session.summary, currentTurn: turnId }
    this.#summaryChanged(session)
    this.#append(session, {
      _tag: "TurnStarted",
      turnId,
      // The Hub tells the model who is talking.
      text: `[${prompt.sender.name}] ${prompt.text}`,
      sender: { _tag: "FromParticipant", participant: prompt.sender },
      promptId: prompt.id,
    })

    let at = 1
    const schedule = (delay: number, fn: () => void) => {
      at += delay
      timers.push(this.#after(at, fn))
    }
    const layout = (step: ReplyStep): void => {
      const agent =
        step.kind !== "queue" && step.kind !== "pause" && step.agentId !== undefined
          ? { agentId: step.agentId }
          : {}
      const touch = () => {
        if (agent.agentId !== undefined) openAgents.add(agent.agentId)
      }
      switch (step.kind) {
        case "text":
          for (const chunk of chunks(step.text)) {
            schedule(1, () => {
              touch()
              this.#append(session, { _tag: "TextDelta", turnId, ...agent, text: chunk })
            })
          }
          break
        case "tool": {
          const toolCallId = `tool-${++this.#ids}`
          schedule(1, () => {
            touch()
            openTools.set(toolCallId, { tool: step.tool, ...agent })
            this.#append(session, {
              _tag: "ToolCallStarted",
              turnId,
              ...agent,
              toolCallId,
              tool: step.tool,
              input: JSON.stringify(step.input),
            })
          })
          // A subagent works while the tool call that started it runs.
          for (const inner of step.during ?? []) layout(inner)
          schedule(step.steps ?? 4, () => {
            openTools.delete(toolCallId)
            this.#append(session, {
              _tag: "ToolCallEnded",
              turnId,
              ...agent,
              toolCallId,
              tool: step.tool,
              outcome: step.outcome ?? "Succeeded",
              output: step.output,
            })
          })
          break
        }
        case "agentEnd":
          schedule(1, () => {
            openAgents.delete(step.agentId)
            this.#append(session, {
              _tag: "TurnEnded",
              turnId,
              agentId: step.agentId,
              reason: "Answered",
              durationMs: Date.now() - started,
            })
          })
          break
        case "queue":
          schedule(0, () => this.#prompt(session, step.sender, step.text, replyTo(step.text)))
          break
        case "pause":
          at += step.steps
          break
      }
    }
    for (const step of steps) layout(step)
    schedule(1, () => end("Answered"))
  }

  #setState(session: FakeSession, state: SessionSummaryWire["state"], message?: string): void {
    session.summary = { ...session.summary, state }
    this.#append(session, {
      _tag: "SessionStateChanged",
      state,
      ...(message !== undefined && { message }),
    })
    this.#summaryChanged(session)
  }

  #append(session: FakeSession, event: SessionEventWire): void {
    const entry: LogEntryWire = { seq: session.log.length, at: Date.now(), event }
    session.log.push(entry)
    for (const socket of this.#joinedSockets(session)) {
      socket.deliver({ _tag: "SessionEventLogged", sessionId: session.summary.id, entry })
    }
  }

  #summaryChanged(session: FakeSession): void {
    for (const socket of this.#sockets) {
      if (socket.welcomed) socket.deliver({ _tag: "SessionUpdated", session: session.summary })
    }
  }

  #queueChanged(session: FakeSession): void {
    for (const socket of this.#joinedSockets(session)) {
      socket.deliver({
        _tag: "PromptQueueChanged",
        sessionId: session.summary.id,
        queue: [...session.queue],
      })
    }
  }

  #presence(session: FakeSession): void {
    // Every connection is the one signed-in person, so they're here if any of theirs joined.
    const sockets = this.#joinedSockets(session)
    const participants = new Map<string, ParticipantWire>()
    if (sockets.length > 0) participants.set(this.#you.id, this.#you)
    for (const guest of session.guests) participants.set(guest.id, guest)
    for (const socket of sockets) {
      socket.deliver({
        _tag: "PresenceChanged",
        sessionId: session.summary.id,
        participants: [...participants.values()],
      })
    }
  }

  #joinedSockets(session: FakeSession): Array<FakeSocket> {
    return [...this.#sockets].filter(
      (socket) => socket.welcomed && socket.joined.has(session.summary.id),
    )
  }

  #fail(socket: FakeSocket, command: string, message: string, sessionId?: string): void {
    socket.deliver({
      _tag: "CommandFailed",
      command,
      message,
      ...(sessionId !== undefined && { sessionId }),
    })
  }

  #after(steps: number, fn: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.#timers.delete(timer)
      fn()
    }, steps * this.stepMs)
    this.#timers.add(timer)
    return timer
  }
}

/** Splits text into the pieces it streams in: a few words at a time. */
export function chunks(text: string): Array<string> {
  const words = text.match(/\S+\s*|\s+/g) ?? []
  const pieces: Array<string> = []
  for (let index = 0; index < words.length; index += 3) {
    pieces.push(words.slice(index, index + 3).join(""))
  }
  return pieces
}
