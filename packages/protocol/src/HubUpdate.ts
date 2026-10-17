import { Schema } from "effect"
import { type BuildVersion, Channel, CommitId, ReleaseVersion } from "./Build.ts"
import { RequestId } from "./Ids.ts"
import { EpochMillis } from "./Session.ts"
import { UpdateStatus } from "./UpdateStatus.ts"

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
// The Owner updates the Hub from the page, and picks its Channel (#362). The Hub starts `kndl
// update --source hub` outside its own service, and follows it in `<home>/update/` (UpdateStatus.ts):
//
//                               ◀──   WebWelcome { hubUpdateRun }, the latest update, ended or not
//   UpdateHub { now, channel? } ──▶   launches `kndl update --source hub [--now] [--channel c]`
//                               ◀──   HubUpdateStarted { requestId }
//                               ◀──   HubUpdateRunChanged { run } as status.json changes: its step
//   (the Hub restarts under it; the new Hub's welcome has how it ended, with the end of the log)
//
// An update started at a terminal shows the same way, from its status file.

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

/** How much of the end of `update.log` the Hub sends its Owner with an update that ended. */
export const MaxUpdateLogTailLines = 80
export const MaxUpdateLogTailLength = 8_000

/**
 * The latest update of the Hub's install, as its Owner sees it: its status, from `status.json`,
 * and once it ended, the end of `update.log`. One the Hub found Running with no update holding the
 * lock any more, as when its process was killed, is shown Failed.
 */
export const HubUpdateRun = Schema.Struct({
  status: UpdateStatus,
  logTail: Schema.optionalKey(Schema.String),
})
export type HubUpdateRun = typeof HubUpdateRun.Type

/** Why the Hub refuses an {@link UpdateHub} while the one it launched hasn't started yet. */
export const hubUpdateStartingMessage = "An update is starting already."

/** Why the Hub refuses an {@link UpdateHub} with no Channel while it is pinned. */
export const hubPinnedMessage = (ref: string) =>
  `This Hub is pinned to ${ref}: pick a Channel to follow one again.`

// ── Web to Hub ─────────────────────────────────────────────────────────────

/**
 * Check for a newer kndl now, rather than at the next periodic check: the Owner's alone. Answered
 * with a {@link HubUpdateChecked}, whether the check worked or not, or a CommandFailed.
 */
export const CheckHubUpdate = Schema.TaggedStruct("CheckHubUpdate", {
  requestId: RequestId,
})
export type CheckHubUpdate = typeof CheckHubUpdate.Type

/**
 * Update the Hub: the Owner's alone, on a Hub that checks. It runs `kndl update --source hub`, with
 * `--now` when `now` is set, so that its Runners stop their running Turns at once rather than
 * letting them end, and with `--channel` when `channel` is set, which on a pinned Hub unpins it.
 * Answered with a {@link HubUpdateStarted} once it is launched, or a CommandFailed: while an update
 * runs, with `updateRunningText`.
 */
export const UpdateHub = Schema.TaggedStruct("UpdateHub", {
  requestId: RequestId,
  now: Schema.Boolean,
  channel: Schema.optionalKey(Channel),
})
export type UpdateHub = typeof UpdateHub.Type

/** What the Owner asks of the Hub's own updates. */
export const HubUpdateCommand = Schema.Union([CheckHubUpdate, UpdateHub])
export type HubUpdateCommand = typeof HubUpdateCommand.Type

// ── Hub to web ─────────────────────────────────────────────────────────────

/** The update an {@link UpdateHub} asked for is launched: its progress follows. */
export const HubUpdateStarted = Schema.TaggedStruct("HubUpdateStarted", {
  requestId: RequestId,
})
export type HubUpdateStarted = typeof HubUpdateStarted.Type

/**
 * The latest update, whenever its status changes: as it starts, at each step, and as it ends. Sent
 * to the Owner's web clients alone, as the log is theirs alone.
 */
export const HubUpdateRunChanged = Schema.TaggedStruct("HubUpdateRunChanged", {
  run: HubUpdateRun,
})
export type HubUpdateRunChanged = typeof HubUpdateRunChanged.Type

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

/** What the Hub tells its Owner of its own updates. */
export const HubUpdateMessage = Schema.Union([
  HubUpdateChecked,
  HubUpdateStarted,
  HubUpdateRunChanged,
])
export type HubUpdateMessage = typeof HubUpdateMessage.Type
