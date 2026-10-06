// An Environment's login environment (#67) on a real microsandbox VM, so it is skipped unless
// KNDL_SANDBOX_IT=1: a build on buildpack-deps:bookworm whose bootstrap installs mise, puts
// its activation in ~/.bashrc and installs bun with it, then a Session whose start script and
// whose Claude Code's environment both find `bun` with nothing else done, and a stored probe that
// holds no variable's value; then a Test build on Alpine, which has no bash. It needs `msb`
// installed for the current user and network access to Docker Hub, mise.run and GitHub (for mise
// and bun), and to npm the first time a Claude Code version is cached. It runs no Claude Code,
// only shell commands with the environment Claude Code would get: no model calls, no
// credentials; the variables are made up. Everything it creates is named it-67-… and removed at the end, pass or
// fail.
//
//   KNDL_SANDBOX_IT=1 bun test packages/runner/src/LoginEnv.integration.test.ts

import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type {
  EnvironmentRecipe,
  RepoName,
  RunnerToHub,
  SessionId,
  TestBuildId,
} from "@kndl/protocol"
import { EnvironmentVersion } from "@kndl/protocol"
import { devHome } from "@kndl/protocol/home"
import { Duration, Effect, Layer, Option, Schema } from "effect"
import { Sandbox, Snapshot, Volume } from "microsandbox"
import { loginEnvGuestPath, readLoginEnv } from "./EnvironmentBuilds.ts"
import { HubLink } from "./HubLink.ts"
import { Sandboxes } from "./Sandbox.ts"
import type { SandboxClaude } from "./Sandbox.ts"
import * as MicrosandboxBackend from "./sandbox/MicrosandboxBackend.ts"
import { SandboxBackend } from "./sandbox/SandboxBackend.ts"
import { ensureSandboxClaude, PinnedClaudeVersion } from "./sandbox/SandboxClaude.ts"
import { workspaceGuestPath } from "./sandbox/SessionLayout.ts"
import { sessionDirectories } from "./SessionNames.ts"
import { makeSessionSandboxes } from "./SessionSandboxes.ts"
import { FakeHubVariables, variable } from "./testSupport.ts"

const enabled = process.env.KNDL_SANDBOX_IT === "1"

/** Everything this test makes is named under it, and only that is removed. */
const namePrefix = "it-67-"
const msbHome = process.env["MSB_HOME"] ?? join(homedir(), ".microsandbox")
const snapshotsDir = join(msbHome, "snapshots")
const repo = "acme/it-67" as RepoName
const version = (n: number) => Schema.decodeSync(EnvironmentVersion)(n)
const buildValue = "it67-build-made-up-5d1c"
const runtimeValue = "it67-runtime-made-up-b84e"

const timings: Array<[string, number]> = []
const timed = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.timed,
    Effect.map(([duration, value]) => {
      timings.push([label, Duration.toMillis(duration)])
      return value
    }),
  )

/** Runs `command` in the Session's Sandbox with Claude Code's environment, in the Workspace. */
const bash = (sessionId: SessionId, claude: SandboxClaude, command: string) =>
  Effect.gen(function* () {
    const backend = yield* SandboxBackend
    const ran = yield* backend.exec(sessionId, {
      command: "bash",
      args: ["-c", command],
      cwd: workspaceGuestPath,
      env: claude.env,
    })
    return ran.stdout + ran.stderr
  })

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
  for (const snapshot of (await Snapshot.list()).filter((s) => s.group?.startsWith(namePrefix))) {
    left.push(`snapshot ${snapshot.group}:${snapshot.name}`)
    await Snapshot.remove(snapshot.reference, { force: true }).catch(() => undefined)
  }
  // microsandbox keeps a group's directory once its snapshots are gone.
  const groups = await readdir(snapshotsDir).catch(() => [])
  for (const group of groups.filter((name) => name.startsWith(namePrefix))) {
    left.push(`group ${group}`)
    await rm(join(snapshotsDir, group), { recursive: true, force: true })
  }
  return left
}

const recipe: EnvironmentRecipe = {
  image: "buildpack-deps:bookworm",
  // mise as its docs say to install it; nothing puts it or bun on PATH but ~/.bashrc. The
  // ~/.bashrc line single-quoted, so it shows what the variables were when the probe ran it.
  bootstrapScript: [
    "curl -fsSL https://mise.run | sh",
    `echo 'eval "$(~/.local/bin/mise activate bash)"' >> ~/.bashrc`,
    `echo 'export IT67_SEEN="[$BUILD_ONLY][$RUNTIME_ONLY]"' >> ~/.bashrc`,
    "~/.local/bin/mise use -g bun@latest",
    'echo "bootstrap saw [$BUILD_ONLY]"',
  ].join("\n"),
  // `[[` is bash's: the start script runs with bash -e, not dash.
  startScript: [
    'if [[ -n "$RUNTIME_ONLY" ]]; then echo "start saw the runtime variable"; fi',
    'echo "start bun $(bun --version) at $(command -v bun)"',
  ].join("\n"),
  docker: false,
  dependencyFolders: [{ pattern: "node_modules", nextTo: "package.json" }],
  resources: { cpus: 2, memoryMib: 2048 },
  variables: [
    { name: "BUILD_ONLY", availableAtBuild: true },
    { name: "RUNTIME_ONLY", availableAtBuild: false },
  ],
}

/** A tool only ~/.profile puts on PATH, on an image without bash. */
const alpineRecipe: EnvironmentRecipe = {
  ...recipe,
  image: "alpine:3.20",
  bootstrapScript: [
    'if command -v bash; then echo "the image has bash" >&2; exit 7; fi',
    "mkdir -p /root/it67-bin",
    `printf '#!/bin/sh\\necho "it67-tool ran"\\n' > /root/it67-bin/it67-tool`,
    "chmod 755 /root/it67-bin/it67-tool",
    `echo 'export PATH="$HOME/it67-bin:$PATH"' >> /root/.profile`,
  ].join("\n"),
  startScript: "it67-tool",
}

test.skipIf(!enabled)(
  "mise installed in the bootstrap puts bun on the start script's and the tools' PATH",
  async () => {
    const sessionId = `s${Date.now().toString(36)}` as SessionId
    const root = await mkdtemp(join(tmpdir(), "it-67-"))
    const directories = sessionDirectories(root, sessionId)
    await mkdir(directories.workspace, { recursive: true })
    await writeFile(join(directories.workspace, "package.json"), '{"name":"app"}\n')
    const cacheDir = process.env.RUNNER_SANDBOX_CLAUDE_CACHE ?? join(devHome.dir, "claude-code")
    const sent: Array<RunnerToHub> = []

    const othersBefore = await Sandbox.list().then((page) =>
      page.sandboxes.filter((s) => !s.name.startsWith(namePrefix)).map((s) => [s.name, s.status]),
    )

    const program = Effect.gen(function* () {
      const sandboxes = yield* Sandboxes
      const v1 = { version: version(1), buildVersion: version(1), recipe }

      // The first start builds, probes the login shell, boots from the build and runs the start
      // script with what the probe found.
      const started = yield* timed(
        "first start (build + probe + restore + start script)",
        sandboxes.start(sessionId, directories, { repo, environment: v1 }),
      )
      const terminal = sent.flatMap((m) => (m._tag === "TerminalFrame" ? [m.data] : [])).join("")
      expect(terminal).toContain(`bootstrap saw [${buildValue}]`)
      expect(terminal).toContain("Reading the login shell's environment...")
      expect(terminal).toContain("start saw the runtime variable")
      expect(terminal).toMatch(/start bun \d+\.\d+\.\d+ at \/root\/\.local\/share\/mise\//)

      // Claude Code's environment finds bun too, and the variables. (Its Bash tool also sources
      // ~/.bashrc for the functions there itself.)
      const tool = yield* timed(
        "Bash with Claude Code's environment: bun --version",
        bash(sessionId, started.claude, 'echo "tool bun $(bun --version) [$RUNTIME_ONLY]"'),
      )
      expect(tool).toMatch(/tool bun \d+\.\d+\.\d+/)
      expect(tool).toContain(`[${runtimeValue}]`)

      // The stored probe ran with no variable: the ~/.bashrc line saw neither, and no value is
      // anywhere in it.
      const stored = yield* bash(sessionId, started.claude, `cat ${loginEnvGuestPath}`)
      expect(stored).toContain("IT67_SEEN")
      expect(stored).toContain("[][]")
      expect(stored).toContain("mise")
      expect(stored).not.toContain(buildValue)
      expect(stored).not.toContain(runtimeValue)
      expect(stored).not.toContain("BUILD_ONLY")
      expect(stored).not.toContain("RUNTIME_ONLY")

      // A wake on the same version keeps the probe and the tools still find bun.
      yield* timed("sleep", sandboxes.stop(sessionId, "Sleep"))
      const woken = yield* timed(
        "wake, same version",
        sandboxes.start(sessionId, directories, { repo, environment: v1 }),
      )
      expect(yield* bash(sessionId, woken.claude, "bun --version")).toMatch(/\d+\.\d+\.\d+/)

      // A Sandbox of a build made before builds kept a login environment reads as having none.
      const backend = yield* SandboxBackend
      expect(Option.isSome(yield* readLoginEnv(backend, sessionId))).toBe(true)
      yield* backend.exec(sessionId, { command: "rm", args: [loginEnvGuestPath] })
      expect(Option.isNone(yield* readLoginEnv(backend, sessionId))).toBe(true)

      yield* timed("archive", sandboxes.stop(sessionId, "Archive"))

      // An image without bash: the probe falls back to `sh -lc`, which reads ~/.profile, and
      // scripts run with `sh -e`. As a Test build, which leaves nothing behind.
      const testBuildLog: Array<string> = []
      yield* timed(
        "Test build on alpine:3.20 (no bash)",
        sandboxes.testBuild(
          {
            _tag: "RunTestBuild",
            testBuildId: "676767676767676767676767" as TestBuildId,
            repo,
            recipe: alpineRecipe,
          },
          (text) => Effect.sync(() => void testBuildLog.push(text)),
        ),
      )
      expect(testBuildLog.join("")).toContain("it67-tool ran")
      expect(testBuildLog.join("")).toContain("The Test build passed.")
    })

    const hub = Layer.succeed(
      HubLink,
      HubLink.of({
        send: (message) => Effect.sync(() => void sent.push(message)),
        connect: () => Effect.void,
        disconnect: Effect.void,
      }),
    )
    const sandboxes = Layer.effect(
      Sandboxes,
      makeSessionSandboxes({
        image: "docker:dind",
        claudeCacheDir: cacheDir,
        sandboxClaude: (libc) =>
          timed(
            `find or cache Claude Code (${libc})`,
            ensureSandboxClaude({ cacheDir, version: PinnedClaudeVersion, libc }).pipe(
              Effect.as(PinnedClaudeVersion),
            ),
          ),
        limits: { cpus: 2, memoryMib: 2048 },
        keepBuilds: 2,
        cloneDefaultBranch: (_repo, directory) =>
          Effect.promise(() => mkdir(directory, { recursive: true })),
        scratchDir: join(root, "scratch"),
        layout: {
          rootDiskMib: 8192,
          workspaceQuotaMib: 1024,
          dependencySizeMib: 256,
          cacheSizeMib: 256,
          dockerSizeMib: 2048,
        },
      }),
    )
    const variables = new FakeHubVariables([
      variable("BUILD_ONLY", buildValue, true),
      variable("RUNTIME_ONLY", runtimeValue),
    ])

    let left: Array<string> = []
    try {
      await Effect.runPromise(
        program.pipe(
          Effect.timeoutOrElse({
            duration: "15 minutes",
            orElse: () => Effect.die(new Error("timed out")),
          }),
          Effect.provide(sandboxes),
          Effect.provide(
            Layer.mergeAll(
              Layer.effect(
                SandboxBackend,
                MicrosandboxBackend.make({ runner: "it-67-runner", namePrefix }),
              ),
              hub,
              variables.layer,
            ),
          ),
          Effect.scoped,
        ),
      )
    } finally {
      // The build's snapshot, the Session's volumes and anything a failure left.
      left = await sweep()
      await rm(root, { recursive: true, force: true })
      console.log(
        timings
          .map(([label, ms]) => `${label.padEnd(56)} ${ms.toFixed(0).padStart(6)} ms`)
          .join("\n"),
      )
    }
    expect(left.filter((item) => item.startsWith("sandbox"))).toEqual([])
    expect(await sweep()).toEqual([])
    const othersAfter = await Sandbox.list().then((page) =>
      page.sandboxes.filter((s) => !s.name.startsWith(namePrefix)).map((s) => [s.name, s.status]),
    )
    expect(othersAfter).toEqual(othersBefore)
  },
  1_200_000,
)
