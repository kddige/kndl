import { Schema } from "effect"

// Which commit of kndl a Hub or Runner runs (ADR 0011): a Runner says in its RunnerHello,
// and the Hub knows its own, so the Runners page can show each Runner's and whether it is behind.
// Reading it from a checkout is `@kndl/protocol/checkout`'s.

/** A full commit id, as `git rev-parse` prints it: 40 hex digits (SHA-1) or 64 (SHA-256). */
export const CommitIdPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

/**
 * A full commit id, lowercase. Every commit that travels between the Hub, its Runners and the CLI
 * is one: a Runner hands the Hub's to git, so nothing else may decode, such as a short id or
 * `--upload-pack=…`, which git would read as an option.
 */
export const CommitId = Schema.String.check(Schema.isPattern(CommitIdPattern))
export type CommitId = typeof CommitId.Type

/**
 * A Release's version (ADR 0025), like `2026.10.1`: the year, the month and the Release's number
 * in the month, none zero-padded. Its tag is the version with a `v` before it.
 */
export const ReleaseVersionPattern = /^[1-9]\d{3}\.([1-9]|1[0-2])\.[1-9]\d*$/

/** A Release's version, without its tag's `v`. */
export const ReleaseVersion = Schema.String.check(Schema.isPattern(ReleaseVersionPattern))
export type ReleaseVersion = typeof ReleaseVersion.Type

/**
 * The commit a Hub or Runner runs, the branch its checkout follows, if it is on one, and the
 * Release, if the commit is one's (ADR 0025). `release` is optional, so a peer from before it
 * leaves it out, and ignores it when it's there.
 */
export const BuildVersion = Schema.Struct({
  commit: CommitId,
  branch: Schema.optionalKey(Schema.NonEmptyString),
  release: Schema.optionalKey(ReleaseVersion),
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

/**
 * A version as people read it: the commit's first 12 characters, and its branch; on a Release,
 * the Release first, with those after it.
 */
export function describeBuild(version: BuildVersion): string {
  const commit = version.commit.slice(0, 12)
  if (version.release !== undefined) {
    const at = version.branch === undefined ? commit : `${commit}, ${version.branch}`
    return `${version.release} (${at})`
  }
  return version.branch === undefined ? commit : `${commit} (${version.branch})`
}

const parts = (version: string) => version.split(".").map(Number) as [number, number, number]

/**
 * The Release among a commit's tags (ADR 0025), without the tag's `v`. A tag with a suffix, like
 * `-beta.1`, or zero-padding isn't a Release's. Of several, the newest.
 */
export function releaseOf(tags: ReadonlyArray<string>): ReleaseVersion | undefined {
  return tags
    .flatMap((tag) => {
      const version = tag.startsWith("v") ? tag.slice(1) : ""
      return ReleaseVersionPattern.test(version) ? [version] : []
    })
    .toSorted((a, b) => {
      const [x, y] = [parts(a), parts(b)]
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
    })
    .at(-1)
}
