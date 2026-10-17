import { Schema } from "effect"
import { CommitId, ReleaseVersion } from "./Build.ts"

// What `kndl update` leaves in the home's `update/` (issue #360), so that it runs with nobody at
// the terminal and the Hub can follow it: the Hub starts it from the web, and reads these after
// its restart (#359).
//
//   update/lock          held while an update runs: one runs at a time, from the CLI or the Hub
//   update/status.json   the latest update, rewritten as each of its steps starts
//   update/update.log    the output of the latest update's steps, emptied as one starts
//
// The CLI writes them; anything may read them. A file is replaced whole, written beside its path
// and renamed over it, so a reader never sees half of one.

/** The lock, relative to the home. */
export const UpdateLockPath = "update/lock"

/** The status of the latest update, relative to the home. */
export const UpdateStatusPath = "update/status.json"

/** The log of the latest update, relative to the home. */
export const UpdateLogPath = "update/update.log"

/** Who started an update: `kndl update` at a terminal, or the Hub (`--source hub`). */
export const UpdateSource = Schema.Literals(["cli", "hub"])
export type UpdateSource = typeof UpdateSource.Type

/**
 * Who holds the lock: the process running the update, since when (in epoch milliseconds), and who
 * started it.
 */
export const UpdateLock = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  startedAt: Schema.Natural,
  source: UpdateSource,
})
export type UpdateLock = typeof UpdateLock.Type

/**
 * Whether the lock is held still: its process runs, and started after the machine last booted. A
 * lock that isn't is stale, left by an update that was killed or that the machine went down
 * under, and the next update takes it over, even when its pid now belongs to another process.
 */
export function updateLockHeld(
  lock: UpdateLock,
  machine: {
    /** Whether a process with this pid runs. */
    readonly running: (pid: number) => boolean
    /** When the machine booted, in epoch milliseconds. */
    readonly bootedAt: number
  },
): boolean {
  return lock.startedAt >= machine.bootedAt && machine.running(lock.pid)
}

/** What a second update says, refused while the lock is held. */
export function updateRunningText(lock: UpdateLock): string {
  return `An update is already running (pid ${lock.pid}, started ${new Date(lock.startedAt).toISOString()}).`
}

/**
 * Where an update is:
 * - `Running`: at `step`;
 * - `Succeeded`: it ended where it meant to, or stayed where it was, as a pinned install does;
 * - `Failed`: it failed before it moved the checkout, or rolling back failed too;
 * - `RolledBack`: it failed after it moved the checkout, which is back where it was, built and
 *   restarted there.
 */
export const UpdateState = Schema.Literals(["Running", "Succeeded", "Failed", "RolledBack"])
export type UpdateState = typeof UpdateState.Type

/** The latest update, as `status.json` holds it. */
export const UpdateStatus = Schema.Struct({
  /** Tells one update from the next. */
  id: Schema.NonEmptyString,
  source: UpdateSource,
  startedAt: Schema.Natural,
  finishedAt: Schema.optionalKey(Schema.Natural),
  /** Where the install was: its commit, and its Release, when the commit is one's. */
  from: Schema.Struct({
    commit: CommitId,
    version: Schema.optionalKey(ReleaseVersion),
  }),
  /**
   * Where it moves to: the branch, tag or commit, as `update` names it, and the commit that is,
   * once the checkout is there. None when it stays where it is.
   */
  target: Schema.optionalKey(
    Schema.Struct({
      ref: Schema.NonEmptyString,
      commit: Schema.optionalKey(CommitId),
    }),
  ),
  /** The step running now, or the last one, for people: "Building the web UI". */
  step: Schema.String,
  state: UpdateState,
  /** Why it failed: when rolling back failed too, both errors. */
  error: Schema.optionalKey(Schema.String),
})
export type UpdateStatus = typeof UpdateStatus.Type

/** Reads `update/lock`'s text: `None` when it isn't a lock. */
export const decodeUpdateLock = Schema.decodeUnknownOption(Schema.fromJsonString(UpdateLock))

/** Reads `update/status.json`'s text: `None` when it isn't a status. */
export const decodeUpdateStatus = Schema.decodeUnknownOption(Schema.fromJsonString(UpdateStatus))
