import { Schema } from "effect"
import { BuildVersion, RunnerVersionStatus } from "./Build.ts"
import {
  AgentId,
  EnvironmentVersion,
  InstallationId,
  ParticipantId,
  PluginId,
  PromptId,
  RunnerId,
  SessionId,
  ToolCallId,
  TurnId,
} from "./Ids.ts"
import { EffortLevel, ModelName, RunnerModels } from "./Model.ts"
import { RunnerUpdater, RunnerUpdateState } from "./Update.ts"

// Shapes shared by more than one channel: who is involved in a Session and what state it is in.

/** Milliseconds since the Unix epoch. */
export const EpochMillis = Schema.Natural
export type EpochMillis = typeof EpochMillis.Type

/**
 * A Repo by its GitHub full name, `owner/name`. GitHub's names ignore case, so two spellings of
 * one name are the same Repo (#197): compare them with {@link sameRepo}, or by {@link repoKey}.
 */
export const RepoName = Schema.String.check(Schema.isPattern(/^[^/\s]+\/[^/\s]+$/))
export type RepoName = typeof RepoName.Type

/** What every spelling of a Repo's name has in common, to key or compare it by. */
export const repoKey = (repo: string): string => repo.toLowerCase()

/** Whether two names are the same Repo: GitHub's names ignore case. */
export const sameRepo = (a: string, b: string): boolean => repoKey(a) === repoKey(b)

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

/**
 * How a Runner shows its own Claude credential (ADR 0015), which runs Sessions whose Creator has
 * stored none. Sent in its hello as `login`, and kept as a Session's `runnerLogin`: names from
 * when every Session ran on the Claude account signed in on its Runner (ADR 0002).
 */
export const RunnerAccount = Schema.Struct({
  /**
   * The credential's kind and last four characters, such as "Subscription token …9f3b"; the
   * account Claude Code is signed in to, when it is Claude Code's login; or "No Claude
   * credential". From a Runner from before: the email address of its Claude account.
   */
  account: Schema.NonEmptyString,
})
export type RunnerAccount = typeof RunnerAccount.Type

/** Whose Claude credential a Session runs on: its Creator's, or its Runner's own (ADR 0015). */
export const ClaudeAccount = Schema.Literals(["Creator", "Runner"])
export type ClaudeAccount = typeof ClaudeAccount.Type

/** A Runner as the web UI lists it: every Runner paired with the Hub and not removed. */
export const RunnerSummary = Schema.Struct({
  id: RunnerId,
  name: Schema.NonEmptyString,
  /** Its own Claude credential as it last said hello with it; null until it first connects. */
  login: Schema.NullOr(RunnerAccount),
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
  /**
   * The models and effort levels its Claude Code takes, as its last hello said (#128); absent
   * from a Runner too old to say, or that couldn't find out.
   */
  models: Schema.optionalKey(RunnerModels),
  /**
   * Whether it has a Claude credential of its own, which runs the Sessions of a Creator who has
   * stored none (ADR 0015); absent while it is offline.
   */
  ownClaudeCredential: Schema.optionalKey(Schema.Boolean),
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
 * Who turned Keep awake on for a Session, and when (ADR 0016): while it is on, the Session doesn't
 * go Asleep for being idle. Pressing Sleep turns it off; a Runner drain or restart leaves it on.
 */
export const KeepAwake = Schema.Struct({
  by: Participant,
  at: EpochMillis,
})
export type KeepAwake = typeof KeepAwake.Type

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
 * An Installation a Session runs with (ADR 0020), with its and its Plugin's names as it started,
 * and the name of its MCP server in Claude Code, which Claude Code shows as `plugin:kndl:<server>`.
 */
export const SessionInstallation = Schema.Struct({
  id: InstallationId,
  name: Schema.String,
  pluginId: PluginId,
  pluginName: Schema.String,
  /** The version of a packaged Plugin it started with, so an Upgrade asks for a Restart. */
  pluginVersion: Schema.optionalKey(Schema.String),
  /** Whether it was on as a global Installation (#219); absent if Repo-scoped. */
  global: Schema.optionalKey(Schema.Boolean),
  server: Schema.String,
  /**
   * The header secrets (#215) it held a value for, and when each was set: never the value. A
   * value set since shows that a Restart applies it. Absent for none.
   */
  values: Schema.optionalKey(
    Schema.Array(Schema.Struct({ key: Schema.String, setAt: EpochMillis })),
  ),
})
export type SessionInstallation = typeof SessionInstallation.Type

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

/**
 * Where one of a Session's subagents is (ADR 0014): running, finished, stopped by TaskStop, or cut
 * off when its Session's Claude Code stopped (sleep, a restart, a lost Runner). Any but Running can
 * be resumed with a message.
 */
export const AgentStatus = Schema.Literals(["Running", "Done", "Stopped", "Interrupted"])
export type AgentStatus = typeof AgentStatus.Type

/** One of a Session's subagents, as the sidebar lists it under the Session. */
export const AgentSummary = Schema.Struct({
  id: AgentId,
  /** What it was started for, as the Agent call described it. */
  description: Schema.String,
  status: AgentStatus,
})
export type AgentSummary = typeof AgentSummary.Type

/**
 * An Open port (GLOSSARY.md): a TCP port something in a Session's Sandbox listens on, as its Runner
 * last saw it (ADR 0016). Forwarding it reaches it through the Hub.
 */
export const OpenPort = Schema.Struct({
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  /**
   * The addresses it listens on, such as `0.0.0.0`, `127.0.0.1`, `::` or `::1`; one port can listen
   * on an IPv4 and an IPv6 address at once.
   */
  addresses: Schema.Array(Schema.String),
  /**
   * What listens on it, shortened: the program's name, or a runtime and its script, such as
   * `node server` or `python3 -m`. `docker-proxy` for a port a Docker container publishes. Absent
   * when the Runner couldn't tell.
   */
  process: Schema.optionalKey(Schema.String),
})
export type OpenPort = typeof OpenPort.Type

/** What listens on a port Docker publishes for a container in the Sandbox. */
export const DockerProxy = "docker-proxy"

/** Whether an Open port is one a Docker container publishes, which the web UI labels Docker. */
export const isDockerPort = (port: OpenPort): boolean => port.process === DockerProxy

// ── Open questions (#193) ──────────────────────────────────────────────────

/** One option of a question Claude asks with AskUserQuestion. */
export const QuestionOption = Schema.Struct({
  /** What the option says, which is also its answer. */
  label: Schema.String,
  /** What choosing it means; absent when Claude gave none. */
  description: Schema.optionalKey(Schema.String),
})
export type QuestionOption = typeof QuestionOption.Type

/** One question of an AskUserQuestion call, as Claude Code's dialog shows it. */
export const Question = Schema.Struct({
  /** The question, which the answers are keyed by. */
  question: Schema.String,
  /** A short label for it, such as `Auth method`. */
  header: Schema.String,
  /** Its options, without "Other": any answer may be typed instead. None for a free-text question. */
  options: Schema.Array(QuestionOption),
  /** Whether more than one option may be picked, their labels joined with ", ". */
  multiSelect: Schema.Boolean,
})
export type Question = typeof Question.Type

/**
 * The answers to an AskUserQuestion call, as Claude Code's dialog submits them: each keyed by its
 * question's text, an option's label, several joined with ", ", or text typed under Other. A
 * question skipped has none.
 */
export const QuestionAnswers = Schema.Record(Schema.String, Schema.String)
export type QuestionAnswers = typeof QuestionAnswers.Type

/**
 * Several options picked for a multi-select question, as one answer the way Claude Code's dialog
 * joins them: with ", ", a label that holds ", " or a quote written as a JSON string.
 */
export const joinAnswers = (labels: ReadonlyArray<string>): string =>
  labels
    .map((label) => (label.includes(", ") || label.includes('"') ? JSON.stringify(label) : label))
    .join(", ")

/** The question was answered: Claude reads the answers, keyed by question. */
export const QuestionAnswered = Schema.TaggedStruct("Answered", { answers: QuestionAnswers })
export type QuestionAnswered = typeof QuestionAnswered.Type

/** Someone replied in their own words instead of answering, which Claude reads as their response. */
export const QuestionReplied = Schema.TaggedStruct("Replied", { text: Schema.NonEmptyString })
export type QuestionReplied = typeof QuestionReplied.Type

/** Someone dismissed the question, as Esc does in Claude Code's dialog: Claude is told no. */
export const QuestionDismissed = Schema.TaggedStruct("Dismissed", {})
export type QuestionDismissed = typeof QuestionDismissed.Type

/** A Participant's answer to an Open question, from the web UI. */
export const QuestionAnswer = Schema.Union([
  QuestionAnswered,
  QuestionReplied,
  QuestionDismissed,
]).pipe(Schema.toTaggedUnion("_tag"))
export type QuestionAnswer = typeof QuestionAnswer.Type

/**
 * How an Open question closed: answered, replied to or dismissed by a Participant or at the
 * terminal, or Cancelled, when its Turn was stopped or its Claude Code stopped first, or its dialog
 * timed out with nobody at the keyboard.
 */
export const QuestionOutcome = Schema.Union([
  QuestionAnswered,
  QuestionReplied,
  QuestionDismissed,
  Schema.TaggedStruct("Cancelled", {}),
]).pipe(Schema.toTaggedUnion("_tag"))
export type QuestionOutcome = typeof QuestionOutcome.Type

/**
 * An Open question (GLOSSARY.md): Claude asked with AskUserQuestion on the main loop, and nobody
 * has answered yet. Claude Code waits on it, and so does the Session, which doesn't sleep.
 */
export const OpenQuestion = Schema.Struct({
  turnId: TurnId,
  /** The AskUserQuestion call, which an answer names. */
  toolCallId: ToolCallId,
  questions: Schema.Array(Question),
  askedAt: EpochMillis,
})
export type OpenQuestion = typeof OpenQuestion.Type

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
  /**
   * Its Runner's own Claude credential as it was when the Session was created, which the Session
   * runs on when `claudeAccount` is `Runner`.
   */
  runnerLogin: RunnerAccount,
  /**
   * Whose Claude account its Claude Code runs on (ADR 0015): its Creator's own credential, or the
   * Runner's, when the Creator has stored none. Absent from a Hub from before.
   */
  claudeAccount: Schema.optionalKey(ClaudeAccount),
  /** Recorded for history only; grants no rights (ADR 0003). */
  creator: Participant,
  createdAt: EpochMillis,
  /** The Turn running now, or null when the Session is idle. */
  currentTurn: Schema.NullOr(TurnId),
  /**
   * Its Running and Interrupted subagents, oldest first (ADR 0014); absent when it has none. A
   * Running one keeps the Session working, as a Turn does.
   */
  agents: Schema.optionalKey(Schema.Array(AgentSummary)),
  /** Present while the Session is Archived. */
  archived: Schema.optionalKey(ArchiveInfo),
  /** Present once its Repo has an Environment. */
  environment: Schema.optionalKey(SessionEnvironmentStatus),
  /**
   * The Installations its Claude Code runs with (ADR 0020), as its last start or Restart gave
   * them; absent for none.
   */
  plugins: Schema.optionalKey(Schema.Array(SessionInstallation)),
  /**
   * Present when its Repo's Installations, or their Plugins, changed since: they apply at its
   * next wake or Restart.
   */
  pluginsChanged: Schema.optionalKey(Schema.Literal(true)),
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
  /**
   * The model its Claude Code runs, as `--model` takes it (#128): absent for Claude Code's
   * default. Shared: anyone with access may change it, from the next Turn on.
   */
  model: Schema.optionalKey(ModelName),
  /** Its effort level (#128): absent for Claude Code's default. */
  effort: Schema.optionalKey(EffortLevel),
  /**
   * Present while its Claude Code still runs on the model and effort from before it was changed:
   * they apply once no Turn runs, when the Hub restarts Claude Code with them.
   */
  modelPending: Schema.optionalKey(Schema.Literal(true)),
  /**
   * Its Open ports, by port, as its Runner last reported them (ADR 0016): present while it is
   * Active and something in its Sandbox listens. Kept in the Hub's memory only.
   */
  openPorts: Schema.optionalKey(Schema.Array(OpenPort)),
  /**
   * Present while Keep awake is on (ADR 0016): it doesn't go Asleep for being idle. Anyone with
   * access to its Repo may turn it on or off; pressing Sleep turns it off.
   */
  keepAwake: Schema.optionalKey(KeepAwake),
  /**
   * Its Open question (#193): present while Claude waits for an answer to an AskUserQuestion call
   * on its main loop, which any Participant may give.
   */
  openQuestion: Schema.optionalKey(OpenQuestion),
})
export type SessionSummary = typeof SessionSummary.Type

/** Another Session, as a prompt it sent names it: its id, and its title when it sent it. */
export const SessionRef = Schema.Struct({
  id: SessionId,
  /** Its Session name, or its Work branch while it had none (see {@link sessionTitle}). */
  title: Schema.NonEmptyString,
})
export type SessionRef = typeof SessionRef.Type

/**
 * A prompt another Session sent: a Child Session's Report or message, or its Parent Session's
 * message, from before ADR 0014 removed Child Sessions. Only history has it: nothing sends one
 * any more, and the Hub's migration rewrote the three senders of ADR 0012 to this one.
 */
export const FromSession = Schema.TaggedStruct("FromSession", { session: SessionRef })
export type FromSession = typeof FromSession.Type

/** A prompt waiting in a Session's Prompt queue. */
export const QueuedPrompt = Schema.Struct({
  id: PromptId,
  /** As typed. */
  text: Schema.NonEmptyString,
  sender: Participant,
  queuedAt: EpochMillis,
})
export type QueuedPrompt = typeof QueuedPrompt.Type

/**
 * A Participant present in a Session: in it in the web UI, forwarding its ports with
 * `kndl forward` (ADR 0016), or both.
 */
export const PresentParticipant = Schema.Struct({
  ...Participant.fields,
  /**
   * The machines they forward the Session's ports from, by the names of their CLI tokens, as
   * "Alice · forwarding from macbook" shows it; absent when they forward from none.
   */
  forwardingFrom: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
})
export type PresentParticipant = typeof PresentParticipant.Type

/** Hub to web and Hub to mod: the Participants connected to a Session now, in full. */
export const PresenceChanged = Schema.TaggedStruct("PresenceChanged", {
  sessionId: SessionId,
  participants: Schema.Array(PresentParticipant),
})
export type PresenceChanged = typeof PresenceChanged.Type

/** Web to Hub, then Hub to mod: end the Session's current Turn. */
export const StopTurn = Schema.TaggedStruct("StopTurn", {
  sessionId: SessionId,
})
export type StopTurn = typeof StopTurn.Type

/**
 * Web to Hub, then Hub to mod: stop one of the Session's subagents (ADR 0014), as Claude Code's
 * TaskStop does. Any Participant may.
 */
export const StopAgent = Schema.TaggedStruct("StopAgent", {
  sessionId: SessionId,
  agentId: AgentId,
})
export type StopAgent = typeof StopAgent.Type
