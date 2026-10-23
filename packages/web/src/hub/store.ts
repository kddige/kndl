// What the web UI knows about the Hub, built only from what the Hub sends: the Runners, the
// Sessions, for each joined Session its event log, the transcript folded from it as it grows,
// presence and Prompt queue, and for each open terminal whether it is live and its size; the
// Environments and shared variables the client asked for (ADR 0009), the Test builds it started, with their logs, and what the GitHub App's
// permissions lack (issue #86); the Pairing codes waiting to be redeemed and the Hub's own commit,
// for the Runners page (issue #85); and the signed-in person's Claude credential, write-only (ADR
// 0015), and the CLI tokens they signed the CLI in with (issue #179); and, for the Hub's Owner alone,
// its Members and pending Invites, for the People page (#209), and the Hub's update check and its
// latest update, for the Hub page (ADR 0028); and the MCP servers and their
// Installations, and the MCP server change logs of the Repos the client asked about (#221); and
// the signed-in person's Connected providers, the Models their pi Sessions can run, and the sign-in
// they have in progress (ADR 0029). The terminal's output itself goes straight to the view that
// draws it (HubClient.openTerminal), not through here.
//
// `reduce` is pure: the HubClient feeds it every decoded HubToWeb message and its own connection
// events, and React reads the result.

import type {
  AppPermissionsCheck,
  BuildVersion,
  HubUpdateRun,
  HubUpdateState,
  ClaudeCredentialInfo,
  CliTokenInfo,
  Environment,
  EnvironmentVersionInfo,
  EventSeq,
  HubToWeb,
  Installation,
  Member,
  PairingCodeId,
  Participant,
  PresentParticipant,
  PendingInvite,
  ProviderId,
  ProvidersState,
  RequestId,
  SignInEnded,
  SignInStep,
  PendingPairingCode,
  McpServer,
  McpServerLogEntry,
  QuestionPick,
  QueuedPrompt,
  RunnerId,
  RunnerSummary,
  SessionId,
  SessionLogEntry,
  SessionSummary,
  SharedVariable,
  TerminalFrame,
  TerminalSize,
  TestBuild,
  TestBuildId,
  TestBuildResult,
  ToolCallId,
} from "@kndl/protocol"
import { repoKey, sameRepo } from "@kndl/protocol"
import type { SignInOptions } from "./config.ts"
import { emptyTranscript, foldTranscript, type LiveTranscript } from "./transcript.ts"

/** Where the connection to the Hub is. */
export type Connection =
  /** Opening the socket, or waiting for the welcome. `attempt` counts tries since the last welcome. */
  | { readonly status: "connecting"; readonly attempt: number }
  /** Welcomed: messages flow. */
  | { readonly status: "online" }
  /** Lost, and trying again after a pause. */
  | { readonly status: "reconnecting"; readonly attempt: number }
  /** The Hub turned the socket away because no one is signed in. */
  | { readonly status: "signedOut"; readonly options: SignInOptions }
  /** The Hub refused the hello (a protocol mismatch): reloading is the only way on. */
  | {
      readonly status: "rejected"
      readonly message: string
      /** The protocol version the Hub speaks, when it said: to tell which side is out of date. */
      readonly hubProtocol?: number
    }

/** A Session the client has joined: its log so far, who's in it and what's queued. */
export interface JoinedSession {
  /** Whether the first SessionHistory has arrived since joining. */
  readonly historyLoaded: boolean
  /** The event log, in `seq` order, without gaps the Hub didn't leave. */
  readonly log: ReadonlyArray<SessionLogEntry>
  /**
   * What the chat shows of the log, folded from each entry as it arrives: a Turn no new entry
   * touched stays the same object.
   */
  readonly transcript: LiveTranscript
  readonly presence: ReadonlyArray<PresentParticipant>
  readonly queue: ReadonlyArray<QueuedPrompt>
  /** The output of its latest start the client has seen, or null before any. */
  readonly startLog: StartLog | null
  /**
   * What the Participants have picked for its Open question so far (#193), or null before the Hub
   * shares any. For the question `toolCallId` names, which may have closed since.
   */
  readonly questionPicks: QuestionPicksState | null
}

/** The Participants' picks for an Open question, as the Hub last shared them (#193). */
export interface QuestionPicksState {
  readonly toolCallId: ToolCallId
  readonly picks: ReadonlyArray<QuestionPick>
}

/**
 * What a Session's start printed before Claude Code's terminal was up: its Environment's build
 * and start script, as terminal output. Only its last `startLogLimit` characters are kept.
 */
export interface StartLog {
  /** The start it is from: the SessionSummary's `starting.since` while it runs. */
  readonly since: number
  readonly text: string
}

/** How much of a start's output the client keeps. */
export const startLogLimit = 256 * 1024

/**
 * A terminal the client has open. It is `waiting` until a Snapshot arrives, after opening and
 * after every reconnect, and drops Output until then: Output only makes sense on top of the
 * screen it follows, so starting from the Snapshot is what keeps a reconnect from showing
 * anything twice.
 */
export interface OpenTerminal {
  readonly status: "waiting" | "live"
  /** The terminal's size, from its last frame; null before the first. */
  readonly size: TerminalSize | null
}

/** A Repo's Environment as last applied, or null before its first, and its versions. */
export interface RepoEnvironment {
  readonly environment: Environment | null
  /** Newest first. */
  readonly versions: ReadonlyArray<EnvironmentVersionInfo>
}

/**
 * The signed-in person's Connected providers, as the Hub last sent them (ADR 0029), and which
 * Harness runs Claude's Models in their new Sessions (ADR 0030).
 */
export type Providers = Pick<
  ProvidersState,
  "connected" | "connectable" | "models" | "claudeHarness" | "liveVoice"
>

/**
 * A sign-in to a Provider this client started (ADR 0029): the steps the Hub sent for it so far, and
 * how it ended, once it has.
 */
export interface SignInProgress {
  /** The StartSignIn's, which its steps, its end and an answer to it carry. */
  readonly requestId: RequestId
  readonly provider: ProviderId
  /** Oldest first. */
  readonly steps: ReadonlyArray<SignInStep>
  /** Null while it runs. */
  readonly ended: Pick<SignInEnded, "outcome" | "message"> | null
}

/** A Test build this client started, with its log so far and, once over, how it ended. */
export interface TestBuildRun {
  readonly testBuild: TestBuild
  readonly log: string
  readonly result: TestBuildResult | null
  /** Why it failed, when the Hub says. */
  readonly message: string | null
}

export interface HubState {
  readonly connection: Connection
  /** The signed-in person, from the welcome. */
  readonly you: Participant | null
  /** Null until the first RunnerList. */
  readonly runners: ReadonlyArray<RunnerSummary> | null
  /** The commit the Hub runs, from the welcome; null when it doesn't say. */
  readonly hubVersion: BuildVersion | null
  /**
   * The Pairing codes not yet used, revoked or expired, as the Hub last listed them; null until
   * the first PairingCodeList. One may have expired since: compare its `expiresAt` with the clock.
   */
  readonly pairingCodes: ReadonlyArray<PendingPairingCode> | null
  /** The Pairing codes redeemed while connected, and the Runner each paired, by code id. */
  readonly redeemedCodes: Readonly<Record<PairingCodeId, RunnerId>>
  /** Null until the first SessionList. */
  readonly sessions: ReadonlyArray<SessionSummary> | null
  readonly joined: Readonly<Record<SessionId, JoinedSession>>
  readonly terminals: Readonly<Record<SessionId, OpenTerminal>>
  /**
   * The Environments of the Repos the client asked about, kept current as versions are applied.
   * By {@link repoKey}, as a Repo's name is the same Repo however it is spelled (#197).
   */
  readonly environments: Readonly<Record<string, RepoEnvironment>>
  /**
   * The Repos the person lost access to while connected (#104), until the Hub sends their
   * Environment again: a screen of one asks why. By {@link repoKey}.
   */
  readonly lostRepos: Readonly<Record<string, true>>
  /** Null until the client first asks for them; then kept current. */
  readonly sharedVariables: ReadonlyArray<SharedVariable> | null
  /** The Test builds this client started since it loaded. */
  readonly testBuilds: Readonly<Record<TestBuildId, TestBuildRun>>
  /** The Hub's last check of the GitHub App's permissions; null without the App, or before one. */
  readonly appPermissions: AppPermissionsCheck | null
  /**
   * The signed-in person's Claude credential, as the Hub shows it, write-only (ADR 0015): null
   * when they have stored none, undefined until the Hub says.
   */
  readonly claudeCredential: ClaudeCredentialInfo | null | undefined
  /** The signed-in person's CLI tokens, newest first (issue #179); null until the Hub says. */
  readonly cliTokens: ReadonlyArray<CliTokenInfo> | null
  /** Whether the signed-in person is the Hub's Owner (#209), from the welcome. */
  readonly owner: boolean
  /** The Members, the Owner first; null until the Hub sends them, which it does to the Owner alone. */
  readonly members: ReadonlyArray<Member> | null
  /**
   * The Invites not yet used, revoked or expired, oldest first; null until the Hub sends them, to
   * the Owner alone. One may have expired since: compare its `expiresAt` with the clock.
   */
  readonly invites: ReadonlyArray<PendingInvite> | null
  /**
   * The Hub's check for a newer kndl (ADR 0028): sent to the Owner alone, by a Hub the kndl
   * service runs from its install; null otherwise, and then there is no Hub page.
   */
  readonly hubUpdate: HubUpdateState | null
  /**
   * The Hub's latest update (#362), running or ended, from the web or the CLI: for the Owner
   * alone, on a Hub that checks; null before any. Kept while the Hub restarts under it.
   */
  readonly hubUpdateRun: HubUpdateRun | null
  /**
   * The MCP servers and their Installations, each Installation with only the Repos the person has
   * access to (#221); null until the client first asks for them, then kept current.
   */
  readonly mcpServers: {
    readonly mcpServers: ReadonlyArray<McpServer>
    readonly installations: ReadonlyArray<Installation>
  } | null
  /**
   * The MCP server change logs of the Repos the client asked about, newest first. By
   * {@link repoKey}.
   */
  readonly mcpServerLogs: Readonly<Record<string, ReadonlyArray<McpServerLogEntry>>>
  /**
   * The signed-in person's Connected providers, what they can connect, and the Models their pi
   * Sessions can run (ADR 0029): null until the Hub says, which it does to them alone.
   */
  readonly providers: Providers | null
  /** The sign-in this client last started, until another replaces it or it is cleared. */
  readonly signIn: SignInProgress | null
}

/** Events the client adds to the Hub's messages. */
export type ClientEvent =
  | { readonly _tag: "ConnectionChanged"; readonly connection: Connection }
  /** The client sent JoinSession: start tracking the Session (keeping what's already known). */
  | { readonly _tag: "Joined"; readonly sessionId: SessionId }
  /** The client sent LeaveSession: forget the Session's log, presence and queue. */
  | { readonly _tag: "Left"; readonly sessionId: SessionId }
  /** The client sent OpenTerminal, first or again after reconnecting: wait for a Snapshot. */
  | { readonly _tag: "TerminalOpened"; readonly sessionId: SessionId }
  | { readonly _tag: "TerminalClosed"; readonly sessionId: SessionId }
  /** The client sent StartSignIn: follow its steps, in place of any sign-in before. */
  | { readonly _tag: "SignInStarted"; readonly requestId: RequestId; readonly provider: ProviderId }
  /** The page is done with the last sign-in's outcome; with `requestId`, if it is still that one. */
  | { readonly _tag: "SignInCleared"; readonly requestId?: RequestId }

export type HubAction = HubToWeb | ClientEvent

export const initialState: HubState = {
  connection: { status: "connecting", attempt: 0 },
  you: null,
  runners: null,
  hubVersion: null,
  pairingCodes: null,
  redeemedCodes: {},
  sessions: null,
  joined: {},
  terminals: {},
  environments: {},
  lostRepos: {},
  sharedVariables: null,
  testBuilds: {},
  appPermissions: null,
  claudeCredential: undefined,
  cliTokens: null,
  owner: false,
  members: null,
  invites: null,
  hubUpdate: null,
  hubUpdateRun: null,
  mcpServers: null,
  mcpServerLogs: {},
  providers: null,
  signIn: null,
}

const emptyJoined: JoinedSession = {
  historyLoaded: false,
  log: [],
  transcript: emptyTranscript,
  presence: [],
  queue: [],
  startLog: null,
  questionPicks: null,
}

export function reduce(state: HubState, action: HubAction): HubState {
  switch (action._tag) {
    case "ConnectionChanged":
      // Frames sent while the connection was down are lost: every terminal waits for a Snapshot.
      return {
        ...state,
        connection: action.connection,
        terminals:
          action.connection.status === "online" ? state.terminals : waitAll(state.terminals),
        // The Hub's sign-in was the connection's: it ends with it.
        signIn:
          action.connection.status === "online" || state.signIn?.ended !== null
            ? state.signIn
            : endSignIn(state.signIn, "Lost the connection to the Hub. Sign in again."),
      }
    case "Joined":
      if (state.joined[action.sessionId]) return state
      return { ...state, joined: { ...state.joined, [action.sessionId]: emptyJoined } }
    case "Left": {
      if (!state.joined[action.sessionId]) return state
      const { [action.sessionId]: _, ...joined } = state.joined
      return { ...state, joined }
    }
    case "WebWelcome":
      return {
        ...state,
        you: action.you,
        owner: action.owner === true,
        hubVersion: action.hub ?? null,
        hubUpdate: action.hubUpdate ?? null,
        hubUpdateRun: action.hubUpdateRun ?? null,
        connection: { status: "online" },
      }
    case "HandshakeRejected":
      return {
        ...state,
        connection: {
          status: "rejected",
          message: action.message,
          hubProtocol: action.protocolVersion,
        },
      }
    case "RunnerList":
      return { ...state, runners: action.runners }
    case "RunnerRemoved":
      return {
        ...state,
        runners: state.runners?.filter((runner) => runner.id !== action.runnerId) ?? null,
      }
    case "RunnerUpdateRequested":
      // The RunnerList that follows shows the update.
      return state
    case "RunnerHistory":
      // Answers the page that asked, which keeps the points itself.
      return state
    case "PairingCodeList":
      return { ...state, pairingCodes: action.codes }
    case "PairingCodeRedeemed":
      return { ...state, redeemedCodes: { ...state.redeemedCodes, [action.id]: action.runnerId } }
    case "PairingCodeCreated":
      // The code is for whoever asked: the PairingCodeList that follows lists it, without it.
      return state
    case "SessionList":
      return { ...state, sessions: action.sessions }
    case "SessionUpdated":
    case "SessionCreated":
      return { ...state, sessions: upsert(state.sessions ?? [], action.session) }
    case "SessionRemoved": {
      // Purged, gone from the Hub with its history, or out of reach: access to its Repo was lost.
      const sessions = state.sessions?.filter((session) => session.id !== action.sessionId) ?? null
      const { [action.sessionId]: _, ...joined } = state.joined
      return { ...state, sessions, joined }
    }
    case "SessionDiskUsage":
      // Answers the Archived screen that asked, which keeps the sizes itself.
      return state
    case "ArchivedSessionPurged":
      // The SessionRemoved sent with it drops the Session.
      return state
    case "SessionHistory":
      return updateJoined(state, action.sessionId, (session) => ({
        ...session,
        historyLoaded: true,
        ...withEntries(session, action.entries),
        // The picks follow the history, if any are still shared.
        questionPicks: null,
      }))
    case "SessionEventLogged": {
      const next = updateJoined(state, action.sessionId, (session) => ({
        ...session,
        ...withEntries(session, [action.entry]),
      }))
      // A live state change moves the Session at once, ahead of the SessionUpdated that follows.
      const event = action.entry.event
      if (next === state || event._tag !== "SessionStateChanged") return next
      const summary = next.sessions?.find((session) => session.id === action.sessionId)
      if (!summary || summary.state === event.state) return next
      return { ...next, sessions: upsert(next.sessions ?? [], { ...summary, state: event.state }) }
    }
    case "PresenceChanged":
      return updateJoined(state, action.sessionId, (session) => ({
        ...session,
        presence: action.participants,
      }))
    case "PromptQueueChanged":
      return updateJoined(state, action.sessionId, (session) => ({
        ...session,
        queue: action.queue,
      }))
    case "QuestionPicks":
      return updateJoined(state, action.sessionId, (session) => ({
        ...session,
        questionPicks: { toolCallId: action.toolCallId, picks: action.picks },
      }))
    case "SessionStartLogged":
      return updateJoined(state, action.sessionId, (session) => {
        // All of it so far, or another start's output: in place of what was held.
        const held =
          action.replace || session.startLog?.since !== action.since ? "" : session.startLog.text
        const text = (held + action.data).slice(-startLogLimit)
        return { ...session, startLog: { since: action.since, text } }
      })
    case "TerminalOpened": {
      const size = state.terminals[action.sessionId]?.size ?? null
      return {
        ...state,
        terminals: { ...state.terminals, [action.sessionId]: { status: "waiting", size } },
      }
    }
    case "TerminalClosed": {
      if (!state.terminals[action.sessionId]) return state
      const { [action.sessionId]: _, ...terminals } = state.terminals
      return { ...state, terminals }
    }
    case "TerminalFrame": {
      const terminal = state.terminals[action.sessionId]
      if (!terminal || !acceptsFrame(terminal, action)) return state
      if (terminal.status === "live" && sameSize(terminal.size, action.size)) return state
      return {
        ...state,
        terminals: {
          ...state.terminals,
          [action.sessionId]: { status: "live", size: action.size },
        },
      }
    }
    case "CommandFailed":
      // A refused sign-in is over. A refused answer to one, or cancel of it, which carries its
      // requestId, isn't: the Hub's flow goes on, and says how it ended. Other refusals are the
      // client's to report.
      if (
        state.signIn !== null &&
        state.signIn.ended === null &&
        action.command === "StartSignIn" &&
        action.requestId === state.signIn.requestId
      )
        return { ...state, signIn: endSignIn(state.signIn, action.message) }
      return state
    case "EnvironmentState": {
      const key = repoKey(action.repo)
      const { [key]: _, ...lostRepos } = state.lostRepos
      return {
        ...state,
        environments: {
          ...state.environments,
          [key]: { environment: action.environment, versions: action.versions },
        },
        lostRepos: key in state.lostRepos ? lostRepos : state.lostRepos,
      }
    }
    case "EnvironmentDraftChecked":
      // An answer for whoever asked: it says nothing that lasts.
      return state
    case "SharedVariables":
      return { ...state, sharedVariables: action.variables }
    case "TestBuildStarted": {
      const { testBuild } = action
      if (state.testBuilds[testBuild.id]) return state
      return {
        ...state,
        testBuilds: {
          ...state.testBuilds,
          [testBuild.id]: { testBuild, log: "", result: null, message: null },
        },
      }
    }
    case "TestBuildLogged":
      return updateTestBuild(state, action.testBuildId, (run) =>
        run.result === null ? { ...run, log: run.log + action.data } : run,
      )
    case "TestBuildEnded":
      return updateTestBuild(state, action.testBuildId, (run) => ({
        ...run,
        result: action.result,
        message: action.message ?? null,
      }))
    case "AppPermissionsChecked":
      return { ...state, appPermissions: action.check }
    case "RepoChecked":
    case "ReposListed":
    case "ListingUnavailable":
    case "BranchesListed":
      // An answer for whoever asked: it says nothing that lasts.
      return state
    case "RepoAccessLost":
      return forgetRepo(state, action.repo)
    case "ClaudeCredentialState":
      return { ...state, claudeCredential: action.credential }
    case "ProvidersState":
      return {
        ...state,
        providers: {
          connected: action.connected,
          connectable: action.connectable,
          models: action.models,
          claudeHarness: action.claudeHarness,
          ...(action.liveVoice !== undefined && { liveVoice: action.liveVoice }),
        },
      }
    case "SignInStarted":
      return {
        ...state,
        signIn: { requestId: action.requestId, provider: action.provider, steps: [], ended: null },
      }
    case "SignInStepped": {
      const signIn = state.signIn
      if (signIn?.requestId !== action.requestId || signIn.ended !== null) return state
      return { ...state, signIn: { ...signIn, steps: [...signIn.steps, action.step] } }
    }
    case "SignInEnded": {
      const signIn = state.signIn
      if (signIn?.requestId !== action.requestId || signIn.ended !== null) return state
      const ended = {
        outcome: action.outcome,
        ...(action.message !== undefined && { message: action.message }),
      }
      return { ...state, signIn: { ...signIn, ended } }
    }
    case "SignInCleared":
      return state.signIn === null ||
        (action.requestId !== undefined && action.requestId !== state.signIn.requestId)
        ? state
        : { ...state, signIn: null }
    case "CliTokenList":
      return { ...state, cliTokens: action.tokens }
    case "InviteCreated":
      // The link is for whoever asked: the InviteList that follows lists it, without it.
      return state
    case "InviteList":
      return { ...state, invites: action.invites }
    case "MemberList":
      return { ...state, members: action.members }
    case "HubUpdateChecked":
      return { ...state, hubUpdate: action.update }
    case "HubUpdateRunChanged":
      return { ...state, hubUpdateRun: action.run }
    case "HubUpdateStarted":
      // Its progress follows, as HubUpdateRunChanged.
      return state
    case "McpServersState":
      return {
        ...state,
        mcpServers: { mcpServers: action.mcpServers, installations: action.installations },
      }
    case "McpServerLog":
      return {
        ...state,
        mcpServerLogs: { ...state.mcpServerLogs, [repoKey(action.repo)]: action.entries },
      }
    case "McpServerPackageRead":
    case "InstallationAuthorizing":
    case "InstallationNeedsClient":
      return state
  }
}

/**
 * Drops what the client knows of a Repo it lost access to (#104), its Environment and the Test
 * builds of it, and notes the loss. Its Sessions go with a SessionRemoved each.
 */
function forgetRepo(state: HubState, repo: string): HubState {
  const key = repoKey(repo)
  const { [key]: _, ...environments } = state.environments
  const { [key]: __, ...mcpServerLogs } = state.mcpServerLogs
  const builds = Object.entries(state.testBuilds) as Array<[TestBuildId, TestBuildRun]>
  const kept = builds.filter(([, run]) => !sameRepo(run.testBuild.repo, repo))
  return {
    ...state,
    environments,
    mcpServerLogs,
    lostRepos: { ...state.lostRepos, [key]: true },
    testBuilds:
      kept.length === builds.length
        ? state.testBuilds
        : (Object.fromEntries(kept) as Record<TestBuildId, TestBuildRun>),
  }
}

/** A sign-in in progress, failed for `message`. */
function endSignIn(signIn: SignInProgress, message: string): SignInProgress {
  return { ...signIn, ended: { outcome: "Failed", message } }
}

/** Whether an open terminal draws a frame: a Snapshot always, Output only once live. */
export function acceptsFrame(terminal: OpenTerminal, frame: TerminalFrame): boolean {
  return frame.kind === "Snapshot" || terminal.status === "live"
}

function sameSize(a: TerminalSize | null, b: TerminalSize): boolean {
  return a !== null && a.cols === b.cols && a.rows === b.rows
}

function waitAll(
  terminals: Readonly<Record<SessionId, OpenTerminal>>,
): Readonly<Record<SessionId, OpenTerminal>> {
  const entries = Object.entries(terminals) as Array<[SessionId, OpenTerminal]>
  if (entries.every(([, terminal]) => terminal.status === "waiting")) return terminals
  return Object.fromEntries(
    entries.map(([id, terminal]) => [id, { ...terminal, status: "waiting" as const }]),
  ) as Record<SessionId, OpenTerminal>
}

function upsert(
  sessions: ReadonlyArray<SessionSummary>,
  session: SessionSummary,
): ReadonlyArray<SessionSummary> {
  const index = sessions.findIndex((existing) => existing.id === session.id)
  if (index === -1) return [...sessions, session]
  return sessions.with(index, session)
}

/** Updates a joined Session; messages for a Session the client hasn't joined are dropped. */
function updateJoined(
  state: HubState,
  sessionId: SessionId,
  update: (session: JoinedSession) => JoinedSession,
): HubState {
  const session = state.joined[sessionId]
  if (!session) return state
  return { ...state, joined: { ...state.joined, [sessionId]: update(session) } }
}

/** Updates a Test build this client follows; others are dropped. */
function updateTestBuild(
  state: HubState,
  id: TestBuildId,
  update: (run: TestBuildRun) => TestBuildRun,
): HubState {
  const run = state.testBuilds[id]
  if (!run) return state
  return { ...state, testBuilds: { ...state.testBuilds, [id]: update(run) } }
}

/**
 * A joined Session's log with entries added, and its transcript with them folded in. Entries
 * usually follow the log's last, and are folded into the transcript as it is; one that goes before
 * it, arriving late, is folded in nowhere but its place, so the transcript is folded anew from the
 * whole log.
 */
function withEntries(
  session: JoinedSession,
  entries: ReadonlyArray<SessionLogEntry>,
): Pick<JoinedSession, "log" | "transcript"> {
  const log = appendEntries(session.log, entries)
  const held = session.log.length
  // Every entry held is kept, in seq order: if the last is where it was, all are.
  const appended = held === 0 || log[held - 1] === session.log[held - 1]
  const transcript = appended
    ? foldTranscript(session.transcript, log.slice(held))
    : foldTranscript(emptyTranscript, log)
  return { log, transcript }
}

/**
 * Adds entries to a log, by `seq`. The log is append-only on the Hub, so an entry already held is
 * the same entry: a replay after reconnecting, or history that overlaps live events, adds nothing
 * twice.
 */
export function appendEntries(
  log: ReadonlyArray<SessionLogEntry>,
  entries: ReadonlyArray<SessionLogEntry>,
): ReadonlyArray<SessionLogEntry> {
  if (entries.length === 0) return log
  // The usual case: everything is new and in order.
  let previous: number = lastSeq(log) ?? -1
  let inOrder = true
  for (const entry of entries) {
    if (entry.seq <= previous) {
      inOrder = false
      break
    }
    previous = entry.seq
  }
  if (inOrder) return log.length === 0 ? entries : log.concat(entries)
  const bySeq = new Map<number, SessionLogEntry>()
  for (const entry of log) bySeq.set(entry.seq, entry)
  for (const entry of entries) if (!bySeq.has(entry.seq)) bySeq.set(entry.seq, entry)
  return [...bySeq.values()].toSorted((a, b) => a.seq - b.seq)
}

/** The last `seq` in a log, which JoinSession's `afterSeq` asks to continue from. */
export function lastSeq(log: ReadonlyArray<SessionLogEntry>): EventSeq | undefined {
  return log.at(-1)?.seq
}

/** Whether a Session is listed, as in the sidebar: every one that isn't Archived. */
export const isListed = (session: SessionSummary): boolean => session.state !== "Archived"

/** The Session with this id, if the Hub has listed it. */
export function findSession(state: HubState, sessionId: string): SessionSummary | undefined {
  return state.sessions?.find((session) => session.id === sessionId)
}
