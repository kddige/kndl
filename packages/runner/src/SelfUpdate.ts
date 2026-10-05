// A Runner following the Hub's commit (issue #87, ADR 0011): the decisions, kept pure. Updater.ts
// runs git and bun, writes the marker, and restarts.
//
// The Hub drains the Runner (no new Sessions, Turns end, Active Sessions sleep); the Runner only
// moves its code:
//
//   check     fetch origin; refuse a commit origin hasn't got, or one not reachable from
//             origin/main unless RUNNER_UPDATE_ANY_COMMIT=1 (checkRefusal)
//   move      write the marker (Applying, with the commit it runs), check out the commit,
//             bun install, build the mod, and check the Runner loads on it (applyPlan)
//   restart   exit with RestartExitCode: the service manager starts it again on the new commit
//   confirm   on the new commit, the Hub's welcome ends the update: the marker goes
//
// Anything failing while moving rolls the checkout back, and the Runner, which never stopped,
// reports it. A new commit that keeps failing to reach the Hub's welcome (MaxBootsBeforeWelcome
// starts) is rolled back as it starts (bootDecision), and the failure is reported in the next
// hello, from the marker.
//
// Who updates itself (updaterOf): only a Runner the claude-hub service runs from the installed
// checkout, `<home>/app`. A Runner a developer runs with `bun run runner` never rewrites their
// checkout: it says the Hub wants another commit and goes on running. Nor does one run by hand
// from the installed checkout, which nothing would start again after its restart.
import {
  BuildVersion,
  CommitId,
  type RunnerUpdater,
  UpdateFailure,
  type UpdateRefusal,
  type UpdateStep,
} from "@claude-hub/protocol"
import { Schema } from "effect"

/** In `runner.env`: follow any commit the Hub runs, not only one on origin/main (a dev Hub). */
export const UpdateAnyCommitVariable = "RUNNER_UPDATE_ANY_COMMIT"

/**
 * Set by the claude-hub service on the process it runs (`runner`): a restart is safe, since the
 * service manager starts it again.
 */
export const ServiceVariable = "CLAUDE_HUB_SERVICE"

/**
 * The exit code that asks for a restart: EX_TEMPFAIL. The services restart a Runner that exits
 * unsuccessfully (launchd's KeepAlive with SuccessfulExit false, systemd's Restart=on-failure).
 */
export const RestartExitCode = 75

/**
 * Set on the Runner started only to check it loads, on the commit it moves to: it imports all its
 * code, checks the mod is built, and exits 0 without connecting.
 */
export const LoadCheckVariable = "CLAUDE_HUB_RUNNER_LOAD_CHECK"

/** How many times a new commit may start without the Hub's welcome before it is rolled back. */
export const MaxBootsBeforeWelcome = 3

/** The branch an update checks a commit against. */
export const MainBranch = "main"

/** What says whether the Runner may update itself. */
export interface UpdaterFacts {
  /** It runs in a checkout's dev home (no CLAUDE_HUB_HOME): `bun run runner`. */
  readonly devHome: boolean
  /** The checkout the Runner runs from, its real path; `undefined` outside a git checkout. */
  readonly checkout: string | undefined
  /** The installed checkout, `<home>/app`, its real path; `undefined` when there is none. */
  readonly app: string | undefined
  /** {@link ServiceVariable}'s value. */
  readonly service: string | undefined
  /** {@link UpdateAnyCommitVariable}'s value. */
  readonly anyCommit: string | undefined
}

/** Whether the Runner updates itself when the Hub asks, as its hello says; why not, if not. */
export function updaterOf(facts: UpdaterFacts): RunnerUpdater {
  const anyCommit = facts.anyCommit === "1" ? { anyCommit: true as const } : {}
  const manual = (reason: string): RunnerUpdater => ({ self: false, reason, ...anyCommit })
  if (facts.checkout === undefined) return manual("it doesn't run from a git checkout")
  if (facts.devHome) {
    return manual(
      "it runs from a developer's checkout (bun run runner), which it never rewrites: pull and restart it there",
    )
  }
  if (facts.app === undefined || facts.checkout !== facts.app) {
    return manual(
      `it runs from ${facts.checkout}, not the installed checkout${facts.app === undefined ? "" : ` ${facts.app}`}`,
    )
  }
  if (facts.service !== "runner") {
    return manual(
      "it isn't run by the claude-hub service, which would start it again: run `claude-hub update` on its machine",
    )
  }
  return { self: true, ...anyCommit }
}

/** What git says about the commit to move to, after fetching origin. */
export interface CommitFacts {
  /** Why fetching from origin failed, if it did. */
  readonly fetchError: string | undefined
  /** The checkout has the commit, after the fetch. */
  readonly exists: boolean
  /** It is reachable from origin/main. */
  readonly onMain: boolean
}

/** Why the Runner won't move to `target`, or `undefined` when it will. */
export function checkRefusal(
  updater: RunnerUpdater,
  target: BuildVersion,
  facts: CommitFacts | undefined,
): UpdateRefusal | undefined {
  if (!updater.self) {
    return {
      reason: "Manual",
      message: `It doesn't update itself: ${updater.reason ?? "unknown"}.`,
    }
  }
  const commit = short(target.commit)
  if (facts === undefined) return { reason: "Failed", message: "It couldn't ask git." }
  if (facts.fetchError !== undefined) {
    return { reason: "Failed", message: `It couldn't fetch from origin: ${facts.fetchError}` }
  }
  if (!facts.exists) {
    return {
      reason: "NotFound",
      message: `origin has no commit ${commit}: push it before the Hub's Runners can follow it.`,
    }
  }
  if (!facts.onMain && updater.anyCommit !== true) {
    return {
      reason: "NotOnMain",
      message: `${commit} isn't on origin/${MainBranch}. To follow any commit, set ${UpdateAnyCommitVariable}=1 in the Runner's runner.env.`,
    }
  }
  return undefined
}

/** Where the checkout is: the commit, and the branch it is on (none when detached). */
export interface Position {
  readonly commit: CommitId
  readonly branch?: string | undefined
}

/**
 * What applying an update does:
 * - `Restart`: the checkout is at the commit already, as on the Hub's machine, whose checkout
 *   `claude-hub update` moved for both: only check the Runner loads, and restart. Nothing to roll
 *   back: this Runner didn't move it.
 * - `Move`: check out the commit (`checkout`, git's arguments), install, build, check, restart;
 *   `back` returns the checkout to where it was.
 */
export type ApplyPlan =
  | { readonly _tag: "Restart" }
  | {
      readonly _tag: "Move"
      readonly checkout: ReadonlyArray<string>
      readonly back: ReadonlyArray<string>
    }

/**
 * How to move from `head` to `target`. A checkout on a branch the commit is on stays on that
 * branch, moved to the commit, so a later `claude-hub update` follows it on; otherwise the
 * checkout is detached at the commit, as `claude-hub update --ref <commit>` would leave it.
 */
export function applyPlan(
  head: Position,
  target: BuildVersion,
  /** `target` is reachable from origin/<head's branch>. */
  onHeadBranch: boolean,
): ApplyPlan {
  if (head.commit === target.commit) return { _tag: "Restart" }
  return {
    _tag: "Move",
    checkout: checkoutArgs({
      commit: target.commit,
      branch: onHeadBranch ? head.branch : undefined,
    }),
    back: checkoutArgs(head),
  }
}

// The git arguments that name a commit or ref, which may be the Hub's. Each puts `--end-of-options`
// before it, so git never reads one as an option (`--upload-pack=<command>` would run the command
// on the Runner's machine), should anything but a commit id ever get past the protocol's CommitId.

/** Fetches `commit` from origin by its id, for one on no branch origin advertises. */
export const fetchCommitArgs = (commit: string): ReadonlyArray<string> => [
  "fetch",
  "--quiet",
  "--end-of-options",
  "origin",
  commit,
]

/** Exits 0 when the checkout has `commit`. */
export const hasCommitArgs = (commit: string): ReadonlyArray<string> => [
  "cat-file",
  "-e",
  "--end-of-options",
  `${commit}^{commit}`,
]

/** Exits 0 when `commit` is reachable from `ref`, 1 when it isn't. */
export const isAncestorArgs = (commit: string, ref: string): ReadonlyArray<string> => [
  "merge-base",
  "--is-ancestor",
  "--end-of-options",
  commit,
  ref,
]

/** git's arguments that put the checkout at `position`, discarding changes to its files. */
export function checkoutArgs(position: Position): ReadonlyArray<string> {
  return position.branch === undefined
    ? ["checkout", "--force", "--detach", "--end-of-options", position.commit]
    : ["checkout", "--force", "-B", position.branch, "--end-of-options", position.commit]
}

/** What the Runner keeps across its restart, in `<home>/runner-update.json`. */
export const Marker = Schema.Union([
  /** It is moving from `from` to `target`; `boots` counts its starts on `target` so far. */
  Schema.TaggedStruct("Applying", {
    from: Schema.Struct({ commit: CommitId, branch: Schema.optional(Schema.String) }),
    target: BuildVersion,
    boots: Schema.Int,
    at: Schema.Number,
  }),
  /**
   * Its last update, from `from`, failed: told to the Hub in each hello while it runs `from`.
   * Without `from` (it couldn't read its checkout after rolling back), the next start clears it.
   */
  Schema.TaggedStruct("Failed", {
    from: Schema.optionalKey(CommitId),
    failure: UpdateFailure,
  }),
])
export type Marker = typeof Marker.Type

/**
 * What to do with the marker as the Runner starts, on `head`:
 * - `Keep`: nothing to do (no marker, or a failure to report);
 * - `Write`: count this start on the new commit;
 * - `RollBack`: the new commit started too many times without the Hub's welcome; return to `from`
 *   and restart there, reporting `failure`;
 * - `Clear`: the marker is stale, since the checkout moved since.
 */
export type BootDecision =
  | { readonly _tag: "Keep" }
  | { readonly _tag: "Write"; readonly marker: Marker }
  | {
      readonly _tag: "RollBack"
      readonly back: ReadonlyArray<string>
      readonly failure: UpdateFailure
    }
  | { readonly _tag: "Clear" }

export function bootDecision(
  marker: Marker | undefined,
  head: string | undefined,
  at: number,
): BootDecision {
  if (marker === undefined) return { _tag: "Keep" }
  if (marker._tag === "Failed") {
    return marker.from !== undefined && marker.from === head ? { _tag: "Keep" } : { _tag: "Clear" }
  }
  // Moved elsewhere since: by a rollback that didn't get to write its failure, or by hand.
  if (head !== marker.target.commit) return { _tag: "Clear" }
  const boots = marker.boots + 1
  if (boots > MaxBootsBeforeWelcome) {
    return {
      _tag: "RollBack",
      back: checkoutArgs(marker.from),
      failure: {
        target: marker.target,
        message: `It started on ${short(marker.target.commit)} ${marker.boots} times without the Hub welcoming it, so it went back to ${short(marker.from.commit)}: see its log.`,
        rolledBack: true,
        at,
      },
    }
  }
  return { _tag: "Write", marker: { ...marker, boots } }
}

/** The marker once the Hub welcomed the Runner: an update it was applying is done. */
export function afterWelcome(marker: Marker | undefined): Marker | undefined {
  return marker?._tag === "Applying" ? undefined : marker
}

/** The failure to tell the Hub in the hello, from the marker. */
export function lastUpdateOf(marker: Marker | undefined): UpdateFailure | undefined {
  return marker?._tag === "Failed" ? marker.failure : undefined
}

/** Where moving to a commit failed, for the message. */
export type FailedAt = UpdateStep | "Checking"

const FailedAtText: Record<FailedAt, string> = {
  Checking: "checking the commit",
  Fetching: "fetching from origin",
  CheckingOut: "checking it out",
  Installing: "installing and building",
  Restarting: "checking the Runner loads on it",
}

/**
 * The failure to report, after the move failed at `step` with `error` and the checkout was put
 * back (`rolledBack`), or not: `undefined` when there was nothing to put back.
 */
export function failureOf(
  target: BuildVersion,
  step: FailedAt,
  error: string,
  rolledBack: boolean | undefined,
  at: number,
): UpdateFailure {
  const after =
    rolledBack === undefined
      ? ""
      : rolledBack
        ? ` It went back to the commit it ran.`
        : ` Going back to the commit it ran failed too: run \`claude-hub update\` on its machine.`
  return {
    target,
    message: `Updating to ${short(target.commit)} failed while ${FailedAtText[step]}: ${firstLines(error)}${after}`,
    rolledBack: rolledBack !== false,
    at,
  }
}

/**
 * What a Runner the Hub turned away logs, and does: `update` when it updates itself and the Hub
 * said its commit; otherwise it only says how to update it by hand.
 */
export function rejectedAdvice(
  updater: RunnerUpdater,
  hub: BuildVersion | undefined,
): { readonly update: boolean; readonly message: string } {
  const at =
    hub === undefined
      ? ""
      : ` (the Hub runs ${short(hub.commit)}${hub.branch === undefined ? "" : ` on ${hub.branch}`})`
  if (updater.self && hub !== undefined) {
    return { update: true, message: `Updating this Runner to the Hub's commit${at}.` }
  }
  const how = updater.self
    ? "run `claude-hub update` on this machine"
    : updater.reason?.startsWith("it runs from a developer's checkout")
      ? "pull this checkout to the Hub's commit and restart `bun run runner`"
      : "run `claude-hub update` on this machine"
  return {
    update: false,
    message: `To connect again, this Runner needs the Hub's version${at}: ${how}. Retrying meanwhile.`,
  }
}

const short = (commit: string) => commit.slice(0, 12)

/** A command's error, cut to its first lines: the Runners page shows it. */
function firstLines(text: string): string {
  const lines = text.trim().split("\n").slice(0, 4).join("\n")
  return lines.length > 600 ? `${lines.slice(0, 600)}…` : lines
}
