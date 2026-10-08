// The mod a Session's Claude Code loads (ADR 0013, ADR 0014) is a copy of the Runner's, in the
// Session's directory, made as its Claude Code starts (#159).
//
// Claude Code reloads a plugin whenever its files change, and a reload in the middle of a Turn
// loses the end of that Turn: the web is left at Working. A Sandbox that mounted the Runner's own
// mod would have an update, or a `bun run mod:build`, change it under every running Session. The
// Session's copy changes only as its Claude Code starts again, at the Session's start, wake or
// relaunch, so a new mod reaches each Session then, when Claude Code starts fresh anyway. The copy
// goes when the Session is purged, with its directory.
//
// Beside the mod's plugins, the copy holds one the Runner writes for a Session with Installations
// (ADR 0020), `kndl`: their MCP servers, all at the Hub's Gateway. Its Installations too change
// only as its Claude Code starts again.

import { randomUUID } from "node:crypto"
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { join, posix } from "node:path"
import type { GatewayServer } from "@kndl/protocol"
import { Data, Effect } from "effect"
import { gatewayMcpServers } from "./ClaudeLaunch.ts"
import { gatewayPlugin, modGuestPath, modPlugins } from "./sandbox/SessionLayout.ts"
import type { SessionDirectories } from "./SessionNames.ts"

export class SessionModError extends Data.TaggedError("SessionModError")<{
  readonly message: string
}> {}

/**
 * Copies the Runner's mod, its plugins under `modDir`, into the Session's `mod/`, in place of the
 * copy there, with the {@link gatewayPlugin} plugin for the MCP servers of its Installations, if
 * any, and returns where the Sandbox sees the new copy. Run only while the Session's Claude Code is
 * stopped.
 *
 * Each copy has a new name: the Sandbox may still hold the last one's paths, and a directory
 * replaced under a mount stays stale. `mod/` itself stays, as the Sandbox mounts it.
 */
export const copySessionMod = (
  modDir: string,
  directories: SessionDirectories,
  plugins: ReadonlyArray<GatewayServer> = [],
) =>
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
      if (plugins.length > 0) {
        const plugin = join(directories.mod, name, gatewayPlugin)
        await mkdir(join(plugin, ".claude-plugin"), { recursive: true })
        await writeFile(
          join(plugin, ".claude-plugin", "plugin.json"),
          JSON.stringify({
            name: gatewayPlugin,
            description: "The MCP servers of the Installations on for this Session's Repo.",
          }),
        )
        await writeFile(join(plugin, ".mcp.json"), JSON.stringify(gatewayMcpServers(plugins)))
      }
      return posix.join(modGuestPath, name)
    },
    catch: (error) =>
      new SessionModError({
        message: `could not copy the mod into ${directories.mod}: ${error instanceof Error ? error.message : String(error)}`,
      }),
  })
