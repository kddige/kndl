import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"
import type { SessionId } from "@kndl/protocol"
import { devHome, homeAt } from "@kndl/protocol/home"
import type { Home } from "@kndl/protocol/home"
import { Effect, Option, Stream } from "effect"
import {
  FakeSandboxBackend,
  killedExitCode,
  makeFake,
  makeFakeWorld,
} from "./FakeSandboxBackend.ts"
import { parseSandboxName, parseVolumeName, runnerMark, sandboxName, volumeName } from "./Naming.ts"
import { reconcileSandboxes } from "./Reconcile.ts"
import { SandboxBackend, shell } from "./SandboxBackend.ts"
import type { SandboxBackendShape } from "./SandboxBackend.ts"
import { dependencyVolumeKey, sessionSandboxSpec } from "./SessionLayout.ts"
import { checkSpec } from "./Spec.ts"

const s1 = "s-1" as SessionId
const s2 = "s-2" as SessionId

const layout = (sessionId: SessionId) =>
  sessionSandboxSpec({
    sessionId,
    image: "docker:dind",
    workspaceHostPath: `/host/workspaces/${sessionId}`,
    env: { REPO_SECRET: "x" },
  })

const run = <A, E>(
  effect: Effect.Effect<A, E, SandboxBackend | FakeSandboxBackend>,
  options?: Parameters<typeof FakeSandboxBackend.layer>[0],
) => Effect.runPromise(effect.pipe(Effect.provide(FakeSandboxBackend.layer(options))))

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

/** The error a spec patched with `patch` is refused with. */
const bad = async (patch: Partial<ReturnType<typeof layout>>) =>
  (await Effect.runPromise(Effect.flip(checkSpec({ ...layout(s1), ...patch }))))._tag

/** Reconciles as the Runner that `backend` works for. */
const reconcileOn = (backend: SandboxBackendShape, known: Array<SessionId>) =>
  Effect.runPromise(reconcileSandboxes(known).pipe(Effect.provideService(SandboxBackend, backend)))

/** The mark of a Runner on the home's default socket and sessions root. */
const markIn = (home: Home) =>
  runnerMark({ tmuxSocket: home.tmuxSocket, sessionsRoot: join(home.dir, "sessions") })

describe("naming", () => {
  test("names carry the prefix and the Session id, and parse back", () => {
    expect(sandboxName(s1)).toBe("kndl-s-1")
    expect(volumeName(s1, "deps-node-modules")).toBe("kndl-s-1.deps-node-modules")
    expect(parseSandboxName("kndl-s-1")).toBe(s1)
    expect(parseVolumeName("kndl-s-1.cache")).toEqual({ sessionId: s1, key: "cache" })
  })

  test("a Runner's mark is fixed by its tmux socket and sessions root", () => {
    const runner = {
      tmuxSocket: "kndl-dev",
      sessionsRoot: "/Users/a/.kndl-dev/sessions",
    }
    expect(runnerMark(runner)).toMatch(/^[0-9a-f]{16}$/)
    expect(runnerMark({ ...runner })).toBe(runnerMark(runner))
    expect(runnerMark({ ...runner, tmuxSocket: "kndl-test" })).not.toBe(runnerMark(runner))
    expect(runnerMark({ ...runner, sessionsRoot: "/tmp/sessions" })).not.toBe(runnerMark(runner))
  })

  test("a dev Runner and an installed one on the same host have different marks", () => {
    expect(markIn(devHome)).not.toBe(markIn(homeAt(join(homedir(), ".kndl"))))
  })

  test("names without the prefix are never ours", () => {
    expect(parseSandboxName("cc-spike")).toBeUndefined()
    expect(parseSandboxName("kndl-")).toBeUndefined()
    expect(parseVolumeName("cc-spike.cache")).toBeUndefined()
    expect(parseVolumeName("kndl-s-1")).toBeUndefined()
  })
})

describe("Session layout", () => {
  test("puts the Workspace on the host and dependencies, caches, Claude Code's state and Docker on volumes", async () => {
    const spec = layout(s1)
    expect(spec.mounts).toEqual([
      {
        _tag: "Host",
        hostPath: "/host/workspaces/s-1",
        guestPath: "/workspace",
        quotaMib: 65536,
      },
      {
        _tag: "Volume",
        key: "deps-node-modules",
        guestPath: "/workspace/node_modules",
        sizeMib: 16384,
      },
      { _tag: "Volume", key: "cache", guestPath: "/var/cache/kndl", sizeMib: 16384 },
      { _tag: "Volume", key: "claude", guestPath: "/var/lib/kndl/claude", sizeMib: 8192 },
    ])
    expect(spec.docker).toEqual({ sizeMib: 32768 })
    expect(spec.env).toMatchObject({
      REPO_SECRET: "x",
      XDG_CACHE_HOME: "/var/cache/kndl",
      BUN_INSTALL_CACHE_DIR: "/var/cache/kndl/bun",
    })
    await Effect.runPromise(checkSpec(spec))
  })

  test("dependency volume keys are safe names", () => {
    expect(dependencyVolumeKey("node_modules")).toBe("deps-node-modules")
    expect(dependencyVolumeKey("apps/Web/node_modules")).toBe("deps-apps-web-node-modules")
  })

  test("rejects specs that can't be built", async () => {
    expect(await bad({ sessionId: "has space" as SessionId })).toBe("InvalidSandboxSpec")
    expect(await bad({ memoryMib: 100 })).toBe("InvalidSandboxSpec")
    expect(
      await bad({
        mounts: [
          { _tag: "Volume", key: "a", guestPath: "/x", sizeMib: 256 },
          { _tag: "Volume", key: "b", guestPath: "/x", sizeMib: 256 },
        ],
      }),
    ).toBe("InvalidSandboxSpec")
    expect(
      await bad({ mounts: [{ _tag: "Volume", key: "Bad Key", guestPath: "/x", sizeMib: 256 }] }),
    ).toBe("InvalidSandboxSpec")
    expect(
      await bad({
        mounts: [{ _tag: "Volume", key: "c", guestPath: "/root/.cache", sizeMib: 256 }],
      }),
    ).toBe("InvalidSandboxSpec")
  })
})

describe("fake backend", () => {
  test("keeps the rootfs and volumes across stop and start, and the Workspace on the host", () =>
    run(
      Effect.gen(function* () {
        const backend = yield* SandboxBackend
        const world = yield* FakeSandboxBackend
        yield* backend.create(layout(s1))
        yield* backend.writeFile(s1, "/etc/marker", "root")
        yield* backend.writeFile(s1, "/workspace/node_modules/dep.js", "dep")
        yield* backend.writeFile(s1, "/workspace/README.md", "readme")

        yield* backend.stop(s1)
        expect(yield* backend.state(s1)).toBe("Stopped")
        expect((yield* Effect.flip(backend.readFile(s1, "/etc/marker")))._tag).toBe(
          "SandboxNotRunning",
        )
        expect(yield* backend.metrics(s1)).toEqual(Option.none())

        yield* backend.start(s1)
        expect(text(yield* backend.readFile(s1, "/etc/marker"))).toBe("root")
        expect(text(yield* backend.readFile(s1, "/workspace/node_modules/dep.js"))).toBe("dep")
        expect(world.hostFiles.get("/host/workspaces/s-1/README.md")).toEqual(
          new TextEncoder().encode("readme"),
        )
        expect(world.volumes.get("kndl-s-1.deps-node-modules")?.has("/dep.js")).toBe(true)
      }),
    ))

  test("a destroy that keeps volumes lets a new Sandbox wake on them", () =>
    run(
      Effect.gen(function* () {
        const backend = yield* SandboxBackend
        yield* backend.create(layout(s1))
        yield* backend.writeFile(s1, "/etc/marker", "root")
        yield* backend.writeFile(s1, "/var/cache/kndl/bun/pkg", "cached")
        yield* backend.destroy(s1, { keepVolumes: true })
        expect(yield* backend.state(s1)).toBe("Destroyed")
        expect((yield* backend.list).map((l) => [l.sessionId, l.state, l.volumes.length])).toEqual([
          [s1, "Destroyed", 4],
        ])

        yield* backend.create(layout(s1))
        expect(text(yield* backend.readFile(s1, "/var/cache/kndl/bun/pkg"))).toBe("cached")
        expect((yield* Effect.flip(backend.readFile(s1, "/etc/marker")))._tag).toBe(
          "SandboxBackendError",
        )

        yield* backend.destroy(s1)
        expect(yield* backend.list).toEqual([])
        yield* backend.destroy(s1)
      }),
    ))

  test("refuses a second Sandbox for the same Session", () =>
    run(
      Effect.gen(function* () {
        const backend = yield* SandboxBackend
        yield* backend.create(layout(s1))
        expect((yield* Effect.flip(backend.create(layout(s1))))._tag).toBe("SandboxAlreadyExists")
        expect((yield* Effect.flip(backend.start(s2)))._tag).toBe("SandboxNotFound")
      }),
    ))

  test("records commands and answers them with the test's handler", () =>
    run(
      Effect.gen(function* () {
        const backend = yield* SandboxBackend
        const world = yield* FakeSandboxBackend
        yield* backend.create(layout(s1))
        const result = yield* backend.exec(s1, shell("git status", { cwd: "/workspace" }))
        expect(result).toEqual({ exitCode: 1, stdout: "out", stderr: "err" })
        const events = yield* Stream.runCollect(backend.execStream(s1, { command: "true" }))
        expect(events.map((e) => e._tag)).toEqual(["Stdout", "Stderr", "Exit"])
        expect(world.execCalls[0]).toEqual({
          sessionId: s1,
          request: { cwd: "/workspace", command: "sh", args: ["-c", "git status"] },
        })
      }),
      { onExec: () => Effect.succeed({ exitCode: 1, stdout: "out", stderr: "err" }) },
    ))

  test("spawns a command that reads what is written to its stdin", () =>
    run(
      Effect.gen(function* () {
        const backend = yield* SandboxBackend
        const world = yield* FakeSandboxBackend
        yield* backend.create(layout(s1))
        const command = yield* backend.spawn(s1, { command: "cat" })
        yield* command.write("one\n")
        yield* command.write("two\n")
        yield* command.closeStdin
        const events = yield* Stream.runCollect(command.events)
        expect(events.map((e) => (e._tag === "Exit" ? e.exitCode : text(e.data)))).toEqual([
          "one\n",
          "two\n",
          0,
        ])
        expect(world.spawnCalls).toEqual([{ sessionId: s1, request: { command: "cat" } }])
        expect((yield* Effect.flip(command.write("late"))).message).toBe("command exited")
      }).pipe(Effect.scoped),
      {
        onSpawn: (_call, io) =>
          Effect.as(
            Stream.runForEach(io.stdin, (data) => io.stdout(data)),
            0,
          ),
      },
    ))

  test("kills spawned commands when their Sandbox stops, and refuses to spawn in a stopped one", () =>
    run(
      Effect.gen(function* () {
        const backend = yield* SandboxBackend
        yield* backend.create(layout(s1))
        const command = yield* backend.spawn(s1, { command: "sleep" })
        yield* backend.stop(s1)
        const events = yield* Stream.runCollect(command.events)
        expect(events).toEqual([{ _tag: "Exit", exitCode: killedExitCode }])
        expect((yield* Effect.flip(backend.spawn(s1, { command: "sleep" })))._tag).toBe(
          "SandboxNotRunning",
        )
      }).pipe(Effect.scoped),
      { onSpawn: () => Effect.never },
    ))

  test("snapshots a stopped Sandbox's rootfs and boots new Sandboxes from it", () =>
    run(
      Effect.gen(function* () {
        const backend = yield* SandboxBackend
        const snapshots = Option.getOrThrow(backend.snapshots)
        yield* backend.create(layout(s1))
        yield* backend.writeFile(s1, "/etc/marker", "root")
        expect((yield* Effect.flip(snapshots.snapshot(s1, "env-a", "b1")))._tag).toBe(
          "SandboxNotRunning",
        )
        yield* backend.stop(s1)
        const reference = yield* snapshots.snapshot(s1, "env-a", "b1")
        yield* backend.destroy(s1)
        yield* snapshots.restore(layout(s1), reference)
        yield* snapshots.restore(layout(s2), reference)
        expect(yield* backend.state(s1)).toBe("Running")
        expect(text(yield* backend.readFile(s2, "/etc/marker"))).toBe("root")
        expect(yield* snapshots.list("env-a")).toEqual([{ name: "b1", reference }])
        expect(yield* snapshots.list("env-b")).toEqual([])
      }),
    ))

  test("retains the named snapshots in a group and removes the rest", () =>
    run(
      Effect.gen(function* () {
        const backend = yield* SandboxBackend
        const snapshots = Option.getOrThrow(backend.snapshots)
        yield* backend.create(layout(s1))
        yield* backend.stop(s1)
        for (const name of ["b1", "b2", "b3"]) yield* snapshots.snapshot(s1, "env-a", name)
        yield* snapshots.snapshot(s1, "env-b", "b1")
        yield* snapshots.retain("env-a", ["b3", "b2"])
        expect((yield* snapshots.list("env-a")).map((s) => s.name).toSorted()).toEqual(["b2", "b3"])
        expect((yield* snapshots.list("env-b")).map((s) => s.name)).toEqual(["b1"])
      }),
    ))
})

describe("reconciling", () => {
  test("stops and reports Sandboxes for unknown Sessions, but destroys nothing", () =>
    run(
      Effect.gen(function* () {
        const backend = yield* SandboxBackend
        yield* backend.create(layout(s1))
        yield* backend.create(layout(s2))
        const s3 = "s-3" as SessionId
        yield* backend.create(layout(s3))
        yield* backend.destroy(s3, { keepVolumes: true })

        const report = yield* reconcileSandboxes([s1])

        expect(report.unknown.map((u) => [u.sessionId, u.state, u.stopped])).toEqual([
          [s2, "Stopped", true],
          [s3, "Destroyed", false],
        ])
        expect(yield* backend.state(s1)).toBe("Running")
        expect(yield* backend.state(s2)).toBe("Stopped")
        expect((yield* backend.list).length).toBe(3)
      }),
    ))

  test("two Runners sharing one backend don't touch each other's Sandboxes (#38)", async () => {
    const world = makeFakeWorld()
    const a = makeFake({ world, runner: "runner-a" }).backend
    const b = makeFake({ world, runner: "runner-b" }).backend
    const s3 = "s-3" as SessionId
    await Effect.runPromise(
      Effect.all([a.create(layout(s1)), a.create(layout(s2)), b.create(layout(s3))]),
    )

    // Runner b knows none of its Sessions any more: only its own Sandbox stops.
    const fromB = await reconcileOn(b, [])
    expect(fromB.unknown.map((u) => [u.sessionId, u.runner, u.stopped])).toEqual([
      [s3, "runner-b", true],
    ])
    expect(fromB.others.map((o) => [o.sessionId, o.runner, o.state])).toEqual([
      [s1, "runner-a", "Running"],
      [s2, "runner-a", "Running"],
    ])
    // And a Runner a that runs s-1 stops its own s-2, leaving b's s-3 as b left it.
    const fromA = await reconcileOn(a, [s1])
    expect(fromA.unknown.map((u) => u.sessionId)).toEqual([s2])
    expect([...world.sandboxes].map(([id, sandbox]) => [id, sandbox.state])).toEqual([
      [s1, "Running"],
      [s2, "Stopped"],
      [s3, "Stopped"],
    ])
  })

  test("leaves Sandboxes from before Runner marks alone, and only reports them", () =>
    run(
      Effect.gen(function* () {
        const backend = yield* SandboxBackend
        const world = yield* FakeSandboxBackend
        // As an older Runner made it: a running Sandbox and volumes with no Runner mark.
        yield* backend.create(layout(s2))
        const legacy = world.sandboxes.get(s2)
        if (legacy === undefined) throw new Error("no Sandbox")
        world.sandboxes.set(s2, { ...legacy, runner: undefined })
        for (const name of world.volumeRunners.keys()) world.volumeRunners.set(name, undefined)

        const report = yield* reconcileSandboxes([])

        expect(report.unknown).toEqual([])
        expect(report.others.map((o) => [o.sessionId, o.runner, o.state])).toEqual([
          [s2, undefined, "Running"],
        ])
        expect(yield* backend.state(s2)).toBe("Running")
      }),
    ))
})
