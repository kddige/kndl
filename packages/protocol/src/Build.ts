import { Schema } from "effect"

// Which commit of claude-hub a Hub or Runner runs (ADR 0011): a Runner says in its RunnerHello,
// and the Hub knows its own, so the Runners page can show each Runner's and whether it is behind.
// Reading it from a checkout is `@claude-hub/protocol/checkout`'s.

/** A full commit id, as `git rev-parse` prints it: 40 hex digits (SHA-1) or 64 (SHA-256). */
export const CommitIdPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

/**
 * A full commit id, lowercase. Every commit that travels between the Hub, its Runners and the CLI
 * is one: a Runner hands the Hub's to git, so nothing else may decode, such as a short id or
 * `--upload-pack=…`, which git would read as an option.
 */
export const CommitId = Schema.String.check(Schema.isPattern(CommitIdPattern))
export type CommitId = typeof CommitId.Type

/** The commit a Hub or Runner runs, and the branch its checkout follows, if it is on one. */
export const BuildVersion = Schema.Struct({
  commit: CommitId,
  branch: Schema.optionalKey(Schema.NonEmptyString),
})
export type BuildVersion = typeof BuildVersion.Type

/**
 * A Runner's commit against the Hub's:
 * - `Current`: the same commit;
 * - `Behind`: an older commit of the Hub's history, which updating the Runner fixes;
 * - `Differs`: a commit the Hub's history doesn't hold, such as a newer one or another branch's;
 * - `Unknown`: the Runner didn't say (it predates the version in the hello) or the Hub doesn't know
 *   its own (it doesn't run from a git checkout).
 */
export const RunnerVersionStatus = Schema.Literals(["Current", "Behind", "Differs", "Unknown"])
export type RunnerVersionStatus = typeof RunnerVersionStatus.Type

/**
 * How a Runner's version compares with the Hub's. `hubHolds` says whether the Hub's history holds
 * a commit (git merge-base --is-ancestor), `undefined` when it can't tell.
 */
export function runnerVersionStatus(
  runner: BuildVersion | undefined,
  hub: BuildVersion | undefined,
  hubHolds: (commit: string) => boolean | undefined,
): RunnerVersionStatus {
  if (runner === undefined || hub === undefined) return "Unknown"
  if (runner.commit === hub.commit) return "Current"
  const held = hubHolds(runner.commit)
  if (held === undefined) return "Unknown"
  return held ? "Behind" : "Differs"
}

/** A version as people read it: the commit's first 12 characters, and its branch. */
export function describeBuild(version: BuildVersion): string {
  const commit = version.commit.slice(0, 12)
  return version.branch === undefined ? commit : `${commit} (${version.branch})`
}
