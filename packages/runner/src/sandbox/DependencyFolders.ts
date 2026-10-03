// An Environment's dependency folders (ADR 0006, 0009): folders such as node_modules, kept on one
// disk per Session rather than on the Workspace's host mount, where many small files are slow.
//
// At every boot, before the start script, the Runner matches the Environment's patterns against
// the Workspace on its host, and the guest bind-mounts `deps/<path>` from the Session's
// dependency disk over `/workspace/<path>` for each match. A pattern with a "next to" file also
// matches where the folder would be next to each such file, so the first install on a fresh clone
// already lands on the disk (spike #46). The binds don't survive a reboot, so they're made anew
// at each boot; the empty mount points they leave on the host are themselves matches next time.

import { readdir } from "node:fs/promises"
import { posix } from "node:path"
import type { DependencyFolder } from "@claude-hub/protocol"
import { Effect } from "effect"
import { workspaceGuestPath } from "./SessionLayout.ts"

/** Where the Session's dependency disk is mounted in the guest. */
export const dependencyDiskGuestPath = "/var/lib/claude-hub/deps"

/** The volume key of the Session's dependency disk. */
export const dependencyDiskKey = "deps"

/** Directories never searched: they hold no project's dependency folders. */
const skipped = new Set([".git"])

/** At most this many matches are bound, however many the patterns find. */
export const maxMatches = 256

const isGlob = (segment: string) => /[*?[\]{}]/.test(segment)

/**
 * The Workspace paths, relative to its root, where the folders go: every directory a pattern
 * matches, and for patterns with a "next to" file, the folder's path next to every such file
 * whose directory the rest of the pattern matches. Matched directories aren't searched further,
 * nor are symlinks followed. Sorted, so parents come before what they hold.
 */
export const matchDependencyFolders = (root: string, folders: ReadonlyArray<DependencyFolder>) =>
  Effect.promise(async () => {
    const patterns = folders.map((folder) => {
      const name = posix.basename(folder.pattern)
      return {
        glob: new Bun.Glob(folder.pattern),
        // The folder a "next to" file implies, when the pattern names it.
        nextTo:
          folder.nextTo === undefined || isGlob(name) || name === "" ? undefined : folder.nextTo,
        name,
      }
    })
    const matches = new Set<string>()
    const matching = (path: string) => patterns.some((pattern) => pattern.glob.match(path))

    const walk = async (relative: string): Promise<void> => {
      if (matches.size >= maxMatches) return
      const entries = await readdir(posix.join(root, relative), { withFileTypes: true }).catch(
        () => [],
      )
      for (const entry of entries) {
        const path = relative === "" ? entry.name : `${relative}/${entry.name}`
        if (path.includes("\n")) continue
        if (entry.isFile()) {
          for (const pattern of patterns) {
            if (pattern.nextTo !== entry.name) continue
            const folder = relative === "" ? pattern.name : `${relative}/${pattern.name}`
            if (pattern.glob.match(folder)) matches.add(folder)
          }
        } else if (entry.isDirectory() && !skipped.has(entry.name)) {
          if (matching(path)) matches.add(path)
          else await walk(path)
        }
      }
    }
    await walk("")
    // A folder next to a file may lie inside another match, such as a package's own
    // node_modules within node_modules: the outer one holds it already.
    const sorted = [...matches].toSorted()
    return sorted
      .filter((path) => !sorted.some((other) => path.startsWith(`${other}/`)))
      .slice(0, maxMatches)
  })

/**
 * The guest script binding each match, read one per line from stdin, from the dependency disk.
 * Run as root at every boot. A path already bound is left as it is.
 */
export const bindDependencyFoldersScript = `
set -e
while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  target="${workspaceGuestPath}/$rel"
  if grep -qs " $target " /proc/mounts; then continue; fi
  mkdir -p "${dependencyDiskGuestPath}/$rel" "$target"
  mount --bind "${dependencyDiskGuestPath}/$rel" "$target"
done`
