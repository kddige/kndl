// How much of the Runner's disk a path takes (#352): what is actually allocated, as `du` counts it,
// never the length of a file. The disk volumes microsandbox keeps for a Session are sparse images
// capped at tens of GiB that take only what the guest wrote, so their length would say nothing.

import type { Stats } from "node:fs"
import { lstat, readdir } from "node:fs/promises"
import { join } from "node:path"

/** A block as `st_blocks` counts it, whatever the filesystem's own block size. */
const BlockBytes = 512

/** How many entries of a directory are looked at at once. */
const Concurrency = 32

/**
 * The bytes allocated to `path` and everything under it: each file's `st_blocks`, directories
 * included. A file with several hard links is counted once. Symlinks are counted themselves and
 * never followed, so a link can't take in anything outside the tree. A path that isn't there, or
 * that can't be read, counts as nothing, as does what vanishes while the tree is walked.
 */
export async function allocatedBytes(path: string): Promise<number> {
  const seen = new Set<string>()
  const walk = async (current: string): Promise<number> => {
    let stats: Stats
    try {
      stats = await lstat(current)
    } catch {
      return 0
    }
    let total = 0
    if (stats.nlink > 1 && !stats.isDirectory()) {
      const key = `${stats.dev}:${stats.ino}`
      if (!seen.has(key)) {
        seen.add(key)
        total += stats.blocks * BlockBytes
      }
    } else {
      total += stats.blocks * BlockBytes
    }
    if (!stats.isDirectory()) return total
    let names: Array<string>
    try {
      names = await readdir(current)
    } catch {
      return total
    }
    for (let from = 0; from < names.length; from += Concurrency) {
      const sizes = await Promise.all(
        names.slice(from, from + Concurrency).map((name) => walk(join(current, name))),
      )
      for (const size of sizes) total += size
    }
    return total
  }
  return walk(path)
}
