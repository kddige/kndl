// Sessions' Sandboxes on a SandboxBackend (#9): each Session's Sandbox is created or started
// around its Workspace before Claude Code launches in it (ADR 0013), and stopped or destroyed when
// the Session stops. Every Sandbox mounts the Claude Code builds and the Session's copy of the mod
// (SessionMod.ts) read-only, and keeps Claude Code's state on a volume of its own; each start makes
// sure it has tmux and seeds that state (ClaudeState.ts). A Sandbox made before Claude Code ran in
// Sandboxes, or before each Session had its own copy of the mod (#159), lacks those mounts, and is
// made anew on its volumes at its next start.
//
// A Session of a Repo with an Environment (ADR 0009) boots from that Environment's build, built
// on this Runner the first time a Session needs it, with the build's output shown in the Session.
// Each new Sandbox then gets its dependency folders bound and runs the start script; each later
// boot binds the folders again. A Sandbox of an older version is recreated at its next start,
// keeping its volumes. The Environment's variables are fetched from the Hub, kept in memory, and
// passed to each process the Runner starts in the Sandbox, Claude Code included, never set on the
// VM, over the login environment its build kept, which each new Sandbox probes again after its
// start script (#67).
//
// Once a Session's Sandbox runs, it is kept with a GitHub token for git and gh, and git there
// commits as the Session's Creator (SandboxGitHub.ts).
//
// The Session's directory holds `sandbox.json`, what its Sandbox was last built from, without
// any value: the Environment version, the build it booted from and its libc, and the recipe.

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { availableParallelism, tmpdir, totalmem } from "node:os"
import { join } from "node:path"
import type {
  GitAnswer,
  RepoName,
  RunTestBuild,
  SandboxState,
  SessionEnvironment,
  SessionId,
  TestBuildId,
  VariableValue,
} from "@claude-hub/protocol"
import { EnvironmentRecipe, EnvironmentVersion, RunnerToHub } from "@claude-hub/protocol"
import { HomeConfig } from "@claude-hub/protocol/home"
import { Config, Effect, Exit, Layer, Option, Schema, Scope, Semaphore } from "effect"
import type { Cause } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { ClaudeProjectsDir } from "./ClaudeConfig.ts"
import {
  buildGroup,
  buildInSandbox,
  buildName,
  capResources,
  parseBuildName,
  probeLoginEnv,
  readLoginEnv,
  runScript,
  testBuildGroup,
  claudeNeedsScript,
  variableNames,
} from "./EnvironmentBuilds.ts"
import type { BuildLog, ResourceLimits } from "./EnvironmentBuilds.ts"
import { cloneDefaultBranch, type GitAuth } from "./HostGit.ts"
import { HubGit } from "./HubGit.ts"
import { HubLink } from "./HubLink.ts"
import { HubVariables, variablesEnv } from "./HubVariables.ts"
import { RunnerConfig } from "./RunnerConfig.ts"
import { SandboxError, Sandboxes } from "./Sandbox.ts"
import type { SandboxClaude, SandboxTarget } from "./Sandbox.ts"
import { claudeStateEnv, ensureTranscript, seedClaudeState } from "./sandbox/ClaudeState.ts"
import {
  bindDependencyFoldersScript,
  dependencyDiskGuestPath,
  dependencyDiskKey,
  matchDependencyFolders,
} from "./sandbox/DependencyFolders.ts"
import { buildSandboxId, isBuildSandboxId, testBuildSandboxId } from "./sandbox/Naming.ts"
import { reconcileSandboxes } from "./sandbox/Reconcile.ts"
import type { HostMount, SandboxSnapshots, SandboxSpec } from "./sandbox/SandboxBackend.ts"
import { SandboxBackend } from "./sandbox/SandboxBackend.ts"
import {
  ensureSandboxClaude,
  PinnedClaudeVersion,
  sandboxClaudeGuestDir,
  sandboxClaudePath,
} from "./sandbox/SandboxClaude.ts"
import type { Libc, SandboxClaudeError } from "./sandbox/SandboxClaude.ts"
import {
  cacheEnv,
  claudeStateGuestPath,
  claudeStateVolumeKey,
  defaults,
  modGuestPath,
  sessionSandboxSpec,
  workspaceGuestPath,
} from "./sandbox/SessionLayout.ts"
import type { SessionLayoutOptions } from "./sandbox/SessionLayout.ts"
import { keepSandboxToken, setSandboxIdentity } from "./SandboxGitHub.ts"
import type { SandboxTokenSource } from "./SandboxGitHub.ts"
import type { SessionDirectories } from "./SessionNames.ts"
import { InitialTerminalSize } from "./Sessions.ts"

export interface SessionSandboxesOptions {
  /** The OCI image Sandboxes boot when their Repo has no Environment. */
  readonly image: string
  /** The host directory of Linux Claude Code builds, mounted read-only into every Sandbox. */
  readonly claudeCacheDir: string
  /**
   * Finds, and downloads if needed, the Claude Code build for `libc` that Sessions run, and
   * returns its version. Run on the first Session start needing that libc until it succeeds.
   */
  readonly sandboxClaude: (libc: Libc) => Effect.Effect<string, SandboxClaudeError>
  /** Size overrides for the Session layout. */
  readonly layout?: Partial<
    Omit<SessionLayoutOptions, "sessionId" | "image" | "workspaceHostPath" | "env">
  >
  /** Fresh GitHub tokens for Sessions' Sandboxes. Without it, Sandboxes get none. */
  readonly githubToken?: SandboxTokenSource
  /** The most CPUs and memory an Environment's Sandbox gets, whatever it asks for. */
  readonly limits: ResourceLimits
  /** How many builds of each Repo's Environment this Runner keeps. At least 1. */
  readonly keepBuilds: number
  /** Clones the tip of the Repo's default branch into a new directory, for a Test build. */
  readonly cloneDefaultBranch: (
    repo: RepoName,
    directory: string,
    testBuildId: TestBuildId,
  ) => Effect.Effect<void, { readonly message: string }>
  /** Where Test builds' clones go while they run. Defaults to the system's temporary directory. */
  readonly scratchDir?: string
}

/** The most a Sandbox may write to a read-only mount: nothing, but it needs a quota. */
const readOnlyQuotaMib = 1

/** The host's time zone, such as `Europe/Copenhagen`, when it has one. */
const hostTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone

/**
 * Claude Code's home in every Sandbox, a UTF-8 locale for its terminal, and the host's time zone,
 * so the times it shows are those of the people watching (#157).
 */
const claudeBaseEnv: Readonly<Record<string, string>> = {
  HOME: "/root",
  LANG: "C.UTF-8",
  ...(hostTimeZone === undefined || hostTimeZone === "" ? {} : { TZ: hostTimeZone }),
}

/** Claude Code's environment in a Sandbox on the Runner's default image. */
const plainClaudeEnv = { ...claudeBaseEnv, ...cacheEnv, ...claudeStateEnv }

/**
 * Tells a Sandbox made before Claude Code ran in Sandboxes (ADR 0013), or before each Session had
 * its own copy of the mod (#159): it lacks these mounts.
 */
const claudeMountsScript = `test -d ${modGuestPath} && test -d ${claudeStateGuestPath}`

/** What a Session's Sandbox was last started from, kept in its directory. Holds no values. */
const SandboxRecord = Schema.Struct({
  repo: Schema.String,
  version: EnvironmentVersion,
  buildVersion: EnvironmentVersion,
  libc: Schema.Literals(["musl", "glibc"]),
  recipe: EnvironmentRecipe,
})
type SandboxRecord = typeof SandboxRecord.Type

const recordPath = (directories: SessionDirectories) => join(directories.session, "sandbox.json")

const readRecord = (directories: SessionDirectories) =>
  Effect.promise(() =>
    readFile(recordPath(directories), "utf8").then(
      (text) => {
        try {
          return Option.getOrUndefined(Schema.decodeUnknownOption(SandboxRecord)(JSON.parse(text)))
        } catch {
          return undefined
        }
      },
      () => undefined,
    ),
  )

const writeRecord = (directories: SessionDirectories, record: SandboxRecord) =>
  Effect.promise(() => writeFile(recordPath(directories), `${JSON.stringify(record, null, 2)}\n`))

const removeRecord = (directories: SessionDirectories) =>
  Effect.promise(() => rm(recordPath(directories), { force: true }))

const errorMessage = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error && error.message !== ""
    ? String(error.message)
    : typeof error === "object" && error !== null && "_tag" in error
      ? String(error._tag)
      : String(error)

const failureMessage = (cause: Cause.Cause<unknown>) =>
  errorMessage(Option.getOrElse(Exit.findErrorOption(Exit.failCause(cause)), () => cause))

/**
 * The Session's copy of the mod, whose plugins Claude Code loads with `--plugin-dir` (ADR 0013,
 * ADR 0014), made each time Claude Code starts (SessionMod.ts).
 */
const modMount = (directories: SessionDirectories): HostMount => ({
  _tag: "Host",
  hostPath: directories.mod,
  guestPath: modGuestPath,
  quotaMib: readOnlyQuotaMib,
  readOnly: true,
})

/** Makes the directory of the Session's copy of the mod, as a Sandbox can't mount a missing one. */
const modMountReady = (directories: SessionDirectories) =>
  Effect.tryPromise({
    try: () => mkdir(directories.mod, { recursive: true }),
    catch: (error) =>
      new SandboxError({ message: `could not create ${directories.mod}: ${errorMessage(error)}` }),
  })

/** The values the bootstrap gets: only those available at build. */
const buildEnv = (values: ReadonlyArray<VariableValue>) =>
  variablesEnv(values, (value) => value.availableAtBuild)

/**
 * The environment of each process the Runner starts in an Environment's Sandbox: its login
 * environment (EnvironmentBuilds.ts) over the cache settings, and the variables over both.
 */
const processEnv = (
  login: Readonly<Record<string, string>>,
  values: ReadonlyArray<VariableValue>,
) => ({
  ...cacheEnv,
  ...login,
  ...variablesEnv(values),
})

/**
 * The Sandbox of an Environment's Session or Test build: the usual layout on the Environment's
 * resources, with one disk for every dependency folder instead of one per folder, Docker if
 * toggled, and no environment of its own.
 */
const environmentSpec = (options: {
  readonly sessionId: SessionId
  readonly recipe: SessionEnvironment["recipe"]
  readonly workspaceHostPath: string
  readonly resources: { readonly cpus: number; readonly memoryMib: number }
  readonly layout: SessionSandboxesOptions["layout"]
  readonly mounts?: ReadonlyArray<HostMount>
}): SandboxSpec => {
  const spec = sessionSandboxSpec({
    ...options.layout,
    sessionId: options.sessionId,
    image: options.recipe.image,
    workspaceHostPath: options.workspaceHostPath,
    cpus: options.resources.cpus,
    memoryMib: options.resources.memoryMib,
    dependencyDirs: [],
    ...(options.recipe.docker ? {} : { dockerSizeMib: false }),
  })
  return {
    ...spec,
    mounts: [
      ...spec.mounts,
      {
        _tag: "Volume",
        key: dependencyDiskKey,
        guestPath: dependencyDiskGuestPath,
        sizeMib: options.layout?.dependencySizeMib ?? defaults.dependencySizeMib,
      },
      ...(options.mounts ?? []),
    ],
    env: {},
  }
}

export const makeSessionSandboxes = (options: SessionSandboxesOptions) =>
  Effect.gen(function* () {
    const backend = yield* SandboxBackend
    const hub = yield* HubLink
    const hubVariables = yield* HubVariables
    const projectsDir = yield* ClaudeProjectsDir
    const layerScope = yield* Effect.scope

    /** What keeps each running Session's Sandbox with a GitHub token, closed when it stops. */
    const tokenKeepers = new Map<SessionId, Scope.Closeable>()
    /** Each running Environment Session's variable values: in memory only. */
    const variables = new Map<SessionId, ReadonlyArray<VariableValue>>()
    /** Builds of one Repo happen one at a time. */
    const buildLocks = new Map<string, Semaphore.Semaphore>()

    // The Claude Code version for each libc, once found; a failure is tried again on the next start.
    const claudeLock = yield* Semaphore.make(1)
    const claudeVersions = new Map<Libc, string>()
    const sandboxClaude = (libc: Libc) =>
      claudeLock.withPermit(
        Effect.suspend(() => {
          const known = claudeVersions.get(libc)
          return known !== undefined
            ? Effect.succeed(known)
            : Effect.tap(options.sandboxClaude(libc), (version) =>
                Effect.sync(() => claudeVersions.set(libc, version)),
              )
        }),
      )

    const snapshotsOrFail: Effect.Effect<SandboxSnapshots, SandboxError> = Option.match(
      backend.snapshots,
      {
        onNone: () =>
          Effect.fail(
            new SandboxError({ message: "this Runner's Sandboxes can't run Environments" }),
          ),
        onSome: Effect.succeed,
      },
    )

    const report = (sessionId: SessionId, state: SandboxState, message?: string) =>
      hub.send(
        RunnerToHub.cases.SandboxStateReport.make({
          sessionId,
          state,
          ...(message === undefined ? {} : { message }),
        }),
      )

    const note = (sessionId: SessionId, message: string) =>
      hub.send(RunnerToHub.cases.SandboxNote.make({ sessionId, message }))

    /** Output shown in the Session's terminal before Claude Code starts there. */
    const sessionLog =
      (sessionId: SessionId): BuildLog =>
      (text) =>
        hub.send(
          RunnerToHub.cases.TerminalFrame.make({
            sessionId,
            kind: "Output",
            data: text.replace(/\r?\n/g, "\r\n"),
            size: InitialTerminalSize,
          }),
        )

    /** The Session's variable values: from memory, or fetched from the Hub and kept. */
    const sessionVariables = (sessionId: SessionId) =>
      Effect.suspend(() => {
        const known = variables.get(sessionId)
        if (known !== undefined) return Effect.succeed(known)
        return hubVariables
          .fetch({ _tag: "Session", sessionId })
          .pipe(Effect.tap((values) => Effect.sync(() => variables.set(sessionId, values))))
      })

    const closeTokenKeeper = (sessionId: SessionId) =>
      Effect.suspend(() => {
        const scope = tokenKeepers.get(sessionId)
        tokenKeepers.delete(sessionId)
        return scope === undefined ? Effect.void : Scope.close(scope, Exit.void)
      })

    /** Closes what runs beside the Session's Sandbox: its token keeper. */
    const release = closeTokenKeeper

    /** Gets the running Sandbox a GitHub token, in the background, and keeps it fresh. */
    const keepToken = (sessionId: SessionId) =>
      Effect.gen(function* () {
        const source = options.githubToken
        if (source === undefined || tokenKeepers.has(sessionId)) return
        const scope = yield* Scope.fork(layerScope)
        yield* keepSandboxToken({ backend, sessionId, source }).pipe(Scope.provide(scope))
        tokenKeepers.set(sessionId, scope)
      })

    /**
     * Readies a new Sandbox once its folders are bound: runs the start script, if the recipe has
     * one, in the Workspace with the build's login environment and the variables, then probes the
     * login environment again there, so Claude Code also gets what the start script set up.
     */
    const runStart = (
      sessionId: SessionId,
      recipe: SessionEnvironment["recipe"],
      values: ReadonlyArray<VariableValue>,
      log: BuildLog,
    ) =>
      Effect.gen(function* () {
        const exclude = variableNames(recipe)
        if (recipe.startScript !== undefined && recipe.startScript.trim() !== "") {
          // A build made before builds kept a login environment is probed now.
          const login = yield* readLoginEnv(backend, sessionId).pipe(
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () => probeLoginEnv(backend, sessionId, { cwd: "/root", exclude }),
              }),
            ),
          )
          yield* log("Running the start script...\n")
          yield* runScript(
            backend,
            sessionId,
            {
              label: "The start script",
              name: "start",
              script: recipe.startScript,
              env: processEnv(login, values),
              cwd: workspaceGuestPath,
            },
            log,
          )
        }
        yield* probeLoginEnv(backend, sessionId, { cwd: workspaceGuestPath, exclude })
      })

    /** Binds the dependency folders found in the Workspace on the host from the Sandbox's disk. */
    const bindDependencyFolders = (
      sessionId: SessionId,
      workspaceHostPath: string,
      recipe: SessionEnvironment["recipe"],
    ) =>
      Effect.gen(function* () {
        if (recipe.dependencyFolders.length === 0) return
        const matches = yield* matchDependencyFolders(workspaceHostPath, recipe.dependencyFolders)
        if (matches.length === 0) return
        const bound = yield* backend.exec(sessionId, {
          command: "sh",
          args: ["-c", bindDependencyFoldersScript],
          stdin: `${matches.join("\n")}\n`,
        })
        if (bound.exitCode !== 0)
          return yield* new SandboxError({
            message: `binding the dependency folders failed: ${bound.stderr.trim() || bound.exitCode}`,
          })
      })

    /** Keeps the newest builds of a group, and removes the rest. */
    const prune = (group: string) =>
      Effect.gen(function* () {
        const snapshots = yield* snapshotsOrFail
        const builds = (yield* snapshots.list(group)).flatMap((snapshot) => {
          const parsed = parseBuildName(snapshot.name)
          return parsed === undefined ? [] : [{ name: snapshot.name, ...parsed }]
        })
        const keep = builds
          .toSorted((a, b) => b.buildVersion - a.buildVersion)
          .slice(0, Math.max(1, options.keepBuilds))
          .map((build) => build.name)
        if (keep.length < builds.length) yield* snapshots.retain(group, keep)
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`Could not remove old builds of ${group}`, cause),
        ),
      )

    /**
     * The build of the Environment's build version, made now if this Runner has none: its
     * snapshot and the libc it needs.
     */
    const ensureBuild = (
      repo: string,
      environment: SessionEnvironment,
      values: Effect.Effect<ReadonlyArray<VariableValue>, { readonly message: string }>,
      log: BuildLog,
    ) =>
      Effect.gen(function* () {
        const snapshots = yield* snapshotsOrFail
        const group = buildGroup(repo)
        let lock = buildLocks.get(group)
        if (lock === undefined) {
          lock = Semaphore.makeUnsafe(1)
          buildLocks.set(group, lock)
        }
        return yield* lock.withPermit(
          Effect.gen(function* () {
            const built = (yield* snapshots.list(group)).flatMap((snapshot) => {
              const parsed = parseBuildName(snapshot.name)
              return parsed?.buildVersion === environment.buildVersion
                ? [{ reference: snapshot.reference, libc: parsed.libc }]
                : []
            })[0]
            if (built !== undefined) return built
            const sessionId = buildSandboxId(`${group}/${environment.buildVersion}`)
            yield* log(
              `Building version ${environment.buildVersion} of the Environment on this Runner.\n`,
            )
            return yield* Effect.gen(function* () {
              const libc = yield* buildInSandbox(
                backend,
                {
                  sessionId,
                  recipe: environment.recipe,
                  limits: options.limits,
                  buildEnv: buildEnv(yield* values),
                },
                log,
              )
              const reference = yield* snapshots.snapshot(
                sessionId,
                group,
                buildName(environment.buildVersion, libc),
              )
              yield* log("The build is ready.\n")
              return { reference, libc }
            }).pipe(
              Effect.ensuring(backend.destroy(sessionId).pipe(Effect.ignore)),
              Effect.tap(() => prune(group)),
            )
          }),
        )
      })

    const claudeMount: HostMount = {
      _tag: "Host",
      hostPath: options.claudeCacheDir,
      guestPath: sandboxClaudeGuestDir,
      quotaMib: readOnlyQuotaMib,
      readOnly: true,
    }

    /**
     * Makes the Claude Code cache directory if it isn't there, as a Sandbox can't mount a missing
     * host directory: an Environment's Sandbox mounts it before its build's libc, and so the
     * download that would make it, is known (#69).
     */
    const claudeMountReady = Effect.tryPromise({
      try: () => mkdir(options.claudeCacheDir, { recursive: true, mode: 0o700 }),
      catch: (error) =>
        new SandboxError({
          message: `could not create ${options.claudeCacheDir}: ${errorMessage(error)}`,
        }),
    })

    /** Whether the running Sandbox has the mounts Claude Code runs from. */
    const hasClaudeMounts = (sessionId: SessionId) =>
      backend
        .exec(sessionId, { command: "sh", args: ["-c", claudeMountsScript] })
        .pipe(Effect.map((result) => result.exitCode === 0))

    /**
     * Destroys the Session's Sandbox, keeping its volumes, when it lacks the mounts Claude Code
     * runs from: it boots it to tell. Says whether it did.
     */
    const replaceOutdated = (sessionId: SessionId, state: SandboxState) =>
      Effect.gen(function* () {
        if (state === "Destroyed") return false
        if (state !== "Running") yield* backend.start(sessionId)
        if (yield* hasClaudeMounts(sessionId)) return false
        yield* Effect.logInfo(
          `Session ${sessionId}: its Sandbox lacks the mounts Claude Code runs from, so it is made anew, keeping its volumes`,
        )
        yield* release(sessionId)
        yield* backend.destroy(sessionId, { keepVolumes: true })
        return true
      })

    /**
     * Readies the running Sandbox for Claude Code: tmux and bash, installed if the image lacks
     * them, with what that prints shown in the Session, and Claude Code's state seeded.
     */
    const readyClaude = (
      sessionId: SessionId,
      claudePath: string,
      env: Readonly<Record<string, string>>,
    ) =>
      Effect.gen(function* () {
        yield* runScript(
          backend,
          sessionId,
          {
            label: "Installing tmux and bash",
            name: "claude-needs",
            script: claudeNeedsScript,
            cwd: "/",
          },
          sessionLog(sessionId),
        )
        yield* seedClaudeState(backend, sessionId)
        return { path: claudePath, env } satisfies SandboxClaude
      })

    /** A Sandbox on the Runner's default image, for a Repo without an Environment. */
    const startPlain = (sessionId: SessionId, directories: SessionDirectories, replace: boolean) =>
      Effect.gen(function* () {
        const version = yield* sandboxClaude("musl")
        let state = yield* backend.state(sessionId)
        const running = state === "Running"
        if (!running) yield* report(sessionId, "Starting")
        if (replace && state !== "Destroyed") {
          // Its Environment's Sandbox: the default one is made anew on the same volumes.
          yield* release(sessionId)
          yield* backend.destroy(sessionId, { keepVolumes: true })
          state = "Destroyed"
        }
        yield* removeRecord(directories)
        if (state === "Destroyed" || (yield* replaceOutdated(sessionId, state))) {
          const spec = sessionSandboxSpec({
            ...options.layout,
            sessionId,
            image: options.image,
            workspaceHostPath: directories.workspace,
          })
          yield* claudeMountReady
          yield* modMountReady(directories)
          yield* backend.create({
            ...spec,
            mounts: [...spec.mounts, claudeMount, modMount(directories)],
          })
        }
        if (!running) yield* report(sessionId, "Running")
        yield* keepToken(sessionId)
        return {
          claude: yield* readyClaude(sessionId, sandboxClaudePath(version, "musl"), plainClaudeEnv),
        }
      })

    const startWithEnvironment = (
      sessionId: SessionId,
      directories: SessionDirectories,
      repo: string,
      environment: SessionEnvironment,
      record: SandboxRecord | undefined,
    ) =>
      Effect.gen(function* () {
        const snapshots = yield* snapshotsOrFail
        const log = sessionLog(sessionId)
        const { recipe } = environment
        let state = yield* backend.state(sessionId)
        if (state !== "Running") yield* report(sessionId, "Starting")
        if (state !== "Destroyed" && record?.version !== environment.version) {
          // Another version's, or one whose start never finished: made anew on its volumes.
          yield* release(sessionId)
          yield* backend.destroy(sessionId, { keepVolumes: true })
          state = "Destroyed"
        }
        if (yield* replaceOutdated(sessionId, state)) state = "Destroyed"
        // Asked for again at each start, as they may have changed. Claude Code gets them, and a
        // new Sandbox's build and start script; a refusal stops the start here.
        variables.delete(sessionId)
        const values = yield* sessionVariables(sessionId)
        let libc: Libc
        if (state === "Destroyed") {
          const build = yield* ensureBuild(repo, environment, Effect.succeed(values), log)
          libc = build.libc
          const resources = capResources(recipe.resources, options.limits)
          if (resources.note !== undefined) yield* note(sessionId, resources.note)
          yield* claudeMountReady
          yield* modMountReady(directories)
          yield* snapshots.restore(
            environmentSpec({
              sessionId,
              recipe,
              workspaceHostPath: directories.workspace,
              resources,
              layout: options.layout,
              mounts: [claudeMount, modMount(directories)],
            }),
            build.reference,
          )
        } else {
          libc = record?.libc ?? "musl"
        }
        const version = yield* sandboxClaude(libc)
        yield* report(sessionId, "Running")
        yield* keepToken(sessionId)
        yield* bindDependencyFolders(sessionId, directories.workspace, recipe)
        if (state === "Destroyed") {
          yield* runStart(sessionId, recipe, values, log)
          yield* writeRecord(directories, {
            repo,
            version: environment.version,
            buildVersion: environment.buildVersion,
            libc,
            recipe,
          })
        }
        return {
          environmentVersion: environment.version,
          claude: yield* readyClaude(
            sessionId,
            sandboxClaudePath(version, libc),
            yield* environmentClaudeEnv(sessionId, values),
          ),
        }
      })

    /**
     * Claude Code's environment in an Environment's Sandbox: its login environment and the
     * variables, as every process the Runner starts there gets.
     */
    const environmentClaudeEnv = (sessionId: SessionId, values: ReadonlyArray<VariableValue>) =>
      Effect.map(readLoginEnv(backend, sessionId), (login) => ({
        ...claudeBaseEnv,
        ...processEnv(
          Option.getOrElse(login, () => ({})),
          values,
        ),
        ...claudeStateEnv,
      }))

    const start = (sessionId: SessionId, directories: SessionDirectories, target: SandboxTarget) =>
      Effect.gen(function* () {
        // Only the Runner's user may reach into the Session's directory.
        yield* Effect.tryPromise(() => chmod(directories.session, 0o700))
        const record = yield* readRecord(directories)
        return target.environment === undefined
          ? yield* startPlain(sessionId, directories, record !== undefined)
          : yield* startWithEnvironment(
              sessionId,
              directories,
              target.repo,
              target.environment,
              record,
            )
      }).pipe(
        // After the start script, so an identity it set is kept.
        Effect.tap(() =>
          target.gitIdentity === undefined
            ? Effect.void
            : setSandboxIdentity(backend, sessionId, target.gitIdentity),
        ),
        Effect.catchCause((cause) => {
          const message = failureMessage(cause)
          return Effect.andThen(
            report(sessionId, "Failed", message),
            Effect.fail(new SandboxError({ message: `the Sandbox did not start: ${message}` })),
          )
        }),
      )

    const runningSandboxes = backend.list.pipe(
      Effect.map((listings) =>
        listings
          .filter(
            (listing) =>
              listing.runner === backend.runner &&
              listing.state === "Running" &&
              !isBuildSandboxId(listing.sessionId),
          )
          .map((listing) => listing.sessionId),
      ),
      Effect.catchCause((cause) =>
        Effect.as(Effect.logWarning("Could not list the running Sandboxes", cause), []),
      ),
    )

    // What it runs is worked out again, as nothing of it outlives the Runner but the
    // Environment's record. The Claude Code this Runner would start is in the Sandbox already,
    // through the mount of the host's builds. A Sandbox made before each Session had its own copy
    // of the mod (#159) has none to start Claude Code with, so that waits for the Session to sleep.
    const keep = (sessionId: SessionId, directories: SessionDirectories) =>
      Effect.gen(function* () {
        const record = yield* readRecord(directories)
        yield* keepToken(sessionId)
        if (!(yield* hasClaudeMounts(sessionId))) {
          return yield* new SandboxError({
            message: "its Sandbox was made before each Session had its own copy of the mod",
          })
        }
        const libc = record?.libc ?? "musl"
        const path = sandboxClaudePath(yield* sandboxClaude(libc), libc)
        if (record === undefined) return { claude: { path, env: plainClaudeEnv } }
        const values = yield* sessionVariables(sessionId)
        return {
          environmentVersion: record.version,
          claude: { path, env: yield* environmentClaudeEnv(sessionId, values) },
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.fail(new SandboxError({ message: failureMessage(cause) })),
        ),
      )

    const hasTranscript = (sessionId: SessionId, directories: SessionDirectories, id: string) =>
      ensureTranscript(backend, sessionId, id, { cwd: directories.claude, projectsDir }).pipe(
        Effect.mapError(
          (error) =>
            new SandboxError({
              message: `could not look for the conversation's transcript: ${errorMessage(error)}`,
            }),
        ),
      )

    const stop = (sessionId: SessionId, reason: "Sleep" | "Archive") =>
      Effect.gen(function* () {
        yield* release(sessionId)
        variables.delete(sessionId)
        if ((yield* backend.state(sessionId)) === "Destroyed" && reason === "Sleep") return
        yield* report(sessionId, "Stopping")
        if (reason === "Archive") {
          // Claude Code's state stays, like the Workspace, for a restore to resume.
          yield* backend.destroy(sessionId, { keepVolumes: [claudeStateVolumeKey] })
          yield* report(sessionId, "Destroyed")
        } else {
          yield* backend.stop(sessionId)
          yield* report(sessionId, "Stopped")
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.andThen(
            Effect.logWarning(`Session ${sessionId}: could not stop its Sandbox`, cause),
            report(sessionId, "Failed", errorMessage(Exit.findErrorOption(Exit.failCause(cause)))),
          ),
        ),
      )

    const purge = (sessionId: SessionId) =>
      Effect.gen(function* () {
        yield* release(sessionId)
        variables.delete(sessionId)
        yield* backend.destroy(sessionId)
      }).pipe(
        Effect.mapError(
          (error) =>
            new SandboxError({ message: `the Sandbox was not destroyed: ${errorMessage(error)}` }),
        ),
      )

    const testBuild = (request: RunTestBuild, log: BuildLog) =>
      Effect.gen(function* () {
        const snapshots = yield* snapshotsOrFail
        const { recipe } = request
        const sessionId = testBuildSandboxId(request.testBuildId)
        const group = testBuildGroup(request.testBuildId)
        const values = yield* hubVariables.fetch({
          _tag: "TestBuild",
          testBuildId: request.testBuildId,
        })
        const scratch = options.scratchDir ?? tmpdir()
        yield* Effect.promise(() => mkdir(scratch, { recursive: true }))
        const directory = yield* Effect.promise(() =>
          mkdtemp(join(scratch, "claude-hub-test-build-")),
        )
        // A new directory for the clone: a directory replaced under a mount stays stale.
        const workspace = join(directory, "workspace")
        yield* Effect.gen(function* () {
          const libc = yield* buildInSandbox(
            backend,
            { sessionId, recipe, limits: options.limits, buildEnv: buildEnv(values) },
            log,
          )
          const reference = yield* snapshots.snapshot(sessionId, group, buildName(0, libc))
          yield* backend.destroy(sessionId)
          yield* log("Cloning the default branch...\n")
          yield* options.cloneDefaultBranch(request.repo, workspace, request.testBuildId)
          const resources = capResources(recipe.resources, options.limits)
          if (resources.note !== undefined) yield* log(`${resources.note}\n`)
          yield* log("Starting a Sandbox from the build...\n")
          yield* snapshots.restore(
            environmentSpec({
              sessionId,
              recipe,
              workspaceHostPath: workspace,
              resources,
              layout: options.layout,
            }),
            reference,
          )
          yield* bindDependencyFolders(sessionId, workspace, recipe)
          yield* runStart(sessionId, recipe, values, log)
          yield* log("The Test build passed.\n")
        }).pipe(
          Effect.ensuring(
            Effect.all(
              [
                backend.destroy(sessionId).pipe(Effect.ignore),
                snapshots.retain(group, []).pipe(Effect.ignore),
                Effect.promise(() => rm(directory, { recursive: true, force: true })),
              ],
              { discard: true },
            ),
          ),
        )
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.fail(new SandboxError({ message: failureMessage(cause) })),
        ),
      )

    yield* Effect.addFinalizer(() =>
      Effect.forEach([...tokenKeepers.keys()], release, { discard: true }),
    )

    const reconcile = (running: Iterable<SessionId>) =>
      reconcileSandboxes(running).pipe(
        Effect.provideService(SandboxBackend, backend),
        // A build's Sandbox left by a Runner that stopped mid-build is of no use to anyone.
        Effect.flatMap((reconciled) =>
          Effect.forEach(
            reconciled.unknown.filter((listing) => isBuildSandboxId(listing.sessionId)),
            (listing) =>
              backend
                .destroy(listing.sessionId)
                .pipe(
                  Effect.tap(() =>
                    Effect.logInfo(`Removed the unfinished build Sandbox ${listing.sessionId}`),
                  ),
                ),
            { discard: true },
          ),
        ),
        Effect.catchCause((cause) => Effect.logWarning("Could not reconcile Sandboxes", cause)),
      )

    return Sandboxes.of({
      start,
      running: runningSandboxes,
      keep,
      hasTranscript,
      stop,
      purge,
      reconcile,
      testBuild,
    })
  })

/**
 * How host git authenticates a Test build's clone, from the Hub's answer to a FetchCloneAccess
 * (#104): with the token it minted, handed to git for the one clone and kept nowhere; with the
 * host's own credentials only when the Hub says it has no GitHub App; and not at all, failing
 * before the clone, when the Hub says why not, such as the App not being installed on the Repo.
 */
export const testBuildCloneAuth = (
  answer: GitAnswer,
): Effect.Effect<GitAuth, { readonly message: string }> => {
  if (answer._tag === "GitFailed") {
    return Effect.fail({ message: `could not get access to clone the Repo: ${answer.message}` })
  }
  if (answer._tag !== "CloneAccess") {
    return Effect.fail({ message: `the Hub answered ${answer._tag} to how to clone the Repo` })
  }
  return Effect.succeed(
    answer.credentials._tag === "CloneToken"
      ? { _tag: "Token", token: answer.credentials.token }
      : { _tag: "Host" },
  )
}

/**
 * Clones a Test build's Repo, the tip of its default branch, into `directory`, as a Session's
 * Workspace is cloned (#104): with a token the Hub mints for the one clone, or failing before the
 * clone when the Hub says why not.
 */
export const cloneTestBuild = (options: {
  readonly url: string
  readonly directory: string
  readonly testBuildId: TestBuildId
}) =>
  Effect.flatMap(HubGit, (hubGit) => hubGit.cloneAccess(options.testBuildId)).pipe(
    Effect.flatMap(testBuildCloneAuth),
    Effect.flatMap((auth) =>
      cloneDefaultBranch({ url: options.url, auth, directory: options.directory }),
    ),
  )

/**
 * Reads the Sandbox settings from the environment:
 *
 * | Variable | Default |
 * |---|---|
 * | `RUNNER_SANDBOX_IMAGE` | `docker:dind` |
 * | `RUNNER_SANDBOX_CLAUDE_VERSION` | {@link PinnedClaudeVersion} |
 * | `RUNNER_SANDBOX_CLAUDE_CACHE` | `claude-code` in the home: `~/.claude-hub-dev/claude-code` |
 * | `RUNNER_SANDBOX_MAX_CPUS` | the host's CPU count |
 * | `RUNNER_SANDBOX_MAX_MEMORY_MIB` | half the host's memory |
 * | `RUNNER_SANDBOX_KEEP_BUILDS` | 3 |
 */
export const SessionSandboxesLive = Layer.effect(
  Sandboxes,
  Effect.gen(function* () {
    const config = yield* RunnerConfig
    const hubGit = yield* HubGit
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const home = yield* HomeConfig
    const settings = yield* Config.all({
      image: Config.String("RUNNER_SANDBOX_IMAGE").pipe(Config.withDefault("docker:dind")),
      version: Config.NonEmptyString("RUNNER_SANDBOX_CLAUDE_VERSION").pipe(
        Config.withDefault(PinnedClaudeVersion),
      ),
      cacheDir: Config.String("RUNNER_SANDBOX_CLAUDE_CACHE").pipe(
        Config.withDefault(join(home.dir, "claude-code")),
      ),
      maxCpus: Config.Int("RUNNER_SANDBOX_MAX_CPUS").pipe(
        Config.withDefault(availableParallelism()),
      ),
      maxMemoryMib: Config.Int("RUNNER_SANDBOX_MAX_MEMORY_MIB").pipe(
        Config.withDefault(Math.floor(totalmem() / 1024 / 1024 / 2)),
      ),
      keepBuilds: Config.Int("RUNNER_SANDBOX_KEEP_BUILDS").pipe(Config.withDefault(3)),
    })
    return yield* makeSessionSandboxes({
      githubToken: (sessionId) => hubGit.ask(sessionId, { _tag: "SandboxToken" }),
      image: settings.image,
      claudeCacheDir: settings.cacheDir,
      sandboxClaude: (libc) =>
        ensureSandboxClaude({ cacheDir: settings.cacheDir, version: settings.version, libc }).pipe(
          Effect.as(settings.version),
        ),
      limits: { cpus: settings.maxCpus, memoryMib: settings.maxMemoryMib },
      keepBuilds: settings.keepBuilds,
      cloneDefaultBranch: (repo, directory, testBuildId) =>
        cloneTestBuild({
          url: config.repoUrlTemplate.replaceAll("{repo}", repo),
          directory,
          testBuildId,
        }).pipe(
          Effect.provideService(HubGit, hubGit),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
    })
  }),
)
