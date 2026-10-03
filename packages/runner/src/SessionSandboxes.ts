// Sessions' Sandboxes on a SandboxBackend (#9, #11): each Session's Sandbox is created or started
// around its Workspace before Claude Code launches, with the tool bridge serving it on the
// Session's socket, and stopped or destroyed when the Session stops.
//
// A Session of a Repo with an Environment (ADR 0009) boots from that Environment's build, built
// on this Runner the first time a Session needs it, with the build's output shown in the Session.
// Each new Sandbox then gets its dependency folders bound and runs the start script; each later
// boot binds the folders again. A Sandbox of an older version is recreated at its next start,
// keeping its volumes. The Environment's variables are fetched from the Hub, kept in memory, and
// passed to each process the Runner starts in the Sandbox, never set on the VM.
//
// The Session's directory holds `sandbox.json`, what its Sandbox was last built from, without
// any value: the Environment version, the build it booted from and its libc, and the recipe.

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { availableParallelism, homedir, tmpdir, totalmem } from "node:os"
import { join } from "node:path"
import type {
  RepoName,
  RunTestBuild,
  SandboxState,
  SessionEnvironment,
  SessionId,
  VariableValue,
} from "@claude-hub/protocol"
import { EnvironmentRecipe, EnvironmentVersion, RunnerToHub } from "@claude-hub/protocol"
import { Config, Effect, Exit, Layer, Option, Schema, Scope, Semaphore } from "effect"
import type { Cause } from "effect"
import { ChildProcessSpawner } from "effect/process"
import {
  buildGroup,
  buildInSandbox,
  buildName,
  capResources,
  parseBuildName,
  runScript,
  testBuildGroup,
} from "./EnvironmentBuilds.ts"
import type { BuildLog, ResourceLimits } from "./EnvironmentBuilds.ts"
import { cloneDefaultBranch } from "./HostGit.ts"
import { HubLink } from "./HubLink.ts"
import { HubVariables, variablesEnv } from "./HubVariables.ts"
import { RunnerConfig } from "./RunnerConfig.ts"
import { SandboxError, Sandboxes } from "./Sandbox.ts"
import type { SandboxTarget } from "./Sandbox.ts"
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
  hostClaudeVersion,
  sandboxClaudeGuestDir,
  sandboxClaudePath,
} from "./sandbox/SandboxClaude.ts"
import type { Libc, SandboxClaudeError } from "./sandbox/SandboxClaude.ts"
import {
  cacheEnv,
  defaults,
  sessionSandboxSpec,
  workspaceGuestPath,
} from "./sandbox/SessionLayout.ts"
import type { SessionLayoutOptions } from "./sandbox/SessionLayout.ts"
import type { SessionDirectories } from "./SessionNames.ts"
import { InitialTerminalSize } from "./Sessions.ts"
import { makeToolEngine, serveToolBridge, ToolBridgeError } from "./ToolBridge.ts"
import type { ToolEngineOptions } from "./ToolBridge.ts"
import { WorkspaceGit } from "./WorkspaceGit.ts"

export interface SessionSandboxesOptions {
  /** The OCI image Sandboxes boot when their Repo has no Environment. */
  readonly image: string
  /** The host directory of Linux Claude Code builds, mounted read-only into every Sandbox. */
  readonly claudeCacheDir: string
  /**
   * Finds, and downloads if needed, the Claude Code build for `libc` that Sandboxes run
   * `mcp serve` from, and returns its version. Run on the first Session start needing that libc
   * until it succeeds.
   */
  readonly sandboxClaude: (libc: Libc) => Effect.Effect<string, SandboxClaudeError>
  /** Size overrides for the Session layout. */
  readonly layout?: Partial<
    Omit<SessionLayoutOptions, "sessionId" | "image" | "workspaceHostPath" | "env">
  >
  readonly bridge?: Pick<ToolEngineOptions, "readyTimeout" | "restartDelay">
  /**
   * Answers the mod's git tools, which the tool bridge serves beside the Sandbox's tools but runs
   * on the host. Without it they are refused.
   */
  readonly git?: WorkspaceGit["Service"]
  /** The most CPUs and memory an Environment's Sandbox gets, whatever it asks for. */
  readonly limits: ResourceLimits
  /** How many builds of each Repo's Environment this Runner keeps. At least 1. */
  readonly keepBuilds: number
  /** Clones the tip of the Repo's default branch into a new directory, for a Test build. */
  readonly cloneDefaultBranch: (
    repo: RepoName,
    directory: string,
  ) => Effect.Effect<void, { readonly message: string }>
  /** Where Test builds' clones go while they run. Defaults to the system's temporary directory. */
  readonly scratchDir?: string
}

/** The most a Sandbox may write to the read-only Claude Code mount: nothing, but it needs a quota. */
const claudeMountQuotaMib = 1

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

/** The values the bootstrap gets: only those available at build. */
const buildEnv = (values: ReadonlyArray<VariableValue>) =>
  variablesEnv(values, (value) => value.availableAtBuild)

/** The environment of each process the Runner starts in an Environment's Sandbox. */
const processEnv = (values: ReadonlyArray<VariableValue>) => ({
  ...cacheEnv,
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
    const layerScope = yield* Effect.scope

    /** Each Session's open tool bridge, closed when its Sandbox stops. */
    const bridges = new Map<SessionId, Scope.Closeable>()
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

    const closeBridge = (sessionId: SessionId) =>
      Effect.suspend(() => {
        const scope = bridges.get(sessionId)
        bridges.delete(sessionId)
        return scope === undefined ? Effect.void : Scope.close(scope, Exit.void)
      })

    const openBridge = (
      sessionId: SessionId,
      directories: SessionDirectories,
      claudePath: string,
      withEnvironment: boolean,
    ) =>
      Effect.gen(function* () {
        if (bridges.has(sessionId)) return
        const scope = yield* Scope.fork(layerScope)
        yield* Effect.gen(function* () {
          const engine = yield* makeToolEngine({
            sessionId,
            claudePath,
            // Claude Code runs in the Session's empty directory, so that is where the model
            // thinks its files are.
            workspaceAlias: directories.claude,
            ...(withEnvironment
              ? {
                  env: sessionVariables(sessionId).pipe(
                    Effect.map(processEnv),
                    Effect.mapError((error) => new ToolBridgeError({ message: error.message })),
                  ),
                }
              : {}),
            ...options.bridge,
          })
          const git = options.git
          yield* serveToolBridge(
            directories.toolsSocket,
            engine,
            git === undefined ? undefined : (call) => git.call(sessionId, directories, call),
          )
        }).pipe(
          Effect.provideService(SandboxBackend, backend),
          Scope.provide(scope),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        )
        bridges.set(sessionId, scope)
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
      quotaMib: claudeMountQuotaMib,
      readOnly: true,
    }

    /** A Sandbox on the Runner's default image, for a Repo without an Environment. */
    const startPlain = (sessionId: SessionId, directories: SessionDirectories, replace: boolean) =>
      Effect.gen(function* () {
        const version = yield* sandboxClaude("musl")
        let state = yield* backend.state(sessionId)
        if (replace && state !== "Destroyed") {
          // Its Environment's Sandbox: the default one is made anew on the same volumes.
          yield* closeBridge(sessionId)
          yield* backend.destroy(sessionId, { keepVolumes: true })
          state = "Destroyed"
        }
        yield* removeRecord(directories)
        if (state !== "Running") {
          yield* report(sessionId, "Starting")
          if (state === "Destroyed") {
            const spec = sessionSandboxSpec({
              ...options.layout,
              sessionId,
              image: options.image,
              workspaceHostPath: directories.workspace,
            })
            yield* backend.create({ ...spec, mounts: [...spec.mounts, claudeMount] })
          } else {
            yield* backend.start(sessionId)
          }
          yield* report(sessionId, "Running")
        }
        yield* openBridge(sessionId, directories, sandboxClaudePath(version, "musl"), false)
        return {}
      })

    const startWithEnvironment = (
      sessionId: SessionId,
      directories: SessionDirectories,
      repo: string,
      environment: SessionEnvironment,
      record: SandboxRecord | undefined,
      adopting: boolean,
    ) =>
      Effect.gen(function* () {
        const snapshots = yield* snapshotsOrFail
        const log = sessionLog(sessionId)
        const { recipe } = environment
        let state = yield* backend.state(sessionId)
        if (adopting && state === "Destroyed")
          // Making it again takes its variables, which the Hub sends only once the Runner is
          // connected, after adopting.
          return yield* new SandboxError({
            message: "its Sandbox is gone; it is made again when the Session next starts",
          })
        if (state !== "Destroyed" && record?.version !== environment.version) {
          // Another version's, or one whose start never finished: made anew on its volumes.
          yield* closeBridge(sessionId)
          yield* backend.destroy(sessionId, { keepVolumes: true })
          state = "Destroyed"
        }
        if (state !== "Running") yield* report(sessionId, "Starting")
        // Asked for again at each start, as they may have changed. Only a new Sandbox needs them
        // now, for its build and start script, and a refusal stops it here; on a wake the tool
        // bridge asks when it first starts a process.
        variables.delete(sessionId)
        const values = state === "Destroyed" ? yield* sessionVariables(sessionId) : []
        let libc: Libc
        if (state === "Destroyed") {
          const build = yield* ensureBuild(repo, environment, Effect.succeed(values), log)
          libc = build.libc
          const resources = capResources(recipe.resources, options.limits)
          if (resources.note !== undefined) yield* note(sessionId, resources.note)
          yield* snapshots.restore(
            environmentSpec({
              sessionId,
              recipe,
              workspaceHostPath: directories.workspace,
              resources,
              layout: options.layout,
              mounts: [claudeMount],
            }),
            build.reference,
          )
        } else {
          libc = record?.libc ?? "musl"
          if (state !== "Running") yield* backend.start(sessionId)
        }
        const version = yield* sandboxClaude(libc)
        yield* report(sessionId, "Running")
        yield* bindDependencyFolders(sessionId, directories.workspace, recipe)
        if (state === "Destroyed") {
          if (recipe.startScript !== undefined && recipe.startScript.trim() !== "") {
            yield* log("Running the start script...\n")
            yield* runScript(
              backend,
              sessionId,
              {
                label: "The start script",
                name: "start",
                script: recipe.startScript,
                env: processEnv(values),
                cwd: workspaceGuestPath,
              },
              log,
            )
          }
          yield* writeRecord(directories, {
            repo,
            version: environment.version,
            buildVersion: environment.buildVersion,
            libc,
            recipe,
          })
        }
        yield* openBridge(sessionId, directories, sandboxClaudePath(version, libc), true)
        return { environmentVersion: environment.version }
      })

    const start = (sessionId: SessionId, directories: SessionDirectories, target?: SandboxTarget) =>
      Effect.gen(function* () {
        // Only the Runner's user may reach into the Session's directory, and so its socket.
        yield* Effect.tryPromise(() => chmod(directories.session, 0o700))
        const record = yield* readRecord(directories)
        if (target === undefined) {
          // Brought back as it was, as after a Runner restart.
          return record === undefined
            ? yield* startPlain(sessionId, directories, false)
            : yield* startWithEnvironment(
                sessionId,
                directories,
                record.repo,
                {
                  version: record.version,
                  buildVersion: record.buildVersion,
                  recipe: record.recipe,
                },
                record,
                true,
              )
        }
        return target.environment === undefined
          ? yield* startPlain(sessionId, directories, record !== undefined)
          : yield* startWithEnvironment(
              sessionId,
              directories,
              target.repo,
              target.environment,
              record,
              false,
            )
      }).pipe(
        Effect.catchCause((cause) => {
          const message = failureMessage(cause)
          return Effect.andThen(
            report(sessionId, "Failed", message),
            Effect.fail(new SandboxError({ message: `the Sandbox did not start: ${message}` })),
          )
        }),
      )

    const stop = (sessionId: SessionId, reason: "Sleep" | "Archive") =>
      Effect.gen(function* () {
        yield* closeBridge(sessionId)
        variables.delete(sessionId)
        if ((yield* backend.state(sessionId)) === "Destroyed" && reason === "Sleep") return
        yield* report(sessionId, "Stopping")
        if (reason === "Archive") {
          yield* backend.destroy(sessionId)
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
        yield* closeBridge(sessionId)
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
          yield* options.cloneDefaultBranch(request.repo, workspace)
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
          if (recipe.startScript !== undefined && recipe.startScript.trim() !== "") {
            yield* log("Running the start script...\n")
            yield* runScript(
              backend,
              sessionId,
              {
                label: "The start script",
                name: "start",
                script: recipe.startScript,
                env: processEnv(values),
                cwd: workspaceGuestPath,
              },
              log,
            )
          }
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
      Effect.forEach([...bridges.keys()], closeBridge, { discard: true }),
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

    return Sandboxes.of({ start, stop, purge, reconcile, testBuild })
  })

/**
 * Reads the Sandbox settings from the environment:
 *
 * | Variable | Default |
 * |---|---|
 * | `RUNNER_SANDBOX_IMAGE` | `docker:dind` |
 * | `RUNNER_SANDBOX_CLAUDE_VERSION` | the host's `claude --version` |
 * | `RUNNER_SANDBOX_CLAUDE_CACHE` | `~/.claude-hub/claude-code` |
 * | `RUNNER_SANDBOX_MAX_CPUS` | the host's CPU count |
 * | `RUNNER_SANDBOX_MAX_MEMORY_MIB` | half the host's memory |
 * | `RUNNER_SANDBOX_KEEP_BUILDS` | 3 |
 */
export const SessionSandboxesLive = Layer.effect(
  Sandboxes,
  Effect.gen(function* () {
    const config = yield* RunnerConfig
    const git = yield* WorkspaceGit
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const settings = yield* Config.all({
      image: Config.String("RUNNER_SANDBOX_IMAGE").pipe(Config.withDefault("docker:dind")),
      version: Config.option(Config.NonEmptyString("RUNNER_SANDBOX_CLAUDE_VERSION")),
      cacheDir: Config.String("RUNNER_SANDBOX_CLAUDE_CACHE").pipe(
        Config.withDefault(join(homedir(), ".claude-hub", "claude-code")),
      ),
      maxCpus: Config.Int("RUNNER_SANDBOX_MAX_CPUS").pipe(
        Config.withDefault(availableParallelism()),
      ),
      maxMemoryMib: Config.Int("RUNNER_SANDBOX_MAX_MEMORY_MIB").pipe(
        Config.withDefault(Math.floor(totalmem() / 1024 / 1024 / 2)),
      ),
      keepBuilds: Config.Int("RUNNER_SANDBOX_KEEP_BUILDS").pipe(Config.withDefault(3)),
    })
    const version = Option.match(settings.version, {
      onNone: () => hostClaudeVersion(config.claudeBin),
      onSome: Effect.succeed,
    })
    return yield* makeSessionSandboxes({
      git,
      image: settings.image,
      claudeCacheDir: settings.cacheDir,
      sandboxClaude: (libc) =>
        version.pipe(
          Effect.tap((v) => ensureSandboxClaude({ cacheDir: settings.cacheDir, version: v, libc })),
        ),
      limits: { cpus: settings.maxCpus, memoryMib: settings.maxMemoryMib },
      keepBuilds: settings.keepBuilds,
      // A Test build has no Session to mint a GitHub App token for: the host's own git
      // credentials clone it.
      cloneDefaultBranch: (repo, directory) =>
        cloneDefaultBranch({
          url: config.repoUrlTemplate.replaceAll("{repo}", repo),
          auth: { _tag: "Host" },
          directory,
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    })
  }),
)
