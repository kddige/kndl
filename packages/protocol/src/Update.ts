import { Schema } from "effect"
import { BuildVersion, type RunnerVersionStatus } from "./Build.ts"

// Runners follow the Hub's commit (ADR 0011, issue #87). The Hub decides when a Runner updates and
// drains it: it stops starting and waking Sessions there, lets running Turns finish (or stops
// them), and puts its Active Sessions to sleep. The Runner decides whether it may move to the
// commit (only one reachable from origin/main, unless RUNNER_UPDATE_ANY_COMMIT=1), moves its
// checkout, builds, and restarts; a failed update is rolled back and reported.
//
//   Hub                                Runner
//   CheckUpdate { target }      ──▶   fetches origin, checks the commit
//                               ◀──   UpdateChecked { target, refusal? }
//   (drains its Sessions)
//   ApplyUpdate { target }      ──▶   checkout, bun install, build, check it loads
//                               ◀──   UpdateProgress { step } …
//                                     exits to be restarted by its service, on the new commit
//                               ◀──   (or) UpdateFailed { rolledBack }
//
// Every field and message here was added in protocol version 1 as optional, so a Runner from
// before it still connects: it doesn't say it updates itself, so the Hub never asks it to.

/** How long the Hub lets a draining Runner's Turns run before it stops them. */
export const UpdateDrainMillis = 10 * 60 * 1000

/**
 * Whether a Runner updates itself when the Hub asks, which it says in its hello:
 * - `self`: it runs as the claude-hub service from the CLI's checkout, `<home>/app`, so it may
 *   move that checkout and exit to be restarted by its service manager.
 * - otherwise it is updated by hand, and `reason` says why: it runs from a developer's checkout,
 *   which it never rewrites, or isn't run by a service that would start it again.
 */
export const RunnerUpdater = Schema.Struct({
  self: Schema.Boolean,
  reason: Schema.optionalKey(Schema.String),
  /** Its `runner.env` sets RUNNER_UPDATE_ANY_COMMIT=1: it follows a commit not on main too. */
  anyCommit: Schema.optionalKey(Schema.Literal(true)),
})
export type RunnerUpdater = typeof RunnerUpdater.Type

/**
 * Why a Runner won't move to the Hub's commit:
 * - `NotOnMain`: the commit isn't reachable from origin/main, and the Runner doesn't follow any
 *   commit;
 * - `NotFound`: origin has no such commit (the Hub runs one that was never pushed);
 * - `Manual`: it doesn't update itself (see {@link RunnerUpdater});
 * - `Failed`: it couldn't tell, as when fetching from origin failed.
 */
export const UpdateRefusalReason = Schema.Literals(["NotOnMain", "NotFound", "Manual", "Failed"])
export type UpdateRefusalReason = typeof UpdateRefusalReason.Type

export const UpdateRefusal = Schema.Struct({
  reason: UpdateRefusalReason,
  message: Schema.String,
})
export type UpdateRefusal = typeof UpdateRefusal.Type

/** A Runner's update that failed: what went wrong, and whether it is back on the commit it ran. */
export const UpdateFailure = Schema.Struct({
  target: BuildVersion,
  message: Schema.String,
  /** Its checkout is back on the commit it ran before; false when even that failed. */
  rolledBack: Schema.Boolean,
  at: Schema.Natural,
})
export type UpdateFailure = typeof UpdateFailure.Type

// ── Hub to Runner ──────────────────────────────────────────────────────────

/** Asks whether the Runner may and can move to `target`; answered with {@link UpdateChecked}. */
export const CheckUpdate = Schema.TaggedStruct("CheckUpdate", {
  target: BuildVersion,
})
export type CheckUpdate = typeof CheckUpdate.Type

/**
 * Move to `target` and restart: sent once the Runner's Sessions are all asleep. The Runner checks
 * the commit again; it answers with progress, then disconnects to restart, or with an
 * {@link UpdateFailed}.
 */
export const ApplyUpdate = Schema.TaggedStruct("ApplyUpdate", {
  target: BuildVersion,
})
export type ApplyUpdate = typeof ApplyUpdate.Type

// ── Runner to Hub ──────────────────────────────────────────────────────────

/** Answers a {@link CheckUpdate}: the Runner will move to `target`, unless it says why not. */
export const UpdateChecked = Schema.TaggedStruct("UpdateChecked", {
  target: BuildVersion,
  refusal: Schema.optionalKey(UpdateRefusal),
})
export type UpdateChecked = typeof UpdateChecked.Type

/** Where an applied update is: for the Runners page. */
export const UpdateStep = Schema.Literals(["Fetching", "CheckingOut", "Installing", "Restarting"])
export type UpdateStep = typeof UpdateStep.Type

export const UpdateProgress = Schema.TaggedStruct("UpdateProgress", {
  target: BuildVersion,
  step: UpdateStep,
})
export type UpdateProgress = typeof UpdateProgress.Type

/**
 * An update failed. Sent on the connection the ApplyUpdate came on when the Runner rolled back
 * without restarting; after a restart, the failure is in its hello's `lastUpdate` instead.
 */
export const UpdateFailed = Schema.TaggedStruct("UpdateFailed", {
  failure: UpdateFailure,
})
export type UpdateFailed = typeof UpdateFailed.Type

// ── Hub to web ─────────────────────────────────────────────────────────────

/**
 * A Runner's update, as the Runners page shows it:
 * - `Checking`: asked whether it may move to the commit;
 * - `Draining`: no new Sessions; waiting for `waitingFor` Sessions' Turns to end (stopped at
 *   `deadline`, or at once with `now`), then putting them to sleep;
 * - `Applying`: moving to the commit, at `step`;
 * - `Restarting`: it disconnected to restart on the commit;
 * - `Refused`: it won't move to the commit (see {@link UpdateRefusalReason});
 * - `Failed`: it tried and failed, rolled back or not.
 */
export const RunnerUpdateState = Schema.Union([
  Schema.TaggedStruct("Checking", { target: BuildVersion, since: Schema.Natural }),
  Schema.TaggedStruct("Draining", {
    target: BuildVersion,
    since: Schema.Natural,
    deadline: Schema.Natural,
    now: Schema.Boolean,
    waitingFor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.TaggedStruct("Applying", {
    target: BuildVersion,
    since: Schema.Natural,
    step: Schema.optionalKey(UpdateStep),
  }),
  Schema.TaggedStruct("Restarting", { target: BuildVersion, since: Schema.Natural }),
  Schema.TaggedStruct("Refused", {
    target: BuildVersion,
    at: Schema.Natural,
    refusal: UpdateRefusal,
  }),
  Schema.TaggedStruct("Failed", { failure: UpdateFailure }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type RunnerUpdateState = typeof RunnerUpdateState.Type

/** Whether the update is under way, rather than over (refused or failed). */
export function updateUnderWay(update: RunnerUpdateState | undefined): boolean {
  return update !== undefined && update._tag !== "Refused" && update._tag !== "Failed"
}

/** Says a Runner needs an update, when Sessions can't be started or woken there. */
export const NeedsUpdateText = "this Runner needs an update"
/** Says a Runner is updating, when Sessions can't be started or woken there. */
export const UpdatingText = "this Runner is updating"

/**
 * Why no Session may be started or woken on a Runner now, or `undefined` when one may. A Runner
 * behind the Hub keeps its running Sessions, but a new or woken one may need what the Hub's commit
 * added (ADR 0011); one updating is about to restart.
 */
export function sessionsRefusal(
  status: RunnerVersionStatus,
  update: RunnerUpdateState | undefined,
): string | undefined {
  if (updateUnderWay(update)) return UpdatingText
  if (status === "Behind") return NeedsUpdateText
  return undefined
}

/** Says a refusal as the Runners page does: "refuses: not on main". */
export function refusalText(refusal: UpdateRefusal): string {
  switch (refusal.reason) {
    case "NotOnMain":
      return "refuses: not on main"
    case "NotFound":
      return "refuses: commit not on origin"
    case "Manual":
      return "updates by hand"
    case "Failed":
      return "couldn't check the commit"
  }
}
