// The Sandbox's GitHub token (#73, ADR 0010) on a real microsandbox VM, so it is skipped unless
// KNDL_SANDBOX_IT=1: a Sandbox on buildpack-deps:bookworm (which has git) gets a made-up
// token the way a Session's does, and git's credential helper and gh's hosts.yml hand it out,
// and its replacement after a refresh. The token is only in the VM's memory: not in its root
// filesystem's image, microsandbox's database or the Sandbox's logs on this disk. gh comes from
// Debian's own apt archive, as an Environment's bootstrap would install it; nothing here reaches
// GitHub. It needs `msb` installed for the current user and network access to Docker Hub and
// Debian. Everything it creates is named it-73-… and removed at the end, pass or fail.
//
//   KNDL_SANDBOX_IT=1 bun test packages/runner/src/SandboxGitHub.integration.test.ts

import { expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionId } from "@kndl/protocol"
import { Cause, Effect, Exit, Layer, Redacted } from "effect"
import { Sandbox, Volume } from "microsandbox"
import * as MicrosandboxBackend from "./sandbox/MicrosandboxBackend.ts"
import { SandboxBackend, shell } from "./sandbox/SandboxBackend.ts"
import { sessionSandboxSpec } from "./sandbox/SessionLayout.ts"
import { credentialsDir, ghHostsPath, installSandboxToken, tokenPath } from "./SandboxGitHub.ts"

const enabled = process.env.KNDL_SANDBOX_IT === "1"

/** Everything this test makes is named under it, and only that is removed. */
const namePrefix = "it-73-"
const msbHome = process.env["MSB_HOME"] ?? join(homedir(), ".microsandbox")

/** Made up: shaped like an installation token, valid nowhere. */
const firstToken = "ghs_it73MadeUpFirstToken0000000000000000"
const secondToken = "ghs_it73MadeUpSecondToken000000000000000"

const ours = <A extends { readonly name: string | null }>(items: ReadonlyArray<A>) =>
  items.filter((item) => item.name?.startsWith(namePrefix) === true)

/** Removes whatever of this test's is left, and returns what was. */
const sweep = async () => {
  const left: Array<string> = []
  for (const sandbox of ours((await Sandbox.list()).sandboxes)) {
    left.push(`sandbox ${sandbox.name}`)
    const handle = await Sandbox.get(sandbox.name).catch(() => undefined)
    await handle?.destroy({ force: true }).catch(() => undefined)
    await Sandbox.remove(sandbox.name).catch(() => undefined)
  }
  for (const volume of ours(await Volume.list())) {
    left.push(`volume ${volume.name}`)
    await Volume.remove(volume.name).catch(() => undefined)
  }
  return left
}

/** The files under `dir` that hold `needle`, read as bytes. */
const filesHolding = async (dir: string, needle: string): Promise<Array<string>> => {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])
  const found: Array<string> = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    const grep = Bun.spawnSync(["grep", "-aqF", needle, path], { env: { LC_ALL: "C" } })
    if (grep.exitCode === 0) found.push(path)
  }
  return found
}

test.skipIf(!enabled)(
  "git and gh in a Sandbox reach GitHub with the token in its tmpfs, and nothing else holds it",
  async () => {
    await sweep()
    const sessionId = `s${Date.now().toString(36)}` as SessionId
    const sandboxName = `${namePrefix}${sessionId}`
    const workspace = await mkdtemp(join(tmpdir(), "kndl-it-73-"))
    const others = () =>
      Sandbox.list().then((page) =>
        page.sandboxes.filter((s) => !s.name.startsWith(namePrefix)).map((s) => [s.name, s.status]),
      )
    const othersBefore = await others()

    const program = Effect.gen(function* () {
      const backend = yield* SandboxBackend
      const sh = (script: string) => backend.exec(sessionId, shell(script))

      yield* backend.create(
        sessionSandboxSpec({
          sessionId,
          image: "buildpack-deps:bookworm",
          workspaceHostPath: workspace,
          env: {},
          cpus: 2,
          memoryMib: 1024,
          rootDiskMib: 4096,
          workspaceQuotaMib: 1024,
          dependencySizeMib: 256,
          cacheSizeMib: 256,
          // The image has no dockerd.
          dockerSizeMib: false,
        }),
      )
      // As an Environment's bootstrap would: Debian's own gh.
      const gh = yield* sh(
        "apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gh >/dev/null && gh --version",
      )
      expect(gh.exitCode, gh.stderr).toBe(0)

      yield* installSandboxToken(backend, sessionId, Redacted.make(firstToken))

      // On a tmpfs, readable by root alone.
      expect((yield* sh("grep ' /run/kndl ' /proc/mounts")).stdout).toContain(
        `${credentialsDir} tmpfs`,
      )
      expect((yield* sh(`stat -c %a ${credentialsDir} ${tokenPath} ${ghHostsPath}`)).stdout).toBe(
        "700\n600\n600\n",
      )

      // git, in the Workspace, asks the credential helper; for github.com only.
      const fill = (host: string) =>
        sh(
          `cd /workspace && printf 'protocol=https\\nhost=${host}\\n\\n' | GIT_TERMINAL_PROMPT=0 git credential fill`,
        )
      const filled = yield* fill("github.com")
      expect(filled.exitCode, filled.stderr).toBe(0)
      expect(filled.stdout).toContain("username=x-access-token\n")
      expect(filled.stdout).toContain(`password=${firstToken}\n`)
      expect((yield* fill("gitlab.com")).stdout).not.toContain(firstToken)

      // gh reads hosts.yml, without asking GitHub.
      const ghToken = yield* sh("cd /workspace && gh auth token --hostname github.com")
      expect(ghToken.exitCode, ghToken.stderr).toBe(0)
      expect(ghToken.stdout.trim()).toBe(firstToken)

      // A refresh replaces it for both.
      yield* installSandboxToken(backend, sessionId, Redacted.make(secondToken))
      expect((yield* fill("github.com")).stdout).toContain(`password=${secondToken}\n`)
      expect((yield* sh("gh auth token")).stdout.trim()).toBe(secondToken)
      expect((yield* sh("grep -c ' /run/kndl ' /proc/mounts")).stdout).toBe("1\n")

      // What is on this disk: the VM's root filesystem image, flushed; its logs; microsandbox's
      // database. None holds either token, though the scan finds what is on the root filesystem.
      const marker = `it73-rootfs-marker-${sessionId}`
      yield* backend.writeFile(sessionId, "/root/it-73-marker", marker)
      yield* sh("sync")
      const sandboxDir = join(msbHome, "sandboxes", sandboxName)
      expect(yield* Effect.promise(() => filesHolding(sandboxDir, marker))).not.toEqual([])
      const holding = yield* Effect.promise(async () => [
        ...(await filesHolding(join(msbHome, "sandboxes", sandboxName), firstToken)),
        ...(await filesHolding(join(msbHome, "sandboxes", sandboxName), secondToken)),
        ...(await filesHolding(join(msbHome, "db"), firstToken)),
        ...(await filesHolding(join(msbHome, "db"), secondToken)),
        ...(await filesHolding(workspace, secondToken)),
      ])
      expect(holding).toEqual([])

      yield* backend.destroy(sessionId)
    }).pipe(
      Effect.provide(
        Layer.effect(
          SandboxBackend,
          MicrosandboxBackend.make({ runner: "it-73-runner", namePrefix }),
        ),
      ),
      Effect.scoped,
    )

    const exit = await Effect.runPromiseExit(program)
    const left = await sweep()
    await rm(workspace, { recursive: true, force: true })
    if (Exit.isFailure(exit)) throw Cause.squash(exit.cause)
    expect(left).toEqual([])
    expect(await others()).toEqual(othersBefore)
  },
  { timeout: 15 * 60_000 },
)
