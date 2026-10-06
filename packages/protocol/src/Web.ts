import { Schema } from "effect"
import { BuildVersion } from "./Build.ts"
import {
  ClaudeCredentialState,
  RemoveClaudeCredential,
  SetClaudeCredential,
} from "./ClaudeCredential.ts"
import { CliTokenId, CliTokenInfo } from "./Cli.ts"
import {
  ApplyEnvironment,
  CheckEnvironmentDraft,
  DeleteSharedVariable,
  EnvironmentDraftChecked,
  EnvironmentState,
  GetEnvironment,
  GetSharedVariables,
  SetSharedVariable,
  SharedVariables,
  StartTestBuild,
  TestBuildEnded,
  TestBuildLogged,
  TestBuildStarted,
} from "./Environment.ts"
import { AppPermissionsCheck } from "./GitHubApp.ts"
import { AgentId, EventSeq, PromptId, RequestId, RunnerId, SessionId } from "./Ids.ts"
import { EffortLevel, ModelName } from "./Model.ts"
import { PairingCodeId, PendingPairingCode } from "./Pairing.ts"
import {
  BranchName,
  EpochMillis,
  Participant,
  PresenceChanged,
  QueuedPrompt,
  RepoName,
  RunnerSummary,
  SessionState,
  SessionSummary,
  StopAgent,
  StopTurn,
} from "./Session.ts"
import { TerminalFrame, TerminalInput, TerminalResize } from "./Terminal.ts"
import { TurnEvent } from "./Turn.ts"
import { CurrentProtocolVersion, HandshakeRejected } from "./Version.ts"

// The Hub ↔ web channel. The browser connects with its sign-in cookie (issue #7), sends a
// WebHello, and waits for a WebWelcome or a HandshakeRejected. The Hub then sends the RunnerList
// and SessionList, and keeps them current.

// ── The Session event log ──────────────────────────────────────────────────

/** The Session moved to another lifecycle state. */
export const SessionStateChanged = Schema.TaggedStruct("SessionStateChanged", {
  state: SessionState,
  /** Who caused it, when a person did, such as by archiving. */
  by: Schema.optionalKey(Participant),
  /** Why, when it says more than the state, such as why a Session is Frozen. */
  message: Schema.optionalKey(Schema.String),
  /**
   * Set when the Session didn't start because its Environment has, or links, a variable that
   * needs a value (#57), so the web can lead to where it's entered.
   */
  valuesNeeded: Schema.optionalKey(Schema.Boolean),
})
export type SessionStateChanged = typeof SessionStateChanged.Type

/** A Participant asked to stop the current Turn. */
export const TurnStopRequested = Schema.TaggedStruct("TurnStopRequested", {
  by: Participant,
})
export type TurnStopRequested = typeof TurnStopRequested.Type

/**
 * A Participant messaged one of the Session's subagents (ADR 0014). Claude Code doesn't keep the
 * message among the agent's own, so the log does.
 */
export const AgentMessaged = Schema.TaggedStruct("AgentMessaged", {
  agentId: AgentId,
  sender: Participant,
  text: Schema.NonEmptyString,
})
export type AgentMessaged = typeof AgentMessaged.Type

/**
 * The Runner could not push the Session's WIP ref (GLOSSARY.md), the snapshot of its Workspace
 * on origin. Nothing waits for it: the Session went on, or to sleep, regardless.
 */
export const WipNotPushed = Schema.TaggedStruct("WipNotPushed", {
  message: Schema.String,
})
export type WipNotPushed = typeof WipNotPushed.Type

/**
 * Something the Runner wants the Session's Participants to know about its Sandbox, such as its
 * CPU or memory being capped below what the Environment asks for (ADR 0009), or about the Claude
 * Code in it, such as a wake that couldn't resume the conversation (#191).
 */
export const SandboxNoted = Schema.TaggedStruct("SandboxNoted", {
  message: Schema.String,
})
export type SandboxNoted = typeof SandboxNoted.Type

/**
 * A Participant changed the Session's model or effort (#128): what it is set to now, which its
 * Claude Code runs from the next Turn on. An absent `model` or `effort` is Claude Code's default.
 */
export const ModelSwitched = Schema.TaggedStruct("ModelSwitched", {
  by: Participant,
  model: Schema.optionalKey(ModelName),
  /**
   * What the Runner's Claude Code called the model then, such as `Sonnet 5.5`; for the default,
   * the model it runs.
   */
  modelLabel: Schema.optionalKey(Schema.NonEmptyString),
  effort: Schema.optionalKey(EffortLevel),
})
export type ModelSwitched = typeof ModelSwitched.Type

/**
 * Everything a Session's history records: Turn events from the mod, and what the Hub saw
 * happen. New kinds of event are added here as members.
 */
export const SessionEvent = Schema.Union([
  TurnEvent,
  SessionStateChanged,
  TurnStopRequested,
  AgentMessaged,
  WipNotPushed,
  SandboxNoted,
  ModelSwitched,
]).pipe(Schema.toTaggedUnion("_tag"))
export type SessionEvent = typeof SessionEvent.Type

/** One entry of a Session's event log, numbered in the order the Hub appended it. */
export const SessionLogEntry = Schema.Struct({
  seq: EventSeq,
  at: EpochMillis,
  event: SessionEvent,
})
export type SessionLogEntry = typeof SessionLogEntry.Type

// ── web to Hub ─────────────────────────────────────────────────────────────

/** The web client's first message on every connection. */
export const WebHello = Schema.TaggedStruct("WebHello", {
  protocolVersion: CurrentProtocolVersion,
})
export type WebHello = typeof WebHello.Type

/**
 * Start a new Session on a Repo, from a base branch. The Hub picks a Runner if none is named. A
 * `model` or `effort` the Runner's Claude Code doesn't take is refused; absent, Claude Code's own
 * default is used (#128).
 */
export const CreateSession = Schema.TaggedStruct("CreateSession", {
  requestId: RequestId,
  repo: RepoName,
  baseBranch: BranchName,
  runnerId: Schema.optionalKey(RunnerId),
  model: Schema.optionalKey(ModelName),
  effort: Schema.optionalKey(EffortLevel),
})
export type CreateSession = typeof CreateSession.Type

/**
 * Join a Session as a Participant: the Hub answers with its history, then sends its events,
 * presence and Prompt queue live until {@link LeaveSession}. On reconnect, `afterSeq` asks only
 * for the entries after the last one the client has.
 */
export const JoinSession = Schema.TaggedStruct("JoinSession", {
  sessionId: SessionId,
  afterSeq: Schema.optionalKey(EventSeq),
})
export type JoinSession = typeof JoinSession.Type

export const LeaveSession = Schema.TaggedStruct("LeaveSession", {
  sessionId: SessionId,
})
export type LeaveSession = typeof LeaveSession.Type

/** Add a prompt to the end of the Session's Prompt queue; the sender is the signed-in person. */
export const SendPrompt = Schema.TaggedStruct("SendPrompt", {
  sessionId: SessionId,
  text: Schema.NonEmptyString,
})
export type SendPrompt = typeof SendPrompt.Type

/** Remove a prompt from the Prompt queue before it is delivered. Any Participant may. */
export const CancelPrompt = Schema.TaggedStruct("CancelPrompt", {
  sessionId: SessionId,
  promptId: PromptId,
})
export type CancelPrompt = typeof CancelPrompt.Type

/**
 * Message one of the Session's subagents (ADR 0014): a running one reads it at its next tool call,
 * and one that has stopped resumes with it. Any Participant may; an Asleep Session is woken first.
 * The message carries the sender's name, as a prompt does.
 */
export const MessageAgent = Schema.TaggedStruct("MessageAgent", {
  sessionId: SessionId,
  agentId: AgentId,
  text: Schema.NonEmptyString,
})
export type MessageAgent = typeof MessageAgent.Type

/**
 * Put an Active Session to sleep now, rather than after it has been idle a while: its Claude
 * Code and Sandbox stop, and its next prompt wakes it. Refused while a Turn runs or prompts wait.
 * It turns Keep awake off (ADR 0016).
 */
export const SleepSession = Schema.TaggedStruct("SleepSession", {
  sessionId: SessionId,
})
export type SleepSession = typeof SleepSession.Type

/** Wake an Asleep Session without sending it a prompt. */
export const WakeSession = Schema.TaggedStruct("WakeSession", {
  sessionId: SessionId,
})
export type WakeSession = typeof WakeSession.Type

/**
 * Turn the Session's Keep awake on or off (ADR 0016): while it is on, the Session doesn't go
 * Asleep for being idle, and an Asleep one is woken when its Runner comes back. Anyone with access
 * to its Repo may, in any state but Archived. Turning it on also wakes an Asleep Session. Every
 * client that can see the Session gets a SessionUpdated. Pressing Sleep (SleepSession) turns it
 * off.
 */
export const SetKeepAwake = Schema.TaggedStruct("SetKeepAwake", {
  sessionId: SessionId,
  on: Schema.Boolean,
})
export type SetKeepAwake = typeof SetKeepAwake.Type

/**
 * Restart a Session now: put it to sleep, then wake it, so its Sandbox is recreated from its
 * Repo's latest Environment version (ADR 0009) on the same Workspace and disks, resuming its
 * conversation. An Asleep Session is just woken. Refused while a Turn runs.
 */
export const RestartSession = Schema.TaggedStruct("RestartSession", {
  sessionId: SessionId,
})
export type RestartSession = typeof RestartSession.Type

/**
 * Delete a Session, which archives it (ADR 0003): its Sandbox is destroyed after the Runner
 * pushes its WIP ref, and anyone may restore it until it is purged. Any Participant may.
 */
export const ArchiveSession = Schema.TaggedStruct("ArchiveSession", {
  sessionId: SessionId,
})
export type ArchiveSession = typeof ArchiveSession.Type

/**
 * Rename a Session (its Session name, GLOSSARY.md). Anyone with access to its Repo may, whatever its
 * state. The Hub trims the name; an empty one clears it, so the Session is shown by its Work branch
 * again, and one over MaxSessionNameLength characters is refused. Every client that can see
 * the Session gets it as a SessionUpdated.
 */
export const RenameSession = Schema.TaggedStruct("RenameSession", {
  sessionId: SessionId,
  name: Schema.String,
})
export type RenameSession = typeof RenameSession.Type

/**
 * Set the Session's model and effort (#128), both at once; an absent one is Claude Code's default.
 * Anyone with access to its Repo may, in any state but Archived. A model or effort the Runner's
 * Claude Code doesn't take is refused, a model as Claude Code refuses it (`Model 'x' not found`).
 * Every client that can see the Session gets a SessionUpdated, and its log a ModelSwitched. A
 * running Turn goes on as it is: Claude Code is restarted with the new setting once no Turn runs,
 * or starts with it when the Session next wakes.
 */
export const SetSessionModel = Schema.TaggedStruct("SetSessionModel", {
  sessionId: SessionId,
  model: Schema.optionalKey(ModelName),
  effort: Schema.optionalKey(EffortLevel),
})
export type SetSessionModel = typeof SetSessionModel.Type

/** Restore an Archived Session before it is purged. It comes back Asleep. Any Participant may. */
export const RestoreSession = Schema.TaggedStruct("RestoreSession", {
  sessionId: SessionId,
})
export type RestoreSession = typeof RestoreSession.Type

/** Start receiving the Session's terminal frames, beginning with a snapshot. */
export const OpenTerminal = Schema.TaggedStruct("OpenTerminal", {
  sessionId: SessionId,
})
export type OpenTerminal = typeof OpenTerminal.Type

export const CloseTerminal = Schema.TaggedStruct("CloseTerminal", {
  sessionId: SessionId,
})
export type CloseTerminal = typeof CloseTerminal.Type

/**
 * Check the GitHub App's permissions again now, rather than at the next periodic check: after
 * changing them on GitHub. Answered with an AppPermissionsChecked, which every other client gets
 * too, or a CommandFailed.
 */
export const CheckAppPermissions = Schema.TaggedStruct("CheckAppPermissions", {
  requestId: RequestId,
})
export type CheckAppPermissions = typeof CheckAppPermissions.Type

/**
 * Check a Repo as it is entered, for a new Session or Environment (#104): whether the person has
 * access to it, and if not, why. With `fresh`, GitHub is asked again rather than the Hub's
 * cached answer used, as after installing the GitHub App. Answered with a {@link RepoChecked}, or
 * a CommandFailed when GitHub can't say.
 */
export const CheckRepo = Schema.TaggedStruct("CheckRepo", {
  requestId: RequestId,
  repo: RepoName,
  fresh: Schema.optionalKey(Schema.Boolean),
})
export type CheckRepo = typeof CheckRepo.Type

// ── Runners (issue #85) ──

/**
 * Mint a Pairing code (GLOSSARY.md): for a new Runner, or, with `runnerId`, to Re-pair that Runner,
 * which keeps its RunnerId and Sessions and gets a new token in place of its old one. Anyone signed
 * in may. Answered with a {@link PairingCodeCreated}, the only place the code is ever shown.
 */
export const CreatePairingCode = Schema.TaggedStruct("CreatePairingCode", {
  requestId: RequestId,
  runnerId: Schema.optionalKey(RunnerId),
})
export type CreatePairingCode = typeof CreatePairingCode.Type

/**
 * Revoke a Pairing code not yet used; Runners already paired are untouched. Answered with a
 * {@link PairingCodeList}.
 */
export const RevokePairingCode = Schema.TaggedStruct("RevokePairingCode", {
  requestId: RequestId,
  pairingCodeId: PairingCodeId,
})
export type RevokePairingCode = typeof RevokePairingCode.Type

/**
 * Revoke one of your own CLI tokens: the CLI holding it is refused from its next request on.
 * Answered with a {@link CliTokenList}, or a CommandFailed for a token that isn't yours.
 */
export const RevokeCliToken = Schema.TaggedStruct("RevokeCliToken", {
  requestId: RequestId,
  cliTokenId: CliTokenId,
})
export type RevokeCliToken = typeof RevokeCliToken.Type

/**
 * Remove a Runner: its token stops working, and a connected Runner is disconnected. Refused while
 * it has Sessions that aren't Archived. Answered with a {@link RunnerRemoved}.
 */
export const RemoveRunner = Schema.TaggedStruct("RemoveRunner", {
  requestId: RequestId,
  runnerId: RunnerId,
})
export type RemoveRunner = typeof RemoveRunner.Type

/**
 * Update a Runner to the Hub's commit (ADR 0011): it stops taking Sessions, its running Turns end
 * (within about ten minutes, or at once with `now`), its Sessions sleep, and it moves to the commit
 * and restarts. Sent again with `now` while it waits, it stops the Turns at once. Answered with a
 * {@link RunnerUpdateRequested}; the RunnerList follows the update.
 */
export const UpdateRunner = Schema.TaggedStruct("UpdateRunner", {
  requestId: RequestId,
  runnerId: RunnerId,
  now: Schema.Boolean,
})
export type UpdateRunner = typeof UpdateRunner.Type

/** Every message a web client sends the Hub. */
export const WebToHub = Schema.Union([
  WebHello,
  CreateSession,
  JoinSession,
  LeaveSession,
  SendPrompt,
  CancelPrompt,
  StopTurn,
  MessageAgent,
  StopAgent,
  SleepSession,
  WakeSession,
  SetKeepAwake,
  RestartSession,
  ArchiveSession,
  RestoreSession,
  RenameSession,
  SetSessionModel,
  OpenTerminal,
  CloseTerminal,
  TerminalInput,
  TerminalResize,
  GetEnvironment,
  CheckEnvironmentDraft,
  StartTestBuild,
  ApplyEnvironment,
  GetSharedVariables,
  SetSharedVariable,
  DeleteSharedVariable,
  SetClaudeCredential,
  RemoveClaudeCredential,
  CheckAppPermissions,
  CheckRepo,
  CreatePairingCode,
  RevokePairingCode,
  RemoveRunner,
  UpdateRunner,
  RevokeCliToken,
]).pipe(Schema.toTaggedUnion("_tag"))
export type WebToHub = typeof WebToHub.Type

// ── Hub to web ─────────────────────────────────────────────────────────────

/** The Hub accepted the web client's hello. */
export const WebWelcome = Schema.TaggedStruct("WebWelcome", {
  protocolVersion: CurrentProtocolVersion,
  /** The signed-in person. */
  you: Participant,
  /** The commit the Hub runs, which Runners are compared with; absent outside a git checkout. */
  hub: Schema.optionalKey(BuildVersion),
})
export type WebWelcome = typeof WebWelcome.Type

/** Every Runner, in full: sent after the welcome and whenever one changes. */
export const RunnerList = Schema.TaggedStruct("RunnerList", {
  runners: Schema.Array(RunnerSummary),
})
export type RunnerList = typeof RunnerList.Type

/** Every Session the person can see, those of the Repos they have access to, in full: sent after the welcome. */
export const SessionList = Schema.TaggedStruct("SessionList", {
  sessions: Schema.Array(SessionSummary),
})
export type SessionList = typeof SessionList.Type

/** A Session was created or changed; replaces the client's copy of it. */
export const SessionUpdated = Schema.TaggedStruct("SessionUpdated", {
  session: SessionSummary,
})
export type SessionUpdated = typeof SessionUpdated.Type

/**
 * The client can no longer see a Session, and drops its copy of it: it was purged, its archive
 * retention (30 days by default) after it was archived, or the person lost access to its Repo on
 * GitHub, which also took them out of it.
 */
export const SessionRemoved = Schema.TaggedStruct("SessionRemoved", {
  sessionId: SessionId,
})
export type SessionRemoved = typeof SessionRemoved.Type

/** Answers a {@link CreateSession}. */
export const SessionCreated = Schema.TaggedStruct("SessionCreated", {
  requestId: RequestId,
  session: SessionSummary,
})
export type SessionCreated = typeof SessionCreated.Type

/** Answers a {@link JoinSession}: the log so far, or since `afterSeq`, oldest first. */
export const SessionHistory = Schema.TaggedStruct("SessionHistory", {
  sessionId: SessionId,
  entries: Schema.Array(SessionLogEntry),
})
export type SessionHistory = typeof SessionHistory.Type

/** An entry was appended to the log of a Session the client has joined. */
export const SessionEventLogged = Schema.TaggedStruct("SessionEventLogged", {
  sessionId: SessionId,
  entry: SessionLogEntry,
})
export type SessionEventLogged = typeof SessionEventLogged.Type

/**
 * Output of a joined Session's start before Claude Code's terminal is up: its Environment's build
 * and start script, redacted, as it streams. On join, while a start is under way, the Hub sends
 * what there is so far as one message that replaces what the client held. `since` is the start's
 * (the SessionSummary's `starting.since`), so a client can tell one start's output from another's.
 */
export const SessionStartLogged = Schema.TaggedStruct("SessionStartLogged", {
  sessionId: SessionId,
  since: EpochMillis,
  data: Schema.String,
  /** The output so far, or its end if long, in place of what the client held. */
  replace: Schema.optionalKey(Schema.Boolean),
})
export type SessionStartLogged = typeof SessionStartLogged.Type

/** A joined Session's Prompt queue, in full and in order: sent on join and whenever it changes. */
export const PromptQueueChanged = Schema.TaggedStruct("PromptQueueChanged", {
  sessionId: SessionId,
  queue: Schema.Array(QueuedPrompt),
})
export type PromptQueueChanged = typeof PromptQueueChanged.Type

/**
 * A command was refused, such as a prompt to a Frozen Session. Names the command's `_tag`, and
 * its Session or request when it had one.
 */
export const CommandFailed = Schema.TaggedStruct("CommandFailed", {
  command: Schema.NonEmptyString,
  sessionId: Schema.optionalKey(SessionId),
  requestId: Schema.optionalKey(RequestId),
  message: Schema.String,
})
export type CommandFailed = typeof CommandFailed.Type

/**
 * What the Hub found when it last checked the GitHub App's permissions (GitHubApp.ts): sent after
 * the welcome once there is a check, and whenever a check finds something else. Not sent without
 * the App, or before a check has succeeded.
 */
export const AppPermissionsChecked = Schema.TaggedStruct("AppPermissionsChecked", {
  /** The CheckAppPermissions this answers, for the client that sent it. */
  requestId: Schema.optionalKey(RequestId),
  check: AppPermissionsCheck,
})
export type AppPermissionsChecked = typeof AppPermissionsChecked.Type

/**
 * What {@link CheckRepo} found: the person has access to the Repo; the GitHub App isn't installed
 * on it, or there is no such Repo; or the App is, and the person has no access on GitHub.
 */
export const RepoStatus = Schema.Literals(["Allowed", "NotInstalled", "NoAccess"])
export type RepoStatus = typeof RepoStatus.Type

/** Answers a {@link CheckRepo}. */
export const RepoChecked = Schema.TaggedStruct("RepoChecked", {
  requestId: RequestId,
  repo: RepoName,
  status: RepoStatus,
  /** Where to install the GitHub App, when it isn't installed on the Repo and the Hub knows. */
  installUrl: Schema.optionalKey(Schema.String),
})
export type RepoChecked = typeof RepoChecked.Type

/**
 * The person no longer has access to the Repo (ADR 0003): its Environment, and any of its Test
 * builds, are gone from this client, as its Sessions are with a SessionRemoved each.
 */
export const RepoAccessLost = Schema.TaggedStruct("RepoAccessLost", {
  repo: RepoName,
})
export type RepoAccessLost = typeof RepoAccessLost.Type

/** Answers a {@link CreatePairingCode}. The code is shown here only: the Hub keeps its hash. */
export const PairingCodeCreated = Schema.TaggedStruct("PairingCodeCreated", {
  requestId: RequestId,
  id: PairingCodeId,
  /** The code, in groups of five. */
  code: Schema.NonEmptyString,
  /** The Hub's public URL with the code as its fragment, for `claude-hub runner join`. */
  link: Schema.NonEmptyString,
  expiresAt: EpochMillis,
  runnerId: Schema.optionalKey(RunnerId),
})
export type PairingCodeCreated = typeof PairingCodeCreated.Type

/**
 * The Pairing codes not yet used, revoked or expired, without the codes: sent after the welcome,
 * whenever one is minted, used or revoked, and in answer to a {@link RevokePairingCode}. A client
 * drops one by itself once its `expiresAt` has passed.
 */
export const PairingCodeList = Schema.TaggedStruct("PairingCodeList", {
  requestId: Schema.optionalKey(RequestId),
  codes: Schema.Array(PendingPairingCode),
})
export type PairingCodeList = typeof PairingCodeList.Type

/**
 * A Pairing code was redeemed, for a new Runner or to Re-pair one: sent to every web client, before
 * the RunnerList and PairingCodeList that follow, so the page that showed the code can say so.
 */
export const PairingCodeRedeemed = Schema.TaggedStruct("PairingCodeRedeemed", {
  id: PairingCodeId,
  runnerId: RunnerId,
  name: Schema.NonEmptyString,
  repaired: Schema.Boolean,
})
export type PairingCodeRedeemed = typeof PairingCodeRedeemed.Type

/**
 * Your CLI tokens, newest first: sent to your web clients alone, after the welcome, whenever one is
 * made or revoked, and in answer to a {@link RevokeCliToken}.
 */
export const CliTokenList = Schema.TaggedStruct("CliTokenList", {
  requestId: Schema.optionalKey(RequestId),
  tokens: Schema.Array(CliTokenInfo),
})
export type CliTokenList = typeof CliTokenList.Type

/** Answers a {@link RemoveRunner}; the RunnerList that follows leaves the Runner out. */
export const RunnerRemoved = Schema.TaggedStruct("RunnerRemoved", {
  requestId: RequestId,
  runnerId: RunnerId,
})
export type RunnerRemoved = typeof RunnerRemoved.Type

/** Answers an {@link UpdateRunner}: the update is under way, as the RunnerList shows. */
export const RunnerUpdateRequested = Schema.TaggedStruct("RunnerUpdateRequested", {
  requestId: RequestId,
  runnerId: RunnerId,
})
export type RunnerUpdateRequested = typeof RunnerUpdateRequested.Type

/** Every message the Hub sends a web client. */
export const HubToWeb = Schema.Union([
  WebWelcome,
  HandshakeRejected,
  RunnerList,
  SessionList,
  SessionUpdated,
  SessionRemoved,
  SessionCreated,
  SessionHistory,
  SessionEventLogged,
  PresenceChanged,
  PromptQueueChanged,
  SessionStartLogged,
  TerminalFrame,
  CommandFailed,
  EnvironmentState,
  EnvironmentDraftChecked,
  TestBuildStarted,
  TestBuildLogged,
  TestBuildEnded,
  SharedVariables,
  ClaudeCredentialState,
  AppPermissionsChecked,
  RepoChecked,
  RepoAccessLost,
  PairingCodeCreated,
  PairingCodeList,
  PairingCodeRedeemed,
  RunnerRemoved,
  RunnerUpdateRequested,
  CliTokenList,
]).pipe(Schema.toTaggedUnion("_tag"))
export type HubToWeb = typeof HubToWeb.Type
