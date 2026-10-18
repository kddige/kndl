// The check for upgrading the pinned pi or Node.js (SandboxPi.ts): the pinned SHA-256 of each
// Node.js build is the one its release's SHASUMS256.txt says, and the bundle, got from the network
// into a new cache as a Runner gets it, runs: the host's own libc's Node.js runs pi's CLI, which
// says the pinned version. It needs network access to nodejs.org, unofficial-builds.nodejs.org and
// npm, so it is skipped unless KNDL_PI_IT=1. It needs no Sandbox: a musl build runs only where
// musl's loader is, which a glibc host lacks, so the host runs its own libc's.
//
//   KNDL_PI_IT=1 bun test packages/runner/src/sandbox/SandboxPi.integration.test.ts

import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, posix } from "node:path"
import { Effect } from "effect"
import {
  ensurePiBundle,
  piCliInInstall,
  PinnedNodeBuilds,
  PinnedNodeVersion,
  PinnedPiVersion,
} from "./SandboxPi.ts"

const enabled = process.env.KNDL_PI_IT === "1"

/** What a command prints, run offline as pi would be in a Sandbox. */
const run = (args: Array<string>) =>
  Bun.spawnSync(args, { env: { PI_OFFLINE: "1", PI_TELEMETRY: "0", PATH: "/usr/bin:/bin" } })
    .stdout.toString()
    .trim()

test.skipIf(!enabled)("each pinned Node.js build's SHA-256 is its release's", async () => {
  for (const build of Object.values(PinnedNodeBuilds)) {
    const sums = await (await fetch(new URL("SHASUMS256.txt", build.url))).text()
    const file = posix.basename(new URL(build.url).pathname)
    expect(sums).toContain(`${build.sha256}  ${file}\n`)
  }
})

test.skipIf(!enabled)(
  "the bundle, got into a new cache, runs pi on the pinned Node.js",
  async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "kndl-pi-it-"))
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
      expect(run([node, join(cacheDir, ready.appDir, piCliInInstall), "--version"])).toBe(
        PinnedPiVersion,
      )
    } finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  },
  600_000,
)
