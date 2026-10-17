// How much of the Runner's disk a path takes (#352): what is actually allocated, as `du` counts it,
// never the length of a file. The disk volumes microsandbox keeps for a Session are sparse images
// capped at tens of GiB that take only what the guest wrote, so their length would say nothing.

import { lstat, readdir } from "node:fs/promises"
import { join } from "node:path"

/** A block as `st_blocks` counts it, whatever the filesystem's own block size. */
const BlockBytes = 512

/**
 * How many paths are looked at at once, in the whole tree: a bound on the walk, not on each
 * directory, so a deep Workspace (`node_modules`) doesn't fan out into thousands of reads at once.
 */
export const DiskUsageConcurrency = 32

/**
 * The bytes allocated to `path` and everything under it: each file's `st_blocks`, directories
 * included. A file with several hard links is counted once. Symlinks are counted themselves and
 * never followed, so a link can't take in anything outside the tree. A path that isn't there, or
 * that can't be read, counts as nothing, as does what vanishes while the tree is walked.
 *
 * The walk is depth first, by {@link DiskUsageConcurrency} workers taking paths off one stack, so
 * what waits to be looked at is the directories' entries along the way down, not the whole tree.
 */
export async function allocatedBytes(path: string): Promise<number> {
  const seen = new Set<string>()
  const waiting: Array<string> = [path]
  const idle: Array<() => void> = []
  let busy = 0
  let total = 0

  /** Counts the path, and gives the entries under it, if it's a directory. */
  const visit = async (current: string): Promise<ReadonlyArray<string>> => {
    const stats = await lstat(current).catch(() => undefined)
    if (stats === undefined) return []
    if (stats.nlink > 1 && !stats.isDirectory()) {
      const key = `${stats.dev}:${stats.ino}`
      if (seen.has(key)) return []
      seen.add(key)
    }
    total += stats.blocks * BlockBytes
    if (!stats.isDirectory()) return []
    const names = await readdir(current).catch(() => [])
    return names.map((name) => join(current, name))
  }

  const wakeAll = () => {
    for (const wake of idle.splice(0)) wake()
  }

  const worker = async (): Promise<void> => {
    for (;;) {
      const next = waiting.pop()
      if (next === undefined) {
        // Nothing left, nor anyone still looking who could find more: the walk is done.
        if (busy === 0) return wakeAll()
        await new Promise<void>((wake) => idle.push(wake))
        continue
      }
      busy++
      try {
        // One by one: a directory can have more entries than a call takes arguments.
        for (const entry of await visit(next)) waiting.push(entry)
      } finally {
        busy--
      }
      wakeAll()
    }
  }

  await Promise.all(Array.from({ length: DiskUsageConcurrency }, worker))
  return total
}
