import { Redacted, Schema } from "effect"
import { GitRequestId } from "./Git.ts"
import {
  EnvironmentVersion,
  RequestId,
  RunnerId,
  SessionId,
  TestBuildId,
  VariablesRequestId,
} from "./Ids.ts"
import { EpochMillis, Participant, RepoName } from "./Session.ts"

// Environments (ADR 0009): each Repo's recipe for its Sandboxes, versioned on the Hub and built
// on each Runner. The web UI edits a draft and applies it; a draft that changes the build needs a
// passing Test build of exactly that draft first. Runners get the recipe with StartSession, and
// fetch variable values from the Hub over their own channel, for the Sessions and Test builds
// they run. Sensitive values never reach the web.
//
// The schemas here accept any string where a rule could refuse it (names, patterns, the image),
// so a bad draft still reaches the Hub and is refused with a reason. `environmentDraftProblems`
// gives the same reasons, for the web UI to show before sending.

// ── The recipe ─────────────────────────────────────────────────────────────

/**
 * A Sensitive value, or any value a Runner fetches: a plain string on the wire, hidden from
 * logging and inspection once decoded.
 */
export const SecretValue = Schema.RedactedFromValue(Schema.String)
export type SecretValue = typeof SecretValue.Type

/**
 * A dependency folder (ADR 0006): folders matching `pattern`, a glob relative to the Workspace
 * such as `**\/node_modules`, are kept on a disk of their own. With `nextTo`, the folder is also
 * created next to every file of that name matching the pattern's parent, such as next to each
 * `package.json`, so the first install on a fresh clone already lands on that disk.
 */
export const DependencyFolder = Schema.Struct({
  pattern: Schema.String,
  nextTo: Schema.optionalKey(Schema.String),
})
export type DependencyFolder = typeof DependencyFolder.Type

/** What each Sandbox gets, capped by the Runner's own limits. */
export const EnvironmentResources = Schema.Struct({
  cpus: Schema.Int,
  memoryMib: Schema.Int,
})
export type EnvironmentResources = typeof EnvironmentResources.Type

/** What builds a Repo's Sandboxes, beside its variables. */
const recipeFields = {
  /** Any OCI image reference. */
  image: Schema.String,
  /** Runs once per build version on each Runner, without the Workspace; the disk is then snapshotted. */
  bootstrapScript: Schema.String,
  /** Runs in each new Sandbox, with the Workspace. Absent for none. */
  startScript: Schema.optionalKey(Schema.String),
  /** Docker in every Sandbox, with its data on a disk of its own. */
  docker: Schema.Boolean,
  dependencyFolders: Schema.Array(DependencyFolder),
  resources: EnvironmentResources,
}

// ── Variables, as the web UI edits them ────────────────────────────────────

/** A variable whose value anyone signed in can read. It always reaches the bootstrap. */
export const PlainVariableInput = Schema.TaggedStruct("Plain", {
  name: Schema.String,
  value: Schema.String,
})
export type PlainVariableInput = typeof PlainVariableInput.Type

/**
 * A variable whose value is encrypted on the Hub and never shown again. Leave `value` out to
 * keep the one saved under this name.
 */
export const SensitiveVariableInput = Schema.TaggedStruct("Sensitive", {
  name: Schema.String,
  value: Schema.optionalKey(SecretValue),
  /** Whether the bootstrap gets it. */
  availableAtBuild: Schema.Boolean,
})
export type SensitiveVariableInput = typeof SensitiveVariableInput.Type

/** A shared variable, put into this Environment under `name`. */
export const VariableLink = Schema.TaggedStruct("Link", {
  name: Schema.String,
  /** The shared variable's own name. */
  sharedVariable: Schema.String,
  /** Whether the bootstrap gets it. */
  availableAtBuild: Schema.Boolean,
})
export type VariableLink = typeof VariableLink.Type

export const EnvironmentVariableInput = Schema.Union([
  PlainVariableInput,
  SensitiveVariableInput,
  VariableLink,
]).pipe(Schema.toTaggedUnion("_tag"))
export type EnvironmentVariableInput = typeof EnvironmentVariableInput.Type

/** An Environment as the web UI edits it, sent whole to test or apply. */
export const EnvironmentDraft = Schema.Struct({
  ...recipeFields,
  variables: Schema.Array(EnvironmentVariableInput),
})
export type EnvironmentDraft = typeof EnvironmentDraft.Type

// ── The Environment, as the web UI sees it ─────────────────────────────────

/** A saved Sensitive variable: its value is never sent. */
export const SensitiveVariable = Schema.TaggedStruct("Sensitive", {
  name: Schema.String,
  availableAtBuild: Schema.Boolean,
  /**
   * Whether it has no value: `secrets-reset` cleared the one a lost HUB_SECRETS_KEY encrypted.
   * The Repo's Sessions don't start until a new value is applied.
   */
  needsValue: Schema.Boolean,
})
export type SensitiveVariable = typeof SensitiveVariable.Type

export const EnvironmentVariable = Schema.Union([
  PlainVariableInput,
  SensitiveVariable,
  VariableLink,
]).pipe(Schema.toTaggedUnion("_tag"))
export type EnvironmentVariable = typeof EnvironmentVariable.Type

/** A Repo's Environment as last applied. */
export const Environment = Schema.Struct({
  repo: RepoName,
  version: EnvironmentVersion,
  ...recipeFields,
  variables: Schema.Array(EnvironmentVariable),
})
export type Environment = typeof Environment.Type

/** One applied version: who applied it and when. Versions record no values. */
export const EnvironmentVersionInfo = Schema.Struct({
  version: EnvironmentVersion,
  appliedBy: Participant,
  appliedAt: EpochMillis,
  /** Whether it changed the build, so Runners build it anew. */
  rebuilt: Schema.Boolean,
})
export type EnvironmentVersionInfo = typeof EnvironmentVersionInfo.Type

// ── Shared variables ───────────────────────────────────────────────────────

/** Where a shared variable is linked. */
export const SharedVariableUse = Schema.Struct({
  repo: RepoName,
  /** The name it has in that Environment. */
  name: Schema.String,
  availableAtBuild: Schema.Boolean,
})
export type SharedVariableUse = typeof SharedVariableUse.Type

/** A Hub-wide variable as the web UI sees it: a Sensitive one without its value. */
export const SharedVariable = Schema.Union([
  Schema.TaggedStruct("Plain", {
    name: Schema.String,
    value: Schema.String,
    linkedBy: Schema.Array(SharedVariableUse),
  }),
  Schema.TaggedStruct("Sensitive", {
    name: Schema.String,
    linkedBy: Schema.Array(SharedVariableUse),
    /**
     * Whether it has no value, as {@link SensitiveVariable}'s `needsValue`: the Sessions of every
     * Repo linking it don't start until it gets one.
     */
    needsValue: Schema.Boolean,
  }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type SharedVariable = typeof SharedVariable.Type

/**
 * A shared variable to save. A Sensitive one without `value` keeps its saved value. Whether the
 * bootstrap gets it is up to each Link.
 */
export const SharedVariableInput = Schema.Union([
  PlainVariableInput,
  Schema.TaggedStruct("Sensitive", {
    name: Schema.String,
    value: Schema.optionalKey(SecretValue),
  }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type SharedVariableInput = typeof SharedVariableInput.Type

// ── Test builds ────────────────────────────────────────────────────────────

/** A Test build, as the web UI follows it. */
export const TestBuild = Schema.Struct({
  id: TestBuildId,
  repo: RepoName,
  runnerId: RunnerId,
  startedBy: Participant,
  startedAt: EpochMillis,
})
export type TestBuild = typeof TestBuild.Type

export const TestBuildResult = Schema.Literals(["Passed", "Failed"])
export type TestBuildResult = typeof TestBuildResult.Type

// ── web to Hub ─────────────────────────────────────────────────────────────

/** Ask for a Repo's Environment and its version history. Answered with {@link EnvironmentState}. */
export const GetEnvironment = Schema.TaggedStruct("GetEnvironment", {
  requestId: RequestId,
  repo: RepoName,
})
export type GetEnvironment = typeof GetEnvironment.Type

/**
 * Ask whether applying a draft needs a Test build first, and whether one of exactly this draft
 * has passed. Answered with {@link EnvironmentDraftChecked}, or a CommandFailed for a draft the
 * Hub would refuse.
 */
export const CheckEnvironmentDraft = Schema.TaggedStruct("CheckEnvironmentDraft", {
  requestId: RequestId,
  repo: RepoName,
  draft: EnvironmentDraft,
})
export type CheckEnvironmentDraft = typeof CheckEnvironmentDraft.Type

/**
 * Build a draft on a Runner: the bootstrap, then the start script against a fresh clone of the
 * default branch. Answered with {@link TestBuildStarted}, then its log and {@link TestBuildEnded}.
 */
export const StartTestBuild = Schema.TaggedStruct("StartTestBuild", {
  requestId: RequestId,
  repo: RepoName,
  runnerId: RunnerId,
  draft: EnvironmentDraft,
})
export type StartTestBuild = typeof StartTestBuild.Type

/**
 * Apply a draft as the Repo's next Environment version. `baseVersion` is the version the draft
 * was made from (null for a Repo without one): a draft made from an older one is refused. A draft
 * that changes the build is refused unless a Test build of exactly it has passed. Answered with
 * {@link EnvironmentState}.
 */
export const ApplyEnvironment = Schema.TaggedStruct("ApplyEnvironment", {
  requestId: RequestId,
  repo: RepoName,
  baseVersion: Schema.NullOr(EnvironmentVersion),
  draft: EnvironmentDraft,
})
export type ApplyEnvironment = typeof ApplyEnvironment.Type

/** Ask for every shared variable. Answered with {@link SharedVariables}. */
export const GetSharedVariables = Schema.TaggedStruct("GetSharedVariables", {
  requestId: RequestId,
})
export type GetSharedVariables = typeof GetSharedVariables.Type

/** Create or change a shared variable. Answered with {@link SharedVariables}. */
export const SetSharedVariable = Schema.TaggedStruct("SetSharedVariable", {
  requestId: RequestId,
  variable: SharedVariableInput,
})
export type SetSharedVariable = typeof SetSharedVariable.Type

/** Delete a shared variable no Environment links. Answered with {@link SharedVariables}. */
export const DeleteSharedVariable = Schema.TaggedStruct("DeleteSharedVariable", {
  requestId: RequestId,
  name: Schema.String,
})
export type DeleteSharedVariable = typeof DeleteSharedVariable.Type

// ── Hub to web ─────────────────────────────────────────────────────────────

/**
 * A Repo's Environment, or null before its first, and its versions, newest first. Answers
 * {@link GetEnvironment} and {@link ApplyEnvironment} with their `requestId`; sent to every
 * other client without one when a version is applied.
 */
export const EnvironmentState = Schema.TaggedStruct("EnvironmentState", {
  requestId: Schema.optionalKey(RequestId),
  repo: RepoName,
  environment: Schema.NullOr(Environment),
  versions: Schema.Array(EnvironmentVersionInfo),
})
export type EnvironmentState = typeof EnvironmentState.Type

/** Answers {@link CheckEnvironmentDraft}. */
export const EnvironmentDraftChecked = Schema.TaggedStruct("EnvironmentDraftChecked", {
  requestId: RequestId,
  repo: RepoName,
  /** Whether the draft changes the build, so applying it needs a passing Test build. */
  needsTestBuild: Schema.Boolean,
  /** Whether a Test build of exactly this draft has passed. */
  testBuildPassed: Schema.Boolean,
})
export type EnvironmentDraftChecked = typeof EnvironmentDraftChecked.Type

/** Answers {@link StartTestBuild}: the Runner has been asked to build the draft. */
export const TestBuildStarted = Schema.TaggedStruct("TestBuildStarted", {
  requestId: RequestId,
  testBuild: TestBuild,
})
export type TestBuildStarted = typeof TestBuildStarted.Type

/** Output of a Test build, in order, to the person who started it. */
export const TestBuildLogged = Schema.TaggedStruct("TestBuildLogged", {
  testBuildId: TestBuildId,
  data: Schema.String,
})
export type TestBuildLogged = typeof TestBuildLogged.Type

/** A Test build is over. A failed one says why, such as its Runner going offline. */
export const TestBuildEnded = Schema.TaggedStruct("TestBuildEnded", {
  testBuildId: TestBuildId,
  repo: RepoName,
  result: TestBuildResult,
  message: Schema.optionalKey(Schema.String),
})
export type TestBuildEnded = typeof TestBuildEnded.Type

/**
 * Every shared variable, by name. Answers {@link GetSharedVariables}, {@link SetSharedVariable}
 * and {@link DeleteSharedVariable} with their `requestId`; sent to every other client without
 * one when they change.
 */
export const SharedVariables = Schema.TaggedStruct("SharedVariables", {
  requestId: Schema.optionalKey(RequestId),
  variables: Schema.Array(SharedVariable),
})
export type SharedVariables = typeof SharedVariables.Type

// ── Hub to Runner ──────────────────────────────────────────────────────────

/** A variable the Runner passes to processes it starts in the Sandbox, by name; no value. */
export const VariableSlot = Schema.Struct({
  name: Schema.String,
  /** Whether the bootstrap gets it. Plain variables always do. */
  availableAtBuild: Schema.Boolean,
})
export type VariableSlot = typeof VariableSlot.Type

/** What a Runner builds a Sandbox from. Values are fetched with {@link FetchVariables}. */
export const EnvironmentRecipe = Schema.Struct({
  ...recipeFields,
  variables: Schema.Array(VariableSlot),
})
export type EnvironmentRecipe = typeof EnvironmentRecipe.Type

/**
 * A Session's Environment, as StartSession gives it. Runners key their builds by `buildVersion`,
 * the version that last changed the build: a version that changed no build input keeps the
 * build of the one before.
 */
export const SessionEnvironment = Schema.Struct({
  version: EnvironmentVersion,
  buildVersion: EnvironmentVersion,
  recipe: EnvironmentRecipe,
})
export type SessionEnvironment = typeof SessionEnvironment.Type

/**
 * Build a draft and report its log and result: the bootstrap, then the start script against a
 * fresh clone of the Repo's default branch.
 */
export const RunTestBuild = Schema.TaggedStruct("RunTestBuild", {
  testBuildId: TestBuildId,
  repo: RepoName,
  recipe: EnvironmentRecipe,
})
export type RunTestBuild = typeof RunTestBuild.Type

/** A variable's value, for the Runner's memory only. */
export const VariableValue = Schema.Struct({
  name: Schema.String,
  value: SecretValue,
  availableAtBuild: Schema.Boolean,
})
export type VariableValue = typeof VariableValue.Type

/** Answers {@link FetchVariables}: every variable of the Session's Environment or the draft. */
export const VariablesFetched = Schema.TaggedStruct("VariablesFetched", {
  requestId: VariablesRequestId,
  variables: Schema.Array(VariableValue),
})
export type VariablesFetched = typeof VariablesFetched.Type

/** Answers {@link FetchVariables} the Hub refused, such as for a Session not the Runner's. */
export const VariablesRefused = Schema.TaggedStruct("VariablesRefused", {
  requestId: VariablesRequestId,
  message: Schema.String,
})
export type VariablesRefused = typeof VariablesRefused.Type

// ── Runner to Hub ──────────────────────────────────────────────────────────

/** What a Runner wants variable values for: a Session or a Test build it is running. */
export const VariablesFor = Schema.Union([
  Schema.TaggedStruct("Session", { sessionId: SessionId }),
  Schema.TaggedStruct("TestBuild", { testBuildId: TestBuildId }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type VariablesFor = typeof VariablesFor.Type

/**
 * Ask for the variable values of a Session or Test build this Runner runs, to keep in memory
 * only. Answered with {@link VariablesFetched} or {@link VariablesRefused}.
 */
export const FetchVariables = Schema.TaggedStruct("FetchVariables", {
  requestId: VariablesRequestId,
  for: VariablesFor,
})
export type FetchVariables = typeof FetchVariables.Type

/**
 * Ask how to clone a Test build this Runner runs (#104), just before cloning. Answered with a
 * GitReply of the same `requestId`, whose answer is a CloneAccess or a GitFailed saying why, such
 * as the GitHub App not being installed on the Repo.
 */
export const FetchCloneAccess = Schema.TaggedStruct("FetchCloneAccess", {
  requestId: GitRequestId,
  testBuildId: TestBuildId,
})
export type FetchCloneAccess = typeof FetchCloneAccess.Type

/** Output of a Test build, in order. */
export const TestBuildLog = Schema.TaggedStruct("TestBuildLog", {
  testBuildId: TestBuildId,
  data: Schema.String,
})
export type TestBuildLog = typeof TestBuildLog.Type

/** A Test build is over. */
export const TestBuildFinished = Schema.TaggedStruct("TestBuildFinished", {
  testBuildId: TestBuildId,
  result: TestBuildResult,
  message: Schema.optionalKey(Schema.String),
})
export type TestBuildFinished = typeof TestBuildFinished.Type

// ── Defaults and rules ─────────────────────────────────────────────────────

/**
 * The recipe a new Environment starts from: Debian with the usual build tools (curl, wget, git,
 * ssh, gcc, make and common `-dev` libraries), nothing else installed, no variables.
 */
export const DefaultEnvironmentDraft: EnvironmentDraft = {
  image: "buildpack-deps:bookworm",
  bootstrapScript: "",
  docker: false,
  dependencyFolders: [
    { pattern: "**/node_modules", nextTo: "package.json" },
    { pattern: "**/.venv", nextTo: "pyproject.toml" },
    { pattern: "**/target", nextTo: "Cargo.toml" },
  ],
  resources: { cpus: 2, memoryMib: 4096 },
  variables: [],
}

/** Names the Runner sets itself, which no variable may take. */
export const ReservedVariablePrefix = "KNDL_"

export const ResourceLimits = {
  cpus: { min: 1, max: 64 },
  memoryMib: { min: 256, max: 262_144 },
} as const

/** The longest a script may be, in characters. */
export const MaxScriptLength = 65_536

/** The longest a variable's value may be, in characters. */
export const MaxVariableValueLength = 65_536

/**
 * The shortest a Sensitive value may be, in characters, leading and trailing whitespace aside.
 * The Hub masks every occurrence of a Sensitive value in what it stores or shows (issue #48), and
 * masking every occurrence of a shorter text would garble output while hiding a value that is
 * guessable anyway.
 */
export const MinSensitiveValueLength = 4

/** Why a variable name can't be used, or undefined when it can. */
export function variableNameProblem(name: string): string | undefined {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return `"${name}" is not a variable name: use letters, digits and underscores, not starting with a digit.`
  }
  if (name.length > 128) return `The variable name ${name.slice(0, 32)}... is over 128 characters.`
  if (name.toUpperCase().startsWith(ReservedVariablePrefix)) {
    return `${name} is reserved: the Runner sets the ${ReservedVariablePrefix}* variables itself.`
  }
  return undefined
}

/** Why a value can't be saved as Sensitive under `name`, or undefined when it can. */
export function sensitiveValueProblem(name: string, value: string): string | undefined {
  if (value.length > MaxVariableValueLength) {
    return `The value of ${name} is over ${MaxVariableValueLength} characters.`
  }
  if (value.trim().length < MinSensitiveValueLength) {
    return `The value of ${name} is under ${MinSensitiveValueLength} characters: too short to redact from output. Make it Plain, or use a longer value.`
  }
  return undefined
}

/** A variable of an Environment that needs a value: its own, or the shared variable it links. */
export interface ValueNeeded {
  readonly name: string
  readonly availableAtBuild: boolean
  /** The shared variable it links, which needs the value; none for its own. */
  readonly sharedVariable?: string
}

/**
 * Names the variables that need a value (#57), as the Hub's refusals and a failed Session start say
 * it, and the Environment screen with them.
 */
export function valuesNeededText(needed: ReadonlyArray<ValueNeeded>): string {
  const names = needed.map((variable) =>
    variable.sharedVariable === undefined
      ? variable.name
      : variable.sharedVariable === variable.name
        ? `${variable.name} (shared)`
        : `${variable.name} (the shared variable ${variable.sharedVariable})`,
  )
  const listed =
    names.length <= 1
      ? (names[0] ?? "")
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
  return `${listed} ${names.length === 1 ? "needs a value" : "need values"}`
}

/** Why the Repo's Sessions don't start while variables need a value, and where to enter them. */
export function cantStartText(repo: string, needed: ReadonlyArray<ValueNeeded>): string {
  const screens = [
    ...(needed.some((variable) => variable.sharedVariable === undefined)
      ? ["the Repo's Environment screen"]
      : []),
    ...(needed.some((variable) => variable.sharedVariable !== undefined)
      ? ["the Shared variables screen"]
      : []),
  ]
  const which = needed.length === 1 ? "it" : "them"
  return `${repo}'s Sessions can't start: ${valuesNeededText(needed)}. Enter ${which} on ${screens.join(" and ")}.`
}

/** Why a dependency folder can't be used, or undefined when it can. */
export function dependencyFolderProblem(folder: DependencyFolder): string | undefined {
  const { pattern, nextTo } = folder
  const segments = pattern.split("/")
  if (
    pattern.length === 0 ||
    pattern.length > 256 ||
    pattern.startsWith("/") ||
    /[\\\0\s]/.test(pattern) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return `"${pattern}" is not a dependency-folder pattern: give a path relative to the Workspace, such as **/node_modules, with no "..".`
  }
  const last = segments.at(-1) ?? ""
  if (last.includes("*") || last.includes("?") || last.includes("[")) {
    return `The dependency-folder pattern ${pattern} must end in a folder name, such as node_modules.`
  }
  if (
    nextTo !== undefined &&
    (!/^[A-Za-z0-9._-]+$/.test(nextTo) || nextTo === "." || nextTo === ".." || nextTo.length > 128)
  ) {
    return `"${nextTo}" is not a file name for the pattern ${pattern} to sit next to, such as package.json.`
  }
  return undefined
}

/**
 * Why the Hub would refuse a draft for what it says alone, such as a bad name or two variables
 * of one name; empty when it wouldn't. The Hub also checks what the draft refers to, such as the
 * shared variables it links.
 */
export function environmentDraftProblems(draft: EnvironmentDraft): ReadonlyArray<string> {
  const problems: Array<string> = []
  const { image } = draft
  if (image.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/.test(image)) {
    problems.push(`"${draft.image}" is not an image reference, such as buildpack-deps:bookworm.`)
  }
  if (draft.bootstrapScript.length > MaxScriptLength) {
    problems.push(`The bootstrap script is over ${MaxScriptLength} characters.`)
  }
  if ((draft.startScript?.length ?? 0) > MaxScriptLength) {
    problems.push(`The start script is over ${MaxScriptLength} characters.`)
  }
  const { cpus, memoryMib } = draft.resources
  if (cpus < ResourceLimits.cpus.min || cpus > ResourceLimits.cpus.max) {
    problems.push(
      `CPUs must be from ${ResourceLimits.cpus.min} to ${ResourceLimits.cpus.max}, not ${cpus}.`,
    )
  }
  if (memoryMib < ResourceLimits.memoryMib.min || memoryMib > ResourceLimits.memoryMib.max) {
    problems.push(
      `Memory must be from ${ResourceLimits.memoryMib.min} to ${ResourceLimits.memoryMib.max} MiB, not ${memoryMib}.`,
    )
  }
  const patterns = new Set<string>()
  for (const folder of draft.dependencyFolders) {
    const problem = dependencyFolderProblem(folder)
    if (problem !== undefined) problems.push(problem)
    else if (patterns.has(folder.pattern)) {
      problems.push(`The dependency-folder pattern ${folder.pattern} is there twice.`)
    }
    patterns.add(folder.pattern)
  }
  const names = new Set<string>()
  for (const variable of draft.variables) {
    const problem = variableNameProblem(variable.name)
    if (problem !== undefined) problems.push(problem)
    else if (names.has(variable.name)) {
      problems.push(`${variable.name} is there twice: each variable and link needs its own name.`)
    }
    names.add(variable.name)
    if (variable._tag === "Plain" && variable.value.length > MaxVariableValueLength) {
      problems.push(`The value of ${variable.name} is over ${MaxVariableValueLength} characters.`)
    }
    if (variable._tag === "Sensitive" && variable.value !== undefined) {
      const valueProblem = sensitiveValueProblem(variable.name, Redacted.value(variable.value))
      if (valueProblem !== undefined) problems.push(valueProblem)
    }
  }
  return problems
}
