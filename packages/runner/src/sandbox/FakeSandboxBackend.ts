// An in-memory SandboxBackend for tests: no VMs, no disk. Sandboxes, volumes and host mounts are
// maps of files, kept or lost the way the real backend keeps or loses them, so tests can check
// that data survives stop, start and a destroy that keeps volumes. Commands don't run: each exec
// is recorded and answered by a handler the test provides.
//
//   const layer = FakeSandboxBackend.layer({ onExec: ({ request }) => Effect.succeed({ stdout: "ok" }) })
//   program.pipe(Effect.provide(layer))  // provides SandboxBackend and FakeSandboxBackend

import { posix } from "node:path"
import type { SandboxState, SessionId } from "@claude-hub/protocol"
import { Context, Effect, Layer, Option, Stream } from "effect"
import { parseVolumeName, volumeName } from "./Naming.ts"
import {
  SandboxAlreadyExists,
  SandboxBackend,
  SandboxBackendError,
  SandboxNotFound,
  SandboxNotRunning,
  collectExec,
} from "./SandboxBackend.ts"
import type {
  ExecEvent,
  ExecRequest,
  SandboxBackendShape,
  SandboxError,
  SandboxSpec,
} from "./SandboxBackend.ts"
import { checkSpec, specVolumes } from "./Spec.ts"

export interface FakeExecCall {
  readonly sessionId: SessionId
  readonly request: ExecRequest
}

export interface FakeExecReply {
  readonly exitCode?: number
  readonly stdout?: string | Uint8Array
  readonly stderr?: string | Uint8Array
}

export interface FakeSandbox {
  readonly spec: SandboxSpec
  state: SandboxState
  /** The root filesystem: every path not under a mount. Kept across stop and start. */
  readonly rootfs: Map<string, Uint8Array>
}

/** What the fake holds, for tests to look at and change. */
export interface FakeSandboxWorld {
  readonly sandboxes: Map<SessionId, FakeSandbox>
  /** Files on each Session volume, by the volume's name. */
  readonly volumes: Map<string, Map<string, Uint8Array>>
  /** Files on the host, by absolute path: what host mounts read and write. */
  readonly hostFiles: Map<string, Uint8Array>
  readonly snapshots: Map<string, Map<string, Uint8Array>>
  readonly execCalls: Array<FakeExecCall>
}

export interface FakeOptions {
  /** Answers every exec. By default a command succeeds with no output. */
  readonly onExec?: (call: FakeExecCall) => Effect.Effect<FakeExecReply>
}

const encode = (data: string | Uint8Array) =>
  typeof data === "string" ? new TextEncoder().encode(data) : data

const within = (guestPath: string, path: string) =>
  path === guestPath || path.startsWith(`${guestPath}/`)

export const makeFake = (options: FakeOptions = {}) => {
  const world: FakeSandboxWorld = {
    sandboxes: new Map(),
    volumes: new Map(),
    hostFiles: new Map(),
    snapshots: new Map(),
    execCalls: [],
  }
  const onExec: NonNullable<FakeOptions["onExec"]> = options.onExec ?? (() => Effect.succeed({}))

  const find = (sessionId: SessionId) => {
    const sandbox = world.sandboxes.get(sessionId)
    return sandbox === undefined
      ? Effect.fail(new SandboxNotFound({ sessionId }))
      : Effect.succeed(sandbox)
  }

  const running = (sessionId: SessionId) =>
    Effect.flatMap(find(sessionId), (sandbox) =>
      sandbox.state === "Running"
        ? Effect.succeed(sandbox)
        : Effect.fail(new SandboxNotRunning({ sessionId, state: sandbox.state })),
    )

  /** The file map and key a guest path lands in: the deepest mount holding it, or the rootfs. */
  const locate = (sandbox: FakeSandbox, path: string) => {
    const normal = posix.normalize(path)
    const mounts = [
      ...sandbox.spec.mounts.filter((m) => m._tag === "Host"),
      ...specVolumes(sandbox.spec),
    ]
      .filter((mount) => within(mount.guestPath, normal))
      .toSorted((a, b) => b.guestPath.length - a.guestPath.length)
    const mount = mounts[0]
    if (mount === undefined) return { files: sandbox.rootfs, key: normal }
    const relative = posix.relative(mount.guestPath, normal)
    if (mount._tag === "Host")
      return { files: world.hostFiles, key: posix.join(mount.hostPath, relative) }
    const name = volumeName(sandbox.spec.sessionId, mount.key)
    const files = world.volumes.get(name) ?? new Map<string, Uint8Array>()
    world.volumes.set(name, files)
    return { files, key: `/${relative}` }
  }

  const boot = (spec: SandboxSpec, rootfs: Map<string, Uint8Array>, state: SandboxState) => {
    for (const volume of specVolumes(spec)) {
      const name = volumeName(spec.sessionId, volume.key)
      if (!world.volumes.has(name)) world.volumes.set(name, new Map())
    }
    world.sandboxes.set(spec.sessionId, { spec, state, rootfs })
  }

  const execStream: SandboxBackendShape["execStream"] = (sessionId, request) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* running(sessionId)
        const call = { sessionId, request }
        world.execCalls.push(call)
        const reply = yield* onExec(call)
        const events: Array<ExecEvent> = []
        if (reply.stdout !== undefined) events.push({ _tag: "Stdout", data: encode(reply.stdout) })
        if (reply.stderr !== undefined) events.push({ _tag: "Stderr", data: encode(reply.stderr) })
        events.push({ _tag: "Exit", exitCode: reply.exitCode ?? 0 })
        return Stream.fromIterable(events)
      }),
    )

  const backend: SandboxBackendShape = {
    create: (spec) =>
      Effect.gen(function* () {
        yield* checkSpec(spec)
        if (world.sandboxes.has(spec.sessionId))
          return yield* new SandboxAlreadyExists({ sessionId: spec.sessionId })
        boot(spec, new Map(), "Running")
      }),
    start: (sessionId) =>
      Effect.map(find(sessionId), (sandbox) => {
        sandbox.state = "Running"
      }),
    stop: (sessionId) =>
      Effect.map(find(sessionId), (sandbox) => {
        sandbox.state = "Stopped"
      }),
    destroy: (sessionId, destroyOptions) =>
      Effect.sync(() => {
        world.sandboxes.delete(sessionId)
        if (destroyOptions?.keepVolumes === true) return
        // Deleting the entry being visited is safe for a Map.
        for (const name of world.volumes.keys())
          if (parseVolumeName(name)?.sessionId === sessionId) world.volumes.delete(name)
      }),
    state: (sessionId) =>
      Effect.succeed(world.sandboxes.get(sessionId)?.state ?? ("Destroyed" as const)),
    list: Effect.sync(() => {
      const ids = new Set<SessionId>(world.sandboxes.keys())
      for (const name of world.volumes.keys()) {
        const parsed = parseVolumeName(name)
        if (parsed !== undefined) ids.add(parsed.sessionId)
      }
      return [...ids].map((sessionId) => ({
        sessionId,
        state: world.sandboxes.get(sessionId)?.state ?? ("Destroyed" as const),
        volumes: [...world.volumes.keys()].filter(
          (name) => parseVolumeName(name)?.sessionId === sessionId,
        ),
      }))
    }),
    execStream,
    exec: (sessionId, request) => collectExec(execStream(sessionId, request)),
    readFile: (sessionId, path) =>
      Effect.flatMap(running(sessionId), (sandbox): Effect.Effect<Uint8Array, SandboxError> => {
        const { files, key } = locate(sandbox, path)
        const data = files.get(key)
        return data === undefined
          ? Effect.fail(
              new SandboxBackendError({ operation: "read file", message: `no such file: ${path}` }),
            )
          : Effect.succeed(data)
      }),
    writeFile: (sessionId, path, data) =>
      Effect.map(running(sessionId), (sandbox) => {
        const { files, key } = locate(sandbox, path)
        files.set(key, encode(data))
      }),
    metrics: (sessionId) =>
      Effect.succeed(
        world.sandboxes.get(sessionId)?.state === "Running"
          ? Option.some({
              cpuPercent: 0,
              memoryBytes: 64 * 1024 * 1024,
              memoryLimitBytes: (world.sandboxes.get(sessionId)?.spec.memoryMib ?? 0) * 1024 * 1024,
              hostResidentBytes: 64 * 1024 * 1024,
              uptimeMs: 0,
            })
          : Option.none(),
      ),
    snapshots: Option.some({
      snapshot: (sessionId, label) =>
        Effect.flatMap(find(sessionId), (sandbox) => {
          if (sandbox.state !== "Stopped")
            return Effect.fail(new SandboxNotRunning({ sessionId, state: sandbox.state }))
          const reference = `${sessionId}:${label}`
          world.snapshots.set(reference, new Map(sandbox.rootfs))
          return Effect.succeed(reference)
        }),
      restore: (spec, reference) =>
        Effect.gen(function* () {
          yield* checkSpec(spec)
          if (world.sandboxes.has(spec.sessionId))
            return yield* new SandboxAlreadyExists({ sessionId: spec.sessionId })
          const rootfs = world.snapshots.get(reference)
          if (rootfs === undefined)
            return yield* new SandboxBackendError({
              operation: "restore",
              message: `no snapshot ${reference}`,
            })
          boot(spec, new Map(rootfs), "Stopped")
        }),
    }),
  }
  return { backend, world }
}

/** The fake's state, provided next to the SandboxBackend by {@link layer}. */
export class FakeSandboxBackend extends Context.Service<FakeSandboxBackend, FakeSandboxWorld>()(
  "@claude-hub/runner/FakeSandboxBackend",
) {
  static readonly layer = (options?: FakeOptions) =>
    Layer.syncContext(() => {
      const { backend, world } = makeFake(options)
      return Context.make(SandboxBackend, backend).pipe(Context.add(FakeSandboxBackend, world))
    })
}
