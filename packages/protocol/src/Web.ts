import { Schema } from "effect"
import { AttachmentIds, PromptAttachments, textOrAttachments } from "./Attachment.ts"
import { BuildVersion } from "./Build.ts"
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
import { HubUpdateCommand, HubUpdateMessage, HubUpdateRun, HubUpdateState } from "./HubUpdate.ts"
import {
  AgentId,
  EventSeq,
  ParticipantId,
  PromptId,
  RequestId,
  RunnerId,
  SessionId,
  ThreadId,
  ToolCallId,
} from "./Ids.ts"
import {
  InstallationAuthorizing,
  InstallationFailure,
  InstallationNeedsClient,
  McpServerCommand,
  McpServerLog,
  McpServerPackageRead,
  McpServersState,
} from "./McpServer.ts"
import { GitHubLogin, InviteId, Member, PendingInvite } from "./Members.ts"
import { Harness, ModelName, ThinkingLevel } from "./Model.ts"
import { PairingCodeId, PendingPairingCode } from "./Pairing.ts"
import { ProviderCommand, ProviderMessage } from "./Provider.ts"
import {
  BranchChoice,
  BranchName,
  EpochMillis,
  Participant,
  PresenceChanged,
  QueuedPrompt,
  QuestionAnswerFromWeb,
  RepoName,
  RunnerSummary,
  SessionState,
  SessionSummary,
  StopAgent,
  StopTurn,
} from "./Session.ts"
import { MaxDiskUsageSessions, RunnerHistoryPoint, SessionDiskSize } from "./Sysinfo.ts"
import { TerminalFrame, TerminalInput, TerminalResize } from "./Terminal.ts"
import {
  ThreadCommand,
  ThreadMessage,
  ThreadModelChanged,
  ThreadPromptFailed,
  ThreadPromptSent,
  ThreadStarted,
} from "./Thread.ts"
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
  /**
   * Set when the Session didn't start because Installations on for its Repo can't work (#216):
   * which, and why, so the web can lead to fixing each.
   */
  installationsFailed: Schema.optionalKey(Schema.Array(InstallationFailure)),
})
export type SessionStateChanged = typeof SessionStateChanged.Type

/** A Participant asked to stop the current Turn. */
export const TurnStopRequested = Schema.TaggedStruct("TurnStopRequested", {
  by: Participant,
  /** The thread whose Turn they asked to stop; absent for the main loop's. */
  threadId: Schema.optionalKey(ThreadId),
})
export type TurnStopRequested = typeof TurnStopRequested.Type

/**
 * A Participant messaged one of the Session's subagents (ADR 0014). Claude Code doesn't keep the
 * message among the agent's own, so the log does.
 */
export const AgentMessaged = Schema.TaggedStruct("AgentMessaged", {
  agentId: AgentId,
  sender: Participant,
  /** As typed; empty for a message of attachments alone. */
  text: Schema.String,
  /** The files it carried (#278). */
  attachments: Schema.optionalKey(PromptAttachments),
}).check(textOrAttachments)
export type AgentMessaged = typeof AgentMessaged.Type

/**
 * Something the Runner wants the Session's Participants to know about its Sandbox, such as its
 * CPU or memory being capped below what the Environment asks for (ADR 0009), or about the Claude
 * Code in it, such as a wake that couldn't resume the conversation (#191).
 *
 * The Hub notes an Installation that fails the Session too (#216): one whose MCP server didn't
 * answer as it started, or that the Gateway found failing since. The Session runs on.
 */
export const SandboxNoted = Schema.TaggedStruct("SandboxNoted", {
  message: Schema.String,
  /** The Installation that failed, when it is about one (#216). */
  installationFailed: Schema.optionalKey(InstallationFailure),
})
export type SandboxNoted = typeof SandboxNoted.Type

/**
 * A Participant changed the Session's model or thinking level (#128): what it is set to now, which
 * its Harness runs from the next Turn on. An absent `model` is Claude Code's default, and an absent
 * `thinkingLevel` the model's usual level.
 */
export const ModelSwitched = Schema.TaggedStruct("ModelSwitched", {
  by: Participant,
  model: Schema.optionalKey(ModelName),
  /**
   * What the model was called then, such as `Sonnet 5.5`: as the Runner's Claude Code named it,
   * for its default the model it runs; or a pi Session's Model's label among its Creator's.
   */
  modelLabel: Schema.optionalKey(Schema.NonEmptyString),
  thinkingLevel: Schema.optionalKey(ThinkingLevel),
  /**
   * The Harness it runs on, when the switch changed it (ADR 0030): the next Turn runs there, with
   * a handoff of what that Harness hasn't seen.
   */
  harness: Schema.optionalKey(Harness),
})
export type ModelSwitched = typeof ModelSwitched.Type

/**
 * The Hub took a queued prompt out of the Prompt queue without it running (ADR 0026): it was
 * queued by someone other than the Session's Creator, before only the Creator could prompt.
 */
export const PromptCancelled = Schema.TaggedStruct("PromptCancelled", {
  promptId: PromptId,
  sender: Participant,
  /** As typed; empty for a prompt of attachments alone. */
  text: Schema.String,
  /** Why it was cancelled, as shown. */
  message: Schema.String,
})
export type PromptCancelled = typeof PromptCancelled.Type

/**
 * Everything a Session's history records: Turn events from the mod, and what the Hub saw
 * happen. New kinds of event are added here as members.
 */
export const SessionEvent = Schema.Union([
  TurnEvent,
  SessionStateChanged,
  TurnStopRequested,
  AgentMessaged,
  SandboxNoted,
  ModelSwitched,
  PromptCancelled,
  ThreadStarted,
  ThreadPromptSent,
  ThreadPromptFailed,
  ThreadModelChanged,
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
 * Start a new Session on a Repo, on a branch (ADR 0023): an existing one, directly or on a new
 * Work branch made from it, or a new one made from another. The Hub picks a Runner if none is
 * named. A `model` or `thinkingLevel` the agent doesn't take is refused (#128): a `model` is one of
 * its Creator's Models, `openai/gpt-6-sol` (ADR 0029), absent for their default Model
 * (`defaultProviderModel`).
 */
export const CreateSession = Schema.TaggedStruct("CreateSession", {
  requestId: RequestId,
  repo: RepoName,
  branch: BranchChoice,
  runnerId: Schema.optionalKey(RunnerId),
  model: Schema.optionalKey(ModelName),
  thinkingLevel: Schema.optionalKey(ThinkingLevel),
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

/**
 * Add a prompt to the end of the Session's Prompt queue; the sender is the signed-in person. Its
 * attachments (#276) are files they uploaded to the Session; an image alone is a prompt.
 */
export const SendPrompt = Schema.TaggedStruct("SendPrompt", {
  sessionId: SessionId,
  text: Schema.String,
  attachments: Schema.optionalKey(AttachmentIds),
}).check(textOrAttachments)
export type SendPrompt = typeof SendPrompt.Type

/** Remove a prompt from the Prompt queue before it is delivered. Any Participant may. */
export const CancelPrompt = Schema.TaggedStruct("CancelPrompt", {
  sessionId: SessionId,
  promptId: PromptId,
})
export type CancelPrompt = typeof CancelPrompt.Type

/**
 * Hand a queued prompt to the running Turn instead of waiting for it to end (#195): it leaves the
 * Prompt queue, and Claude reads it at the Turn's next step. Any Participant may, while a Turn
 * runs on the main loop.
 */
export const SteerPrompt = Schema.TaggedStruct("SteerPrompt", {
  sessionId: SessionId,
  promptId: PromptId,
})
export type SteerPrompt = typeof SteerPrompt.Type

/**
 * Message one of the Session's subagents (ADR 0014): a running one reads it at its next tool call,
 * and one that has stopped resumes with it. Any Participant may; an Asleep Session is woken first.
 * The message carries the sender's name, as a prompt does. Its attachments (#278) are files they
 * uploaded to the Session; an image alone is a message.
 */
export const MessageAgent = Schema.TaggedStruct("MessageAgent", {
  sessionId: SessionId,
  agentId: AgentId,
  text: Schema.String,
  attachments: Schema.optionalKey(AttachmentIds),
}).check(textOrAttachments)
export type MessageAgent = typeof MessageAgent.Type

/**
 * Answer the Session's Open question (#193): with options or typed text, by replying in your own
 * words, or by dismissing it. Any Participant may. The first answer to reach Claude Code, from
 * here or its terminal, is the one Claude reads; a later one is refused with a CommandFailed
 * saying who answered first, and what.
 */
export const AnswerQuestion = Schema.TaggedStruct("AnswerQuestion", {
  sessionId: SessionId,
  /** The Open question's call, so an answer meant for another question is refused. */
  toolCallId: ToolCallId,
  answer: QuestionAnswerFromWeb,
  /** The files a reply carries (#278): ones its sender uploaded to the Session. */
  attachments: Schema.optionalKey(AttachmentIds),
})
export type AnswerQuestion = typeof AnswerQuestion.Type

/**
 * Show the other Participants what you have picked for one of the Open question's questions,
 * before answering (#193): an option's label, several joined with ", ", or typed text. Empty
 * takes your pick back. Nothing reaches Claude.
 */
export const PickAnswer = Schema.TaggedStruct("PickAnswer", {
  sessionId: SessionId,
  toolCallId: ToolCallId,
  question: Schema.String,
  answer: Schema.String,
})
export type PickAnswer = typeof PickAnswer.Type

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
 * Delete a Session, which archives it (ADR 0003): its Sandbox is destroyed, its Workspace kept,
 * and anyone may restore it until it is purged. Any Participant may.
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
 * Set the Session's model and thinking level (#128), both at once: an absent model is Claude Code's
 * default, and an absent level the model's usual one. Its Creator may (ADR 0026), in any state but
 * Archived. The model says its Harness (`harnessOfModel`, ADR 0030), and a model or level that
 * Harness doesn't take is refused, a model as Claude Code refuses it (`Model 'x' not found`):
 * Claude Code's as the Runner's Claude Code has them, pi's among its Creator's Models. Every client
 * that can see the Session gets a SessionUpdated, and its log a ModelSwitched. A running Turn goes
 * on as it is: once no Turn runs, pi switches in place, Claude Code is restarted with the new
 * setting, and a model of the other Harness switches the Session to it; or the Session starts with
 * it when it next wakes.
 */
export const SetSessionModel = Schema.TaggedStruct("SetSessionModel", {
  sessionId: SessionId,
  model: Schema.optionalKey(ModelName),
  thinkingLevel: Schema.optionalKey(ThinkingLevel),
})
export type SetSessionModel = typeof SetSessionModel.Type

/** Restore an Archived Session before it is purged. It comes back Asleep. Any Participant may. */
export const RestoreSession = Schema.TaggedStruct("RestoreSession", {
  sessionId: SessionId,
})
export type RestoreSession = typeof RestoreSession.Type

/**
 * Purge an Archived Session now, rather than at the end of its retention, to free its Runner's
 * disk (#351): the Hub deletes it, its log and queue, and its Runner deletes its Workspace and
 * the rest, at once or when it is back. It can't be restored after. Any Member who can see it may,
 * not just its Creator (ADR 0027). Refused for a Session that isn't Archived. Answered with an
 * {@link ArchivedSessionPurged}; every client that could see it gets a SessionRemoved.
 */
export const PurgeArchivedSession = Schema.TaggedStruct("PurgeArchivedSession", {
  requestId: RequestId,
  sessionId: SessionId,
})
export type PurgeArchivedSession = typeof PurgeArchivedSession.Type

/**
 * Ask how much of its Runner's disk each of the Archived Sessions takes (#352), to show what
 * purging them would free. The Hub asks their Runners, which measure on demand, and keeps what they
 * say for a minute. Answered with a {@link SessionDiskUsage}, whose sizes are unknown for a Session
 * the person can't see or that isn't Archived, and for one whose Runner is offline. At most
 * {@link MaxDiskUsageSessions} Sessions.
 */
export const GetSessionDiskUsage = Schema.TaggedStruct("GetSessionDiskUsage", {
  requestId: RequestId,
  sessionIds: Schema.Array(SessionId).check(Schema.isMaxLength(MaxDiskUsageSessions)),
})
export type GetSessionDiskUsage = typeof GetSessionDiskUsage.Type

/**
 * What a web client asks of a Session's archive: deleting it, restoring it, purging it and how much
 * disk it takes.
 */
export const ArchiveCommand = Schema.Union([
  ArchiveSession,
  RestoreSession,
  PurgeArchivedSession,
  GetSessionDiskUsage,
])
export type ArchiveCommand = typeof ArchiveCommand.Type

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

/**
 * The Repos the person may start a Session on, for New Session's Repo combo box: those the GitHub
 * App is installed on and the person has access to. Answered with a {@link ReposListed}, a
 * {@link ListingUnavailable} without a GitHub App, or a CommandFailed when GitHub can't say.
 */
export const ListRepos = Schema.TaggedStruct("ListRepos", {
  requestId: RequestId,
})
export type ListRepos = typeof ListRepos.Type

/**
 * A Repo's branches and its default branch, through the GitHub App, for New Session's Branch combo
 * box. Answered with a {@link BranchesListed}, a {@link ListingUnavailable} without a GitHub App,
 * or a CommandFailed when the person has no access to the Repo or GitHub can't say.
 */
export const ListBranches = Schema.TaggedStruct("ListBranches", {
  requestId: RequestId,
  repo: RepoName,
})
export type ListBranches = typeof ListBranches.Type

/** What a web client asks the Hub about Repos and branches as New Session is filled in. */
export const RepoLookup = Schema.Union([CheckRepo, ListRepos, ListBranches])
export type RepoLookup = typeof RepoLookup.Type

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

/**
 * Ask for a Runner's history (#350, #356): its free disk, available memory and load over the last
 * 7 days, for the Runners page's Monitor to chart. Apart from the RunnerList because it is long
 * and changes little. Answered with a {@link RunnerHistory}, or a CommandFailed for a Runner that
 * isn't there.
 */
export const GetRunnerHistory = Schema.TaggedStruct("GetRunnerHistory", {
  requestId: RequestId,
  runnerId: RunnerId,
})
export type GetRunnerHistory = typeof GetRunnerHistory.Type

// ── People (issue #209, ADR 0019) ──
//
// The Owner's alone: the Hub refuses each, with a CommandFailed, from anyone else.

/**
 * Make an Invite: a link that admits one person, once, within InviteLifetimeMs; with `login`, only
 * the GitHub account of that login. Answered with an {@link InviteCreated}, the only place the
 * link is ever shown.
 */
export const CreateInvite = Schema.TaggedStruct("CreateInvite", {
  requestId: RequestId,
  login: Schema.optionalKey(GitHubLogin),
})
export type CreateInvite = typeof CreateInvite.Type

/** List the Invites not yet used, revoked or expired. Answered with an {@link InviteList}. */
export const ListInvites = Schema.TaggedStruct("ListInvites", {
  requestId: RequestId,
})
export type ListInvites = typeof ListInvites.Type

/** Revoke an Invite not yet used. Answered with an {@link InviteList}. */
export const RevokeInvite = Schema.TaggedStruct("RevokeInvite", {
  requestId: RequestId,
  inviteId: InviteId,
})
export type RevokeInvite = typeof RevokeInvite.Type

/** List the Members. Answered with a {@link MemberList}. */
export const ListMembers = Schema.TaggedStruct("ListMembers", {
  requestId: RequestId,
})
export type ListMembers = typeof ListMembers.Type

/**
 * Remove a Member who isn't the Owner: their sign-ins and CLI tokens are revoked at once, and they
 * can't sign in again without a new Invite. Their Sessions and Claude credential stay. Answered
 * with a {@link MemberList}.
 */
export const RemoveMember = Schema.TaggedStruct("RemoveMember", {
  requestId: RequestId,
  participantId: ParticipantId,
})
export type RemoveMember = typeof RemoveMember.Type

/** Every message a web client sends the Hub. */
export const WebToHub = Schema.Union([
  WebHello,
  CreateSession,
  JoinSession,
  LeaveSession,
  SendPrompt,
  CancelPrompt,
  SteerPrompt,
  StopTurn,
  MessageAgent,
  StopAgent,
  AnswerQuestion,
  PickAnswer,
  SleepSession,
  WakeSession,
  SetKeepAwake,
  RestartSession,
  ArchiveCommand,
  RenameSession,
  SetSessionModel,
  OpenTerminal,
  CloseTerminal,
  TerminalInput,
  TerminalResize,
  ThreadCommand,
  GetEnvironment,
  CheckEnvironmentDraft,
  StartTestBuild,
  ApplyEnvironment,
  GetSharedVariables,
  SetSharedVariable,
  DeleteSharedVariable,
  McpServerCommand,
  ProviderCommand,
  CheckAppPermissions,
  HubUpdateCommand,
  RepoLookup,
  CreatePairingCode,
  RevokePairingCode,
  RemoveRunner,
  UpdateRunner,
  GetRunnerHistory,
  RevokeCliToken,
  CreateInvite,
  ListInvites,
  RevokeInvite,
  ListMembers,
  RemoveMember,
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
  /** True when you are the Hub's Owner (#209), who alone may invite and remove people. */
  owner: Schema.optionalKey(Schema.Boolean),
  /**
   * The Hub's update check (ADR 0028): for its Owner alone, on a Hub that checks for a newer kndl.
   * Its absence tells the web there is no Hub page.
   */
  hubUpdate: Schema.optionalKey(HubUpdateState),
  /** The latest update of the Hub (#362), for its Owner alone, on a Hub that checks. */
  hubUpdateRun: Schema.optionalKey(HubUpdateRun),
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
 * retention (30 days by default) after it was archived or sooner by hand, or the person lost access
 * to its Repo on GitHub, which also took them out of it.
 */
export const SessionRemoved = Schema.TaggedStruct("SessionRemoved", {
  sessionId: SessionId,
})
export type SessionRemoved = typeof SessionRemoved.Type

/**
 * Answers a {@link PurgeArchivedSession}: the Session is gone from the Hub. Its Runner frees its
 * disk now if `runnerOnline`, otherwise when it is back.
 */
export const ArchivedSessionPurged = Schema.TaggedStruct("ArchivedSessionPurged", {
  requestId: RequestId,
  sessionId: SessionId,
  runnerOnline: Schema.Boolean,
})
export type ArchivedSessionPurged = typeof ArchivedSessionPurged.Type

/**
 * Answers a {@link GetSessionDiskUsage}: one entry for each Session asked about, in the order asked,
 * with `bytes` absent where it isn't known.
 */
export const SessionDiskUsage = Schema.TaggedStruct("SessionDiskUsage", {
  requestId: RequestId,
  sizes: Schema.Array(SessionDiskSize),
})
export type SessionDiskUsage = typeof SessionDiskUsage.Type

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

/** One Participant's pick for one question of an Open question, as PickAnswer shared it. */
export const QuestionPick = Schema.Struct({
  participant: Participant,
  question: Schema.String,
  answer: Schema.NonEmptyString,
})
export type QuestionPick = typeof QuestionPick.Type

/**
 * What the Participants have picked for a joined Session's Open question so far, in full: sent on
 * join while a question is open, and whenever a pick changes. The Hub keeps them in memory only.
 */
export const QuestionPicks = Schema.TaggedStruct("QuestionPicks", {
  sessionId: SessionId,
  toolCallId: ToolCallId,
  picks: Schema.Array(QuestionPick),
})
export type QuestionPicks = typeof QuestionPicks.Type

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
 * Answers a {@link ListRepos} or {@link ListBranches} when the Hub has no GitHub App to list with,
 * so the web UI can fall back to its Sessions without offering a retry. `hint` says what to set,
 * and is sent to a dev login only.
 */
export const ListingUnavailable = Schema.TaggedStruct("ListingUnavailable", {
  requestId: RequestId,
  hint: Schema.optionalKey(Schema.String),
})
export type ListingUnavailable = typeof ListingUnavailable.Type

/** Answers a {@link ListRepos}. */
export const ReposListed = Schema.TaggedStruct("ReposListed", {
  requestId: RequestId,
  repos: Schema.Array(RepoName),
})
export type ReposListed = typeof ReposListed.Type

/** Answers a {@link ListBranches}. */
export const BranchesListed = Schema.TaggedStruct("BranchesListed", {
  requestId: RequestId,
  repo: RepoName,
  branches: Schema.Array(BranchName),
  /** The Repo's default branch, which is among `branches`. */
  defaultBranch: BranchName,
})
export type BranchesListed = typeof BranchesListed.Type

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
  /** The Hub's public URL with the code as its fragment, for `kndl runner join`. */
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

/** Answers a {@link CreateInvite}. The link is shown here only: the Hub keeps its secret's hash. */
export const InviteCreated = Schema.TaggedStruct("InviteCreated", {
  requestId: RequestId,
  id: InviteId,
  /** The web UI's Invite page, with the secret as its fragment. */
  link: Schema.NonEmptyString,
  login: Schema.optionalKey(GitHubLogin),
  expiresAt: EpochMillis,
})
export type InviteCreated = typeof InviteCreated.Type

/**
 * The Invites not yet used, revoked or expired, without their links, oldest first: sent to the
 * Owner's web clients alone, in answer to a {@link ListInvites} or {@link RevokeInvite}, and
 * whenever one is made, used or revoked. A client drops one by itself once its `expiresAt` has
 * passed.
 */
export const InviteList = Schema.TaggedStruct("InviteList", {
  requestId: Schema.optionalKey(RequestId),
  invites: Schema.Array(PendingInvite),
})
export type InviteList = typeof InviteList.Type

/**
 * The Members, the Owner first, then by when they were admitted: sent to the Owner's web clients
 * alone, in answer to a {@link ListMembers} or {@link RemoveMember}, and whenever someone is
 * admitted or removed.
 */
export const MemberList = Schema.TaggedStruct("MemberList", {
  requestId: Schema.optionalKey(RequestId),
  members: Schema.Array(Member),
})
export type MemberList = typeof MemberList.Type

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

/** Answers a {@link GetRunnerHistory}: the Runner's host over time, oldest point first. */
export const RunnerHistory = Schema.TaggedStruct("RunnerHistory", {
  requestId: RequestId,
  runnerId: RunnerId,
  points: Schema.Array(RunnerHistoryPoint),
})
export type RunnerHistory = typeof RunnerHistory.Type

/** Every message the Hub sends a web client. */
export const HubToWeb = Schema.Union([
  WebWelcome,
  HandshakeRejected,
  RunnerList,
  SessionList,
  SessionUpdated,
  SessionRemoved,
  ArchivedSessionPurged,
  SessionDiskUsage,
  SessionCreated,
  SessionHistory,
  SessionEventLogged,
  PresenceChanged,
  PromptQueueChanged,
  QuestionPicks,
  SessionStartLogged,
  TerminalFrame,
  ThreadMessage,
  CommandFailed,
  EnvironmentState,
  EnvironmentDraftChecked,
  TestBuildStarted,
  TestBuildLogged,
  TestBuildEnded,
  SharedVariables,
  McpServersState,
  McpServerLog,
  McpServerPackageRead,
  InstallationAuthorizing,
  InstallationNeedsClient,
  ProviderMessage,
  AppPermissionsChecked,
  HubUpdateMessage,
  RepoChecked,
  ReposListed,
  BranchesListed,
  ListingUnavailable,
  RepoAccessLost,
  PairingCodeCreated,
  PairingCodeList,
  PairingCodeRedeemed,
  RunnerRemoved,
  RunnerUpdateRequested,
  RunnerHistory,
  CliTokenList,
  InviteCreated,
  InviteList,
  MemberList,
]).pipe(Schema.toTaggedUnion("_tag"))
export type HubToWeb = typeof HubToWeb.Type
