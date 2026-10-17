import { Schema } from "effect"
import { type BuildVersion, Channel, CommitId, ReleaseVersion } from "./Build.ts"
import { RequestId } from "./Ids.ts"
import { EpochMillis } from "./Session.ts"

// The Hub checks GitHub for a newer kndl, and its Owner sees what it found on the Hub page (ADR
// 0028, #361). Only a Hub the kndl service runs from its install's own checkout, `<home>/app`,
// checks: on any other, such as a checkout run with `bun run hub`, there is nothing to update from
// the web, and its web clients are never told of any of this.
//
// What counts as newer follows the Hub's Channel (ADR 0025): on stable, a Release newer than the
// Hub's; on dev, main's head past the Hub's commit; on a ref `--ref` pinned, nothing.
//
//   web (the Owner's)                  Hub
//                               ◀──   WebWelcome { hubUpdate }, the last check's, kept in the DB
//   CheckHubUpdate              ──▶   checks GitHub now
//                               ◀──   HubUpdateChecked { requestId, update }
//                               ◀──   HubUpdateChecked { update } after every check, its own too
//
// Updating the Hub from the page builds on this (#362).

/** kndl's own repository on GitHub, which the Hub checks for a newer kndl. */
export const KndlRepo = "kddige/kndl"

/** The branch the dev Channel follows. */
export const DevBranch = "main"

/** GitHub's compare view of kndl from `base` to `head`, each a commit or a tag. */
export const kndlCompareUrl = (base: string, head: string) =>
  `https://github.com/${KndlRepo}/compare/${base}...${head}`

/** A Release's page on GitHub. */
export const kndlReleaseUrl = (version: ReleaseVersion) =>
  `https://github.com/${KndlRepo}/releases/tag/v${version}`

/** How many of the commits since the Hub's a dev Hub's check lists, the newest. */
export const MaxCommitTitles = 50

/**
 * What the Hub's install follows: a Channel, or what `--ref` pinned it to (ADR 0025), a branch
 * other than main, a tag or a commit, which nothing newer is offered for.
 */
export const HubFollows = Schema.Union([
  Schema.TaggedStruct("Channel", { channel: Channel }),
  Schema.TaggedStruct("Pinned", { ref: Schema.NonEmptyString }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type HubFollows = typeof HubFollows.Type

/**
 * What a Hub at `version` follows. Its recorded Channel; else main, which an install from before
 * Channels follows, as the dev Channel (ADR 0025); else pinned, to its branch, its Release's tag
 * or its commit.
 */
export function hubFollows(version: BuildVersion): HubFollows {
  if (version.channel !== undefined) return { _tag: "Channel", channel: version.channel }
  if (version.branch === DevBranch) return { _tag: "Channel", channel: "dev" }
  const ref =
    version.branch ??
    (version.release === undefined ? version.commit.slice(0, 12) : `v${version.release}`)
  return { _tag: "Pinned", ref }
}

/** A Release newer than the Hub's, with its notes. */
export const ReleaseNotes = Schema.Struct({
  version: ReleaseVersion,
  /** As on GitHub, markdown: its Highlights first, then its changes by area. */
  notes: Schema.String,
  /** Its page on GitHub. */
  url: Schema.String,
  publishedAt: Schema.optionalKey(EpochMillis),
})
export type ReleaseNotes = typeof ReleaseNotes.Type

/** A commit on main since the Hub's, by its title: its message's first line. */
export const CommitTitle = Schema.Struct({
  commit: CommitId,
  title: Schema.String,
})
export type CommitTitle = typeof CommitTitle.Type

/**
 * What a check found:
 * - `UpToDate`: nothing newer on the Hub's Channel;
 * - `NewerRelease`: on stable, Releases newer than the Hub's, newest first: the first is the one
 *   an update moves to;
 * - `NewerCommits`: on dev, main's head is `behindBy` commits past the Hub's. `commits` lists the
 *   newest of them, newest first, up to {@link MaxCommitTitles}.
 */
export const HubUpdateFound = Schema.Union([
  Schema.TaggedStruct("UpToDate", {}),
  Schema.TaggedStruct("NewerRelease", {
    releases: Schema.NonEmptyArray(ReleaseNotes),
    /** GitHub's compare view from the Hub's version to the newest Release. */
    compareUrl: Schema.String,
  }),
  Schema.TaggedStruct("NewerCommits", {
    head: CommitId,
    behindBy: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    commits: Schema.Array(CommitTitle),
    /** GitHub's compare view from the Hub's commit to main's head. */
    compareUrl: Schema.String,
  }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type HubUpdateFound = typeof HubUpdateFound.Type

/**
 * The Hub's update check, as its Owner sees it: what it follows, what the last check that worked
 * found and when, and the last one's failure, if it failed since. A pinned Hub never checks.
 */
export const HubUpdateState = Schema.Struct({
  follows: HubFollows,
  checked: Schema.optionalKey(Schema.Struct({ at: EpochMillis, found: HubUpdateFound })),
  failed: Schema.optionalKey(Schema.Struct({ at: EpochMillis, message: Schema.String })),
})
export type HubUpdateState = typeof HubUpdateState.Type

/**
 * What the update the state offers moves the Hub to, as a key the Owner dismisses its banner by:
 * `v2026.10.4` on stable, main's head commit on dev. `undefined` when it offers none.
 */
export function hubUpdateTarget(state: HubUpdateState | undefined): string | undefined {
  const found = state?.checked?.found
  switch (found?._tag) {
    case "NewerRelease":
      return `v${found.releases[0].version}`
    case "NewerCommits":
      return found.head
    case "UpToDate":
    case undefined:
      return undefined
  }
}

/** Why the Hub refuses a {@link CheckHubUpdate} where it doesn't check, as it says it. */
export const hubUpdatesOffMessage =
  "This Hub doesn't check for updates: only one the kndl service runs from its install does."

// ── Web to Hub ─────────────────────────────────────────────────────────────

/**
 * Check for a newer kndl now, rather than at the next periodic check: the Owner's alone. Answered
 * with a {@link HubUpdateChecked}, whether the check worked or not, or a CommandFailed.
 */
export const CheckHubUpdate = Schema.TaggedStruct("CheckHubUpdate", {
  requestId: RequestId,
})
export type CheckHubUpdate = typeof CheckHubUpdate.Type

// ── Hub to web ─────────────────────────────────────────────────────────────

/**
 * The Hub's update check, after a check: sent to the Owner's web clients alone, after every check,
 * and in answer to a {@link CheckHubUpdate}.
 */
export const HubUpdateChecked = Schema.TaggedStruct("HubUpdateChecked", {
  /** The CheckHubUpdate this answers, for the client that sent it. */
  requestId: Schema.optionalKey(RequestId),
  update: HubUpdateState,
})
export type HubUpdateChecked = typeof HubUpdateChecked.Type
