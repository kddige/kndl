// An Environment (ADR 0009) on a real microsandbox VM, so it is skipped unless
// CLAUDE_HUB_SANDBOX_IT=1: a real build of an Alpine recipe with Docker, a Session booted from
// it, a variable reaching the Session's processes but not the VM's stored environment, a wake, a
// recreate on a new version, and a Test build. It needs `msb` installed for the current user,
// network access to Docker Hub and Alpine's packages, and to npm the first time a Claude Code
// version is cached. It runs only `claude mcp serve` in the VM: no model calls, no credentials;
// the variables are made up. Everything it creates is named it-49-… and removed at the end,
// pass or fail.
//
//   CLAUDE_HUB_SANDBOX_IT=1 bun test packages/runner/src/Environments.integration.test.ts

import { expect, test } from "bun:test"
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type {
  EnvironmentRecipe,
  RepoName,
  RunnerToHub,
  SessionId,
  TestBuildId,
  ToolBridgeReply,
} from "@claude-hub/protocol"
import { EnvironmentVersion } from "@claude-hub/protocol"
import { devHome } from "@claude-hub/protocol/home"
import { Duration, Effect, Layer, Option, Schema } from "effect"
import { Sandbox, Snapshot, Volume } from "microsandbox"
import { buildGroup } from "./EnvironmentBuilds.ts"
import { HubLink } from "./HubLink.ts"
import { Sandboxes } from "./Sandbox.ts"
import * as MicrosandboxBackend from "./sandbox/MicrosandboxBackend.ts"
import { SandboxBackend } from "./sandbox/SandboxBackend.ts"
import { ensureSandboxClaude, hostClaudeVersion } from "./sandbox/SandboxClaude.ts"
import { sessionDirectories } from "./SessionNames.ts"
import { makeSessionSandboxes } from "./SessionSandboxes.ts"
import { FakeHubVariables, variable } from "./testSupport.ts"

const enabled = process.env.CLAUDE_HUB_SANDBOX_IT === "1"

/** Everything this test makes is named under it, and only that is removed. */
const namePrefix = "it-49-"
const msbHome = process.env["MSB_HOME"] ?? join(homedir(), ".microsandbox")
const snapshotsDir = join(msbHome, "snapshots")
const repo = "acme/it-49" as RepoName
const version = (n: number) => Schema.decodeSync(EnvironmentVersion)(n)
const buildValue = "it49-build-made-up-1f3a"
const runtimeValue = "it49-runtime-made-up-9c2e"

const timings: Array<[string, number]> = []
const timed = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.timed,
    Effect.map(([duration, value]) => {
      timings.push([label, Duration.toMillis(duration)])
      return value
    }),
  )

/** Runs `command` with the Session's Bash tool, through its bridge, as Claude Code would. */
const bash = (socket: string, command: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 50; attempt++) {
      const reply = yield* Effect.promise(async () => {
        const response = await fetch("http://bridge/tools/call", {
          method: "POST",
          unix: socket,
          body: JSON.stringify({ tool: "Bash", input: { command } }),
        })
        return (await response.json()) as ToolBridgeReply
      })
      if (reply._tag === "ToolRan") return JSON.stringify(reply.result)
      yield* Effect.sleep("200 millis")
    }
    return yield* Effect.die(new Error(`Bash never ran: ${command}`))
  })

/** Every file under `path` holding `needle`, not following links. */
const filesHolding = async (path: string, needle: string): Promise<Array<string>> => {
  const info = await lstat(path).catch(() => undefined)
  if (info === undefined || info.isSymbolicLink()) return []
  if (info.isDirectory()) {
    const entries = await readdir(path)
    return (
      await Promise.all(entries.map((entry) => filesHolding(join(path, entry), needle)))
    ).flat()
  }
  const data = await readFile(path).catch(() => undefined)
  return data !== undefined && data.includes(needle) ? [path] : []
}

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
  image: "alpine:3.20",
  // What the bootstrap saw is kept in the build: the build variable, and not the other one.
  bootstrapScript:
    'apk add --no-cache jq >/dev/null\necho "build saw [$BUILD_ONLY] [$RUNTIME_ONLY]" > /root/build-saw\necho bootstrapped',
  startScript: 'echo "start saw [$RUNTIME_ONLY]" > /root/start-saw\necho started',
  docker: true,
  dependencyFolders: [{ pattern: "node_modules", nextTo: "package.json" }],
  resources: { cpus: 2, memoryMib: 1024 },
  variables: [
    { name: "BUILD_ONLY", availableAtBuild: true },
    { name: "RUNTIME_ONLY", availableAtBuild: false },
  ],
}

test.skipIf(!enabled)(
  "an Environment is built, booted, woken, recreated and Test built on a real VM",
  async () => {
    const sessionId = `s${Date.now().toString(36)}` as SessionId
    const root = await mkdtemp(join(tmpdir(), "claude-hub-it-49-"))
    const directories = sessionDirectories(root, sessionId)
    await mkdir(directories.workspace, { recursive: true })
    await mkdir(directories.claude, { recursive: true })
    await writeFile(join(directories.workspace, "package.json"), '{"name":"app"}\n')
    const cacheDir = process.env.RUNNER_SANDBOX_CLAUDE_CACHE ?? join(devHome.dir, "claude-code")
    const sent: Array<RunnerToHub> = []
    const testBuildLog: Array<string> = []

    const othersBefore = await Sandbox.list().then((page) =>
      page.sandboxes.filter((s) => !s.name.startsWith(namePrefix)).map((s) => [s.name, s.status]),
    )

    const program = Effect.gen(function* () {
      const sandboxes = yield* Sandboxes
      const backend = yield* SandboxBackend
      const snapshots = Option.getOrThrow(backend.snapshots)
      const socket = directories.toolsSocket
      const v1 = { version: version(1), buildVersion: version(1), recipe }

      // The first start builds version 1, boots from it and runs the start script.
      expect(
        yield* timed(
          "first start (build + restore + start script)",
          sandboxes.start(sessionId, directories, { repo, environment: v1 }),
        ),
      ).toEqual({ environmentVersion: version(1) })
      const terminal = sent.flatMap((m) => (m._tag === "TerminalFrame" ? [m.data] : [])).join("")
      expect(terminal).toContain("bootstrapped")
      expect(terminal).toContain("started")
      expect((yield* snapshots.list(buildGroup(repo))).map((s) => s.name)).toEqual(["b1-musl"])

      const seen = yield* timed(
        "Bash: variables, build, folders, docker",
        bash(
          socket,
          'echo "tool saw [$RUNTIME_ONLY]"; cat /root/build-saw /root/start-saw; ' +
            "command -v jq; grep -c RUNTIME_ONLY /proc/1/environ; " +
            "mkdir -p node_modules/dep && echo dependency > node_modules/dep/index.js; " +
            "docker info --format 'docker {{.ServerVersion}}'",
        ),
      )
      expect(seen).toContain(`tool saw [${runtimeValue}]`)
      expect(seen).toContain(`build saw [${buildValue}] []`)
      expect(seen).toContain(`start saw [${runtimeValue}]`)
      expect(seen).toContain("/usr/bin/jq")
      expect(seen).toMatch(/docker \d+\./)
      // node_modules is on the Session's dependency disk, not in the host's Workspace.
      expect(
        yield* Effect.promise(() =>
          readFile(join(directories.workspace, "node_modules", "dep", "index.js")).then(
            () => "on the host",
            () => "not on the host",
          ),
        ),
      ).toBe("not on the host")

      // The value reached processes, and nothing of microsandbox's on the host holds it: not its
      // database, where VM-level env would be, and not the Sandbox's directory, whose exec log
      // is a link to /dev/null.
      const name = `${namePrefix}${sessionId}`
      expect(
        (yield* Effect.promise(() =>
          lstat(join(msbHome, "sandboxes", name, "logs", "exec.log")),
        )).isSymbolicLink(),
      ).toBe(true)
      expect(
        yield* Effect.promise(async () => [
          ...(await filesHolding(join(msbHome, "db"), runtimeValue)),
          ...(await filesHolding(join(msbHome, "sandboxes", name), runtimeValue)),
        ]),
      ).toEqual([])

      // A wake on the same version starts the same VM and binds the folders again.
      yield* timed("sleep", sandboxes.stop(sessionId, "Sleep"))
      yield* timed(
        "wake, same version",
        sandboxes.start(sessionId, directories, { repo, environment: v1 }),
      )
      expect(yield* bash(socket, "cat node_modules/dep/index.js")).toContain("dependency")

      // Version 2 changed no build input, so it keeps build 1: the Sandbox is recreated from it,
      // on the same disks, and the start script runs again.
      yield* sandboxes.stop(sessionId, "Sleep")
      yield* timed(
        "wake, new version (recreate)",
        sandboxes.start(sessionId, directories, {
          repo,
          environment: { ...v1, version: version(2) },
        }),
      )
      const recreated = yield* bash(socket, "cat node_modules/dep/index.js /root/start-saw")
      expect(recreated).toContain("dependency")
      expect(recreated).toContain(`start saw [${runtimeValue}]`)
      expect((yield* snapshots.list(buildGroup(repo))).map((s) => s.name)).toEqual(["b1-musl"])

      yield* timed("archive", sandboxes.stop(sessionId, "Archive"))
      expect(yield* backend.state(sessionId)).toBe("Destroyed")

      // A Test build of a draft without Docker, against a "clone" in a new directory.
      yield* timed(
        "Test build",
        sandboxes.testBuild(
          {
            _tag: "RunTestBuild",
            testBuildId: "0123456789abcdef01234567" as TestBuildId,
            repo,
            recipe: { ...recipe, docker: false },
          },
          (text) => Effect.sync(() => void testBuildLog.push(text)),
        ),
      )
      expect(testBuildLog.join("")).toContain("started")
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
            hostClaudeVersion("claude").pipe(
              Effect.tap((v) => ensureSandboxClaude({ cacheDir, version: v, libc })),
            ),
          ),
        limits: { cpus: 2, memoryMib: 2048 },
        keepBuilds: 2,
        cloneDefaultBranch: (_repo, directory) =>
          Effect.promise(async () => {
            await mkdir(directory, { recursive: true })
            await writeFile(join(directory, "package.json"), '{"name":"app"}\n')
          }),
        scratchDir: join(root, "scratch"),
        layout: {
          rootDiskMib: 4096,
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
            duration: "12 minutes",
            orElse: () => Effect.die(new Error("timed out")),
          }),
          Effect.provide(sandboxes),
          Effect.provide(
            Layer.mergeAll(
              Layer.effect(
                SandboxBackend,
                MicrosandboxBackend.make({ runner: "it-49-runner", namePrefix }),
              ),
              hub,
              variables.layer,
            ),
          ),
          Effect.scoped,
        ),
      )
    } finally {
      // The build's snapshots, the Session's volumes and anything a failure left.
      left = await sweep()
      await rm(root, { recursive: true, force: true })
      console.log(
        timings
          .map(([label, ms]) => `${label.padEnd(48)} ${ms.toFixed(0).padStart(6)} ms`)
          .join("\n"),
      )
    }
    // Only the kept builds and the archived Session's volumes were left to sweep.
    expect(left.filter((item) => item.startsWith("sandbox"))).toEqual([])
    expect(left.filter((item) => item.startsWith("snapshot"))).toHaveLength(1)
    // The Test build removed its own group; only the Environment's builds' was left.
    expect(left.filter((item) => item.startsWith("group"))).toHaveLength(1)
    expect(await sweep()).toEqual([])
    const othersAfter = await Sandbox.list().then((page) =>
      page.sandboxes.filter((s) => !s.name.startsWith(namePrefix)).map((s) => [s.name, s.status]),
    )
    expect(othersAfter).toEqual(othersBefore)
  },
  900_000,
)
