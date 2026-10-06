import type {
  EnvironmentVersion,
  GitIdentity,
  RepoName,
  RunTestBuild,
  SessionEnvironment,
  SessionId,
  StopSession,
} from "@claude-hub/protocol"
import { Context, Data, type Effect } from "effect"
import type { SessionDirectories } from "./SessionNames.ts"

export class SandboxError extends Data.TaggedError("SandboxError")<{
  readonly message: string
}> {}

/** What a Session's Sandbox is built from. */
export interface SandboxTarget {
  readonly repo: RepoName
  /** The Repo's Environment (ADR 0009); absent for the Runner's default image. */
  readonly environment?: SessionEnvironment
  /** Who commits in the Sandbox are by, unless the Environment sets its own (#110). */
  readonly gitIdentity?: GitIdentity
}

/** How to run Claude Code in a started Sandbox (ADR 0013). */
export interface SandboxClaude {
  /** Its executable, in the Sandbox. */
  readonly path: string
  /**
   * Its environment over the Sandbox's: what the Runner gives each process it starts there (an
   * Environment's login environment and variables), with Claude Code's state directory. Holds no
   * Claude credential and no Session token, which the launch adds.
   */
  readonly env: Readonly<Record<string, string>>
}

/** A started Sandbox. */
export interface SandboxStarted {
  /** The Environment version the Sandbox runs, if any. */
  readonly environmentVersion?: EnvironmentVersion
  readonly claude: SandboxClaude
}

/**
 * The seam for a Session's Sandbox (#9): created and started around its Workspace before Claude
 * Code launches in it, and stopped after Claude Code stops.
 *
 * The live one (SessionSandboxes.ts) reports its state to the Hub with `SandboxStateReport`, and
 * readies the Sandbox for Claude Code at each start: tmux, and Claude Code's state (ADR 0013).
 */
export class Sandboxes extends Context.Service<
  Sandboxes,
  {
    /**
     * Creates the Session's Sandbox, or reuses its stopped one, and starts it. A Sandbox of
     * another Environment version, or one made before Claude Code ran in Sandboxes, is recreated,
     * keeping its volumes.
     */
    readonly start: (
      sessionId: SessionId,
      directories: SessionDirectories,
      target: SandboxTarget,
    ) => Effect.Effect<SandboxStarted, SandboxError>
    /**
     * The Sessions whose Sandbox of this Runner's is running, as after a Runner restart, which
     * leaves them running with their Claude Code in them (#157).
     */
    readonly running: Effect.Effect<ReadonlyArray<SessionId>>
    /**
     * Takes back the Session's running Sandbox after a Runner restart, its Claude Code still
     * running in it (#157): keeps its GitHub token fresh again, and says what it runs, as
     * {@link start} would, for Claude Code to start again in it with a new model.
     */
    readonly keep: (
      sessionId: SessionId,
      directories: SessionDirectories,
    ) => Effect.Effect<SandboxStarted, SandboxError>
    /**
     * Whether Claude Code in the Session's started Sandbox has a transcript of conversation `id`
     * to resume. One Claude Code wrote on the host, before it moved into the Sandbox, is copied
     * in first (ADR 0013).
     */
    readonly hasTranscript: (
      sessionId: SessionId,
      directories: SessionDirectories,
      id: string,
    ) => Effect.Effect<boolean, SandboxError>
    /**
     * `Sleep` stops the Sandbox and keeps its volumes; `Archive` destroys it but for the volume
     * with Claude Code's state (ADR 0006).
     */
    readonly stop: (sessionId: SessionId, reason: StopSession["reason"]) => Effect.Effect<void>
    /**
     * Destroys whatever is left of a purged Session's Sandbox: the Sandbox if any, and every one
     * of its volumes. Succeeds when nothing is left.
     */
    readonly purge: (sessionId: SessionId) => Effect.Effect<void, SandboxError>
    /**
     * Stops any of this Runner's Sandboxes left running for a Session not among `running`, as
     * after a crash, and logs the Sandboxes it doesn't know. Other Runners' Sandboxes, and ones
     * from before Sandboxes carried their Runner's mark, are left alone. Destroys nothing of a
     * Session's; a build's leftover Sandbox is destroyed.
     */
    readonly reconcile: (running: Iterable<SessionId>) => Effect.Effect<void>
    /**
     * Runs a Test build (ADR 0009): the bootstrap, then the start script against a fresh clone
     * of the Repo's default branch, writing its output to `log`. Fails with why it failed.
     */
    readonly testBuild: (
      request: RunTestBuild,
      log: (text: string) => Effect.Effect<void>,
    ) => Effect.Effect<void, SandboxError>
  }
>()("@claude-hub/runner/Sandboxes") {}
