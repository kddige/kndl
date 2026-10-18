// The disk Archived Sessions take on their Runners (#352), as the Archived screens show it: a size
// for each, and what purging several would free.

import type { SessionId } from "@kndl/protocol"
import { bytes, counted } from "../app/format.ts"

/**
 * What is known of each Session's size: its bytes, or `null` when the Hub couldn't say (its Runner
 * is offline or couldn't measure it). A Session not in the map is still being measured.
 */
export type DiskSizes = ReadonlyMap<SessionId, number | null>

/** What purging the Sessions would free, as far as it's known. */
export interface Freed {
  /** The sum of the sizes that are known. */
  readonly bytes: number
  /** How many sizes the Hub couldn't say. */
  readonly unknown: number
  /** How many are still being measured. */
  readonly measuring: number
  /** How many Sessions there are. */
  readonly count: number
}

export function freedBy(sessionIds: ReadonlyArray<SessionId>, sizes: DiskSizes): Freed {
  let total = 0
  let unknown = 0
  let measuring = 0
  for (const sessionId of sessionIds) {
    const size = sizes.get(sessionId)
    if (size === undefined) measuring++
    else if (size === null) unknown++
    else total += size
  }
  return { bytes: total, unknown, measuring, count: sessionIds.length }
}

/** "1.8 GiB", "Size unknown" or "Measuring…": one Session's size. */
export function sizeText(size: number | null | undefined): string {
  if (size === undefined) return "Measuring…"
  return size === null ? "Size unknown" : bytes(size)
}

/**
 * What purging frees, in words: "Frees 3.4 GiB"; "Frees at least 3.4 GiB (1 size unknown)" when
 * some sizes aren't known, since it frees what they hold too; "Disk use unknown" when none are; and
 * "Measuring disk use…" while any is still being measured.
 */
export function freedText(freed: Freed): string {
  if (freed.measuring > 0) return "Measuring disk use…"
  if (freed.unknown === freed.count) return "Disk use unknown"
  if (freed.unknown === 0) return `Frees ${bytes(freed.bytes)}`
  const sizes = `${counted(freed.unknown, { one: "size", other: "sizes" })} unknown`
  return `Frees at least ${bytes(freed.bytes)} (${sizes})`
}
