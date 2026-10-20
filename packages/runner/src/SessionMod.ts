// The mod a Session runs, its durable agent (docs/design/durable-harness.md), is a copy of the
// Runner's, in the Session's directory, made as the agent starts (#159). A Sandbox that mounted
// the Runner's own mod would have an update, or a `bun run mod:build`, change it under every
// running Session. The Session's copy changes only as its agent starts again, at the Session's
// start, wake or relaunch, so a new mod reaches each Session then. The copy goes when the Session
// is purged, with its directory.
//
// The agent is one ESM file, `durable/agent.js`, holding everything it needs but pi's packages
// (`@earendil-works/*`), which it imports by name from the pi bundle mounted in the Sandbox
// (sandbox/SandboxPi.ts). ESM resolves a bare name only through `node_modules` directories, never
// `NODE_PATH`, so beside the agent the copy holds `durable/node_modules`: a symlink to the bundle's
// `node_modules`, at its path in the Sandbox. On the host it points at nothing; in the Sandbox,
// where the copy is mounted at `/opt/kndl/mod`, Node finds each package through it, and each
// package's own dependencies from where the symlink leads. A `package.json` there says the agent
// is an ES module.

import { randomUUID } from "node:crypto"
import { cp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { dirname, join, posix } from "node:path"
import { Data, Effect } from "effect"
import { durableAgent, modGuestPath } from "./sandbox/SessionLayout.ts"
import type { SessionDirectories } from "./SessionNames.ts"

/** Where `bun run mod:build` writes the durable agent, in the mod package. */
export const durableAgentBuild = "durable/dist/agent.js"

export class SessionModError extends Data.TaggedError("SessionModError")<{
  readonly message: string
}> {}

/**
 * Copies the Runner's mod's durable agent, under `modDir`, into the Session's `mod/`, in place of
 * the copy there, with its `node_modules` linked to `nodeModules`, the pi bundle's in the Sandbox,
 * and returns where the Sandbox sees the new copy. Run only while the Session's agent is stopped.
 *
 * Each copy has a new name: the Sandbox may still hold the last one's paths, and a directory
 * replaced under a mount stays stale. `mod/` itself stays, as the Sandbox mounts it.
 */
export const copySessionMod = (
  modDir: string,
  directories: SessionDirectories,
  nodeModules: string,
) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(directories.mod, { recursive: true })
      for (const old of await readdir(directories.mod)) {
        await rm(join(directories.mod, old), { recursive: true, force: true })
      }
      const name = randomUUID().slice(0, 8)
      const agent = join(directories.mod, name, durableAgent)
      await mkdir(dirname(agent), { recursive: true })
      await cp(join(modDir, durableAgentBuild), agent)
      await writeFile(
        join(dirname(agent), "package.json"),
        `${JSON.stringify({ type: "module" })}\n`,
      )
      await symlink(nodeModules, join(dirname(agent), "node_modules"))
      return posix.join(modGuestPath, name)
    },
    catch: (error) =>
      new SessionModError({
        message: `could not copy the mod into ${directories.mod}: ${error instanceof Error ? error.message : String(error)}`,
      }),
  })
