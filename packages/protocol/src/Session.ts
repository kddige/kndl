import { Schema } from "effect"
import { BuildVersion, RunnerVersionStatus } from "./Build.ts"
import { EnvironmentVersion, ParticipantId, PromptId, RunnerId, SessionId, TurnId } from "./Ids.ts"
import { RunnerUpdater, RunnerUpdateState } from "./Update.ts"

// Shapes shared by more than one channel: who is involved in a Session and what state it is in.

/** Milliseconds since the Unix epoch. */
export const EpochMillis = Schema.Natural
export type EpochMillis = typeof EpochMillis.Type

/** A Repo by its GitHub full name, `owner/name`. */
export const RepoName = Schema.String.check(Schema.isPattern(/^[^/\s]+\/[^/\s]+$/))
export type RepoName = typeof RepoName.Type

/** A git branch name: a Session's base branch or its Work branch. */
export const BranchName = Schema.NonEmptyString
export type BranchName = typeof BranchName.Type

/** The longest a Session name may be, in characters. */
export const MaxSessionNameLength = 80

/**
 * A Session's editable display name (GLOSSARY.md): trimmed, not empty, at most
 * {@link MaxSessionNameLength} characters. A Session without one is shown by its Work branch.
 */
export const SessionName = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(MaxSessionNameLength),
)
export type SessionName = typeof SessionName.Type

/**
 * The Session name a rename asks for, as the Hub stores it: trimmed, or null when nothing is left,
 * which clears the name so the Work branch shows again. A string when the name can't be used: why.
 */
export function sessionNameFrom(text: string): { readonly name: SessionName | null } | string {
  const name = text.trim()
  if (name.length > MaxSessionNameLength) {
    return `A Session name can be at most ${MaxSessionNameLength} characters; this one is ${name.length}.`
  }
  return { name: name === "" ? null : name }
}

/** What the web UI calls a Session: its name, or its Work branch while it has none. */
export const sessionTitle = (session: {
  readonly name?: SessionName
  readonly workBranch: BranchName
}): string => session.name ?? session.workBranch

/**
 * Where a Session is in its lifecycle (see GLOSSARY.md):
 * - `Active`: its Sandbox is running, or starting.
 * - `Asleep`: its Claude Code and Sandbox were stopped after being idle, or by hand; the next
 *   prompt, or a WakeSession, wakes it.
 * - `Frozen`: its Runner is offline; readable, and prompts queue until the Runner returns.
 * - `Archived`: deleted, restorable until it is purged, 30 days later by default (ADR 0003).
 */
export const SessionState = Schema.Literals(["Active", "Asleep", "Frozen", "Archived"])
export type SessionState = typeof SessionState.Type

/** A person signed in to the Hub with GitHub, as shown to others. */
export const Participant = Schema.Struct({
  id: ParticipantId,
  /** GitHub login. */
  login: Schema.NonEmptyString,
  /** Display name; the login when GitHub has none. */
  name: Schema.NonEmptyString,
  /** The person's GitHub avatar, an `https://avatars.githubusercontent.com/` URL; absent for dev login. */
  avatarUrl: Schema.optionalKey(Schema.NonEmptyString),
})
export type Participant = typeof Participant.Type

/** The Claude account signed in on a Runner, shown on every Session that runs there (ADR 0002). */
export const RunnerLogin = Schema.Struct({
  /** How the account is shown, such as its email address. */
  account: Schema.NonEmptyString,
})
export type RunnerLogin = typeof RunnerLogin.Type

/** A Runner as the web UI lists it: every Runner paired with the Hub and not removed. */
export const RunnerSummary = Schema.Struct({
  id: RunnerId,
  name: Schema.NonEmptyString,
  /** The Runner login it last said hello with; null until it first connects. */
  login: Schema.NullOr(RunnerLogin),
  isOnline: Schema.Boolean,
  /** The version it last said hello with; null before it connects, or from a Runner too old to say. */
  version: Schema.NullOr(BuildVersion),
  /** Its version against the Hub's own (WebWelcome's `hub`). */
  versionStatus: RunnerVersionStatus,
  /** When it was last connected: now, while it is online; null before it first connects. */
  lastSeenAt: Schema.NullOr(EpochMillis),
  /**
   * Its Sessions that aren't Archived: Active, Asleep or Frozen, in any Repo. While it has any,
   * it can't be removed.
   */
  openSessions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Whether it updates itself, as it said in its last hello; absent from a Runner too old to say. */
  updater: Schema.optionalKey(RunnerUpdater),
  /** Its update under way, or the last one's refusal or failure (#87). */
  update: Schema.optionalKey(RunnerUpdateState),
})
export type RunnerSummary = typeof RunnerSummary.Type

/** Who archived a Session and when, and when it will be purged unless restored first. */
export const ArchiveInfo = Schema.Struct({
  by: Participant,
  at: EpochMillis,
  purgeAt: EpochMillis,
})
export type ArchiveInfo = typeof ArchiveInfo.Type

/**
 * The Environment version a Session's Sandbox runs on, against its Repo's latest: on an older one,
 * the Session picks up the latest on its next wake, or straight away through a restart.
 */
export const SessionEnvironmentStatus = Schema.Struct({
  /** Null when its Sandbox was started before the Repo had an Environment, or by an older Runner. */
  version: Schema.NullOr(EnvironmentVersion),
  latestVersion: EnvironmentVersion,
})
export type SessionEnvironmentStatus = typeof SessionEnvironmentStatus.Type

/**
 * A start of the Session's Claude Code and Sandbox the Hub is waiting on: from its StartSession
 * until the Runner says it started, or couldn't. A start may first build the Environment and run
 * its start script, which can take minutes.
 */
export const SessionStart = Schema.Struct({
  /** When the Hub sent StartSession. */
  since: EpochMillis,
  /** The Environment version it is being started on; absent for a Repo without an Environment. */
  environmentVersion: Schema.optionalKey(EnvironmentVersion),
})
export type SessionStart = typeof SessionStart.Type

/**
 * A RestartSession under way: an Active Session goes to sleep, then starts again; an Asleep one
 * starts. Over once it has started, or failed to.
 */
export const SessionRestart = Schema.Struct({
  by: Participant,
  since: EpochMillis,
})
export type SessionRestart = typeof SessionRestart.Type

/** A Session as the web UI lists it. */
export const SessionSummary = Schema.Struct({
  id: SessionId,
  repo: RepoName,
  baseBranch: BranchName,
  workBranch: BranchName,
  /** Its Session name; absent until someone names it, when it is shown by its Work branch. */
  name: Schema.optionalKey(SessionName),
  state: SessionState,
  runnerId: RunnerId,
  /** The Runner login every Turn of this Session runs on. */
  runnerLogin: RunnerLogin,
  /** Recorded for history only; grants no rights (ADR 0003). */
  creator: Participant,
  createdAt: EpochMillis,
  /** The Turn running now, or null when the Session is idle. */
  currentTurn: Schema.NullOr(TurnId),
  /** Present while the Session is Archived. */
  archived: Schema.optionalKey(ArchiveInfo),
  /** Present once its Repo has an Environment. */
  environment: Schema.optionalKey(SessionEnvironmentStatus),
  /**
   * Present while its Claude Code and Sandbox are being started. `environment.version` stays the
   * one it ran on before, if any, until the start is over.
   */
  starting: Schema.optionalKey(SessionStart),
  /** Present while a restart is under way. */
  restarting: Schema.optionalKey(SessionRestart),
  /**
   * Present while it is Asleep because Claude Code exited on its own: the last lines its terminal
   * showed, redacted as the terminal is, so why it exited can be read (#105).
   */
  lastOutput: Schema.optionalKey(Schema.String),
})
export type SessionSummary = typeof SessionSummary.Type

/** A prompt waiting in a Session's Prompt queue. */
export const QueuedPrompt = Schema.Struct({
  id: PromptId,
  text: Schema.NonEmptyString,
  sender: Participant,
  queuedAt: EpochMillis,
})
export type QueuedPrompt = typeof QueuedPrompt.Type

/** Hub to web and Hub to mod: the Participants connected to a Session now, in full. */
export const PresenceChanged = Schema.TaggedStruct("PresenceChanged", {
  sessionId: SessionId,
  participants: Schema.Array(Participant),
})
export type PresenceChanged = typeof PresenceChanged.Type

/** Web to Hub, then Hub to mod: end the Session's current Turn. */
export const StopTurn = Schema.TaggedStruct("StopTurn", {
  sessionId: SessionId,
})
export type StopTurn = typeof StopTurn.Type
