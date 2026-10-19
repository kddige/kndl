// The check for upgrading the pinned pi or Node.js (SandboxPi.ts): the pinned SHA-256 of each
// Node.js build is the one its release's SHASUMS256.txt says, and the bundle, got from the network
// into a new cache as a Runner gets it, runs a durable agent: the host's own libc's Node.js runs a
// stand-in for it, from a Session's copy of the mod (SessionMod.ts), which loads every pi package
// the agent imports through the copy's node_modules and opens a Pi Durable storage. It needs
// network access to nodejs.org, unofficial-builds.nodejs.org and npm, so it is skipped unless
// KNDL_PI_IT=1. It needs no Sandbox: a musl build runs only where musl's loader is, which a glibc
// host lacks, so the host runs its own libc's.
//
//   KNDL_PI_IT=1 bun test packages/runner/src/sandbox/SandboxPi.integration.test.ts

import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, posix } from "node:path"
import { Effect } from "effect"
import { copySessionMod, durableAgentBuild } from "../SessionMod.ts"
import { sessionDirectories } from "../SessionNames.ts"
import { sessionId } from "../testSupport.ts"
import { ensurePiBundle, PinnedNodeBuilds, PinnedNodeVersion } from "./SandboxPi.ts"
import { durableAgent, modGuestPath } from "./SessionLayout.ts"

const enabled = process.env.KNDL_PI_IT === "1"

/** What a command prints, run with nothing of the host's environment but a PATH. */
const run = (args: Array<string>) =>
  Bun.spawnSync(args, { env: { PATH: "/usr/bin:/bin" }, cwd: tmpdir() })
    .stdout.toString()
    .trim()

/**
 * Stands in for the durable agent: imports each pi package the agent does, as bare names, and
 * opens a storage as the agent opens its own.
 */
const fakeAgent = `
import "@earendil-works/chord"
import "@earendil-works/pi-ai"
import "@earendil-works/pi-codemode"
import "@earendil-works/pi-mcp"
import { createCodingTools } from "@earendil-works/pi-durable/tools"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
const storage = await openNodeSqliteStorage(process.argv[2])
console.log(typeof createCodingTools, typeof storage)
`

test.skipIf(!enabled)("each pinned Node.js build's SHA-256 is its release's", async () => {
  for (const build of Object.values(PinnedNodeBuilds)) {
    const sums = await (await fetch(new URL("SHASUMS256.txt", build.url))).text()
    const file = posix.basename(new URL(build.url).pathname)
    expect(sums).toContain(`${build.sha256}  ${file}\n`)
  }
})

test.skipIf(!enabled)(
  "the bundle, got into a new cache, runs a durable agent on the pinned Node.js",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "kndl-pi-it-"))
    const cacheDir = join(root, "cache")
    try {
      const ready = await Effect.runPromise(ensurePiBundle({ cacheDir }))
      const libc = existsSync("/lib/ld-musl-x86_64.so.1") || existsSync("/lib/ld-musl-aarch64.so.1")
      const node = join(
        cacheDir,
        `node-v${PinnedNodeVersion}-${libc ? "musl" : "glibc"}`,
        "bin",
        "node",
      )
      expect(run([node, "--version"])).toBe(`v${PinnedNodeVersion}`)

      // The Session's copy of the mod links the install where the host has it, in place of where
      // a Sandbox mounts it.
      const modDir = join(root, "mod")
      await mkdir(join(modDir, durableAgentBuild, ".."), { recursive: true })
      await writeFile(join(modDir, durableAgentBuild), fakeAgent)
      const directories = sessionDirectories(join(root, "sessions"), sessionId("s-1"))
      const copy = await Effect.runPromise(
        copySessionMod(modDir, directories, join(cacheDir, ready.appDir, "node_modules")),
      )
      const agent = join(directories.mod, posix.relative(modGuestPath, copy), durableAgent)
      expect(run([node, agent, join(root, "session.sqlite")])).toBe("function object")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  600_000,
)
