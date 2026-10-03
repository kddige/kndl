// Sessions' Sandboxes from an Environment (ADR 0009), on the fake backend: builds, boots from
// them, start scripts, variables, resources, versions, pruning and Test builds.

import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  EnvironmentRecipe,
  RepoName,
  RunnerToHub,
  SandboxStateReport,
  SessionEnvironment,
  TestBuildId,
} from "@claude-hub/protocol"
import { EnvironmentVersion } from "@claude-hub/protocol"
import { Effect, Layer, References, Schema } from "effect"
import { buildGroup, buildName } from "./EnvironmentBuilds.ts"
import { HubLink } from "./HubLink.ts"
import { Sandboxes } from "./Sandbox.ts"
import { dependencyDiskGuestPath } from "./sandbox/DependencyFolders.ts"
import { FakeSandboxBackend } from "./sandbox/FakeSandboxBackend.ts"
import type { FakeExecCall, FakeExecReply, FakeSandboxWorld } from "./sandbox/FakeSandboxBackend.ts"
import type { SandboxBackend } from "./sandbox/SandboxBackend.ts"
import { detectLibcScript, sandboxClaudePath } from "./sandbox/SandboxClaude.ts"
import { workspaceGuestPath } from "./sandbox/SessionLayout.ts"
import { sessionDirectories } from "./SessionNames.ts"
import type { SessionSandboxesOptions } from "./SessionSandboxes.ts"
import { makeSessionSandboxes } from "./SessionSandboxes.ts"
import {
  echoTools,
  FakeHubVariables,
  fakeMcpServer,
  sandboxesDefaults,
  sessionId,
  variable,
  waitFor,
} from "./testSupport.ts"

const s1 = sessionId("s-1")
const s2 = sessionId("s-2")
const repo = "acme/app" as RepoName
const version = (n: number) => Schema.decodeSync(EnvironmentVersion)(n)

const recipe = (overrides: Partial<EnvironmentRecipe> = {}): EnvironmentRecipe => ({
  image: "node:22",
  bootstrapScript: "npm install -g pnpm",
  startScript: "pnpm install",
  docker: false,
  dependencyFolders: [{ pattern: "node_modules", nextTo: "package.json" }],
  resources: { cpus: 2, memoryMib: 4096 },
  variables: [
    { name: "NPM_TOKEN", availableAtBuild: true },
    { name: "API_KEY", availableAtBuild: false },
  ],
  ...overrides,
})

const environment = (
  v: number,
  overrides: Partial<EnvironmentRecipe> = {},
  buildVersion = v,
): SessionEnvironment => ({
  version: version(v),
  buildVersion: version(buildVersion),
  recipe: recipe(overrides),
})

/** The script a `runScript` exec runs, by its name in the guest, if it is one. */
const scriptOf = (call: FakeExecCall) =>
  call.request.command !== "sh"
    ? undefined
    : /\/tmp\/claude-hub-(\w+)\.sh$/.exec(call.request.args?.at(-1) ?? "")?.[1]

const isScript = (name: string) => (call: FakeExecCall) => scriptOf(call) === name

interface Harness {
  readonly root: string
  readonly sent: Array<RunnerToHub>
  readonly variables: FakeHubVariables
}

/** Runs `body` with live Sandboxes on the fake backend and fake Hub variables. */
const withEnvironments = async (
  body: (
    harness: Harness,
  ) => Effect.Effect<void, unknown, Sandboxes | FakeSandboxBackend | SandboxBackend>,
  options: {
    readonly onExec?: (call: FakeExecCall) => FakeExecReply | undefined
    readonly sandboxes?: Partial<SessionSandboxesOptions>
    readonly variables?: FakeHubVariables
  } = {},
) => {
  const root = await mkdtemp(join(tmpdir(), "claude-hub-environments-"))
  const sent: Array<RunnerToHub> = []
  const variables =
    options.variables ??
    new FakeHubVariables([variable("NPM_TOKEN", "npm-made-up", true), variable("API_KEY", "k-1")])
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
      claudeCacheDir: "/host/claude-code",
      sandboxClaude: () => Effect.succeed("2.1.287"),
      ...sandboxesDefaults,
      scratchDir: join(root, "scratch"),
      bridge: { readyTimeout: "2 seconds", restartDelay: () => "10 millis" },
      ...options.sandboxes,
    }),
  )
  const onExec = options.onExec
  const backend = FakeSandboxBackend.layer({
    onSpawn: (_call, io) => fakeMcpServer(echoTools)(io),
    onExec: (call) =>
      Effect.succeed(
        onExec?.(call) ??
          (call.request.args?.includes(detectLibcScript) ? { stdout: "musl\n" } : {}),
      ),
  })
  try {
    await body({ root, sent, variables }).pipe(
      Effect.provide(sandboxes.pipe(Layer.provideMerge(backend))),
      Effect.provide([hub, variables.layer]),
      Effect.scoped,
      Effect.provideService(References.MinimumLogLevel, "None"),
      Effect.runPromise,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** A Session's directories, its Workspace holding a package.json. */
const directoriesIn = (root: string, id = s1) =>
  Effect.promise(async () => {
    const directories = sessionDirectories(root, id)
    await mkdir(directories.workspace, { recursive: true })
    await mkdir(directories.claude, { recursive: true })
    await writeFile(join(directories.workspace, "package.json"), "{}\n")
    return directories
  })

const states = (sent: ReadonlyArray<RunnerToHub>, id = s1) =>
  sent
    .filter((m): m is SandboxStateReport => m._tag === "SandboxStateReport" && m.sessionId === id)
    .map((m) => m.state)

/** What the Session's terminal showed before Claude Code. */
const terminal = (sent: ReadonlyArray<RunnerToHub>, id = s1) =>
  sent.flatMap((m) => (m._tag === "TerminalFrame" && m.sessionId === id ? [m.data] : [])).join("")

const snapshotNames = (world: FakeSandboxWorld) =>
  [...world.snapshots.keys()].map((reference) => reference.split("/").slice(1).join("/")).toSorted()

describe("Sandboxes from an Environment", () => {
  test("the first Session builds the Environment, boots from the build, and runs the start script", () =>
    withEnvironments(({ root, sent, variables }) =>
      Effect.gen(function* () {
        const sandboxes = yield* Sandboxes
        const world = yield* FakeSandboxBackend
        const directories = yield* directoriesIn(root)

        const started = yield* sandboxes.start(s1, directories, {
          repo,
          environment: environment(1),
        })
        expect(started).toEqual({ environmentVersion: version(1) })
        expect(variables.asked).toEqual([{ _tag: "Session", sessionId: s1 }])

        // The bootstrap ran without the Workspace, and got only the variables available at build.
        const bootstrap = world.execCalls.find(isScript("bootstrap"))
        expect(bootstrap?.request.env).toEqual({ NPM_TOKEN: "npm-made-up" })
        expect(bootstrap?.sessionId).not.toBe(s1)
        expect(snapshotNames(world)).toEqual([`${buildGroup(repo)}/${buildName(1, "musl")}`])
        // The build's own Sandbox is gone; the Session's was booted from the build.
        expect([...world.sandboxes.keys()]).toEqual([s1])
        expect(world.restores).toEqual([
          { sessionId: s1, reference: expect.stringContaining(buildName(1, "musl")) },
        ])

        const spec = world.sandboxes.get(s1)?.spec
        expect(spec?.cpus).toBe(2)
        expect(spec?.memoryMib).toBe(4096)
        // No values on the VM, no Docker disk without the toggle, and one disk for the folders.
        expect(spec?.env).toEqual({})
        expect(spec?.docker).toBeUndefined()
        expect(spec?.mounts).toContainEqual(
          expect.objectContaining({ _tag: "Volume", guestPath: dependencyDiskGuestPath }),
        )

        // The folders were bound before the start script, which ran in the Workspace with every
        // variable in its own environment.
        const calls = world.execCalls.filter((call) => call.sessionId === s1)
        const bind = calls.findIndex((call) => call.request.stdin === "node_modules\n")
        const start = calls.findIndex(isScript("start"))
        expect(bind).toBeGreaterThanOrEqual(0)
        expect(start).toBeGreaterThan(bind)
        expect(calls[start]?.request.cwd).toBe(workspaceGuestPath)
        expect(calls[start]?.request.env).toMatchObject({
          NPM_TOKEN: "npm-made-up",
          API_KEY: "k-1",
        })

        // The build showed in the Session's terminal, and the Sandbox was reported running.
        expect(terminal(sent)).toContain("Running the bootstrap script...\r\n")
        expect(terminal(sent)).toContain("Running the start script...\r\n")
        expect(states(sent)).toEqual(["Starting", "Running"])

        // What it was built from is kept beside the Session, with no value.
        const record = yield* Effect.promise(() =>
          readFile(join(directories.session, "sandbox.json"), "utf8"),
        )
        expect(JSON.parse(record)).toMatchObject({
          repo,
          version: 1,
          buildVersion: 1,
          libc: "musl",
        })
        expect(record).not.toContain("npm-made-up")
        expect(record).not.toContain("k-1")
      }),
    ))

  test("the tool bridge's processes get the variables, and run the libc's Claude Code", () =>
    withEnvironments(
      ({ root }) =>
        Effect.gen(function* () {
          const sandboxes = yield* Sandboxes
          const world = yield* FakeSandboxBackend
          const directories = yield* directoriesIn(root)
          yield* sandboxes.start(s1, directories, { repo, environment: environment(1) })

          yield* waitFor(Effect.sync(() => world.spawnCalls.some((c) => c.sessionId === s1)))
          const serve = world.spawnCalls.find((call) => call.sessionId === s1)
          expect(serve?.request.command).toBe(sandboxClaudePath("2.1.287", "glibc"))
          expect(serve?.request.env).toMatchObject({ NPM_TOKEN: "npm-made-up", API_KEY: "k-1" })
          expect(snapshotNames(world)).toEqual([`${buildGroup(repo)}/${buildName(1, "glibc")}`])
        }),
      {
        onExec: (call) =>
          call.request.args?.includes(detectLibcScript) ? { stdout: "glibc\n" } : undefined,
      },
    ))

  test("a later Session of the same build version boots from the build already made", () =>
    withEnvironments(({ root, sent }) =>
      Effect.gen(function* () {
        const sandboxes = yield* Sandboxes
        const world = yield* FakeSandboxBackend
        yield* sandboxes.start(s1, yield* directoriesIn(root, s1), {
          repo,
          environment: environment(1),
        })
        // Version 2 changed nothing the build uses, so it keeps build version 1.
        yield* sandboxes.start(s2, yield* directoriesIn(root, s2), {
          repo,
          environment: environment(2, {}, 1),
        })
        expect(world.execCalls.filter(isScript("bootstrap"))).toHaveLength(1)
        expect(world.restores.map((restore) => restore.sessionId)).toEqual([s1, s2])
        expect(world.execCalls.filter(isScript("start")).map((call) => call.sessionId)).toEqual([
          s1,
          s2,
        ])
        expect(terminal(sent, s2)).not.toContain("bootstrap")
      }),
    ))

  test("a failed bootstrap fails the Session's start with the end of its output", () =>
    withEnvironments(
      ({ root, sent }) =>
        Effect.gen(function* () {
          const sandboxes = yield* Sandboxes
          const world = yield* FakeSandboxBackend
          const error = yield* Effect.flip(
            sandboxes.start(s1, yield* directoriesIn(root), {
              repo,
              environment: environment(1),
            }),
          )
          expect(error.message).toContain("The bootstrap script exited with 1")
          expect(error.message).toContain("E404 pnpm not found")
          expect(terminal(sent)).toContain("E404 pnpm not found")
          expect(states(sent).at(-1)).toBe("Failed")
          expect(world.snapshots.size).toBe(0)
          expect(world.sandboxes.size).toBe(0)
        }),
      {
        onExec: (call) =>
          isScript("bootstrap")(call)
            ? { exitCode: 1, stderr: "E404 pnpm not found\n" }
            : undefined,
      },
    ))

  test("refused variables stop the start before anything runs", () =>
    withEnvironments(
      ({ root }) =>
        Effect.gen(function* () {
          const sandboxes = yield* Sandboxes
          const world = yield* FakeSandboxBackend
          const error = yield* Effect.flip(
            sandboxes.start(s1, yield* directoriesIn(root), {
              repo,
              environment: environment(1),
            }),
          )
          expect(error.message).toContain("the Session is archived")
          expect(world.execCalls).toEqual([])
        }),
      { variables: new FakeHubVariables([], "the Session is archived") },
    ))

  test("resources are capped by the Runner's limits, with a note in the Session", () =>
    withEnvironments(
      ({ root, sent }) =>
        Effect.gen(function* () {
          const sandboxes = yield* Sandboxes
          const world = yield* FakeSandboxBackend
          yield* sandboxes.start(s1, yield* directoriesIn(root), {
            repo,
            environment: environment(1, { resources: { cpus: 16, memoryMib: 2048 } }),
          })
          expect(world.sandboxes.get(s1)?.spec.cpus).toBe(4)
          expect(world.sandboxes.get(s1)?.spec.memoryMib).toBe(2048)
          expect(sent).toContainEqual(
            expect.objectContaining({
              _tag: "SandboxNote",
              sessionId: s1,
              message: expect.stringContaining("4 CPUs instead of 16"),
            }),
          )
        }),
      { sandboxes: { limits: { cpus: 4, memoryMib: 8192 } } },
    ))

  test("Docker is installed in the build and gets its own disk when toggled", () =>
    withEnvironments(({ root }) =>
      Effect.gen(function* () {
        const sandboxes = yield* Sandboxes
        const world = yield* FakeSandboxBackend
        yield* sandboxes.start(s1, yield* directoriesIn(root), {
          repo,
          environment: environment(1, { docker: true }),
        })
        const build = world.execCalls.filter((call) => call.sessionId !== s1).map(scriptOf)
        expect(build.indexOf("docker")).toBeGreaterThanOrEqual(0)
        expect(build.indexOf("docker")).toBeLessThan(build.indexOf("bootstrap"))
        expect(world.sandboxes.get(s1)?.spec.docker).toBeDefined()
      }),
    ))

  test("a wake on the same version starts the Sandbox again and binds its folders, without the start script", () =>
    withEnvironments(({ root }) =>
      Effect.gen(function* () {
        const sandboxes = yield* Sandboxes
        const world = yield* FakeSandboxBackend
        const directories = yield* directoriesIn(root)
        const target = { repo, environment: environment(1) }
        yield* sandboxes.start(s1, directories, target)
        yield* sandboxes.stop(s1, "Sleep")
        const before = world.execCalls.length

        yield* sandboxes.start(s1, directories, target)
        const woken = world.execCalls.slice(before)
        expect(world.restores).toHaveLength(1)
        expect(woken.some((call) => call.request.stdin === "node_modules\n")).toBe(true)
        expect(woken.some(isScript("start"))).toBe(false)
      }),
    ))

  test("a wake on a new version recreates the Sandbox from its build, keeping the volumes", () =>
    withEnvironments(({ root }) =>
      Effect.gen(function* () {
        const sandboxes = yield* Sandboxes
        const world = yield* FakeSandboxBackend
        const directories = yield* directoriesIn(root)
        yield* sandboxes.start(s1, directories, { repo, environment: environment(1) })
        const volumes = [...world.volumes.keys()].toSorted()
        yield* sandboxes.stop(s1, "Sleep")

        const started = yield* sandboxes.start(s1, directories, {
          repo,
          environment: environment(2, { bootstrapScript: "npm install -g pnpm@9" }),
        })
        expect(started).toEqual({ environmentVersion: version(2) })
        expect(world.execCalls.filter(isScript("bootstrap"))).toHaveLength(2)
        expect(world.restores.at(-1)?.reference).toContain(buildName(2, "musl"))
        expect([...world.volumes.keys()].toSorted()).toEqual(volumes)
        expect(world.sandboxes.get(s1)?.state).toBe("Running")
      }),
    ))

  test("the Repo losing its Environment gives the Session the default Sandbox again", () =>
    withEnvironments(({ root }) =>
      Effect.gen(function* () {
        const sandboxes = yield* Sandboxes
        const world = yield* FakeSandboxBackend
        const directories = yield* directoriesIn(root)
        yield* sandboxes.start(s1, directories, { repo, environment: environment(1) })
        yield* sandboxes.stop(s1, "Sleep")
        expect(yield* sandboxes.start(s1, directories, { repo })).toEqual({})
        expect(world.sandboxes.get(s1)?.spec.image).toBe("docker:dind")
        const files = yield* Effect.promise(() => readdir(directories.session))
        expect(files).not.toContain("sandbox.json")
      }),
    ))

  test("a re-adopted Session's Sandbox comes back as it was recorded", () =>
    withEnvironments(({ root }) =>
      Effect.gen(function* () {
        const sandboxes = yield* Sandboxes
        const world = yield* FakeSandboxBackend
        const directories = yield* directoriesIn(root)
        yield* sandboxes.start(s1, directories, { repo, environment: environment(3) })
        yield* sandboxes.stop(s1, "Sleep")
        expect(yield* sandboxes.start(s1, directories)).toEqual({
          environmentVersion: version(3),
        })
        expect(world.sandboxes.get(s1)?.state).toBe("Running")
        expect(world.restores).toHaveLength(1)
      }),
    ))

  test("only the last builds of each Repo are kept", () =>
    withEnvironments(
      ({ root }) =>
        Effect.gen(function* () {
          const sandboxes = yield* Sandboxes
          const world = yield* FakeSandboxBackend
          for (const v of [1, 2, 3]) {
            const id = sessionId(`s-v${v}`)
            yield* sandboxes.start(id, yield* directoriesIn(root, id), {
              repo,
              environment: environment(v),
            })
          }
          expect(snapshotNames(world)).toEqual([
            `${buildGroup(repo)}/${buildName(2, "musl")}`,
            `${buildGroup(repo)}/${buildName(3, "musl")}`,
          ])
          // The Sandbox booted from the pruned build keeps running.
          expect(world.sandboxes.get(sessionId("s-v1"))?.state).toBe("Running")
        }),
      { sandboxes: { keepBuilds: 2 } },
    ))

  test("a Session without an Environment boots the Runner's default Sandbox, as before", () =>
    withEnvironments(({ root, variables }) =>
      Effect.gen(function* () {
        const sandboxes = yield* Sandboxes
        const world = yield* FakeSandboxBackend
        expect(yield* sandboxes.start(s1, yield* directoriesIn(root), { repo })).toEqual({})
        expect(world.sandboxes.get(s1)?.spec.image).toBe("docker:dind")
        expect(world.snapshots.size).toBe(0)
        expect(variables.asked).toEqual([])
      }),
    ))
})

describe("Test builds", () => {
  const testBuildId = "0123456789abcdef01234567" as TestBuildId

  test("build, then the start script on a fresh clone, streamed; nothing is left after", () => {
    const cloned: Array<string> = []
    return withEnvironments(
      ({ root, variables }) =>
        Effect.gen(function* () {
          const sandboxes = yield* Sandboxes
          const world = yield* FakeSandboxBackend
          const log: Array<string> = []
          yield* sandboxes.testBuild(
            { _tag: "RunTestBuild", testBuildId, repo, recipe: recipe() },
            (text) => Effect.sync(() => void log.push(text)),
          )
          expect(variables.asked).toEqual([{ _tag: "TestBuild", testBuildId }])
          expect(log.join("")).toContain("Running the bootstrap script...")
          expect(log.join("")).toContain("pnpm: done")
          expect(log.join("")).toContain("The Test build passed.")

          // The start script ran in a Sandbox booted from the build, on the clone in a new
          // directory under the scratch directory.
          expect(cloned).toHaveLength(1)
          expect(cloned[0]?.startsWith(join(root, "scratch"))).toBe(true)
          const start = world.execCalls.find(isScript("start"))
          expect(start?.request.cwd).toBe(workspaceGuestPath)
          expect(start?.request.env).toMatchObject({ API_KEY: "k-1" })
          expect(world.restores).toHaveLength(1)

          expect(world.sandboxes.size).toBe(0)
          expect(world.snapshots.size).toBe(0)
          expect(world.volumes.size).toBe(0)
          expect(yield* Effect.promise(() => readdir(join(root, "scratch")))).toEqual([])
        }),
      {
        sandboxes: {
          cloneDefaultBranch: (_repo, directory) =>
            Effect.promise(async () => {
              cloned.push(directory)
              await mkdir(directory, { recursive: true })
              await writeFile(join(directory, "package.json"), "{}\n")
            }),
        },
        onExec: (call) => (isScript("start")(call) ? { stdout: "pnpm: done\n" } : undefined),
      },
    )
  })

  test("a failing start script fails the Test build with its output", () =>
    withEnvironments(
      ({ root }) =>
        Effect.gen(function* () {
          const sandboxes = yield* Sandboxes
          const world = yield* FakeSandboxBackend
          const error = yield* Effect.flip(
            sandboxes.testBuild(
              { _tag: "RunTestBuild", testBuildId, repo, recipe: recipe() },
              () => Effect.void,
            ),
          )
          expect(error.message).toContain("The start script exited with 2")
          expect(error.message).toContain("lockfile is out of date")
          expect(world.sandboxes.size).toBe(0)
          expect(world.snapshots.size).toBe(0)
          expect(yield* Effect.promise(() => readdir(join(root, "scratch")))).toEqual([])
        }),
      {
        sandboxes: {
          cloneDefaultBranch: (_repo, directory) =>
            Effect.promise(() => mkdir(directory, { recursive: true })),
        },
        onExec: (call) =>
          isScript("start")(call)
            ? { exitCode: 2, stderr: "lockfile is out of date\n" }
            : undefined,
      },
    ))
})
