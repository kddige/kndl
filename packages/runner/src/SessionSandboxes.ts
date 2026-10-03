// Sessions' Sandboxes on a SandboxBackend (#9, #11): each Session's Sandbox is created or started
// around its Workspace before Claude Code launches, with the tool bridge serving it on the
// Session's socket, and stopped or destroyed when the Session stops.

import { chmod } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { SandboxState, SessionId } from "@claude-hub/protocol"
import { RunnerToHub } from "@claude-hub/protocol"
import { Config, Effect, Exit, Layer, Option, Scope, Semaphore } from "effect"
import { HubLink } from "./HubLink.ts"
import { RunnerConfig } from "./RunnerConfig.ts"
import { SandboxError, Sandboxes } from "./Sandbox.ts"
import { reconcileSandboxes } from "./sandbox/Reconcile.ts"
import type { HostMount } from "./sandbox/SandboxBackend.ts"
import { SandboxBackend } from "./sandbox/SandboxBackend.ts"
import {
  ensureSandboxClaude,
  hostClaudeVersion,
  sandboxClaudeGuestDir,
  sandboxClaudePath,
} from "./sandbox/SandboxClaude.ts"
import type { SandboxClaudeError } from "./sandbox/SandboxClaude.ts"
import { sessionSandboxSpec } from "./sandbox/SessionLayout.ts"
import type { SessionLayoutOptions } from "./sandbox/SessionLayout.ts"
import type { SessionDirectories } from "./SessionNames.ts"
import { makeToolEngine, serveToolBridge } from "./ToolBridge.ts"
import type { ToolEngineOptions } from "./ToolBridge.ts"
import { WorkspaceGit } from "./WorkspaceGit.ts"

export interface SessionSandboxesOptions {
  /** The OCI image every Sandbox boots. */
  readonly image: string
  /** The host directory of Linux Claude Code builds, mounted read-only into every Sandbox. */
  readonly claudeCacheDir: string
  /**
   * Finds, and downloads if needed, the Claude Code build Sandboxes run `mcp serve` from, and
   * returns its version. Run on the first Session start until it succeeds.
   */
  readonly sandboxClaude: Effect.Effect<string, SandboxClaudeError>
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
}

/** The most a Sandbox may write to the read-only Claude Code mount: nothing, but it needs a quota. */
const claudeMountQuotaMib = 1

const errorMessage = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error && error.message !== ""
    ? String(error.message)
    : typeof error === "object" && error !== null && "_tag" in error
      ? String(error._tag)
      : String(error)

export const makeSessionSandboxes = (options: SessionSandboxesOptions) =>
  Effect.gen(function* () {
    const backend = yield* SandboxBackend
    const hub = yield* HubLink
    const layerScope = yield* Effect.scope

    /** Each Session's open tool bridge, closed when its Sandbox stops. */
    const bridges = new Map<SessionId, Scope.Closeable>()

    // The Claude Code version, once found; a failure is tried again on the next start.
    const claudeLock = yield* Semaphore.make(1)
    let claudeVersion: string | undefined
    const sandboxClaude = claudeLock.withPermit(
      Effect.suspend(() =>
        claudeVersion === undefined
          ? Effect.tap(options.sandboxClaude, (version) =>
              Effect.sync(() => {
                claudeVersion = version
              }),
            )
          : Effect.succeed(claudeVersion),
      ),
    )

    const report = (sessionId: SessionId, state: SandboxState, message?: string) =>
      hub.send(
        RunnerToHub.cases.SandboxStateReport.make({
          sessionId,
          state,
          ...(message === undefined ? {} : { message }),
        }),
      )

    const closeBridge = (sessionId: SessionId) =>
      Effect.suspend(() => {
        const scope = bridges.get(sessionId)
        bridges.delete(sessionId)
        return scope === undefined ? Effect.void : Scope.close(scope, Exit.void)
      })

    const openBridge = (sessionId: SessionId, directories: SessionDirectories, version: string) =>
      Effect.gen(function* () {
        if (bridges.has(sessionId)) return
        const scope = yield* Scope.fork(layerScope)
        yield* Effect.gen(function* () {
          const engine = yield* makeToolEngine({
            sessionId,
            claudePath: sandboxClaudePath(version),
            // Claude Code runs in the Session's empty directory, so that is where the model
            // thinks its files are.
            workspaceAlias: directories.claude,
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

    const bootSandbox = (sessionId: SessionId, directories: SessionDirectories) =>
      Effect.gen(function* () {
        const state = yield* backend.state(sessionId)
        if (state === "Running") return
        yield* report(sessionId, "Starting")
        if (state === "Destroyed") {
          const claudeMount: HostMount = {
            _tag: "Host",
            hostPath: options.claudeCacheDir,
            guestPath: sandboxClaudeGuestDir,
            quotaMib: claudeMountQuotaMib,
            readOnly: true,
          }
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
      })

    const start = (sessionId: SessionId, directories: SessionDirectories) =>
      Effect.gen(function* () {
        const version = yield* sandboxClaude
        // Only the Runner's user may reach into the Session's directory, and so its socket.
        yield* Effect.tryPromise(() => chmod(directories.session, 0o700))
        yield* bootSandbox(sessionId, directories)
        yield* openBridge(sessionId, directories, version)
      }).pipe(
        Effect.catchCause((cause) => {
          const message = errorMessage(
            Option.getOrElse(Exit.findErrorOption(Exit.failCause(cause)), () => cause),
          )
          return Effect.andThen(
            report(sessionId, "Failed", message),
            Effect.fail(new SandboxError({ message: `the Sandbox did not start: ${message}` })),
          )
        }),
      )

    const stop = (sessionId: SessionId, reason: "Sleep" | "Archive") =>
      Effect.gen(function* () {
        yield* closeBridge(sessionId)
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
        yield* backend.destroy(sessionId)
      }).pipe(
        Effect.mapError(
          (error) =>
            new SandboxError({ message: `the Sandbox was not destroyed: ${errorMessage(error)}` }),
        ),
      )

    yield* Effect.addFinalizer(() =>
      Effect.forEach([...bridges.keys()], closeBridge, { discard: true }),
    )

    const reconcile = (running: Iterable<SessionId>) =>
      reconcileSandboxes(running).pipe(
        Effect.provideService(SandboxBackend, backend),
        Effect.asVoid,
        Effect.catchCause((cause) => Effect.logWarning("Could not reconcile Sandboxes", cause)),
      )

    return Sandboxes.of({ start, stop, purge, reconcile })
  })

/**
 * Reads the Sandbox settings from the environment:
 *
 * | Variable | Default |
 * |---|---|
 * | `RUNNER_SANDBOX_IMAGE` | `docker:dind` |
 * | `RUNNER_SANDBOX_CLAUDE_VERSION` | the host's `claude --version` |
 * | `RUNNER_SANDBOX_CLAUDE_CACHE` | `~/.claude-hub/claude-code` |
 */
export const SessionSandboxesLive = Layer.effect(
  Sandboxes,
  Effect.gen(function* () {
    const config = yield* RunnerConfig
    const git = yield* WorkspaceGit
    const settings = yield* Config.all({
      image: Config.String("RUNNER_SANDBOX_IMAGE").pipe(Config.withDefault("docker:dind")),
      version: Config.option(Config.NonEmptyString("RUNNER_SANDBOX_CLAUDE_VERSION")),
      cacheDir: Config.String("RUNNER_SANDBOX_CLAUDE_CACHE").pipe(
        Config.withDefault(join(homedir(), ".claude-hub", "claude-code")),
      ),
    })
    const version = Option.match(settings.version, {
      onNone: () => hostClaudeVersion(config.claudeBin),
      onSome: Effect.succeed,
    })
    return yield* makeSessionSandboxes({
      git,
      image: settings.image,
      claudeCacheDir: settings.cacheDir,
      sandboxClaude: version.pipe(
        Effect.tap((v) => ensureSandboxClaude({ cacheDir: settings.cacheDir, version: v })),
      ),
    })
  }),
)
