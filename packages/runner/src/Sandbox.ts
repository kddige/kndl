import type {
  EnvironmentVersion,
  GitIdentity,
  Harness,
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
  /** What the Session runs (ADR 0029): a pi Session's Sandbox is readied for pi too. */
  readonly harness?: Harness
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

/** How to run pi in a started Sandbox (ADR 0029). */
export interface SandboxPi {
  /** Node.js's executable, in the Sandbox, for its image's libc. pi's CLI is the bundle's. */
  readonly node: string
  /**
   * Its environment over the Sandbox's: Claude Code's, but for Claude Code's state, which pi gets
   * only with a Claude credential for its Claude bridge.
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
 * readies the Sandbox for Claude Code at each start: tmux, and Claude Code's state (ADR 0013).
 */
export class Sandboxes extends Context.Service<
  Sandboxes,
  {
    /**
     * Creates the Session's Sandbox, or reuses its stopped one, and starts it. A Sandbox of
     * another Environment version, or one without the mounts Claude Code and pi run from, is
     * recreated, keeping its volumes.
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
     * {@link start} would, for Claude Code to start again in it with a new model. Fails for one
     * without the mounts Claude Code runs from, which only its next start makes anew.
     */
    readonly keep: (
      sessionId: SessionId,
      directories: SessionDirectories,
    ) => Effect.Effect<SandboxStarted, SandboxError>
    /**
     * Readies the Session's running Sandbox for `harness`, one it didn't start with, as its start
     * would have (ADR 0030): Claude Code's state seeded, and, for pi, Node.js running there and
     * pi's state directory made. `started` is what its start or {@link keep} said it runs. Fails
     * for pi in a Sandbox without the pi bundle's mount.
     */
    readonly readyFor: (
      sessionId: SessionId,
      harness: Harness,
      started: SandboxStarted,
    ) => Effect.Effect<void, SandboxError>
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
