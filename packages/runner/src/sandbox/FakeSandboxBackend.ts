// An in-memory SandboxBackend for tests: no VMs, no disk. Sandboxes, volumes and host mounts are
// maps of files, kept or lost the way the real backend keeps or loses them, so tests can check
// that data survives stop, start and a destroy that keeps volumes. Commands don't run: each exec
// is recorded and answered by a handler the test provides, and each spawned command is a fiber
// running a handler that reads its stdin and writes its output. Stopping or destroying a Sandbox
// kills the commands spawned in it.
//
//   const layer = FakeSandboxBackend.layer({ onExec: ({ request }) => Effect.succeed({ stdout: "ok" }) })
//   program.pipe(Effect.provide(layer))  // provides SandboxBackend and FakeSandboxBackend
//
// A TCP connection into a fake Sandbox (connectTcp) is a real one to the same address on the host,
// at the port `tcpPort` maps the guest's to, so a test serves the "guest" with Bun.serve.
//
// Each fake works for one Runner, by its mark. Two fakes given the same `world` are two Runners
// on one host, sharing one microsandbox.

import { stat } from "node:fs/promises"
import { createConnection } from "node:net"
import { posix } from "node:path"
import type { SandboxState, SessionId } from "@claude-hub/protocol"
import { Context, Effect, Fiber, Layer, Option, Queue, Stream } from "effect"
import type { Cause, Scope } from "effect"
import { parseVolumeName, volumeName } from "./Naming.ts"
import {
  InvalidSandboxSpec,
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
  GuestTcpConnection,
  GuestTcpEvents,
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
  /** The mark of the Runner that made it; undefined for one from before marks. */
  readonly runner: string | undefined
  state: SandboxState
  /** The root filesystem: every path not under a mount. Kept across stop and start. */
  readonly rootfs: Map<string, Uint8Array>
}

/** What the fake holds, for tests to look at and change. */
export interface FakeSandboxWorld {
  readonly sandboxes: Map<SessionId, FakeSandbox>
  /** Files on each Session volume, by the volume's name. */
  readonly volumes: Map<string, Map<string, Uint8Array>>
  /** The mark of the Runner that made each volume, by the volume's name. */
  readonly volumeRunners: Map<string, string | undefined>
  /** Files on the host, by absolute path: what host mounts read and write. */
  readonly hostFiles: Map<string, Uint8Array>
  /** Saved root filesystems, by reference: `<runner>/<group>/<name>`. */
  readonly snapshots: Map<string, Map<string, Uint8Array>>
  /** Every Sandbox booted from a snapshot, in order. */
  readonly restores: Array<{ readonly sessionId: SessionId; readonly reference: string }>
  readonly execCalls: Array<FakeExecCall>
  readonly spawnCalls: Array<FakeExecCall>
  /** Every TCP connection asked for, in order. */
  readonly tcpConnects: Array<{
    readonly sessionId: SessionId
    readonly address: string
    readonly port: number
  }>
}

export interface FakeOptions {
  /** The mark of the Runner this fake works for. Defaults to {@link fakeRunner}. */
  readonly runner?: string
  /** The host's Sandboxes and volumes, to share with another fake. A new one by default. */
  readonly world?: FakeSandboxWorld
  /** Answers every exec. By default a command succeeds with no output. */
  readonly onExec?: (call: FakeExecCall) => Effect.Effect<FakeExecReply>
  /**
   * Plays every spawned command, returning its exit code when it exits. By default a command
   * reads stdin to the end and exits 0.
   */
  readonly onSpawn?: (call: FakeExecCall, io: FakeProcessIO) => Effect.Effect<number>
  /**
   * Refuses, as microsandbox does, to create or restore a Sandbox with a host mount whose path
   * isn't a directory on the real disk. Off by default, so tests may mount made-up paths.
   */
  readonly checkHostPaths?: boolean
  /** The host port a connection to a guest port reaches. The same port by default. */
  readonly tcpPort?: (guestPort: number) => number
}

/** The mark of a fake's Runner, unless the test names one. */
export const fakeRunner = "fake-runner"

/** An empty host. */
export const makeFakeWorld = (): FakeSandboxWorld => ({
  sandboxes: new Map(),
  volumes: new Map(),
  volumeRunners: new Map(),
  hostFiles: new Map(),
  snapshots: new Map(),
  restores: [],
  execCalls: [],
  spawnCalls: [],
  tcpConnects: [],
})

/** The exit code a spawned command reports when its Sandbox stops under it. */
export const killedExitCode = 137

const encode = (data: string | Uint8Array) =>
  typeof data === "string" ? new TextEncoder().encode(data) : data

const within = (guestPath: string, path: string) =>
  path === guestPath || path.startsWith(`${guestPath}/`)

export const makeFake = (options: FakeOptions = {}) => {
  const world = options.world ?? makeFakeWorld()
  const runner = options.runner ?? fakeRunner
  const onExec: NonNullable<FakeOptions["onExec"]> = options.onExec ?? (() => Effect.succeed({}))
  const onSpawn: NonNullable<FakeOptions["onSpawn"]> =
    options.onSpawn ?? ((_call, io) => Effect.as(Stream.runDrain(io.stdin), 0))
  const snapshotReference = (group: string, name: string) => `${runner}/${group}/${name}`
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

  const checkHostPaths = (spec: SandboxSpec) =>
    Effect.forEach(
      options.checkHostPaths === true ? spec.mounts : [],
      (mount) =>
        mount._tag !== "Host"
          ? Effect.void
          : Effect.flatMap(
              Effect.promise(() =>
                stat(mount.hostPath).then(
                  (stats) => stats.isDirectory(),
                  () => false,
                ),
              ),
              (isDirectory) =>
                isDirectory
                  ? Effect.void
                  : Effect.fail(
                      new InvalidSandboxSpec({
                        message: `host path ${mount.hostPath} is not a directory`,
                      }),
                    ),
            ),
      { discard: true },
    )

  const boot = (spec: SandboxSpec, rootfs: Map<string, Uint8Array>, state: SandboxState) => {
    for (const volume of specVolumes(spec)) {
      const name = volumeName(spec.sessionId, volume.key)
      if (world.volumes.has(name)) continue
      world.volumes.set(name, new Map())
      world.volumeRunners.set(name, runner)
    }
    world.sandboxes.set(spec.sessionId, { spec, runner, state, rootfs })
  }

  const readFile: SandboxBackendShape["readFile"] = (sessionId, path) =>
    Effect.flatMap(running(sessionId), (sandbox): Effect.Effect<Uint8Array, SandboxError> => {
      const { files, key } = locate(sandbox, path)
      const data = files.get(key)
      return data === undefined
        ? Effect.fail(
            new SandboxBackendError({ operation: "read file", message: `no such file: ${path}` }),
          )
        : Effect.succeed(data)
    })

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
        Effect.andThen(
          Fiber.interrupt(fiber),
          Effect.sync(() => kills.delete(kill)),
        ),
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
    runner,
    create: (spec) =>
      Effect.gen(function* () {
        yield* checkSpec(spec)
        if (world.sandboxes.has(spec.sessionId))
          return yield* new SandboxAlreadyExists({ sessionId: spec.sessionId })
        yield* checkHostPaths(spec)
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
          const keep = destroyOptions?.keepVolumes ?? []
          if (keep === true) return
          // Deleting the entry being visited is safe for a Map.
          for (const name of world.volumes.keys()) {
            const volume = parseVolumeName(name)
            if (volume?.sessionId === sessionId && !keep.includes(volume.key)) {
              world.volumes.delete(name)
              world.volumeRunners.delete(name)
            }
          }
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
      return [...ids].map((sessionId) => {
        const sandbox = world.sandboxes.get(sessionId)
        const volumes = [...world.volumes.keys()].filter(
          (name) => parseVolumeName(name)?.sessionId === sessionId,
        )
        return {
          sessionId,
          runner:
            sandbox === undefined
              ? volumes.map((name) => world.volumeRunners.get(name)).find((r) => r !== undefined)
              : sandbox.runner,
          state: sandbox?.state ?? ("Destroyed" as const),
          volumes,
        }
      })
    }),
    execStream,
    spawn,
    exec: (sessionId, request) => collectExec(execStream(sessionId, request)),
    connectTcp: (sessionId, address, port, events) =>
      Effect.flatMap(running(sessionId), () => {
        world.tcpConnects.push({ sessionId, address, port })
        return connectHostTcp(address, options.tcpPort?.(port) ?? port, events)
      }),
    readFile,
    readTextFile: (sessionId, path) =>
      Effect.map(readFile(sessionId, path), (data) => new TextDecoder().decode(data)),
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
      snapshot: (sessionId, group, name) =>
        Effect.flatMap(find(sessionId), (sandbox) => {
          if (sandbox.state !== "Stopped")
            return Effect.fail(new SandboxNotRunning({ sessionId, state: sandbox.state }))
          const reference = snapshotReference(group, name)
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
          yield* checkHostPaths(spec)
          world.restores.push({ sessionId: spec.sessionId, reference })
          boot(spec, new Map(rootfs), "Running")
        }),
      list: (group) =>
        Effect.sync(() => {
          const inGroup = snapshotReference(group, "")
          return [...world.snapshots.keys()]
            .filter((reference) => reference.startsWith(inGroup))
            .map((reference) => ({ name: reference.slice(inGroup.length), reference }))
        }),
      retain: (group, names) =>
        Effect.sync(() => {
          const inGroup = snapshotReference(group, "")
          for (const reference of world.snapshots.keys())
            if (reference.startsWith(inGroup) && !names.includes(reference.slice(inGroup.length)))
              world.snapshots.delete(reference)
        }),
    }),
  }
  return { backend, world }
}

/**
 * A real TCP connection to `address`:`port` on the host, as a guest connection: what the fake's
 * connectTcp makes, and what tests stand in for a Sandbox's with. Like agentd's (AgentTcp.ts), it
 * reads the socket as fast as it comes and hands everything on; a write is done once the socket
 * has taken it.
 */
export const connectHostTcp = (
  address: string,
  port: number,
  events: GuestTcpEvents,
): Effect.Effect<GuestTcpConnection, SandboxError> =>
  Effect.callback<GuestTcpConnection, SandboxError>((resume) => {
    const socket = createConnection({ host: address, port, allowHalfOpen: true })
    let connected = false
    let over = false
    const finish = () => {
      if (over) return
      over = true
      events.closed(false)
    }
    socket.on("error", (error) => {
      if (connected) return
      resume(
        Effect.fail(
          new SandboxBackendError({ operation: `connect to port ${port}`, message: error.message }),
        ),
      )
    })
    socket.on("data", (data: Buffer) => events.data(new Uint8Array(data)))
    socket.on("end", () => events.eof())
    socket.on("close", () => {
      if (connected) finish()
    })
    socket.on("connect", () => {
      connected = true
      resume(
        Effect.succeed({
          write: (data) =>
            Effect.callback<void, SandboxError>((done) => {
              if (socket.destroyed || socket.writableEnded) {
                return done(
                  Effect.fail(
                    new SandboxBackendError({
                      operation: `write to port ${port}`,
                      message: "the connection is closed",
                    }),
                  ),
                )
              }
              if (socket.write(data)) return done(Effect.void)
              const settle = () => {
                socket.off("drain", settle)
                socket.off("close", settle)
                done(Effect.void)
              }
              socket.on("drain", settle)
              socket.on("close", settle)
            }),
          end: Effect.sync(() => void socket.end()),
          close: Effect.sync(() => {
            socket.destroy()
            finish()
          }),
        }),
      )
    })
  })

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
