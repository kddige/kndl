// The Sandbox backend: how the Runner creates, drives and removes the virtual machine each Session's
// file and command work happens in (ADR 0007). The microsandbox implementation is in
// MicrosandboxBackend.ts; an in-memory fake for tests is in FakeSandboxBackend.ts.
//
// A Sandbox is addressed by its Session's id: a Session has at most one Sandbox at a time, and
// every Sandbox and volume a backend makes is named after its Session (see Naming.ts). A backend
// works for one Runner, and marks what it makes as that Runner's.
//
// A backend keeps what commands print off the host's disk: their output may hold variable values
// (ADR 0009).

import type { SandboxState, SessionId } from "@claude-hub/protocol"
import { Context, Data, Effect, Stream } from "effect"
import type { Option, Scope } from "effect"

// ── What a Sandbox is made of ──────────────────────────────────────────────

/**
 * A directory on the Runner's host mounted into the Sandbox, such as the Workspace (ADR 0006).
 * Writes from the guest land on the host directly, so they outlive the Sandbox.
 */
export interface HostMount {
  readonly _tag: "Host"
  /** Absolute path on the Runner's host. Must exist. */
  readonly hostPath: string
  /** Absolute path in the guest. */
  readonly guestPath: string
  /** The most the guest may write through this mount, in MiB. */
  readonly quotaMib: number
  readonly readOnly?: boolean
}

/**
 * A disk volume that belongs to the Session: created on first use, kept across stop, start and
 * a destroy that keeps it, and removed with the Session's other volumes on destroy. Used for
 * dependency directories, package caches, Docker's data and Claude Code's state, which are slow on
 * a host mount or belong to the Session alone.
 */
export interface VolumeMount {
  readonly _tag: "Volume"
  /** Names the volume within its Session: lowercase letters, digits, `_` and `-`. */
  readonly key: string
  /** Absolute path in the guest. May sit inside a {@link HostMount}, as `node_modules` does. */
  readonly guestPath: string
  /** Capacity in MiB, used when the volume is first created. At least 256. */
  readonly sizeMib: number
}

export type Mount = HostMount | VolumeMount

/** Everything needed to boot a Session's Sandbox. `SessionLayout.ts` builds the usual one. */
export interface SandboxSpec {
  readonly sessionId: SessionId
  /** An OCI image reference, such as `docker:dind`. */
  readonly image: string
  readonly cpus: number
  /**
   * The guest's memory, in MiB, and its hard cap. Memory the guest frees is not returned to the
   * host while the Sandbox runs, so the host must budget for this much per running Sandbox.
   */
  readonly memoryMib: number
  /** The guest's root filesystem size in MiB. Defaults to the backend's own. */
  readonly rootDiskMib?: number
  readonly mounts: ReadonlyArray<Mount>
  /**
   * Run Docker in the Sandbox, with its data on a Session volume at `/var/lib/docker`. The
   * backend starts `dockerd` on every boot and stops containers cleanly before stopping, then
   * starts the same containers on the next boot. The image must ship `dockerd`.
   */
  readonly docker?: { readonly sizeMib: number }
  /**
   * Environment for every command, kept across stop and start. Stored with the Sandbox on the
   * host's disk, so never put secrets here: pass them per command (ADR 0009).
   */
  readonly env: Readonly<Record<string, string>>
  /** The working directory commands start in when they name none. */
  readonly workdir?: string
}

// ── Running commands ───────────────────────────────────────────────────────

export interface ExecRequest {
  readonly command: string
  readonly args?: ReadonlyArray<string>
  readonly cwd?: string
  /** Added to the Sandbox's own environment for this command. */
  readonly env?: Readonly<Record<string, string>>
  readonly user?: string
  /** Fed to the command's stdin; the command sees end of input after it. */
  readonly stdin?: string | Uint8Array
}

/** `sh -c script`, the way most of the Runner's commands are run. */
export const shell = (script: string, options?: Omit<ExecRequest, "command" | "args">) => ({
  ...options,
  command: "sh",
  args: ["-c", script],
})

/** Output from a running command, in the order the guest produced it, ending with `Exit`. */
export type ExecEvent =
  | { readonly _tag: "Stdout"; readonly data: Uint8Array }
  | { readonly _tag: "Stderr"; readonly data: Uint8Array }
  | { readonly _tag: "Exit"; readonly exitCode: number }

/**
 * A command started with its stdin left open, for a long-lived server the Runner talks to, such
 * as `tmux -C` for the terminal mirror (Tmux.ts).
 */
export interface SpawnedCommand {
  /** The command's output as it comes, ending with `Exit`. Run it once. */
  readonly events: Stream.Stream<ExecEvent, SandboxError>
  /** Writes to the command's stdin. */
  readonly write: (data: string | Uint8Array) => Effect.Effect<void, SandboxError>
  /** Closes the command's stdin, so it sees end of input. Does nothing the second time. */
  readonly closeStdin: Effect.Effect<void>
}

/** A finished command's output, decoded as UTF-8. */
export interface ExecResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

// ── Observing Sandboxes ────────────────────────────────────────────────────

/** A Session's Sandbox and volumes as the backend finds them. */
export interface SandboxListing {
  readonly sessionId: SessionId
  /**
   * The mark of the Runner that made them (Naming.ts), or undefined for ones made before
   * Sandboxes carried a mark, which belong to no Runner.
   */
  readonly runner: string | undefined
  /** `Destroyed` when only the Session's volumes are left. */
  readonly state: SandboxState
  /** The backend's names for the Session's volumes. */
  readonly volumes: ReadonlyArray<string>
}

export interface SandboxMetrics {
  readonly cpuPercent: number
  /** Memory in use inside the guest. */
  readonly memoryBytes: number
  readonly memoryLimitBytes: number
  /** What the Sandbox costs the host: its high-water mark until it stops. Null if unknown. */
  readonly hostResidentBytes: number | null
  readonly uptimeMs: number
}

/** A saved root filesystem, as {@link SandboxSnapshots.list} finds it. */
export interface SnapshotListing {
  /** Its name within its group. */
  readonly name: string
  /** How to restore it. */
  readonly reference: string
}

/**
 * Saving a stopped Sandbox's root filesystem, and booting new Sandboxes from it: how an
 * Environment's build is kept (ADR 0009). Volumes and host mounts are not saved. Snapshots are
 * kept in groups, and a backend keeps each Runner's groups apart from other Runners'.
 */
export interface SandboxSnapshots {
  /**
   * Saves the stopped Sandbox as `name` in `group`, and returns how to restore it. Names and
   * groups are as `isSnapshotName` and `isSnapshotGroup` allow (Naming.ts).
   */
  readonly snapshot: (
    sessionId: SessionId,
    group: string,
    name: string,
  ) => Effect.Effect<string, SandboxError>
  /**
   * Boots a new Sandbox for the spec's Session from a saved root filesystem, on the spec's
   * mounts, resources and working directory, and starts Docker if the spec has it, as `create`
   * does. The spec's image is ignored, and so is its `env`: pass environment per command. The
   * Session must have no Sandbox.
   */
  readonly restore: (spec: SandboxSpec, reference: string) => Effect.Effect<void, SandboxError>
  /** The snapshots in `group`. */
  readonly list: (group: string) => Effect.Effect<ReadonlyArray<SnapshotListing>, SandboxError>
  /**
   * Removes every snapshot in `group` but the named ones, which must exist, newest first: the
   * first becomes the group's head. With no names the whole group goes. Sandboxes booted from a
   * removed snapshot keep working.
   */
  readonly retain: (
    group: string,
    names: ReadonlyArray<string>,
  ) => Effect.Effect<void, SandboxError>
}

// ── Errors ─────────────────────────────────────────────────────────────────

/** The Session has no Sandbox. */
export class SandboxNotFound extends Data.TaggedError("SandboxNotFound")<{
  readonly sessionId: SessionId
}> {}

/** `create` found the Session already has a Sandbox. */
export class SandboxAlreadyExists extends Data.TaggedError("SandboxAlreadyExists")<{
  readonly sessionId: SessionId
}> {}

/** The operation needs a running Sandbox, and this one is not. */
export class SandboxNotRunning extends Data.TaggedError("SandboxNotRunning")<{
  readonly sessionId: SessionId
  readonly state: SandboxState
}> {}

/** The spec can't be built, such as a Session id that can't name a Sandbox. */
export class InvalidSandboxSpec extends Data.TaggedError("InvalidSandboxSpec")<{
  readonly message: string
}> {}

/** The backend failed underneath, such as a file that doesn't exist or a VM that won't boot. */
export class SandboxBackendError extends Data.TaggedError("SandboxBackendError")<{
  readonly operation: string
  readonly message: string
  readonly cause?: unknown
}> {}

export type SandboxError =
  | SandboxNotFound
  | SandboxAlreadyExists
  | SandboxNotRunning
  | InvalidSandboxSpec
  | SandboxBackendError

// ── The service ────────────────────────────────────────────────────────────

export interface SandboxBackendShape {
  /** The mark of the Runner this backend works for, put on everything it makes. */
  readonly runner: string
  /**
   * Creates the Session's volumes where missing and boots a new Sandbox on them. Existing
   * volumes are reused as they are, which is how a fresh Sandbox wakes on old data.
   */
  readonly create: (spec: SandboxSpec) => Effect.Effect<void, SandboxError>
  /** Boots the Session's stopped Sandbox again. Does nothing if it is running. */
  readonly start: (sessionId: SessionId) => Effect.Effect<void, SandboxError>
  /**
   * Stops the Session's Sandbox, first stopping its Docker containers cleanly. Its root
   * filesystem and volumes are kept. Does nothing if it is not running.
   */
  readonly stop: (sessionId: SessionId) => Effect.Effect<void, SandboxError>
  /**
   * Stops and removes the Session's Sandbox and its volumes, but those `keepVolumes` names by key,
   * or all of them when it is `true`. Never touches host mounts. Succeeds when there is nothing
   * left to remove.
   */
  readonly destroy: (
    sessionId: SessionId,
    options?: { readonly keepVolumes?: true | ReadonlyArray<string> },
  ) => Effect.Effect<void, SandboxError>
  /** Where the Session's Sandbox is: `Destroyed` when it has none. */
  readonly state: (sessionId: SessionId) => Effect.Effect<SandboxState, SandboxError>
  /**
   * Every Sandbox and volume named as a Session's on this host, grouped by Session: this Runner's,
   * other Runners' and unmarked ones alike.
   */
  readonly list: Effect.Effect<ReadonlyArray<SandboxListing>, SandboxError>
  /**
   * Runs a command in the running Sandbox, streaming its output as it comes. Interrupting the
   * stream kills the command.
   */
  readonly execStream: (
    sessionId: SessionId,
    request: ExecRequest,
  ) => Stream.Stream<ExecEvent, SandboxError>
  /**
   * Starts a command in the running Sandbox with its stdin open for writing. Closing the scope
   * kills the command if it is still running. `request.stdin` is ignored: write instead.
   */
  readonly spawn: (
    sessionId: SessionId,
    request: ExecRequest,
  ) => Effect.Effect<SpawnedCommand, SandboxError, Scope.Scope>
  /** Runs a command to completion and returns its output. */
  readonly exec: (
    sessionId: SessionId,
    request: ExecRequest,
  ) => Effect.Effect<ExecResult, SandboxError>
  readonly readFile: (sessionId: SessionId, path: string) => Effect.Effect<Uint8Array, SandboxError>
  /** Reads a whole file as UTF-8 text, without starting a process in the guest. */
  readonly readTextFile: (sessionId: SessionId, path: string) => Effect.Effect<string, SandboxError>
  /** Writes a whole file, replacing it, and makes any missing parent directories. */
  readonly writeFile: (
    sessionId: SessionId,
    path: string,
    data: string | Uint8Array,
  ) => Effect.Effect<void, SandboxError>
  /** Current usage, or none while the Sandbox is not running or its metrics aren't ready yet. */
  readonly metrics: (
    sessionId: SessionId,
  ) => Effect.Effect<Option.Option<SandboxMetrics>, SandboxError>
  /** Present when the backend can snapshot and restore. */
  readonly snapshots: Option.Option<SandboxSnapshots>
}

export class SandboxBackend extends Context.Service<SandboxBackend, SandboxBackendShape>()(
  "@claude-hub/runner/SandboxBackend",
) {}

/** Runs an {@link ExecEvent} stream to the end and collects it, for a backend's `exec`. */
export const collectExec = <E>(events: Stream.Stream<ExecEvent, E>): Effect.Effect<ExecResult, E> =>
  Effect.gen(function* () {
    const stdout: Array<Uint8Array> = []
    const stderr: Array<Uint8Array> = []
    let exitCode = -1
    yield* Stream.runForEach(events, (event) =>
      Effect.sync(() => {
        switch (event._tag) {
          case "Stdout":
            stdout.push(event.data)
            break
          case "Stderr":
            stderr.push(event.data)
            break
          case "Exit":
            exitCode = event.exitCode
            break
        }
      }),
    )
    return { exitCode, stdout: decode(stdout), stderr: decode(stderr) }
  })

const decode = (chunks: ReadonlyArray<Uint8Array>) =>
  new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))))
