// An in-process stand-in for the Hub's web channel, until the real one (issues #7 and #8) is
// done. It speaks the protocol over a fake socket, so the HubClient can't tell the difference,
// and plays a scripted Session: streamed text, tool calls, a subagent, a second Participant
// joining and queueing a prompt, and a terminal to watch and type into; and Environments, shared
// variables and Test builds with a streaming log (environments.ts). `VITE_FAKE_HUB=1` runs the UI
// against it; tests use it too.
//
// It keeps its data in the wire (encoded) shapes and decodes what the client sends, so a client
// message the real Hub would refuse fails here too.

import { checkHandshake, ProtocolVersion, WebToHub } from "@claude-hub/protocol"
import { Schema } from "effect"
import type { SignInOptions } from "../config.ts"
import type { HubSocket, HubTransport, SignInStatus, SocketHandlers } from "../transport.ts"
import { FakeEnvironments, sessionStartScript, testBuildScript } from "./environments.ts"
import {
  archiveRetentionMs,
  bob,
  demoSessionId,
  type ReplyStep,
  replyTo,
  scriptedTurn,
  seedRunners,
  seedSessions,
  you as defaultYou,
} from "./script.ts"
import { FakeTerminal } from "./terminal.ts"
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
  /** Its Claude Code terminal, made when first opened. */
  terminal: FakeTerminal | null
  /** What its latest start printed, for clients that join while it runs. */
  startLog: string
}

class FakeSocket implements HubSocket {
  welcomed = false
  readonly joined = new Set<string>()
  /** The Sessions whose terminal this connection watches. */
  readonly terminals = new Set<string>()
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
  readonly environments = new FakeEnvironments()
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
        terminal: null,
        startLog: "",
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

  /**
   * Bob applies a version of `repo`'s Environment that gives each Sandbox more memory, as a
   * teammate would meanwhile: a draft made from the version before is then stale. In the browser,
   * `fakeHub.teammateApplies("kddige/claude-hub")` in the console.
   */
  teammateApplies(repo: string): void {
    const { environment } = this.environments.state(repo)
    if (!environment) return
    const { version: _, repo: __, ...recipe } = environment
    const refused = this.environments.apply(
      repo,
      environment.version,
      {
        ...recipe,
        resources: { ...recipe.resources, memoryMib: recipe.resources.memoryMib + 1024 },
      },
      bob,
    )
    if (refused === undefined) this.#environmentApplied(repo)
  }

  /** Tells everyone but `except` (who asked) the Repo's new version, and its Sessions too. */
  #environmentApplied(repo: string, except?: FakeSocket): void {
    const state = this.environments.state(repo)
    for (const socket of this.#sockets) {
      if (socket !== except && socket.welcomed) socket.deliver(state)
    }
    const latestVersion = this.environments.latestVersion(repo)
    if (latestVersion === undefined) return
    for (const session of this.sessions.values()) {
      if (session.summary.repo !== repo) continue
      session.summary = {
        ...session.summary,
        environment: { version: session.summary.environment?.version ?? null, latestVersion },
      }
      this.#summaryChanged(session)
    }
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
        const starting = session.summary.starting
        if (starting && session.startLog !== "") {
          socket.deliver({
            _tag: "SessionStartLogged",
            sessionId: message.sessionId,
            since: starting.since,
            data: session.startLog,
            replace: true,
          })
        }
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
        if (session.summary.state === "Archived") {
          this.#fail(
            socket,
            "SendPrompt",
            "The Session is archived: restore it to send prompts.",
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
      case "SleepSession": {
        const session = this.sessions.get(message.sessionId)
        if (!session) break
        if (session.summary.starting) {
          const reason = "The Session is still starting; put it to sleep once it has started."
          this.#fail(socket, "SleepSession", reason, message.sessionId)
          break
        }
        if (session.summary.state !== "Active" || session.stopTurn || session.queue.length > 0) {
          this.#fail(
            socket,
            "SleepSession",
            "Only an idle Active Session can be put to sleep.",
            message.sessionId,
          )
          break
        }
        this.#setState(session, "Asleep", "Put to sleep", this.#you)
        break
      }
      case "WakeSession": {
        const session = this.sessions.get(message.sessionId)
        if (!session) break
        if (session.summary.state === "Asleep") {
          this.#wake(session, "Woken on studio", this.#you)
          this.#next(session)
        } else if (session.summary.state !== "Active") {
          this.#fail(
            socket,
            "WakeSession",
            `The Session is ${session.summary.state}.`,
            message.sessionId,
          )
        }
        break
      }
      case "RestartSession":
        this.#restart(socket, message.sessionId)
        break
      case "GetEnvironment":
        socket.deliver({ ...this.environments.state(message.repo), requestId: message.requestId })
        break
      case "CheckEnvironmentDraft": {
        const prepared = this.environments.prepare(message.repo, message.draft)
        if (typeof prepared === "string") {
          this.#refuse(socket, message._tag, message.requestId, prepared)
          break
        }
        socket.deliver({
          _tag: "EnvironmentDraftChecked",
          requestId: message.requestId,
          repo: message.repo,
          needsTestBuild: prepared.changesBuild,
          testBuildPassed: this.environments.testBuildPassed(message.repo, prepared.digest),
        })
        break
      }
      case "StartTestBuild": {
        const runner = this.runners.find((candidate) => candidate.id === message.runnerId)
        if (!runner?.isOnline) {
          const reason = `Runner ${message.runnerId} is not online.`
          this.#refuse(socket, message._tag, message.requestId, reason)
          break
        }
        const prepared = this.environments.prepare(message.repo, message.draft)
        if (typeof prepared === "string") {
          this.#refuse(socket, message._tag, message.requestId, prepared)
          break
        }
        const testBuildId = `tb-${++this.#ids}`
        socket.deliver({
          _tag: "TestBuildStarted",
          requestId: message.requestId,
          testBuild: {
            id: testBuildId,
            repo: message.repo,
            runnerId: runner.id,
            startedBy: this.#you,
            startedAt: Date.now(),
          },
        })
        const { lines, passes } = testBuildScript(message.repo, message.draft)
        lines.forEach((line, index) =>
          this.#after(index + 1, () =>
            socket.deliver({ _tag: "TestBuildLogged", testBuildId, data: `${line}\n` }),
          ),
        )
        this.#after(lines.length + 1, () => {
          if (passes) this.environments.recordPassed(message.repo, prepared.digest)
          socket.deliver({
            _tag: "TestBuildEnded",
            testBuildId,
            repo: message.repo,
            result: passes ? "Passed" : "Failed",
            ...(!passes && { message: "The bootstrap script failed." }),
          })
        })
        break
      }
      case "ApplyEnvironment": {
        const { repo } = message
        const refused = this.environments.apply(repo, message.baseVersion, message.draft, this.#you)
        if (refused !== undefined) {
          this.#refuse(socket, message._tag, message.requestId, refused)
          break
        }
        socket.deliver({ ...this.environments.state(repo), requestId: message.requestId })
        this.#environmentApplied(repo, socket)
        break
      }
      case "GetSharedVariables":
        socket.deliver({
          _tag: "SharedVariables",
          requestId: message.requestId,
          variables: this.environments.sharedVariables(),
        })
        break
      case "SetSharedVariable":
      case "DeleteSharedVariable": {
        const refused =
          message._tag === "SetSharedVariable"
            ? this.environments.setShared(message.variable)
            : this.environments.deleteShared(message.name)
        if (refused !== undefined) {
          this.#refuse(socket, message._tag, message.requestId, refused)
          break
        }
        const shared = {
          _tag: "SharedVariables" as const,
          variables: this.environments.sharedVariables(),
        }
        socket.deliver({ ...shared, requestId: message.requestId })
        this.#toOthers(socket, shared)
        break
      }
      case "ArchiveSession": {
        const session = this.sessions.get(message.sessionId)
        if (!session) {
          this.#fail(socket, "ArchiveSession", "There is no such Session.", message.sessionId)
          break
        }
        if (session.summary.state === "Archived") {
          this.#fail(
            socket,
            "ArchiveSession",
            "The Session is already archived.",
            message.sessionId,
          )
          break
        }
        const at = Date.now()
        // A start or restart under way is over: its Claude Code is stopped for good.
        const { starting: _, restarting: __, ...summary } = session.summary
        session.summary = {
          ...summary,
          archived: { by: this.#you, at, purgeAt: at + archiveRetentionMs },
        }
        this.#setState(session, "Archived", undefined, this.#you)
        // Its Claude Code is stopped for good; the queue waits for a restore, as on the Hub.
        session.stopTurn?.()
        for (const watcher of this.#sockets) watcher.terminals.delete(message.sessionId)
        break
      }
      case "RestoreSession": {
        const session = this.sessions.get(message.sessionId)
        if (!session) {
          this.#fail(socket, "RestoreSession", "There is no such Session.", message.sessionId)
          break
        }
        if (session.summary.state !== "Archived") {
          this.#fail(socket, "RestoreSession", "The Session is not archived.", message.sessionId)
          break
        }
        const { archived: _, ...summary } = session.summary
        session.summary = summary
        this.#setState(session, "Asleep", "Restored from the archive", this.#you)
        break
      }
      // The terminal, as the real Hub relays it: watching needs no running terminal, but
      // keystrokes and resizes reach only an Active Session, from someone watching it. An
      // Archived Session has no terminal to open.
      case "OpenTerminal": {
        const session = this.sessions.get(message.sessionId)
        if (!session) break
        if (session.summary.state === "Archived") {
          this.#fail(
            socket,
            "OpenTerminal",
            "The Session is archived: it has no terminal to open.",
            message.sessionId,
          )
          break
        }
        socket.terminals.add(message.sessionId)
        if (session.summary.state === "Active") this.#snapshot(session, [socket])
        break
      }
      case "CloseTerminal":
        socket.terminals.delete(message.sessionId)
        break
      case "TerminalInput":
      case "TerminalResize": {
        const session = this.sessions.get(message.sessionId)
        if (!session) break
        if (!socket.terminals.has(message.sessionId)) {
          this.#fail(socket, message._tag, "Open the Session's terminal first.", message.sessionId)
          break
        }
        if (session.summary.state !== "Active") {
          const reason = `The Session is ${session.summary.state}: its terminal isn't running.`
          this.#fail(socket, message._tag, reason, message.sessionId)
          break
        }
        const terminal = this.#terminal(session)
        if (message._tag === "TerminalInput") terminal.type(message.data)
        // Like the Runner, a resize redraws everyone from a snapshot at the new size.
        else if (terminal.resize(message.size)) this.#snapshot(session)
        break
      }
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
    const version = this.environments.latestVersion(repo)
    if (version === undefined) {
      const message = `${repo} has no Environment yet: set one up before its first Session.`
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
      // Not started on any version until its Runner says so: it is being started on `version`.
      environment: { version: null, latestVersion: version },
    }
    const session: FakeSession = {
      summary,
      log: [],
      queue: [],
      guests: [],
      stopTurn: null,
      terminal: null,
      startLog: "",
    }
    this.sessions.set(id, session)
    this.#start(session)
    socket.deliver({ _tag: "SessionCreated", requestId, session: session.summary })
    for (const other of this.#sockets) {
      if (other !== socket && other.welcomed)
        other.deliver({ _tag: "SessionUpdated", session: session.summary })
    }
  }

  /**
   * Starts the Session's Claude Code and Sandbox, as the Hub does on create and wake: Active at
   * once, with `why` in its history, and starting until its Runner says it started, which
   * streams the start's output meanwhile (#70). Queued prompts wait until it has started.
   */
  #start(session: FakeSession, why?: { message: string; by?: ParticipantWire }): void {
    const sessionId = session.summary.id
    const { environment } = this.environments.state(session.summary.repo)
    const since = Date.now()
    // Built the first time it starts on a version; after that the Runner has the build.
    const build =
      environment !== null && session.summary.environment?.version !== environment.version
    session.startLog = ""
    session.summary = {
      ...session.summary,
      starting: { since, ...(environment !== null && { environmentVersion: environment.version }) },
    }
    if (why) this.#setState(session, "Active", why.message, why.by)
    const lines = sessionStartScript(environment, build)
    const stillStarting = () => session.summary.starting?.since === since
    lines.forEach((data, index) =>
      this.#after(2 * index + 1, () => {
        if (!stillStarting()) return
        session.startLog += data
        for (const socket of this.#joinedSockets(session)) {
          socket.deliver({ _tag: "SessionStartLogged", sessionId, since, data })
        }
      }),
    )
    this.#after(2 * lines.length + 1, () => {
      if (!stillStarting()) return
      const { starting: _, restarting: __, ...summary } = session.summary
      session.summary =
        environment === null
          ? summary
          : {
              ...summary,
              environment: {
                version: environment.version,
                latestVersion: this.environments.latestVersion(summary.repo) ?? environment.version,
              },
            }
      this.#summaryChanged(session)
      // Claude Code is up: its Runner sends a snapshot to everyone watching.
      this.#snapshot(session)
      this.#next(session)
    })
  }

  /**
   * Sleep then wake, so the Sandbox is rebuilt from the latest Environment version; an Asleep
   * Session is just woken. Refused as the Hub refuses it.
   */
  #restart(socket: FakeSocket, sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      this.#fail(socket, "RestartSession", "There is no such Session.", sessionId)
      return
    }
    if (session.summary.restarting) {
      this.#fail(socket, "RestartSession", "The Session is already restarting.", sessionId)
      return
    }
    const restarting = { by: this.#you, since: Date.now() }
    switch (session.summary.state) {
      case "Asleep":
        session.summary = { ...session.summary, restarting }
        this.#wake(session, "Woken on studio", this.#you)
        return
      case "Active":
        if (session.summary.starting) {
          const reason = "The Session is still starting; restart it once it has started."
          this.#fail(socket, "RestartSession", reason, sessionId)
          return
        }
        if (session.stopTurn) {
          const reason = "A Turn is running: stop it first, then restart."
          this.#fail(socket, "RestartSession", reason, sessionId)
          return
        }
        // Active until its Runner has stopped it, then Asleep, then started again.
        session.summary = { ...session.summary, restarting }
        this.#summaryChanged(session)
        this.#after(3, () => {
          if (session.summary.restarting !== restarting) return
          this.#setState(
            session,
            "Asleep",
            "Restarting for the Environment's latest version",
            this.#you,
          )
        })
        this.#after(6, () => {
          if (session.summary.state !== "Asleep" || session.summary.restarting !== restarting) {
            return
          }
          this.#wake(session, "Woken on studio", this.#you)
        })
        return
      case "Frozen":
        this.#fail(
          socket,
          "RestartSession",
          "The Session is Frozen: its Runner is offline. Restart it once the Runner returns.",
          sessionId,
        )
        return
      case "Archived":
        this.#fail(socket, "RestartSession", "The Session is archived.", sessionId)
        return
    }
  }

  /**
   * Starts an Asleep Session again, on its Repo's latest Environment version; queued prompts are
   * delivered once it has started.
   */
  #wake(session: FakeSession, message: string, by?: ParticipantWire): void {
    this.#start(session, { message, ...(by !== undefined && { by }) })
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
    // A Frozen Session's prompts wait for its Runner.
    if (session.stopTurn === null && session.summary.state !== "Frozen") this.#next(session)
  }

  /**
   * Delivers the next queued prompt; an Asleep Session is woken first, and a starting or
   * restarting one gets it once it has started.
   */
  #next(session: FakeSession): void {
    const { state, starting, restarting } = session.summary
    if (state === "Archived" || starting || restarting) return
    if (session.queue.length === 0) return
    if (session.summary.state === "Asleep") {
      this.#wake(session, "Woken by a prompt")
      return
    }
    const prompt = session.queue.shift()
    if (!prompt) return
    this.#queueChanged(session)
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

  #terminal(session: FakeSession): FakeTerminal {
    if (session.terminal) return session.terminal
    const terminal = new FakeTerminal(
      {
        after: (steps, fn) => void this.#after(steps, fn),
        changed: () => this.#terminalOutput(session),
      },
      {
        cwd: `/workspace/${session.summary.repo.split("/").at(-1) ?? "repo"}`,
        demo: session.summary.id === demoSessionId,
      },
    )
    session.terminal = terminal
    return terminal
  }

  /** Sends the whole screen to `sockets`, or to everyone watching. */
  #snapshot(session: FakeSession, sockets = this.#watching(session)): void {
    const terminal = this.#terminal(session)
    for (const socket of sockets) {
      socket.deliver({
        _tag: "TerminalFrame",
        sessionId: session.summary.id,
        kind: "Snapshot",
        data: terminal.snapshot(),
        size: terminal.size,
      })
    }
  }

  #terminalOutput(session: FakeSession): void {
    if (session.summary.state !== "Active") return
    const terminal = this.#terminal(session)
    for (const socket of this.#watching(session)) {
      socket.deliver({
        _tag: "TerminalFrame",
        sessionId: session.summary.id,
        kind: "Output",
        data: terminal.redraw(),
        size: terminal.size,
      })
    }
  }

  #watching(session: FakeSession): Array<FakeSocket> {
    return [...this.#sockets].filter(
      (socket) => socket.welcomed && socket.terminals.has(session.summary.id),
    )
  }

  #setState(
    session: FakeSession,
    state: SessionSummaryWire["state"],
    message?: string,
    by?: ParticipantWire,
  ): void {
    const wasActive = session.summary.state === "Active"
    session.summary = { ...session.summary, state }
    this.#append(session, {
      _tag: "SessionStateChanged",
      state,
      ...(by !== undefined && { by }),
      ...(message !== undefined && { message }),
    })
    this.#summaryChanged(session)
    // Claude Code starts again with the Session, and its Runner sends a snapshot to everyone
    // watching; a Session being started sends it once Claude Code is up.
    if (state === "Active" && !wasActive && !session.summary.starting) this.#snapshot(session)
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

  /** Refuses a command that has a request to answer. */
  #refuse(socket: FakeSocket, command: string, requestId: string, message: string): void {
    socket.deliver({ _tag: "CommandFailed", command, requestId, message })
  }

  /** Tells every other client, as the Hub broadcasts an applied version or changed variables. */
  #toOthers(socket: FakeSocket, message: HubMessage): void {
    for (const other of this.#sockets) {
      if (other !== socket && other.welcomed) other.deliver(message)
    }
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
