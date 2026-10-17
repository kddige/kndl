// What the Hub page and its banner work out from the Hub's update check (ADR 0028), apart from how
// they show it, and which update the Owner dismissed the banner of. A dismissal is per viewer, in
// localStorage, as the sidebar's folds are, and lasts until the check finds another update: a
// newer Release on stable, or main moving again on dev.

import {
  type BuildVersion,
  describeBuild,
  type HubFollows,
  type HubUpdateState,
  hubUpdateTarget,
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

/** What the banner says of an update: its title, and the line under it. */
export function bannerText(
  update: HubUpdateState,
  version: BuildVersion | null,
): { readonly title: string; readonly description: string } | null {
  const found = update.checked?.found
  switch (found?._tag) {
    case "NewerRelease": {
      const [newest] = found.releases
      const behind = found.releases.length
      return {
        title: `kndl ${newest.version} is out`,
        description:
          version?.release === undefined
            ? "See what changed on the Hub page."
            : `This Hub runs ${version.release}, ${behind === 1 ? "one Release" : `${behind} Releases`} behind. See what changed on the Hub page.`,
      }
    }
    case "NewerCommits":
      return {
        title: `main is ${found.behindBy === 1 ? "1 commit" : `${found.behindBy} commits`} ahead of this Hub`,
        description: "See what changed on the Hub page.",
      }
    case "UpToDate":
    case undefined:
      return null
  }
}
