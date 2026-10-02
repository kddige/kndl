// An in-memory SandboxBackend for tests: no VMs, no disk. Sandboxes, volumes and host mounts are
// maps of files, kept or lost the way the real backend keeps or loses them, so tests can check
// that data survives stop, start and a destroy that keeps volumes. Commands don't run: each exec
// is recorded and answered by a handler the test provides, and each spawned command is a fiber
// running a handler that reads its stdin and writes its output. Stopping or destroying a Sandbox
// kills the commands spawned in it.
//
//   const layer = FakeSandboxBackend.layer({ onExec: ({ request }) => Effect.succeed({ stdout: "ok" }) })
//   program.pipe(Effect.provide(layer))  // provides SandboxBackend and FakeSandboxBackend

import { posix } from "node:path"
import type { SandboxState, SessionId } from "@claude-hub/protocol"
import { Context, Effect, Fiber, Layer, Option, Queue, Stream } from "effect"
import type { Cause, Scope } from "effect"
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
  SpawnedCommand,
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

/** A spawned command's side of its pipes, for an `onSpawn` handler. */
export interface FakeProcessIO {
  /** What the Runner writes to the command's stdin, ending when it closes stdin. */
  readonly stdin: Stream.Stream<Uint8Array>
  readonly stdout: (data: string | Uint8Array) => Effect.Effect<void>
  readonly stderr: (data: string | Uint8Array) => Effect.Effect<void>
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
  readonly spawnCalls: Array<FakeExecCall>
}

export interface FakeOptions {
  /** Answers every exec. By default a command succeeds with no output. */
  readonly onExec?: (call: FakeExecCall) => Effect.Effect<FakeExecReply>
  /**
   * Plays every spawned command, returning its exit code when it exits. By default a command
   * reads stdin to the end and exits 0.
   */
  readonly onSpawn?: (call: FakeExecCall, io: FakeProcessIO) => Effect.Effect<number>
}

/** The exit code a spawned command reports when its Sandbox stops under it. */
export const killedExitCode = 137

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
    spawnCalls: [],
  }
  const onExec: NonNullable<FakeOptions["onExec"]> = options.onExec ?? (() => Effect.succeed({}))
  const onSpawn: NonNullable<FakeOptions["onSpawn"]> =
    options.onSpawn ?? ((_call, io) => Effect.as(Stream.runDrain(io.stdin), 0))
  /** How to kill each Sandbox's running spawned commands. */
  const killers = new Map<SessionId, Set<Effect.Effect<void>>>()
  const killAll = (sessionId: SessionId) =>
    Effect.suspend(() => {
      const kills = [...(killers.get(sessionId) ?? [])]
      killers.delete(sessionId)
      return Effect.all(kills, { discard: true })
    })

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

  const spawn = (
    sessionId: SessionId,
    request: ExecRequest,
  ): Effect.Effect<SpawnedCommand, SandboxError, Scope.Scope> =>
    Effect.gen(function* () {
      yield* running(sessionId)
      const call = { sessionId, request }
      world.spawnCalls.push(call)
      const stdin = yield* Queue.unbounded<Uint8Array, Cause.Done>()
      const output = yield* Queue.unbounded<ExecEvent, Cause.Done>()
      const status = { exited: false }
      const exit = (exitCode: number) =>
        Effect.suspend(() => {
          if (status.exited) return Effect.void
          status.exited = true
          return Effect.andThen(Queue.offer(output, { _tag: "Exit", exitCode }), Queue.end(output))
        })
      const emit = (_tag: "Stdout" | "Stderr") => (data: string | Uint8Array) =>
        Effect.asVoid(Queue.offer(output, { _tag, data: encode(data) }))
      const fiber = yield* onSpawn(call, {
        stdin: Stream.fromQueue(stdin),
        stdout: emit("Stdout"),
        stderr: emit("Stderr"),
      }).pipe(Effect.flatMap(exit), Effect.forkScoped)
      const kill = Effect.andThen(Fiber.interrupt(fiber), exit(killedExitCode))
      const kills = killers.get(sessionId) ?? new Set()
      killers.set(sessionId, kills.add(kill))
      yield* Effect.addFinalizer(() =>
        Effect.andThen(Fiber.interrupt(fiber), Effect.sync(() => kills.delete(kill))),
      )
      return {
        events: Stream.fromQueue(output),
        write: (data) =>
          status.exited
            ? Effect.fail(
                new SandboxBackendError({ operation: "write stdin", message: "command exited" }),
              )
            : Effect.asVoid(Queue.offer(stdin, encode(data))),
        closeStdin: Effect.asVoid(Queue.end(stdin)),
      }
    })

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
      Effect.flatMap(find(sessionId), (sandbox) => {
        sandbox.state = "Stopped"
        return killAll(sessionId)
      }),
    destroy: (sessionId, destroyOptions) =>
      Effect.andThen(
        killAll(sessionId),
        Effect.sync(() => {
          world.sandboxes.delete(sessionId)
          if (destroyOptions?.keepVolumes === true) return
          // Deleting the entry being visited is safe for a Map.
          for (const name of world.volumes.keys())
            if (parseVolumeName(name)?.sessionId === sessionId) world.volumes.delete(name)
        }),
      ),
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
    spawn,
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
