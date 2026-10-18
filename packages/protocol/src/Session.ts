import { Schema } from "effect"
import { PromptAttachments, textOrAttachments } from "./Attachment.ts"
import { BuildVersion, RunnerVersionStatus } from "./Build.ts"
import {
  AgentId,
  EnvironmentVersion,
  InstallationId,
  ParticipantId,
  McpServerId,
  PromptId,
  RunnerId,
  SessionId,
  ToolCallId,
  TurnId,
} from "./Ids.ts"
import { Harness, ModelName, RunnerModels, ThinkingLevel } from "./Model.ts"
import { SysinfoSample } from "./Sysinfo.ts"
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

/** The longest a branch name may be that a person enters, in characters. */
export const MaxBranchNameLength = 255

/** A git branch name: a Session's base branch or its Work branch. */
export const BranchName = Schema.NonEmptyString
export type BranchName = typeof BranchName.Type

/**
 * Why git would refuse `name` for a new branch, by the rules of `git check-ref-format --branch`,
 * or undefined when it would take it. Worded for the person typing the name.
 */
export function branchNameProblem(name: string): string | undefined {
  if (name === "") return "A branch name can't be empty."
  if (name.length > MaxBranchNameLength) {
    return `A branch name can be at most ${MaxBranchNameLength} characters; this one is ${name.length}.`
  }
  if (name === "@") return "A branch can't be named just @."
  if (name === "HEAD") return "A branch can't be named HEAD."
  if (name.startsWith("-")) return "A branch name can't start with -."
  if (name.startsWith("/") || name.endsWith("/")) return "A branch name can't start or end with /."
  if (name.includes("//")) return "A branch name can't have // in it."
  if (name.endsWith(".")) return "A branch name can't end with a dot."
  if (name.includes("..")) return "A branch name can't have two dots in a row."
  if (name.includes("@{")) return "A branch name can't have @{ in it."
  // oxlint-disable-next-line no-control-regex -- git refuses control characters
  if (/[\x00-\x20\x7f]/.test(name)) return "A branch name can't have spaces or control characters."
  const bad = /[~^:?*[\\]/.exec(name)
  if (bad !== null) return `A branch name can't have ${bad[0]} in it.`
  for (const part of name.split("/")) {
    if (part.startsWith(".")) return "A branch name's parts can't start with a dot."
    if (part.endsWith(".lock")) return "A branch name's parts can't end with .lock."
  }
  return undefined
}

/** Where kndl's own Work branches live: a branch under it can't be made by hand. */
export const WorkBranchPrefix = "claude/"

/** The work branch a new Session commits to, unless it works directly on a branch. */
export const workBranchFor = (sessionId: SessionId): BranchName => `${WorkBranchPrefix}${sessionId}`

/**
 * Why `name` can't be a new branch made from `from`, or undefined when it can: git must accept
 * it ({@link branchNameProblem}), it can't be under the Work branches' prefix, and it can't be
 * the branch it is made from. Without `from`, only the name is checked.
 */
export function newBranchProblem(name: string, from?: string): string | undefined {
  const problem = branchNameProblem(name)
  if (problem !== undefined) return problem
  if (name.startsWith(WorkBranchPrefix)) {
    return `Names under ${WorkBranchPrefix} are for the Work branches kndl makes.`
  }
  if (name === from) return "A new branch can't be made from a branch of the same name."
  return undefined
}

/**
 * A branch name git accepts, by {@link branchNameProblem} and at most {@link MaxBranchNameLength}
 * characters: one that is already there, as a person enters it. A Session keeps whatever name its
 * branch had, so {@link BranchName} itself has no limit.
 */
export const GitBranchName = BranchName.check(Schema.makeFilter((name) => branchNameProblem(name)))
export type GitBranchName = typeof GitBranchName.Type

/** The name of a branch to create: one git accepts, and not under the Work branches' prefix. */
export const NewBranchName = BranchName.check(Schema.makeFilter((name) => newBranchProblem(name)))
export type NewBranchName = typeof NewBranchName.Type

/** A New Session on a branch that is already there: on it directly, or on a new Work branch. */
export const ExistingBranch = Schema.TaggedStruct("Existing", {
  name: GitBranchName,
  /** True to work on a new `claude/<id>` branch made from it; false to commit to it directly. */
  newWorkBranch: Schema.Boolean,
})
export type ExistingBranch = typeof ExistingBranch.Type

/** A New Session on a branch to create, from `from`, which is its base branch. */
export const CreateBranch = Schema.TaggedStruct("Create", {
  name: NewBranchName,
  from: GitBranchName,
}).check(Schema.makeFilter((branch) => newBranchProblem(branch.name, branch.from)))
export type CreateBranch = typeof CreateBranch.Type

/**
 * Which branch a New Session works on (ADR 0023): the Hub turns it into the base branch the Repo
 * is cloned on and the Work branch the Session commits to.
 */
export const BranchChoice = Schema.Union([ExistingBranch, CreateBranch]).pipe(
  Schema.toTaggedUnion("_tag"),
)
export type BranchChoice = typeof BranchChoice.Type

/**
 * The branches a New Session's branch choice comes to (ADR 0023): the one its Repo is cloned on,
 * and the one it commits to.
 */
export const branchesFor = (
  choice: BranchChoice,
  sessionId: SessionId,
): { readonly baseBranch: BranchName; readonly workBranch: BranchName } => {
  if (choice._tag === "Create") return { baseBranch: choice.from, workBranch: choice.name }
  return {
    baseBranch: choice.name,
    workBranch: choice.newWorkBranch ? workBranchFor(sessionId) : choice.name,
  }
}

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

/** How many characters of a Session's id its title shows, where its branch isn't its own. */
const titleIdLength = 4

/**
 * What the web UI calls a Session: its name, or its Work branch while it has none. A Session on
 * its base branch itself (ADR 0023) shares that branch with others, so its title adds its short
 * id: `main · 3f96`.
 */
export const sessionTitle = (session: {
  readonly id: SessionId
  readonly name?: SessionName
  readonly baseBranch: BranchName
  readonly workBranch: BranchName
}): string =>
  session.name ??
  (session.workBranch === session.baseBranch
    ? `${session.workBranch} · ${session.id.slice(0, titleIdLength)}`
    : session.workBranch)

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

/** A Runner as the web UI lists it: every Runner paired with the Hub and not removed. */
export const RunnerSummary = Schema.Struct({
  id: RunnerId,
  name: Schema.NonEmptyString,
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
   * The models and thinking levels its Claude Code takes, as its last hello said (#128); absent
   * from a Runner too old to say, or that couldn't find out.
   */
  models: Schema.optionalKey(RunnerModels),
  /**
   * The Harnesses it runs Sessions on, as its last hello said (ADR 0029); absent for one that runs
   * Claude Code alone.
   */
  harnesses: Schema.optionalKey(Schema.Array(Harness)),
  /**
   * What its host looked like when it last sampled it (#350), kept after it disconnects, for the
   * page to show greyed out; absent from a Runner too old to sample, and before its first sample.
   * Its history is asked for apart, with a GetRunnerHistory.
   */
  sysinfo: Schema.optionalKey(SysinfoSample),
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
 * An Installation a Session runs with (ADR 0020), with its and its MCP server's names as it
 * started, and the name Claude Code knows its server by, shown as `plugin:kndl:<server>`.
 */
export const SessionInstallation = Schema.Struct({
  id: InstallationId,
  name: Schema.String,
  mcpServerId: McpServerId,
  mcpServerName: Schema.String,
  /** The version of a packaged MCP server it started with, so an Upgrade asks for a Restart. */
  mcpServerVersion: Schema.optionalKey(Schema.String),
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

/**
 * Someone replied in their own words instead of answering, which Claude reads as their response,
 * with the files they attached to it (#278), which Claude opens by their markers. The web sends
 * the files' ids beside it (AnswerQuestion), and the Hub puts the files here. A reply is in their
 * own words: files alone are not one.
 */
export const QuestionReplied = Schema.TaggedStruct("Replied", {
  text: Schema.NonEmptyString,
  attachments: Schema.optionalKey(PromptAttachments),
})
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
 * An answer as a Participant sends it (web AnswerQuestion): a reply's attachments come as ids
 * beside it, and the Hub puts them on the reply it sends the mod (#278).
 */
export const QuestionAnswerFromWeb = Schema.Union([
  QuestionAnswered,
  Schema.TaggedStruct("Replied", { text: Schema.NonEmptyString }),
  QuestionDismissed,
]).pipe(Schema.toTaggedUnion("_tag"))
export type QuestionAnswerFromWeb = typeof QuestionAnswerFromWeb.Type

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
   * Whose setup token its Claude Code runs on, and the only one who drives it: prompts it, answers
   * it, stops it, controls it and uses its terminal (ADR 0026). Other Participants watch.
   */
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
  mcpServers: Schema.optionalKey(Schema.Array(SessionInstallation)),
  /**
   * Present when its Repo's Installations, or their MCP servers, changed since: they apply at its
   * next wake or Restart.
   */
  mcpServersChanged: Schema.optionalKey(Schema.Literal(true)),
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
   * The model it is set to (#128), which names its Harness (`harnessOfModel`, ADR 0030): Claude
   * Code's as `--model` takes it, absent for Claude Code's default; or pi's, `<provider>/<id>`. Its
   * Creator may change it, from the next Turn on. While a switch of Harness waits, it is the new
   * Harness's, and `harness` still the one running.
   */
  model: Schema.optionalKey(ModelName),
  /**
   * What runs its agent now (ADR 0029, 0030); absent for a Session from before, which runs Claude
   * Code.
   */
  harness: Schema.optionalKey(Harness),
  /** Its thinking level (#128): absent for the model's usual level. */
  thinkingLevel: Schema.optionalKey(ThinkingLevel),
  /**
   * Present while its Harness still runs on the model and thinking level from before they were
   * changed: they apply once no Turn runs, when pi switches to them, or Claude Code, or the other
   * Harness, starts again with them.
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
  /** As typed; empty for a prompt of attachments alone. */
  text: Schema.String,
  sender: Participant,
  queuedAt: EpochMillis,
  /** The files it carries (#276), in the order they were added. */
  attachments: Schema.optionalKey(PromptAttachments),
}).check(textOrAttachments)
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
