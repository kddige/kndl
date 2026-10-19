import type {
  EnvironmentVersion,
  GitIdentity,
  RepoName,
  RunTestBuild,
  SessionEnvironment,
  SessionId,
  StopSession,
} from "@kndl/protocol"
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

/** How to run Claude Code in a started Sandbox (ADR 0013), as the agent's Claude bridge does. */
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

/** How to run the durable agent, and the Session's terminal, in a started Sandbox. */
export interface SandboxPi {
  /** Node.js's executable, in the Sandbox, for its image's libc. */
  readonly node: string
  /**
   * Their environment over the Sandbox's: Claude Code's, but for Claude Code's state, which the
   * agent gets only with a Claude credential for its Claude bridge.
   */
  readonly env: Readonly<Record<string, string>>
}

/** A started Sandbox. */
export interface SandboxStarted {
  /** The Environment version the Sandbox runs, if any. */
  readonly environmentVersion?: EnvironmentVersion
  readonly claude: SandboxClaude
  readonly pi: SandboxPi
}

/**
 * The seam for a Session's Sandbox (#9): created and started around its Workspace before Claude
 * Code launches in it, and stopped after Claude Code stops.
 *
 * The live one (SessionSandboxes.ts) reports its state to the Hub with `SandboxStateReport`, and
 * readies the Sandbox for its agent at each start: tmux, Node.js, and Claude Code's state, which
 * the agent's Claude bridge runs on (ADR 0013).
 */
export class Sandboxes extends Context.Service<
  Sandboxes,
  {
    /**
     * Creates the Session's Sandbox, or reuses its stopped one, and starts it. A Sandbox of
     * another Environment version, or one without the mounts the agent and Claude Code run from,
     * is recreated, keeping its volumes.
     */
    readonly start: (
      sessionId: SessionId,
      directories: SessionDirectories,
      target: SandboxTarget,
    ) => Effect.Effect<SandboxStarted, SandboxError>
    /**
     * The Sessions whose Sandbox of this Runner's is running, as after a Runner restart, which
     * leaves them running with their agent in them (#157).
     */
    readonly running: Effect.Effect<ReadonlyArray<SessionId>>
    /**
     * Takes back the Session's running Sandbox after a Runner restart, its agent still running in
     * it (#157): keeps its GitHub token fresh again, and says what it runs, as {@link start}
     * would, for the agent to start again in it with a new model. Fails for one without the mounts
     * the agent runs from, which only its next start makes anew.
     */
    readonly keep: (
      sessionId: SessionId,
      directories: SessionDirectories,
    ) => Effect.Effect<SandboxStarted, SandboxError>
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
     * The bytes of the host's disk the Session's Sandbox volumes take (#352): what is allocated to
     * them, not their caps. 0 when it has none.
     */
    readonly diskUsage: (sessionId: SessionId) => Effect.Effect<number, SandboxError>
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
>()("@kndl/runner/Sandboxes") {}
