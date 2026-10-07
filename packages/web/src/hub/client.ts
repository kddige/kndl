// The web channel's client: opens the socket, says hello, decodes what the Hub sends into the
// store, and reconnects. On reconnect it joins each joined Session again with `afterSeq`, so the
// Hub sends only the entries it missed, and opens each open terminal again, which redraws it from
// a fresh Snapshot. Commands that the Hub answers (creating a Session, the Environment commands)
// return a promise of the answer, matched to it by request id.

import {
  type AgentId,
  type AppPermissionsCheck,
  checkHandshake,
  type ClaudeCredentialState,
  type ClaudePlanChoice,
  type CliTokenId,
  type CommandFailed,
  type EnvironmentDraft,
  type EffortLevel,
  type EnvironmentDraftChecked,
  type EnvironmentState,
  type EnvironmentVersion,
  HubToWeb,
  type ModelName,
  type PairingCodeCreated,
  type PairingCodeId,
  ProtocolVersion,
  RequestId,
  type RunnerId,
  type PromptId,
  type RepoChecked,
  type SessionId,
  type SessionSummary,
  type SharedVariable,
  type SharedVariableInput,
  type TerminalFrame,
  type TerminalSize,
  type TestBuild,
  WebToHub,
} from "@kndl/protocol"
import { Redacted, Schema } from "effect"
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
  /** The model to start it on; Claude Code's default without one (#128). */
  readonly model?: ModelName
  readonly effort?: EffortLevel
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

/** A message the Hub sends in answer to a request, with its id. */
type Answer = Extract<HubToWeb, { readonly requestId?: RequestId }>
type AnswerTag = Exclude<Answer["_tag"], "CommandFailed">

interface PendingRequest {
  readonly answer: AnswerTag
  resolve(message: Answer): void
  reject(error: CommandError): void
}

/** A command that carries a request id, without it: {@link HubClient} adds one. */
type Request = WebToHub extends infer Message
  ? Message extends { readonly requestId: RequestId }
    ? Omit<Message, "requestId">
    : never
  : never

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

  /**
   * Steers a queued prompt into the running Turn (#195): it leaves the queue once it has joined
   * the Turn, and stays in its place if it can't.
   */
  steerPrompt(sessionId: SessionId, promptId: PromptId): boolean {
    return this.#send({ _tag: "SteerPrompt", sessionId, promptId })
  }

  stopTurn(sessionId: SessionId): boolean {
    return this.#send({ _tag: "StopTurn", sessionId })
  }

  /**
   * Messages a subagent of the Session (ADR 0014): a running one reads it at its next tool call,
   * a finished one resumes.
   */
  messageAgent(sessionId: SessionId, agentId: AgentId, text: string): boolean {
    const trimmed = text.trim()
    if (trimmed === "") return false
    return this.#send({ _tag: "MessageAgent", sessionId, agentId, text: trimmed })
  }

  stopAgent(sessionId: SessionId, agentId: AgentId): boolean {
    return this.#send({ _tag: "StopAgent", sessionId, agentId })
  }

  /**
   * Puts an Active Session to sleep now, rather than when it has been idle long enough. It turns
   * Keep awake off.
   */
  sleepSession(sessionId: SessionId): boolean {
    return this.#send({ _tag: "SleepSession", sessionId })
  }

  /**
   * Turns a Session's Keep awake on or off (ADR 0016): while on, it doesn't go to sleep when idle.
   * Turning it on wakes an Asleep Session. Every open tab gets the change as a SessionUpdated.
   */
  setKeepAwake(sessionId: SessionId, on: boolean): boolean {
    return this.#send({ _tag: "SetKeepAwake", sessionId, on })
  }

  /** Wakes an Asleep Session without sending it a prompt. */
  wakeSession(sessionId: SessionId): boolean {
    return this.#send({ _tag: "WakeSession", sessionId })
  }

  /**
   * Deletes a Session, which archives it at once: its Sandbox is destroyed, and it can be
   * restored until it is purged.
   */
  archiveSession(sessionId: SessionId): boolean {
    return this.#send({ _tag: "ArchiveSession", sessionId })
  }

  /**
   * Gives a Session a Session name, or clears it with an empty one, so its Work branch shows again.
   * Every open tab gets the change, this one included, as a SessionUpdated.
   */
  renameSession(sessionId: SessionId, name: string): boolean {
    return this.#send({ _tag: "RenameSession", sessionId, name })
  }

  /**
   * Sets the model and effort a Session runs, for everyone in it (#128); an absent one is Claude
   * Code's default. A running Turn finishes on the old one: the new one runs from the next Turn.
   * Every open tab gets the change as a SessionUpdated, and the transcript a ModelSwitched.
   */
  setSessionModel(
    sessionId: SessionId,
    setting: { readonly model?: ModelName; readonly effort?: EffortLevel },
  ): boolean {
    return this.#send({
      _tag: "SetSessionModel",
      sessionId,
      ...(setting.model !== undefined && { model: setting.model }),
      ...(setting.effort !== undefined && { effort: setting.effort }),
    })
  }

  /** Brings an Archived Session back, Asleep: the next prompt wakes it. */
  restoreSession(sessionId: SessionId): boolean {
    return this.#send({ _tag: "RestoreSession", sessionId })
  }

  /**
   * Restarts a Session so its Sandbox is rebuilt from its Repo's latest Environment version: an
   * Active one is put to sleep and woken again, an Asleep one just woken.
   */
  restartSession(sessionId: SessionId): boolean {
    return this.#send({ _tag: "RestartSession", sessionId })
  }

  /** Creates a Session; resolves with it once the Hub has, or rejects with the Hub's reason. */
  async createSession(input: NewSession): Promise<SessionSummary> {
    const created = await this.#request(
      {
        _tag: "CreateSession",
        repo: input.repo,
        baseBranch: input.baseBranch,
        ...(input.runnerId !== undefined && { runnerId: input.runnerId }),
        ...(input.model !== undefined && { model: input.model }),
        ...(input.effort !== undefined && { effort: input.effort }),
      },
      "SessionCreated",
    )
    return created.session
  }

  // ── Environments (ADR 0009) ──────────────────────────────────────────────

  /** A Repo's Environment and versions, which the store then keeps current. */
  getEnvironment(repo: string): Promise<EnvironmentState> {
    return this.#request({ _tag: "GetEnvironment", repo }, "EnvironmentState")
  }

  /** Whether applying `draft` needs a Test build first, and whether one of it has passed. */
  checkEnvironmentDraft(repo: string, draft: EnvironmentDraft): Promise<EnvironmentDraftChecked> {
    return this.#request({ _tag: "CheckEnvironmentDraft", repo, draft }, "EnvironmentDraftChecked")
  }

  /** Builds `draft` on a Runner; the store then follows its log under the Test build's id. */
  async startTestBuild(
    repo: string,
    runnerId: RunnerId,
    draft: EnvironmentDraft,
  ): Promise<TestBuild> {
    const started = await this.#request(
      { _tag: "StartTestBuild", repo, runnerId, draft },
      "TestBuildStarted",
    )
    return started.testBuild
  }

  /** Applies `draft`, made from `baseVersion`, as the Repo's next Environment version. */
  applyEnvironment(
    repo: string,
    baseVersion: EnvironmentVersion | null,
    draft: EnvironmentDraft,
  ): Promise<EnvironmentState> {
    return this.#request({ _tag: "ApplyEnvironment", repo, baseVersion, draft }, "EnvironmentState")
  }

  /** Has the Hub check the GitHub App's permissions now; the store then holds what it found. */
  async checkAppPermissions(): Promise<AppPermissionsCheck> {
    return (await this.#request({ _tag: "CheckAppPermissions" }, "AppPermissionsChecked")).check
  }

  /**
   * Whether the signed-in person has access to `repo`, and if not, why (#104): asked as a Repo is
   * entered. With `fresh`, the Hub asks GitHub again rather than answering from its cache.
   */
  checkRepo(repo: string, fresh = false): Promise<RepoChecked> {
    return this.#request({ _tag: "CheckRepo", repo, ...(fresh && { fresh }) }, "RepoChecked")
  }

  /** Every shared variable, which the store then keeps current. */
  async getSharedVariables(): Promise<ReadonlyArray<SharedVariable>> {
    return (await this.#request({ _tag: "GetSharedVariables" }, "SharedVariables")).variables
  }

  async setSharedVariable(variable: SharedVariableInput): Promise<ReadonlyArray<SharedVariable>> {
    return (await this.#request({ _tag: "SetSharedVariable", variable }, "SharedVariables"))
      .variables
  }

  /** Deletes a shared variable; the Hub refuses while an Environment links it. */
  async deleteSharedVariable(name: string): Promise<ReadonlyArray<SharedVariable>> {
    return (await this.#request({ _tag: "DeleteSharedVariable", name }, "SharedVariables"))
      .variables
  }

  // ── Runners (issue #85) ──────────────────────────────────────────────────

  /**
   * Mints a Pairing code: for a new Runner, or, with `runnerId`, to Re-pair that one. The answer
   * is the only place the code is ever shown.
   */
  createPairingCode(runnerId?: RunnerId): Promise<PairingCodeCreated> {
    return this.#request(
      { _tag: "CreatePairingCode", ...(runnerId !== undefined && { runnerId }) },
      "PairingCodeCreated",
    )
  }

  /** Revokes a Pairing code not yet used; a Runner already paired with one is untouched. */
  async revokePairingCode(pairingCodeId: PairingCodeId): Promise<void> {
    await this.#request({ _tag: "RevokePairingCode", pairingCodeId }, "PairingCodeList")
  }

  /** Removes a Runner; the Hub refuses while it has Sessions that aren't Archived, and says so. */
  async removeRunner(runnerId: RunnerId): Promise<void> {
    await this.#request({ _tag: "RemoveRunner", runnerId }, "RunnerRemoved")
  }

  /**
   * Updates a Runner to the Hub's commit (ADR 0011): its Turns end, or stop at once with `now`, its
   * Sessions sleep, and it moves and restarts. The RunnerList follows the update; the Hub refuses,
   * saying why, when the Runner can't update itself.
   */
  async updateRunner(runnerId: RunnerId, now: boolean): Promise<void> {
    await this.#request({ _tag: "UpdateRunner", runnerId, now }, "RunnerUpdateRequested")
  }

  // ── The person's Claude credential (ADR 0015) ────────────────────────────

  /**
   * Stores the signed-in person's Claude credential, a token on `plan` or an API key, in place of
   * any before. The Hub checks it with Anthropic, and refuses one Anthropic rejects; the answer
   * carries a warning when it was stored without that check. The store then holds what it shows.
   */
  setClaudeCredential(secret: string, plan?: ClaudePlanChoice): Promise<ClaudeCredentialState> {
    return this.#request(
      {
        _tag: "SetClaudeCredential",
        secret: Redacted.make(secret),
        ...(plan !== undefined && { plan }),
      },
      "ClaudeCredentialState",
    )
  }

  /** Removes the signed-in person's Claude credential. */
  async removeClaudeCredential(): Promise<void> {
    await this.#request({ _tag: "RemoveClaudeCredential" }, "ClaudeCredentialState")
  }

  // ── The person's CLI tokens (issue #179) ─────────────────────────────────

  /** Revokes one of the signed-in person's CLI tokens: the CLI it was for is refused at once. */
  async revokeCliToken(cliTokenId: CliTokenId): Promise<void> {
    await this.#request({ _tag: "RevokeCliToken", cliTokenId }, "CliTokenList")
  }

  /** Sends `command` with a new request id; resolves with the Hub's `answer` to it. */
  #request<Tag extends AnswerTag>(
    command: Request,
    answer: Tag,
  ): Promise<Extract<Answer, { readonly _tag: Tag }>> {
    const requestId = RequestId.make(`req-${Date.now().toString(36)}-${++this.#requestCount}`)
    return new Promise((resolve, reject) => {
      if (!this.#send({ ...command, requestId } as WebToHub)) {
        reject(new CommandError("Not connected to the Hub."))
        return
      }
      this.#requests.set(requestId, {
        answer,
        resolve: (message) => resolve(message as Extract<Answer, { readonly _tag: Tag }>),
        reject,
      })
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
      case "SessionCreated":
      case "EnvironmentState":
      case "EnvironmentDraftChecked":
      case "TestBuildStarted":
      case "SharedVariables":
      case "AppPermissionsChecked":
      case "RepoChecked":
      case "PairingCodeCreated":
      case "PairingCodeList":
      case "RunnerRemoved":
      case "RunnerUpdateRequested":
      case "ClaudeCredentialState":
      case "CliTokenList": {
        if (message.requestId === undefined) break
        const request = this.#requests.get(message.requestId)
        if (request?.answer !== message._tag) break
        this.#requests.delete(message.requestId)
        request.resolve(message)
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
