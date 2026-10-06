// The mod a Session's Claude Code loads (ADR 0013, ADR 0014) is a copy of the Runner's, in the
// Session's directory, made as its Claude Code starts (#159).
//
// Claude Code reloads a plugin whenever its files change, and a reload in the middle of a Turn
// loses the end of that Turn: the web is left at Working. A Sandbox that mounted the Runner's own
// mod would have an update, or a `bun run mod:build`, change it under every running Session. The
// Session's copy changes only as its Claude Code starts again, at the Session's start, wake or
// relaunch, so a new mod reaches each Session then, when Claude Code starts fresh anyway. The copy
// goes when the Session is purged, with its directory.

import { randomUUID } from "node:crypto"
import { cp, mkdir, readdir, rm } from "node:fs/promises"
import { join, posix } from "node:path"
import { Data, Effect } from "effect"
import { modGuestPath, modPlugins } from "./sandbox/SessionLayout.ts"
import type { SessionDirectories } from "./SessionNames.ts"

export class SessionModError extends Data.TaggedError("SessionModError")<{
  readonly message: string
}> {}

/**
 * Copies the Runner's mod, its plugins under `modDir`, into the Session's `mod/`, in place of the
 * copy there, and returns where the Sandbox sees the new copy. Run only while the Session's Claude
 * Code is stopped.
 *
 * Each copy has a new name: the Sandbox may still hold the last one's paths, and a directory
 * replaced under a mount stays stale. `mod/` itself stays, as the Sandbox mounts it.
 */
export const copySessionMod = (modDir: string, directories: SessionDirectories) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(directories.mod, { recursive: true })
      for (const old of await readdir(directories.mod)) {
        await rm(join(directories.mod, old), { recursive: true, force: true })
      }
      const name = randomUUID().slice(0, 8)
      for (const plugin of modPlugins) {
        await cp(join(modDir, "plugins", plugin), join(directories.mod, name, plugin), {
          recursive: true,
        })
      }
      return posix.join(modGuestPath, name)
    },
    catch: (error) =>
      new SessionModError({
        message: `could not copy the mod into ${directories.mod}: ${error instanceof Error ? error.message : String(error)}`,
      }),
  })
