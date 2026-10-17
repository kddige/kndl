// Whether a newer kndl is out (ADR 0028, #361): the Hub checks kndl's repository on GitHub
// (Upstream.ts) as it starts, then every `checkInterval`, and when its Owner asks; whoever asks
// while a check is under way gets that one. What counts as newer follows the Hub's Channel (ADR
// 0025):
//
//   stable   the Releases newer than the Hub's, with their notes. On a commit that is no Release's,
//            as after moving from dev, newer than the Release it came after, and only once the
//            newest holds the Hub's commit: the stable Channel never moves an install back.
//   dev      main's head past the Hub's commit, with the titles of the newest commits since.
//   pinned   nothing, and no check: `--ref` pinned a branch other than main, a tag or a commit.
//
// A check that fails keeps what the last one that worked found, beside its error and when. Every
// check's outcome is kept in the database, for the commit and Channel it was made for, so a Hub
// that restarts shows the last one at once; one for another commit or Channel is dropped.
//
// Only a Hub the kndl service runs from the install's own checkout, `<home>/app`, checks (see
// `hubUpdatesOf`): there is nothing the web could update on any other, such as a checkout run with
// `bun run hub`, so it never polls, and its web clients hear nothing of it.

import { existsSync, realpathSync } from "node:fs"
import { join } from "node:path"
import {
  type BuildVersion,
  compareReleases,
  DevBranch,
  type HubFollows,
  type HubUpdateFound,
  HubUpdateState,
  hubFollows,
  hubUpdateTarget,
  kndlCompareUrl,
  MaxCommitTitles,
  type ReleaseNotes,
  type ReleaseVersion,
  releaseOfTag,
} from "@kndl/protocol"
import { releaseInHistory, thisCheckout } from "@kndl/protocol/checkout"
import { HomeConfig } from "@kndl/protocol/home"
import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Layer,
  Option,
  PubSub,
  Schema,
  type Scope,
} from "effect"
import { SqlClient } from "effect/sql"
import { HubVersion } from "./HubVersion.ts"
import { Upstream, type UpstreamError, type UpstreamRelease } from "./Upstream.ts"

/** How often the Hub checks on its own. The Owner's Check now checks at once. */
export const checkInterval = Duration.hours(6)

/** Set by the kndl service on the process it runs, to its role: `hub` for the Hub. */
export const ServiceVariable = "KNDL_SERVICE"

/** What says whether the Hub checks for a newer kndl. */
export interface InstallFacts {
  /** It runs in a checkout's dev home (no KNDL_HOME): `bun run hub`. */
  readonly devHome: boolean
  /** The checkout the Hub runs from, its real path; `undefined` outside a git checkout. */
  readonly checkout: string | undefined
  /** The installed checkout, `<home>/app`, its real path; `undefined` when there is none. */
  readonly app: string | undefined
  /** {@link ServiceVariable}'s value. */
  readonly service: string | undefined
}

const off = (reason: string) => ({ on: false as const, reason })

/**
 * Whether the Hub checks for a newer kndl, and offers its Owner the Hub page: only when the kndl
 * service runs it from the installed checkout, which `kndl update` moves. Why not, if not.
 */
export function hubUpdatesOf(
  facts: InstallFacts,
): { readonly on: true } | { readonly on: false; readonly reason: string } {
  if (facts.checkout === undefined) return off("it doesn't run from a git checkout")
  if (facts.devHome) return off("it runs from a developer's checkout (bun run hub)")
  if (facts.app === undefined || facts.checkout !== facts.app) {
    return off(`it runs from ${facts.checkout}, not the installed checkout`)
  }
  if (facts.service !== "hub") return off("it isn't run by the kndl service")
  return { on: true }
}

/**
 * The Releases newer than `from`, newest first, with their notes: those GitHub lists whose tags
 * are Releases', prereleases left out. All of them when the Hub knows no Release before its
 * commit.
 */
export function newerReleases(
  releases: ReadonlyArray<UpstreamRelease>,
  from: ReleaseVersion | undefined,
): Array<ReleaseNotes> {
  return releases
    .flatMap((release) => {
      const version = releaseOfTag(release.tag)
      if (version === undefined || release.prerelease) return []
      if (from !== undefined && compareReleases(version, from) <= 0) return []
      return [
        {
          version,
          notes: release.notes,
          url: release.url,
          ...(release.publishedAt !== undefined && { publishedAt: release.publishedAt }),
        },
      ]
    })
    .toSorted((a, b) => compareReleases(b.version, a.version))
}

/**
 * What a check of GitHub finds for a Hub at `version` on `channel`. `before` is the newest Release
 * in the Hub's history, for a Hub on a commit that is no Release's.
 */
export const findUpdate = Effect.fn("HubUpdates.findUpdate")(function* (
  version: BuildVersion,
  channel: "stable" | "dev",
  before: ReleaseVersion | undefined,
) {
  const upstream = yield* Upstream
  const upToDate: HubUpdateFound = { _tag: "UpToDate" }
  if (channel === "dev") {
    const head = yield* upstream.head(DevBranch)
    if (head === version.commit) return upToDate
    const comparison = yield* upstream.compare(version.commit, head)
    // A Hub ahead of main, as on a commit not pushed yet, has nothing to move to.
    if (comparison.aheadBy === 0) return upToDate
    const found: HubUpdateFound = {
      _tag: "NewerCommits",
      head,
      behindBy: comparison.aheadBy,
      commits: comparison.commits.slice(-MaxCommitTitles).toReversed(),
      compareUrl: kndlCompareUrl(version.commit, head),
    }
    return found
  }
  const from = version.release ?? before
  const [newest, ...older] = newerReleases(yield* upstream.releases, from)
  if (newest === undefined) return upToDate
  if (version.release === undefined) {
    // Only a Release holding the Hub's commit is newer than it.
    const comparison = yield* upstream.compare(version.commit, `v${newest.version}`)
    if (comparison.status !== "ahead") return upToDate
  }
  const found: HubUpdateFound = {
    _tag: "NewerRelease",
    releases: [newest, ...older],
    compareUrl: kndlCompareUrl(
      version.release === undefined ? version.commit : `v${version.release}`,
      `v${newest.version}`,
    ),
  }
  return found
})

const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(HubUpdateState))

/** Whether two values say the same, as JSON. */
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export class HubUpdates extends Context.Service<
  HubUpdates,
  {
    /** Whether the Hub checks: it is run by the kndl service from `<home>/app`. */
    readonly on: boolean
    /** Where the check is, while it is on: what the last check found, kept across restarts. */
    readonly latest: Effect.Effect<Option.Option<HubUpdateState>>
    /**
     * Checks now, or while a check is under way waits for that one: where the check is after it,
     * whether it worked or not. None while the check is off.
     */
    readonly check: Effect.Effect<Option.Option<HubUpdateState>>
    /** Where the check is after each check, from now on. */
    readonly changes: Effect.Effect<PubSub.Subscription<HubUpdateState>, never, Scope.Scope>
  }
>()("@kndl/hub/HubUpdates") {
  /** No check, where nothing could update the Hub from the web: a Hub that isn't installed. */
  static readonly offService = HubUpdates.of({
    on: false,
    latest: Effect.succeedNone,
    check: Effect.succeedNone,
    // Nothing is ever published to it.
    changes: Effect.flatMap(PubSub.unbounded<HubUpdateState>(), PubSub.subscribe),
  })

  static readonly off = Layer.succeed(HubUpdates, HubUpdates.offService)

  /** On while the kndl service runs the Hub from `<home>/app` (`hubUpdatesOf`); off otherwise. */
  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const home = yield* HomeConfig
      const checkout = existsSync(join(thisCheckout, ".git")) ? realpath(thisCheckout) : undefined
      const updates = hubUpdatesOf({
        devHome: home.dev,
        checkout,
        app: realpath(join(home.dir, "app")),
        service: process.env[ServiceVariable],
      })
      if (!updates.on) {
        yield* Effect.logDebug(`The Hub doesn't check for a newer kndl: ${updates.reason}.`)
        return HubUpdates.off
      }
      return HubUpdates.layerOn({ before: releaseInHistory(checkout) })
    }),
  )

  /**
   * Checks, from the Hub's version: GitHub through Upstream, and the database for what the last
   * check found. `before` is the newest Release in the Hub's history (`releaseInHistory`).
   */
  static readonly layerOn = (install: { readonly before: ReleaseVersion | undefined }) =>
    Layer.effect(
      HubUpdates,
      Effect.gen(function* () {
        const { version } = yield* HubVersion
        if (version === undefined) return HubUpdates.offService
        const upstream = yield* Upstream
        const sql = yield* SqlClient.SqlClient
        const layerScope = yield* Effect.scope
        const published = yield* PubSub.unbounded<HubUpdateState>()
        const follows: HubFollows = hubFollows(version)

        // What the last check found, unless it was for another commit or Channel.
        const rows = yield* sql<{ readonly hubCommit: string; readonly state: string }>`
          SELECT hub_commit AS "hubCommit", state FROM hub_update_check
        `.pipe(
          Effect.catchTag("SqlError", (error) =>
            Effect.as(Effect.logWarning("Could not read the last update check", error), []),
          ),
        )
        const kept = Option.fromUndefinedOr(rows[0]).pipe(
          Option.filter((row) => row.hubCommit === version.commit),
          Option.flatMap((row) => decodeState(row.state)),
          Option.filter((found) => same(found.follows, follows)),
        )
        let state: HubUpdateState = Option.getOrElse(kept, () => ({ follows }))
        let lastFailure: string | undefined
        let running: Deferred.Deferred<HubUpdateState> | undefined

        const save = (next: HubUpdateState, at: number) =>
          sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`DELETE FROM hub_update_check`
                yield* sql`
                  INSERT INTO hub_update_check (hub_commit, state, saved_at)
                  VALUES (${version.commit}, ${JSON.stringify(next)}, ${at})
                `
              }),
            )
            .pipe(
              Effect.catchTag("SqlError", (error) =>
                Effect.logWarning("Could not keep what the update check found", error),
              ),
            )

        const checkNow = Effect.gen(function* () {
          if (follows._tag === "Pinned") return state
          const found = yield* findUpdate(version, follows.channel, install.before).pipe(
            Effect.provideService(Upstream, upstream),
            Effect.result,
          )
          const at = yield* Clock.currentTimeMillis
          const before = hubUpdateTarget(state)
          if (found._tag === "Success") {
            lastFailure = undefined
            state = { follows, checked: { at, found: found.success } }
            const target = hubUpdateTarget(state)
            if (target !== undefined && target !== before) {
              yield* Effect.logInfo(`A newer kndl is out (${target}): see the Hub page.`)
            }
          } else {
            const { message } = found.failure satisfies UpstreamError
            // Once, not every interval of an outage.
            if (message !== lastFailure) {
              yield* Effect.logWarning(`Could not check for a newer kndl: ${message}`)
            }
            lastFailure = message
            state = {
              follows,
              ...(state.checked !== undefined && { checked: state.checked }),
              failed: { at, message },
            }
          }
          yield* save(state, at)
          yield* PubSub.publish(published, state)
          return state
        })

        // In the layer's scope, so that one who asks and goes away doesn't stop it for the others.
        const check = Effect.suspend(() => {
          if (running !== undefined) return Deferred.await(running)
          const deferred = Deferred.makeUnsafe<HubUpdateState>()
          running = deferred
          return checkNow.pipe(
            Effect.onExit((exit) =>
              Effect.suspend(() => {
                running = undefined
                return Deferred.done(deferred, exit)
              }),
            ),
            Effect.forkIn(layerScope),
            Effect.andThen(Deferred.await(deferred)),
          )
        })

        if (follows._tag === "Channel") {
          // Forever: a failure is kept, and the next interval tries again.
          yield* check.pipe(
            Effect.andThen(Effect.sleep(checkInterval)),
            Effect.forever,
            Effect.forkIn(layerScope),
          )
        }

        return HubUpdates.of({
          on: true,
          latest: Effect.sync(() => Option.some(state)),
          check: Effect.map(check, Option.some),
          changes: PubSub.subscribe(published),
        })
      }),
    )
}

function realpath(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}
