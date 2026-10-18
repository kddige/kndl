// What the Hub page and its banner work out from the Hub's update check (ADR 0028) and its latest
// update (#362), apart from how they show it, and which update the Owner dismissed the banner of.
// A dismissal is per viewer, in localStorage, as the sidebar's folds are, and lasts until the
// check finds another update: a newer Release on stable, or main moving again on dev.

import {
  type BuildVersion,
  type Channel,
  describeBuild,
  type HubFollows,
  type HubUpdateRun,
  type HubUpdateState,
  hubUpdateTarget,
  releaseOfTag,
  type RunnerSummary,
} from "@kndl/protocol"
import { useSyncExternalStore } from "react"

const storageKey = "kndl:hub-update-dismissed"

/** A dismissal that couldn't be stored, as when storage is off: it lasts until the page closes. */
let unstored: string | undefined
const listeners = new Set<() => void>()

function stored(): string | null {
  if (unstored !== undefined) return unstored
  try {
    return localStorage.getItem(storageKey)
  } catch {
    return null
  }
}

function subscribe(listener: () => void): () => void {
  const fromOtherTab = (event: StorageEvent) => {
    if (event.key === storageKey || event.key === null) listener()
  }
  listeners.add(listener)
  window.addEventListener("storage", fromOtherTab)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", fromOtherTab)
  }
}

/** Dismisses the banner of the update to `target` (`hubUpdateTarget`), in every tab. */
export function dismissUpdate(target: string): void {
  try {
    localStorage.setItem(storageKey, target)
    unstored = undefined
  } catch {
    unstored = target
  }
  for (const listener of listeners) listener()
}

/** The update whose banner the Owner dismissed last, if they did. */
export function useDismissedUpdate(): string | null {
  return useSyncExternalStore(subscribe, stored, stored)
}

/**
 * The update the banner tells of: the check's target, unless the Owner dismissed it. Null when the
 * check offers none.
 */
export function bannerTarget(
  update: HubUpdateState | null,
  dismissed: string | null,
): string | null {
  const target = hubUpdateTarget(update ?? undefined)
  return target === undefined || target === dismissed ? null : target
}

/** What the Hub follows, as the Hub page says it: "stable", "dev", "Pinned to fix-login". */
export function followsText(follows: HubFollows): string {
  return follows._tag === "Channel" ? follows.channel : `Pinned to ${follows.ref}`
}

/** The kndl the Hub runs, as the Hub page says it: its Release on stable, its commit on dev. */
export function versionText(version: BuildVersion | null, follows: HubFollows): string {
  if (version === null) return "Unknown"
  if (follows._tag === "Channel" && follows.channel === "dev") return version.commit.slice(0, 12)
  return describeBuild(version)
}

/** What the Hub page says of the latest update: Running, or how it ended. */
export function runTitle(run: HubUpdateRun): string {
  const { status } = run
  switch (status.state) {
    case "Running":
      return `Updating… ${status.step}`
    case "Succeeded": {
      const { target } = status
      if (target === undefined) return "Nothing to move to: the Hub stayed where it was"
      const release = releaseOfTag(target.ref)
      if (release !== undefined) return `Updated to ${release}`
      return `Updated to ${target.commit?.slice(0, 12) ?? target.ref}`
    }
    case "Failed":
      return "Update failed"
    case "RolledBack":
      return "Update rolled back"
  }
}

/** Who started the latest update, as the Hub page says it. */
export function runSourceText(run: HubUpdateRun): string {
  return run.status.source === "cli" ? "with kndl update on the Hub's machine" : "from this page"
}

/**
 * The Runners following the Hub's commit that still wait for their running Turns to end, up to
 * ten minutes, before they update: the ones Update now stops the Turns of.
 */
export function drainingRunners(
  runners: ReadonlyArray<RunnerSummary> | null,
  hub: BuildVersion | null,
): Array<RunnerSummary> {
  if (runners === null || hub === null) return []
  return runners.filter(
    (runner) =>
      runner.update?._tag === "Draining" &&
      !runner.update.now &&
      runner.update.target.commit === hub.commit,
  )
}

/** What picking `to` on the Channel picker does, as its confirmation says it. */
export function channelChangeText(
  follows: HubFollows,
  to: Channel,
): { readonly title: string; readonly description: string; readonly action: string } {
  const unpin = follows._tag === "Pinned"
  const title = unpin ? `Unpin the Hub, and follow ${to}?` : `Follow ${to}?`
  const action = unpin ? `Unpin and follow ${to}` : `Follow ${to}`
  if (to === "dev") {
    return {
      title,
      action,
      description: `${unpin ? `The Hub leaves ${follows.ref}, and` : "The Hub"} moves to the head of main now: it updates, and restarts. Later updates follow main.`,
    }
  }
  return {
    title,
    action,
    description: `${unpin ? `The Hub leaves ${follows.ref}, and` : "The Hub"} moves to the latest Release, if it is newer than this commit, and restarts. Otherwise it stays on this commit until a newer Release is out: stable never moves an install back.`,
  }
}

/** What the Hub page says of a Hub on stable that runs a commit no Release has reached. */
export const onStableNote = "On stable. You'll move at the next Release newer than this commit."

/** What the banner says of an update: its title, and the line under it. */
export function bannerText(
  update: HubUpdateState,
  version: BuildVersion | null,
): { readonly title: string; readonly description?: string } | null {
  const found = update.checked?.found
  switch (found?._tag) {
    case "NewerRelease": {
      const [newest] = found.releases
      const behind = found.releases.length
      return {
        title: `kndl ${newest.version} is out`,
        ...(version?.release !== undefined && {
          description: `This Hub runs ${version.release}, ${behind === 1 ? "one Release" : `${behind} Releases`} behind.`,
        }),
      }
    }
    case "NewerCommits":
      return {
        title: `main is ${found.behindBy === 1 ? "1 commit" : `${found.behindBy} commits`} ahead of this Hub`,
      }
    case "UpToDate":
    case undefined:
      return null
  }
}
