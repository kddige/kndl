import { Schema } from "effect"
import { BuildVersion } from "./Build.ts"
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
import { GitIdentity, GitReply, GitRequest, SessionTurnEnded, WipPushFailed } from "./Git.ts"
import { ClaudeSessionId, EnvironmentVersion, RunnerId, SessionId } from "./Ids.ts"
import { EffortLevel, ModelName, RunnerModels } from "./Model.ts"
import { BranchName, RepoName, RunnerLogin, SessionRef } from "./Session.ts"
import {
  RequestTerminalSnapshot,
  TerminalFrame,
  TerminalInput,
  TerminalResize,
} from "./Terminal.ts"
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
  login: RunnerLogin,
  /** Sessions whose Claude Code is still running here, re-adopted after a Runner restart. */
  sessions: Schema.Array(SessionId),
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
   * The models and effort levels its Claude Code takes (#128). Absent from a Runner from before,
   * or one that couldn't find out: its Sessions then run Claude Code's defaults only.
   */
  models: Schema.optionalKey(RunnerModels),
  /**
   * It takes a {@link RelaunchSession} (#128). A Runner from before doesn't say so: a Session's
   * new model then takes effect when it next wakes.
   */
  relaunches: Schema.optionalKey(Schema.Literal(true)),
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

/** Something about the Session's Sandbox for its Participants. The Hub records it in the Session's log. */
export const SandboxNote = Schema.TaggedStruct("SandboxNote", {
  sessionId: SessionId,
  message: Schema.String,
})
export type SandboxNote = typeof SandboxNote.Type

/** A {@link PurgeSession} is done: nothing of the Session is left on the Runner. */
export const SessionPurged = Schema.TaggedStruct("SessionPurged", {
  sessionId: SessionId,
})
export type SessionPurged = typeof SessionPurged.Type

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
  WipPushFailed,
  SandboxNote,
  FetchVariables,
  FetchCloneAccess,
  TestBuildLog,
  TestBuildFinished,
  UpdateChecked,
  UpdateProgress,
  UpdateFailed,
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
 * branch; to wake an Asleep one, with `resume` and the Workspace already in place.
 */
export const StartSession = Schema.TaggedStruct("StartSession", {
  sessionId: SessionId,
  repo: RepoName,
  baseBranch: BranchName,
  workBranch: BranchName,
  /** Claude Code's session id to resume, when waking an Asleep Session. */
  resume: Schema.optionalKey(ClaudeSessionId),
  /**
   * The token the Session's mod authenticates to the Hub with, scoped to this Session (issue #7).
   * Passed to Claude Code's environment on the host; never into the Sandbox (ADR 0004).
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
  /**
   * Its Parent Session, when it is a Child Session (ADR 0012): Claude Code is told whose child it
   * is and that its final message of each Turn goes there, and its mod offers no Child Session
   * tools.
   */
  parent: Schema.optionalKey(SessionRef),
  /** The model to start Claude Code on, its `--model` (#128); absent for Claude Code's default. */
  model: Schema.optionalKey(ModelName),
  /** The effort level to start Claude Code at, its `--effort` (#128); absent for its default. */
  effort: Schema.optionalKey(EffortLevel),
})
export type StartSession = typeof StartSession.Type

/**
 * Start a running Session's Claude Code again with its model and effort as they are set now
 * (#128): Claude Code alone, resuming its conversation, with its Sandbox left running. The Hub
 * sends it only while no Turn runs, and only to a Runner whose hello says it `relaunches`.
 * Answered as a StartSession is, with SessionStarted, or SessionStartFailed when Claude Code
 * didn't start again.
 */
export const RelaunchSession = Schema.TaggedStruct("RelaunchSession", {
  sessionId: SessionId,
  /** Claude Code's session id to resume, from its mod's last hello. */
  resume: ClaudeSessionId,
  /** A new mod token, in place of the old one, which the Hub revoked as it sent this. */
  modToken: Schema.NonEmptyString,
  parent: Schema.optionalKey(SessionRef),
  model: Schema.optionalKey(ModelName),
  effort: Schema.optionalKey(EffortLevel),
})
export type RelaunchSession = typeof RelaunchSession.Type

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

/** Every message the Hub sends a Runner. */
export const HubToRunner = Schema.Union([
  RunnerWelcome,
  HandshakeRejected,
  StartSession,
  RelaunchSession,
  StopSession,
  PurgeSession,
  TerminalInput,
  TerminalResize,
  RequestTerminalSnapshot,
  GitReply,
  SessionTurnEnded,
  RunTestBuild,
  VariablesFetched,
  VariablesRefused,
  CheckUpdate,
  ApplyUpdate,
]).pipe(Schema.toTaggedUnion("_tag"))
export type HubToRunner = typeof HubToRunner.Type
