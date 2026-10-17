import { Schema } from "effect"
import { BuildVersion } from "./Build.ts"
import {
  ClaudeCredentialFetched,
  ClaudeCredentialRefused,
  FetchClaudeCredential,
} from "./ClaudeCredential.ts"
import {
  FetchCloneAccess,
  FetchVariables,
  RunTestBuild,
  SessionEnvironment,
  TestBuildFinished,
  TestBuildLog,
  VariablesFetched,
  VariablesRefused,
} from "./Environment.ts"
import { GitIdentity, GitReply, GitRequest } from "./Git.ts"
import { ConversationId, EnvironmentVersion, RequestId, RunnerId, SessionId } from "./Ids.ts"
import { GatewayServer } from "./McpServer.ts"
import { ThinkingLevel, ModelName, RunnerModels } from "./Model.ts"
import { BranchName, OpenPort, RepoName } from "./Session.ts"
import { MaxDiskUsageSessions, SessionDiskSize, Sysinfo } from "./Sysinfo.ts"
import {
  RequestTerminalSnapshot,
  TerminalFrame,
  TerminalInput,
  TerminalResize,
} from "./Terminal.ts"
import { TunnelId } from "./Tunnel.ts"
import {
  ApplyUpdate,
  CheckUpdate,
  RunnerUpdater,
  UpdateChecked,
  UpdateFailed,
  UpdateFailure,
  UpdateProgress,
} from "./Update.ts"
import { CurrentProtocolVersion, HandshakeRejected } from "./Version.ts"

// The Runner ↔ Hub channel. The Runner connects with its own token (issue #7), sends a
// RunnerHello, and waits for a RunnerWelcome or a HandshakeRejected before anything else.

// ── Runner to Hub ──────────────────────────────────────────────────────────

/** The Runner's first message on every connection. */
export const RunnerHello = Schema.TaggedStruct("RunnerHello", {
  protocolVersion: CurrentProtocolVersion,
  /** The Runner's name, such as its short hostname. */
  name: Schema.NonEmptyString,
  /** Sessions whose Claude Code is running here, including those it kept across a restart. */
  sessions: Schema.Array(SessionId),
  /**
   * Those of `sessions` it kept running across its own restart (#157). It holds no mod token for
   * them, as mod tokens live in its memory alone, so the Hub sends each a {@link ModTokenReissued}.
   * Absent when there are none, and from a Runner from before, which kept none.
   */
  withoutModToken: Schema.optionalKey(Schema.Array(SessionId)),
  /**
   * The commit the Runner runs (ADR 0011). Optional, so a Runner from before it was added still
   * connects, and is listed with its version unknown.
   */
  version: Schema.optionalKey(BuildVersion),
  /**
   * The Runner asks the Hub how to clone each Test build, with a FetchCloneAccess (#104). A Runner
   * from before doesn't say so: it would clone with its host's own git credentials, so a Hub with
   * the GitHub App sends it no Test builds.
   */
  asksCloneAccess: Schema.optionalKey(Schema.Literal(true)),
  /**
   * Whether it updates itself when the Hub asks (#87). A Runner from before doesn't say, and is
   * never asked.
   */
  updater: Schema.optionalKey(RunnerUpdater),
  /** Its last update, when that failed: kept until it next updates, so a restarted Hub hears it. */
  lastUpdate: Schema.optionalKey(UpdateFailure),
  /**
   * The models and thinking levels its Claude Code takes (#128). Absent from a Runner from before,
   * or one that couldn't find out: its Sessions then run Claude Code's defaults only.
   */
  models: Schema.optionalKey(RunnerModels),
  /**
   * It takes a {@link RelaunchSession} (#128). A Runner from before doesn't say so: a Session's
   * new model then takes effect when it next wakes.
   */
  relaunches: Schema.optionalKey(Schema.Literal(true)),
  /**
   * It takes an {@link OpenTunnel} (#177). A Runner from before doesn't say so: the Hub opens no
   * tunnel to its Sessions.
   */
  forwardsPorts: Schema.optionalKey(Schema.Literal(true)),
  /**
   * Whether it gives a Session's Claude Code the MCP servers of its Installations, reached through
   * its relay at `/gateway/<installationId>` (ADR 0020). A Runner from before doesn't say so: the
   * Hub sends it none.
   */
  relaysMcpServers: Schema.optionalKey(Schema.Literal(true)),
  /**
   * It takes a {@link MeasureSessionDisks} (#352). A Runner from before doesn't say so: the Hub
   * doesn't ask it, and the archive list shows its Sessions' sizes as unknown.
   */
  measuresDisk: Schema.optionalKey(Schema.Literal(true)),
})
export type RunnerHello = typeof RunnerHello.Type

/** Claude Code is running for the Session, with the mod loaded. */
export const SessionStarted = Schema.TaggedStruct("SessionStarted", {
  sessionId: SessionId,
  /** The Environment version its Sandbox runs on; absent when StartSession gave none. */
  environmentVersion: Schema.optionalKey(EnvironmentVersion),
})
export type SessionStarted = typeof SessionStarted.Type

/** A {@link StartSession} failed; nothing is left running for the Session. */
export const SessionStartFailed = Schema.TaggedStruct("SessionStartFailed", {
  sessionId: SessionId,
  message: Schema.String,
})
export type SessionStartFailed = typeof SessionStartFailed.Type

/** The most characters of a {@link SessionStopped}'s `output` that a Runner sends and a Hub keeps. */
export const MaxLastOutputLength = 4000

/**
 * The Session's Claude Code is no longer running: `Requested` after a {@link StopSession},
 * `Exited` when the process ended on its own.
 */
export const SessionStopped = Schema.TaggedStruct("SessionStopped", {
  sessionId: SessionId,
  reason: Schema.Literals(["Requested", "Exited"]),
  exitCode: Schema.optionalKey(Schema.Int),
  /**
   * For `Exited`: the last lines Claude Code's terminal showed, as plain text, so why it exited
   * can be read (#105). At most {@link MaxLastOutputLength} characters, the end kept. Optional, so
   * a Runner from before it was added still connects; a Hub from before ignores it.
   */
  output: Schema.optionalKey(Schema.String),
})
export type SessionStopped = typeof SessionStopped.Type

/** Where a Session's Sandbox is: `Destroyed` once it is gone for good, as on archive. */
export const SandboxState = Schema.Literals([
  "Starting",
  "Running",
  "Stopping",
  "Stopped",
  "Destroyed",
  "Failed",
])
export type SandboxState = typeof SandboxState.Type

/** The Session's Sandbox changed state. */
export const SandboxStateReport = Schema.TaggedStruct("SandboxStateReport", {
  sessionId: SessionId,
  state: SandboxState,
  /** What went wrong, for `Failed`. */
  message: Schema.optionalKey(Schema.String),
})
export type SandboxStateReport = typeof SandboxStateReport.Type

/**
 * Something about the Session's Sandbox, or the Claude Code in it, for its Participants, such as a
 * wake that couldn't resume the conversation. The Hub records it in the Session's log.
 */
export const SandboxNote = Schema.TaggedStruct("SandboxNote", {
  sessionId: SessionId,
  message: Schema.String,
})
export type SandboxNote = typeof SandboxNote.Type

/**
 * The Open ports of an awake Session's Sandbox (ADR 0016), sent whenever they change: the whole
 * list each time, and an empty one when the Session goes to sleep. Leaves out the port Claude Code
 * itself listens on for a login.
 */
export const SessionPorts = Schema.TaggedStruct("SessionPorts", {
  sessionId: SessionId,
  ports: Schema.Array(OpenPort),
})
export type SessionPorts = typeof SessionPorts.Type

/** A {@link PurgeSession} is done: nothing of the Session is left on the Runner. */
export const SessionPurged = Schema.TaggedStruct("SessionPurged", {
  sessionId: SessionId,
})
export type SessionPurged = typeof SessionPurged.Type

/**
 * An {@link OpenTunnel} the Runner couldn't open: the Session doesn't run here, the address isn't
 * loopback, or nothing in the Sandbox took the connection. Sent instead of dialing back.
 */
export const TunnelFailed = Schema.TaggedStruct("TunnelFailed", {
  tunnelId: TunnelId,
  message: Schema.String,
})
export type TunnelFailed = typeof TunnelFailed.Type

/**
 * What the Runner's host looks like now (#350): sent right after the Runner is welcomed, then every
 * SysinfoIntervalMillis while it is connected. The Hub keeps the latest of each Runner for the
 * Runners page, and its free disk, available memory and 1-minute load as history (#356). A Runner
 * from before doesn't send it.
 */
export const RunnerSysinfo = Schema.TaggedStruct("RunnerSysinfo", Sysinfo.fields)
export type RunnerSysinfo = typeof RunnerSysinfo.Type

/**
 * Answers a {@link MeasureSessionDisks}: the disk each of the Sessions takes on the Runner, in the
 * order asked. A Session the Runner couldn't measure has no `bytes`.
 */
export const SessionDisksMeasured = Schema.TaggedStruct("SessionDisksMeasured", {
  requestId: RequestId,
  sizes: Schema.Array(SessionDiskSize),
})
export type SessionDisksMeasured = typeof SessionDisksMeasured.Type

/** Every message a Runner sends the Hub. */
export const RunnerToHub = Schema.Union([
  RunnerHello,
  SessionStarted,
  SessionStartFailed,
  SessionStopped,
  SandboxStateReport,
  SessionPurged,
  TerminalFrame,
  GitRequest,
  SandboxNote,
  SessionPorts,
  FetchVariables,
  FetchClaudeCredential,
  FetchCloneAccess,
  TestBuildLog,
  TestBuildFinished,
  UpdateChecked,
  UpdateProgress,
  UpdateFailed,
  TunnelFailed,
  RunnerSysinfo,
  SessionDisksMeasured,
]).pipe(Schema.toTaggedUnion("_tag"))
export type RunnerToHub = typeof RunnerToHub.Type

// ── Hub to Runner ──────────────────────────────────────────────────────────

/** The Hub accepted the Runner's hello. */
export const RunnerWelcome = Schema.TaggedStruct("RunnerWelcome", {
  protocolVersion: CurrentProtocolVersion,
  /** The id the Hub knows this Runner by, from its token. */
  runnerId: RunnerId,
})
export type RunnerWelcome = typeof RunnerWelcome.Type

/**
 * Start Claude Code for a Session: for a new Session, after cloning its Repo onto its Work
 * branch, which it creates from the base branch unless it is the base branch (ADR 0023); to wake
 * an Asleep one, with `resume` and the Workspace already in place. Claude Code runs on its
 * Creator's setup token, which the Runner asks for first with a {@link FetchClaudeCredential}: a
 * refusal fails the start, with the Hub's message (ADR 0026).
 */
export const StartSession = Schema.TaggedStruct("StartSession", {
  sessionId: SessionId,
  repo: RepoName,
  baseBranch: BranchName,
  workBranch: BranchName,
  /** The conversation to resume, when waking an Asleep Session. */
  resume: Schema.optionalKey(ConversationId),
  /**
   * The token the Session's mod authenticates to the Hub with, scoped to this Session (issue #7).
   * Kept in the Runner's memory, for its mod relay to relay the mod's calls with; never passed
   * into the Sandbox (ADR 0004, 0026).
   */
  modToken: Schema.NonEmptyString,
  /**
   * The Repo's Environment as last applied, to build the Sandbox from (ADR 0009). Absent while the
   * Repo has none: the Runner then uses its own default image.
   */
  environment: Schema.optionalKey(SessionEnvironment),
  /**
   * Who commits made in the Sandbox are by, unless its Environment sets a git identity of its
   * own: the Session's Creator (#110). Absent from a Hub older than that.
   */
  gitIdentity: Schema.optionalKey(GitIdentity),
  /** The model to start Claude Code on, its `--model` (#128); absent for Claude Code's default. */
  model: Schema.optionalKey(ModelName),
  /** The thinking level to start Claude Code at, its `--effort` (#128); absent for its default. */
  thinkingLevel: Schema.optionalKey(ThinkingLevel),
  /**
   * An MCP server for each Installation on for its Repo (ADR 0020); absent for none. Sent only to
   * a Runner whose hello says it `relaysMcpServers`.
   */
  mcpServers: Schema.optionalKey(Schema.Array(GatewayServer)),
})
export type StartSession = typeof StartSession.Type

/**
 * Start a running Session's Claude Code again with its model and thinking level as they are set now
 * (#128): Claude Code alone, resuming its conversation, with its Sandbox left running. The Hub
 * sends it only while no Turn runs, and only to a Runner whose hello says it `relaunches`.
 * Answered as a StartSession is, with SessionStarted, or SessionStartFailed when Claude Code
 * didn't start again, as when the Hub refuses its setup token.
 */
export const RelaunchSession = Schema.TaggedStruct("RelaunchSession", {
  sessionId: SessionId,
  repo: RepoName,
  workBranch: BranchName,
  /** The conversation to resume, from its mod's last hello. */
  resume: ConversationId,
  /** A new mod token, in place of the old one, which the Hub revoked as it sent this. */
  modToken: Schema.NonEmptyString,
  model: Schema.optionalKey(ModelName),
  thinkingLevel: Schema.optionalKey(ThinkingLevel),
  /** The Session's MCP servers, as its last start gave them: a relaunch changes none. */
  mcpServers: Schema.optionalKey(Schema.Array(GatewayServer)),
})
export type RelaunchSession = typeof RelaunchSession.Type

/**
 * A new mod token for a Session whose Claude Code the Runner kept running across its restart
 * (#157), in place of the one its memory lost, which the Hub revoked as it sent this. Sent to a
 * Runner whose hello lists the Session as `withoutModToken`.
 */
export const ModTokenReissued = Schema.TaggedStruct("ModTokenReissued", {
  sessionId: SessionId,
  modToken: Schema.NonEmptyString,
})
export type ModTokenReissued = typeof ModTokenReissued.Type

/**
 * Stop a Session's Claude Code and its Sandbox: `Sleep` keeps the Sandbox's volumes to wake on,
 * `Archive` destroys the Sandbox (ADR 0003, 0006).
 */
export const StopSession = Schema.TaggedStruct("StopSession", {
  sessionId: SessionId,
  reason: Schema.Literals(["Sleep", "Archive"]),
})
export type StopSession = typeof StopSession.Type

/**
 * Delete everything of an Archived Session from the Runner, once it is past restoring: its
 * Sandbox and volumes if any are left, its Workspace, and Claude Code's state for it. Answered
 * with {@link SessionPurged}; sent again on reconnect until it is.
 */
export const PurgeSession = Schema.TaggedStruct("PurgeSession", {
  sessionId: SessionId,
})
export type PurgeSession = typeof PurgeSession.Type

/**
 * Open one connection to a port in a Session's Sandbox, for a client of the Hub (#177, ADR 0016):
 * the Runner connects to `address` and `port` in the Sandbox, then dials the Hub back at
 * `/runner/tunnel/<tunnelId>` with its Runner token and carries the connection's bytes over that
 * WebSocket (Tunnel.ts). Answered with {@link TunnelFailed} when it can't. Sent only to a Runner
 * whose hello says it `forwardsPorts`. `address` is `127.0.0.1` or `::1`, in the family the port
 * listens on; a Runner refuses any other.
 */
export const OpenTunnel = Schema.TaggedStruct("OpenTunnel", {
  tunnelId: TunnelId,
  sessionId: SessionId,
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  address: Schema.String,
})
export type OpenTunnel = typeof OpenTunnel.Type

/**
 * Measure how much disk the Sessions take on the Runner (#352), for the archive list. The Runner
 * works it out when asked (it walks their directories, so it isn't sampled) and answers with a
 * {@link SessionDisksMeasured}. Sent only to a Runner whose hello says it `measuresDisk`; at most
 * {@link MaxDiskUsageSessions} Sessions.
 */
export const MeasureSessionDisks = Schema.TaggedStruct("MeasureSessionDisks", {
  requestId: RequestId,
  sessionIds: Schema.Array(SessionId).check(Schema.isMaxLength(MaxDiskUsageSessions)),
})
export type MeasureSessionDisks = typeof MeasureSessionDisks.Type

/** Every message the Hub sends a Runner. */
export const HubToRunner = Schema.Union([
  RunnerWelcome,
  HandshakeRejected,
  StartSession,
  RelaunchSession,
  ModTokenReissued,
  StopSession,
  PurgeSession,
  TerminalInput,
  TerminalResize,
  RequestTerminalSnapshot,
  GitReply,
  RunTestBuild,
  VariablesFetched,
  VariablesRefused,
  ClaudeCredentialFetched,
  ClaudeCredentialRefused,
  CheckUpdate,
  ApplyUpdate,
  OpenTunnel,
  MeasureSessionDisks,
]).pipe(Schema.toTaggedUnion("_tag"))
export type HubToRunner = typeof HubToRunner.Type
