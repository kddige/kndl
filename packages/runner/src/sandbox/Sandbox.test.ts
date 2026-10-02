import { describe, expect, test } from "bun:test"
import type { SessionId } from "@claude-hub/protocol"
import { Effect, Option, Stream } from "effect"
import { FakeSandboxBackend } from "./FakeSandboxBackend.ts"
import { parseSandboxName, parseVolumeName, sandboxName, volumeName } from "./Naming.ts"
import { reconcileSandboxes } from "./Reconcile.ts"
import { SandboxBackend, shell } from "./SandboxBackend.ts"
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

describe("naming", () => {
  test("names carry the prefix and the Session id, and parse back", () => {
    expect(sandboxName(s1)).toBe("claude-hub-s-1")
    expect(volumeName(s1, "deps-node-modules")).toBe("claude-hub-s-1.deps-node-modules")
    expect(parseSandboxName("claude-hub-s-1")).toBe(s1)
    expect(parseVolumeName("claude-hub-s-1.cache")).toEqual({ sessionId: s1, key: "cache" })
  })

  test("names without the prefix are never ours", () => {
    expect(parseSandboxName("cc-spike")).toBeUndefined()
    expect(parseSandboxName("claude-hub-")).toBeUndefined()
    expect(parseVolumeName("cc-spike.cache")).toBeUndefined()
    expect(parseVolumeName("claude-hub-s-1")).toBeUndefined()
  })
})

describe("Session layout", () => {
  test("puts the Workspace on the host and dependencies, caches and Docker on volumes", async () => {
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
      { _tag: "Volume", key: "cache", guestPath: "/var/cache/claude-hub", sizeMib: 16384 },
    ])
    expect(spec.docker).toEqual({ sizeMib: 32768 })
    expect(spec.env).toMatchObject({
      REPO_SECRET: "x",
      XDG_CACHE_HOME: "/var/cache/claude-hub",
      BUN_INSTALL_CACHE_DIR: "/var/cache/claude-hub/bun",
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
        expect(world.volumes.get("claude-hub-s-1.deps-node-modules")?.has("/dep.js")).toBe(true)
      }),
    ))

  test("a destroy that keeps volumes lets a new Sandbox wake on them", () =>
    run(
      Effect.gen(function* () {
        const backend = yield* SandboxBackend
        yield* backend.create(layout(s1))
        yield* backend.writeFile(s1, "/etc/marker", "root")
        yield* backend.writeFile(s1, "/var/cache/claude-hub/bun/pkg", "cached")
        yield* backend.destroy(s1, { keepVolumes: true })
        expect(yield* backend.state(s1)).toBe("Destroyed")
        expect((yield* backend.list).map((l) => [l.sessionId, l.state, l.volumes.length])).toEqual([
          [s1, "Destroyed", 3],
        ])

        yield* backend.create(layout(s1))
        expect(text(yield* backend.readFile(s1, "/var/cache/claude-hub/bun/pkg"))).toBe("cached")
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

  test("snapshots a stopped Sandbox's rootfs and restores it stopped", () =>
    run(
      Effect.gen(function* () {
        const backend = yield* SandboxBackend
        const snapshots = Option.getOrThrow(backend.snapshots)
        yield* backend.create(layout(s1))
        yield* backend.writeFile(s1, "/etc/marker", "root")
        yield* backend.stop(s1)
        const reference = yield* snapshots.snapshot(s1, "before")
        yield* backend.destroy(s1)
        yield* snapshots.restore(layout(s1), reference)
        expect(yield* backend.state(s1)).toBe("Stopped")
        yield* backend.start(s1)
        expect(text(yield* backend.readFile(s1, "/etc/marker"))).toBe("root")
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
})
