// The web channel's client: opens the socket, says hello, decodes what the Hub sends into the
// store, and reconnects. On reconnect it joins each joined Session again with `afterSeq`, so the
// Hub sends only the entries it missed, and opens each open terminal again, which redraws it from
// a fresh Snapshot. Commands that the Hub answers (creating a Session, the Environment commands)
// return a promise of the answer, matched to it by request id.

import {
  type AgentId,
  type AppPermissionsCheck,
  type ArchivedSessionPurged,
  type AttachmentId,
  type BranchChoice,
  type BranchesListed,
  checkHandshake,
  type ClaudeCredentialState,
  type CliTokenId,
  type CommandFailed,
  MaxDiskUsageSessions,
  type EnvironmentDraft,
  type EffortLevel,
  type EnvironmentDraftChecked,
  type EnvironmentState,
  type EnvironmentVersion,
  type GitHubLogin,
  type HeaderValueInput,
  HubToWeb,
  type Channel,
  type HubUpdateState,
  type InstallationAuthorizing,
  type InstallationId,
  type InstallationNeedsClient,
  type InviteCreated,
  type InviteId,
  type ModelName,
  type PairingCodeCreated,
  type PairingCodeId,
  type ParticipantId,
  type McpServerAuth,
  type McpServerId,
  type McpServerLogEntry,
  type McpServerPackageFrom,
  type McpServerPackageRead,
  type McpServersState,
  ProtocolVersion,
  type QuestionAnswerFromWeb,
  RequestId,
  type RunnerHistoryPoint,
  type RunnerId,
  type PromptId,
  type RepoChecked,
  type SessionDiskSize,
  type SessionId,
  type SessionSummary,
  type SharedVariable,
  type SharedVariableInput,
  type TerminalFrame,
  type TerminalSize,
  type TestBuild,
  type ToolCallId,
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
import type { HubSocket, HubTransport, UploadOptions } from "./transport.ts"

export interface HubClientOptions {
  /** How long to wait before reconnect attempt `attempt` (1, 2, ...), in milliseconds. */
  retryDelay?: (attempt: number) => number
}

export interface NewSession {
  readonly repo: string
  /** The branch it works on (ADR 0023); the Hub resolves it to a base branch and a Work branch. */
  readonly branch: BranchChoice
  readonly runnerId?: RunnerId
  /** The model to start it on; Claude Code's default without one (#128). */
  readonly model?: ModelName
  readonly effort?: EffortLevel
}

/** The Hub has no GitHub App to list Repos or branches with: asking again can't help. */
export class ListingUnavailableError extends Error {
  override readonly name = "ListingUnavailableError"
}

/** A command the Hub refused, or that couldn't be sent. */
export class CommandError extends Error {
  override readonly name = "CommandError"
}

const unavailableText = (answer: { readonly hint?: string }) =>
  answer.hint ?? "The Hub has no GitHub App."

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
  /** The answers it takes. */
  readonly answer: ReadonlyArray<AnswerTag>
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

  /**
   * Queues a prompt, with the files uploaded for it (#276): an image alone is a prompt. False if it
   * couldn't be sent because the Hub isn't connected, or there is nothing to send.
   */
  sendPrompt(
    sessionId: SessionId,
    text: string,
    attachments: ReadonlyArray<AttachmentId> = [],
  ): boolean {
    const trimmed = text.trim()
    if (trimmed === "" && attachments.length === 0) return false
    return this.#send({
      _tag: "SendPrompt",
      sessionId,
      text: trimmed,
      ...(attachments.length > 0 && { attachments }),
    })
  }

  /** Uploads a file to attach to a prompt in the Session (#276): the Hub's id for it. */
  uploadAttachment(
    sessionId: SessionId,
    file: File,
    options: UploadOptions,
  ): Promise<AttachmentId> {
    return this.transport.uploadAttachment(sessionId, file, options)
  }

  /** Where the browser loads one of the Session's attachments from. */
  attachmentUrl(sessionId: SessionId, attachmentId: AttachmentId): string {
    return this.transport.attachmentUrl(sessionId, attachmentId)
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
   * Messages a subagent of the Session (ADR 0014), with the files uploaded for it (#278): a running
   * one reads it at its next tool call, a finished one resumes. An image alone is a message.
   */
  messageAgent(
    sessionId: SessionId,
    agentId: AgentId,
    text: string,
    attachments: ReadonlyArray<AttachmentId> = [],
  ): boolean {
    const trimmed = text.trim()
    if (trimmed === "" && attachments.length === 0) return false
    return this.#send({
      _tag: "MessageAgent",
      sessionId,
      agentId,
      text: trimmed,
      ...(attachments.length > 0 && { attachments }),
    })
  }

  stopAgent(sessionId: SessionId, agentId: AgentId): boolean {
    return this.#send({ _tag: "StopAgent", sessionId, agentId })
  }

  /**
   * Answers the Session's Open question (#193), named by its call: the first answer to reach
   * Claude Code is Claude's, and a later one is refused, saying who answered first. A reply carries
   * the files uploaded for it (#278).
   */
  answerQuestion(
    sessionId: SessionId,
    toolCallId: ToolCallId,
    answer: QuestionAnswerFromWeb,
    attachments: ReadonlyArray<AttachmentId> = [],
  ): boolean {
    return this.#send({
      _tag: "AnswerQuestion",
      sessionId,
      toolCallId,
      answer,
      ...(attachments.length > 0 && { attachments }),
    })
  }

  /**
   * Shows the others what you have picked for one of the Open question's questions so far (#193);
   * "" takes it back.
   */
  pickAnswer(
    sessionId: SessionId,
    toolCallId: ToolCallId,
    question: string,
    answer: string,
  ): boolean {
    return this.#send({ _tag: "PickAnswer", sessionId, toolCallId, question, answer })
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
   * Purges an Archived Session now, to free its Runner's disk (#351): it can't be restored after.
   * Anyone who can see it may. Resolves once the Hub has deleted it, saying whether its Runner was
   * online to free the disk now, or does when it is back; rejects with the Hub's reason.
   */
  purgeSession(sessionId: SessionId): Promise<ArchivedSessionPurged> {
    return this.#request({ _tag: "PurgeArchivedSession", sessionId }, "ArchivedSessionPurged")
  }

  /**
   * How much of their Runners' disk the Archived Sessions take (#352), one entry for each Session
   * asked about, in the order asked, with `bytes` absent where it isn't known: its Runner is
   * offline or couldn't measure it. The Hub keeps what its Runners say for a minute.
   */
  async sessionDiskUsage(
    sessionIds: ReadonlyArray<SessionId>,
  ): Promise<ReadonlyArray<SessionDiskSize>> {
    // The Hub takes so many at a time.
    const chunks: Array<ReadonlyArray<SessionId>> = []
    for (let from = 0; from < sessionIds.length; from += MaxDiskUsageSessions) {
      chunks.push(sessionIds.slice(from, from + MaxDiskUsageSessions))
    }
    const answers = await Promise.all(
      chunks.map((chunk) =>
        this.#request({ _tag: "GetSessionDiskUsage", sessionIds: chunk }, "SessionDiskUsage"),
      ),
    )
    return answers.flatMap((answer) => answer.sizes)
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
        branch: input.branch,
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
   * Has the Hub check for a newer kndl now (ADR 0028), as its Owner alone may: where the check is
   * after it, which the store then holds too. A check that fails says so in it.
   */
  async checkHubUpdate(): Promise<HubUpdateState> {
    return (await this.#request({ _tag: "CheckHubUpdate" }, "HubUpdateChecked")).update
  }

  /**
   * Has the Hub run `kndl update` on its machine (#362), as its Owner alone may: with `now`, its
   * Runners stop their running Turns at once; with `channel`, it follows that Channel from now on.
   * Resolves once the update is launched; its progress reaches the store as it goes.
   */
  async updateHub(request: { readonly now: boolean; readonly channel?: Channel }): Promise<void> {
    await this.#request({ _tag: "UpdateHub", ...request }, "HubUpdateStarted")
  }

  /**
   * Whether the signed-in person has access to `repo`, and if not, why (#104): asked as a Repo is
   * entered. With `fresh`, the Hub asks GitHub again rather than answering from its cache.
   */
  checkRepo(repo: string, fresh = false): Promise<RepoChecked> {
    return this.#request({ _tag: "CheckRepo", repo, ...(fresh && { fresh }) }, "RepoChecked")
  }

  /**
   * The Repos the signed-in person may start a Session on, from the GitHub App's installations
   * (ADR 0023); rejects with the Hub's reason where it can't say, and with a ListingUnavailableError without the App.
   */
  async listRepos(): Promise<ReadonlyArray<string>> {
    const answer = await this.#request({ _tag: "ListRepos" }, ["ReposListed", "ListingUnavailable"])
    if (answer._tag === "ListingUnavailable")
      throw new ListingUnavailableError(unavailableText(answer))
    return answer.repos
  }

  /** A Repo's branches and its default branch, through the GitHub App; rejects as `listRepos`. */
  async listBranches(repo: string): Promise<BranchesListed> {
    const answer = await this.#request({ _tag: "ListBranches", repo }, [
      "BranchesListed",
      "ListingUnavailable",
    ])
    if (answer._tag === "ListingUnavailable")
      throw new ListingUnavailableError(unavailableText(answer))
    return answer
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

  // ── MCP servers (ADR 0020) ───────────────────────────────────────────────────

  /**
   * Asks for every MCP server and Installation; the store then holds them, and keeps them fresh.
   */
  getMcpServers(): Promise<McpServersState> {
    return this.#request({ _tag: "GetMcpServers" }, "McpServersState")
  }

  /**
   * Creates a Hub-only MCP server, with the header secrets `auth` declares; its
   * id is `hub:` and a slug of its name.
   */
  createMcpServer(name: string, url: string, auth: McpServerAuth): Promise<McpServersState> {
    return this.#request({ _tag: "CreateMcpServer", name, url, auth }, "McpServersState")
  }

  /**
   * Changes an MCP server's name, URL or header secrets; its Sessions pick it up on their next wake
   * or Restart. A change to the URL's origin clears its Installations' values, and one to a header
   * secret's key or header clears that header secret's.
   */
  editMcpServer(
    mcpServerId: McpServerId,
    name: string,
    url: string,
    auth: McpServerAuth,
  ): Promise<McpServersState> {
    return this.#request({ _tag: "EditMcpServer", mcpServerId, name, url, auth }, "McpServersState")
  }

  /** Deletes an MCP server; the Hub refuses while it has Installations. */
  deleteMcpServer(mcpServerId: McpServerId): Promise<McpServersState> {
    return this.#request({ _tag: "DeleteMcpServer", mcpServerId }, "McpServersState")
  }

  /**
   * Creates an Installation of an MCP server, on in the Repos listed, with values for its
   * header secrets: write-only, the Hub never sends them back. A global one (#219), which only the
   * Owner creates, lists no Repos: it is on in every Repo.
   */
  createInstallation(
    mcpServerId: McpServerId,
    name: string,
    repos: ReadonlyArray<string>,
    values: ReadonlyArray<HeaderValueInput> = [],
    global = false,
  ): Promise<McpServersState> {
    return this.#request(
      {
        _tag: "CreateInstallation",
        mcpServerId,
        name,
        repos,
        ...(values.length > 0 && { values }),
        ...(global && { global }),
      },
      "McpServersState",
    )
  }

  /**
   * Renames an Installation, sets the whole list of Repos it is on in, and replaces the values
   * given; the others stay. `global` is whether it is global (#219), on in every Repo and listing
   * none: only the Owner makes it so, or edits one.
   */
  editInstallation(
    installationId: InstallationId,
    name: string,
    repos: ReadonlyArray<string>,
    values: ReadonlyArray<HeaderValueInput> = [],
    global = false,
  ): Promise<McpServersState> {
    return this.#request(
      {
        _tag: "EditInstallation",
        installationId,
        name,
        repos,
        ...(values.length > 0 && { values }),
        ...(global && { global }),
      },
      "McpServersState",
    )
  }

  /**
   * Turns a global Installation off for a Repo, or back on (#219): anyone with access to the Repo
   * may. Its Sessions pick it up on their next wake or Restart.
   */
  turnGlobalInstallation(
    installationId: InstallationId,
    repo: string,
    on: boolean,
  ): Promise<McpServersState> {
    return this.#request(
      { _tag: "TurnGlobalInstallation", installationId, repo, on },
      "McpServersState",
    )
  }

  /** Deletes an Installation, taking it off every Repo it lists. */
  deleteInstallation(installationId: InstallationId): Promise<McpServersState> {
    return this.#request({ _tag: "DeleteInstallation", installationId }, "McpServersState")
  }

  /**
   * Begins connecting an OAuth Installation to its account (#217): where to send the browser, the
   * authorization server's page to sign in and consent. It comes back through the Hub, which keeps
   * the tokens, to the MCP page. Where the authorization server offers no Dynamic Client
   * Registration, the Hub asks for a client registered there by hand instead (#218), to begin
   * again with; `changeClient` asks for another.
   */
  connectInstallation(
    installationId: InstallationId,
    options: {
      readonly client?: { readonly clientId: string; readonly clientSecret?: string }
      readonly changeClient?: boolean
    } = {},
  ): Promise<InstallationAuthorizing | InstallationNeedsClient> {
    const { client, changeClient } = options
    return this.#request(
      {
        _tag: "ConnectInstallation",
        installationId,
        ...(client !== undefined && {
          client: {
            clientId: client.clientId,
            ...(client.clientSecret !== undefined && {
              clientSecret: Redacted.make(client.clientSecret),
            }),
          },
        }),
        ...(changeClient === true && { changeClient }),
      },
      ["InstallationAuthorizing", "InstallationNeedsClient"],
    )
  }

  /** Disconnects an OAuth Installation, so the Hub forgets its tokens (#217). */
  disconnectInstallation(installationId: InstallationId): Promise<McpServersState> {
    return this.#request({ _tag: "DisconnectInstallation", installationId }, "McpServersState")
  }

  /**
   * Reads an MCP server package from git or an upload (#220), changing nothing: what adding it
   * would make, or, if an MCP server from the same source has its name, what upgrading that would
   * change.
   */
  readMcpServerPackage(from: McpServerPackageFrom): Promise<McpServerPackageRead> {
    return this.#request({ _tag: "ReadMcpServerPackage", from }, "McpServerPackageRead")
  }

  /** Reads a packaged MCP server's git ref again, for what upgrading it would change. */
  checkMcpServerUpgrade(mcpServerId: McpServerId): Promise<McpServerPackageRead> {
    return this.#request({ _tag: "CheckMcpServerUpgrade", mcpServerId }, "McpServerPackageRead")
  }

  /** Adds the package a read found, as it was read. */
  addMcpServerPackage(readId: string): Promise<McpServersState> {
    return this.#request({ _tag: "AddMcpServerPackage", readId }, "McpServersState")
  }

  /**
   * Upgrades a packaged MCP server to the package a read found; its Sessions pick it up on Restart.
   */
  upgradeMcpServer(mcpServerId: McpServerId, readId: string): Promise<McpServersState> {
    return this.#request({ _tag: "UpgradeMcpServer", mcpServerId, readId }, "McpServersState")
  }

  /** Asks for a Repo's MCP server change log, newest first; the store then holds it. */
  async getMcpServerLog(repo: string): Promise<ReadonlyArray<McpServerLogEntry>> {
    return (await this.#request({ _tag: "GetMcpServerLog", repo }, "McpServerLog")).entries
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

  /**
   * A Runner's free disk, available memory and 1-minute load over the last 7 days (#350, #356),
   * oldest point first.
   */
  async runnerHistory(runnerId: RunnerId): Promise<ReadonlyArray<RunnerHistoryPoint>> {
    return (await this.#request({ _tag: "GetRunnerHistory", runnerId }, "RunnerHistory")).points
  }

  // ── The person's Claude credential (ADR 0015, ADR 0026) ──────────────────

  /**
   * Stores the signed-in person's Claude credential, a setup token, in place of any before. The
   * Hub checks it with Anthropic, and refuses one Anthropic rejects; the answer carries a warning
   * when it was stored without that check. The store then holds what it shows.
   */
  setClaudeCredential(secret: string): Promise<ClaudeCredentialState> {
    return this.#request(
      { _tag: "SetClaudeCredential", secret: Redacted.make(secret) },
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

  // ── People: the Hub's Owner alone (issue #209, ADR 0019) ─────────────────

  /**
   * Makes an Invite, for anyone with its link or, with `login`, for that GitHub account alone. The
   * answer is the only place its link is ever shown.
   */
  createInvite(login?: GitHubLogin): Promise<InviteCreated> {
    return this.#request(
      { _tag: "CreateInvite", ...(login !== undefined && { login }) },
      "InviteCreated",
    )
  }

  /** Asks for the Invites not yet used, revoked or expired; the store then holds them. */
  async listInvites(): Promise<void> {
    await this.#request({ _tag: "ListInvites" }, "InviteList")
  }

  /** Revokes an Invite not yet used: its link admits no one after. */
  async revokeInvite(inviteId: InviteId): Promise<void> {
    await this.#request({ _tag: "RevokeInvite", inviteId }, "InviteList")
  }

  /** Asks for the Members; the store then holds them. */
  async listMembers(): Promise<void> {
    await this.#request({ _tag: "ListMembers" }, "MemberList")
  }

  /**
   * Removes a Member who isn't the Owner: they are signed out everywhere at once, and need a new
   * Invite to get back in. Their Sessions and Claude credential stay.
   */
  async removeMember(participantId: ParticipantId): Promise<void> {
    await this.#request({ _tag: "RemoveMember", participantId }, "MemberList")
  }

  /** Sends `command` with a new request id; resolves with the Hub's `answer` to it. */
  #request<Tag extends AnswerTag>(
    command: Request,
    answer: Tag | ReadonlyArray<Tag>,
  ): Promise<Extract<Answer, { readonly _tag: Tag }>> {
    const requestId = RequestId.make(`req-${Date.now().toString(36)}-${++this.#requestCount}`)
    return new Promise((resolve, reject) => {
      if (!this.#send({ ...command, requestId } as WebToHub)) {
        reject(new CommandError("Not connected to the Hub."))
        return
      }
      this.#requests.set(requestId, {
        answer: typeof answer === "string" ? [answer] : answer,
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
      case "ArchivedSessionPurged":
      case "SessionDiskUsage":
      case "EnvironmentState":
      case "EnvironmentDraftChecked":
      case "TestBuildStarted":
      case "SharedVariables":
      case "AppPermissionsChecked":
      case "HubUpdateChecked":
      case "HubUpdateStarted":
      case "RepoChecked":
      case "ReposListed":
      case "ListingUnavailable":
      case "BranchesListed":
      case "PairingCodeCreated":
      case "PairingCodeList":
      case "RunnerRemoved":
      case "RunnerUpdateRequested":
      case "RunnerHistory":
      case "ClaudeCredentialState":
      case "CliTokenList":
      case "InviteCreated":
      case "InviteList":
      case "MemberList":
      case "McpServersState":
      case "McpServerLog":
      case "McpServerPackageRead":
      case "InstallationAuthorizing":
      case "InstallationNeedsClient": {
        if (message.requestId === undefined) break
        const request = this.#requests.get(message.requestId)
        if (request === undefined || !request.answer.includes(message._tag)) break
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
