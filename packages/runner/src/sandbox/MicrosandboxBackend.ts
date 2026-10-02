// The Sandbox backend on microsandbox (ADR 0007): libkrun microVMs through its TypeScript SDK.
//
// Settings from spike #3 (issue #3, and the comment on issue #9):
// - Network: allowAll. The default blocks the host and the LAN, which ADR 0004 wants open.
// - Host mounts: an explicit quota (the default silently caps guest writes at 4 GiB) and
//   hostPermissions "mirror" (otherwise host git sees every file as 0600, losing executable bits).
// - Session volumes are ext4 disk volumes. A volume mounted inside a host mount needs its mount
//   point to exist on the host, so it is created there first.
// - Docker: dockerd is started on every boot, and containers are stopped before the VM stops,
//   or services crash-recover on the next boot. Those containers are started again on the next
//   boot.
// - Memory: set per VM, and the cap. Freed guest memory isn't returned to the host until stop.
// - metrics() throws for about 2 s after boot; that reads as "no metrics yet".
// - Sandboxes are detached, so they outlive the Runner process: Claude Code keeps running in tmux
//   across a Runner restart, and Reconcile.ts finds any the Runner no longer knows.
//
// Snapshots are not offered (ADR 0006 defers them). In 0.7.6 disk snapshots work, but a restored
// Sandbox loses its env and labels, and a snapshot group's head can't be removed without --force.

import { mkdir, realpath, stat } from "node:fs/promises"
import { join, posix } from "node:path"
import type { SandboxState, SessionId } from "@claude-hub/protocol"
import { Effect, Layer, Option, Stream } from "effect"
import { MicrosandboxError, NetworkPolicy, Sandbox, Volume } from "microsandbox"
import type { SandboxStatus, Sandbox as MsbSandbox } from "microsandbox"
import { prefix, parseSandboxName, parseVolumeName, sandboxName, volumeName } from "./Naming.ts"
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
  HostMount,
  Mount,
  SandboxBackendShape,
  SandboxError,
  SandboxListing,
  SandboxSpec,
} from "./SandboxBackend.ts"
import { checkSpec, dockerDataPath, specVolumes } from "./Spec.ts"

/** Seconds each container gets to stop before Docker kills it. */
const containerStopSeconds = 10

const stateOf = (status: SandboxStatus): SandboxState => {
  switch (status) {
    case "starting":
      return "Starting"
    case "running":
      return "Running"
    case "draining":
      return "Stopping"
    case "crashed":
      return "Failed"
    case "created":
    case "paused":
    case "stopped":
      return "Stopped"
  }
}

const isRunning = (status: SandboxStatus) => status === "running" || status === "draining"

/** Maps a rejection from the SDK to our errors. */
const toError =
  (operation: string, sessionId?: SessionId) =>
  (cause: unknown): SandboxError => {
    if (cause instanceof MicrosandboxError && sessionId !== undefined) {
      switch (cause.code) {
        case "sandboxNotFound":
          return new SandboxNotFound({ sessionId })
        case "sandboxAlreadyExists":
          return new SandboxAlreadyExists({ sessionId })
        case "sandboxNotRunning":
          return new SandboxNotRunning({ sessionId, state: "Stopped" })
      }
    }
    if (cause instanceof MicrosandboxError && cause.code === "invalidConfig")
      return new InvalidSandboxSpec({ message: `${operation}: ${cause.message}` })
    return new SandboxBackendError({
      operation,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    })
  }

const isCode = (code: MicrosandboxError["code"]) => (cause: unknown) =>
  cause instanceof MicrosandboxError && cause.code === code

const call = <A>(operation: string, sessionId: SessionId | undefined, f: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: f, catch: toError(operation, sessionId) })

// Run inside the guest. Each is a no-op when Docker isn't set up for the Sandbox.

/** Lists the containers stopped by the last clean stop, to start again on the next boot. */
const runningListPath = `${dockerDataPath}/.claude-hub-running`

const startDockerScript = `
grep -q ' ${dockerDataPath} ' /proc/mounts || exit 0
command -v dockerd >/dev/null || { echo "the image has no dockerd" >&2; exit 3; }
if ! docker info >/dev/null 2>&1; then
  rm -f /var/run/docker.pid
  (nohup dockerd >/var/log/dockerd.log 2>&1 &)
  i=0
  until docker info >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -ge 300 ] && { tail -n 20 /var/log/dockerd.log >&2; exit 1; }
    sleep 0.1
  done
fi
[ -s ${runningListPath} ] || exit 0
docker start $(cat ${runningListPath}) >/dev/null && rm -f ${runningListPath}`

// Stopping containers by hand means Docker won't restart them on the next boot, whatever their
// restart policy, so the ones running are listed for startDockerScript.
const stopDockerScript = `
command -v docker >/dev/null && docker info >/dev/null 2>&1 || exit 0
ids=$(docker ps -q)
if [ -n "$ids" ]; then
  echo $ids > ${runningListPath}
  docker stop -t ${containerStopSeconds} $ids >/dev/null
fi
pid=$(cat /var/run/docker.pid 2>/dev/null) || exit 0
kill "$pid" 2>/dev/null || exit 0
while kill -0 "$pid" 2>/dev/null; do sleep 0.1; done
sync`

/** The directories on the host that volumes mounted inside host mounts need as mount points. */
const hostMountPoints = (spec: SandboxSpec) => {
  const hosts = spec.mounts.filter((mount): mount is HostMount => mount._tag === "Host")
  return specVolumes(spec).flatMap((volume) => {
    const host = hosts
      .filter((h) => volume.guestPath.startsWith(`${h.guestPath}/`))
      .toSorted((a, b) => b.guestPath.length - a.guestPath.length)[0]
    return host === undefined
      ? []
      : [join(host.hostPath, posix.relative(host.guestPath, volume.guestPath))]
  })
}

const handle = (sessionId: SessionId) =>
  call("look up Sandbox", sessionId, () => Sandbox.get(sandboxName(sessionId)))

const state: SandboxBackendShape["state"] = (sessionId) =>
  handle(sessionId).pipe(
    Effect.map((h) => stateOf(h.status)),
    Effect.catchTag("SandboxNotFound", () => Effect.succeed("Destroyed" as const)),
  )

/** Builds and boots the VM. Host paths must already be resolved. */
const boot = (spec: SandboxSpec) => {
  // Parents before the mounts nested in them.
  const mounts = [...spec.mounts.filter((m) => m._tag === "Host"), ...specVolumes(spec)].toSorted(
    (a, b) => a.guestPath.length - b.guestPath.length,
  )
  let builder = Sandbox.builder(sandboxName(spec.sessionId))
    .image(spec.image)
    .cpus(spec.cpus)
    .memory(spec.memoryMib)
    .network((n) => n.policy(NetworkPolicy.allowAll()))
    .label("claude-hub.session", spec.sessionId)
    .envs({ ...spec.env })
    .detached(true)
  if (spec.rootDiskMib !== undefined) builder = builder.rootDisk(spec.rootDiskMib)
  if (spec.workdir !== undefined) builder = builder.workdir(spec.workdir)
  for (const mount of mounts) {
    builder = builder.volume(mount.guestPath, (m) => {
      if (mount._tag === "Volume") return m.named(volumeName(spec.sessionId, mount.key))
      const bound = m.bind(mount.hostPath).hostPermissions("mirror").quota(mount.quotaMib)
      return mount.readOnly === true ? bound.readonly() : bound
    })
  }
  return builder.create()
}

export const make = Effect.gen(function* () {
  // Connections to running Sandboxes, so each command doesn't reconnect.
  const connections = new Map<SessionId, MsbSandbox>()

  const forget = (sessionId: SessionId) => {
    const sandbox = connections.get(sessionId)
    connections.delete(sessionId)
    return sandbox === undefined
      ? Effect.void
      : Effect.promise(() => sandbox.detach().catch(() => undefined))
  }

  yield* Effect.addFinalizer(() =>
    Effect.forEach([...connections.keys()], forget, { discard: true }),
  )

  const remember = (sessionId: SessionId, sandbox: MsbSandbox) =>
    Effect.gen(function* () {
      yield* forget(sessionId)
      connections.set(sessionId, sandbox)
      return sandbox
    })

  const connected = Effect.fnUntraced(function* (sessionId: SessionId) {
    const existing = connections.get(sessionId)
    if (existing !== undefined) return existing
    const h = yield* handle(sessionId)
    if (!isRunning(h.status))
      return yield* new SandboxNotRunning({ sessionId, state: stateOf(h.status) })
    const sandbox = yield* call("connect to Sandbox", sessionId, () => h.connect())
    return yield* remember(sessionId, sandbox)
  })

  /** Runs an operation on the connected Sandbox; any failure drops the connection. */
  const withSandbox = <A>(
    sessionId: SessionId,
    operation: string,
    f: (sandbox: MsbSandbox) => PromiseLike<A>,
  ) =>
    connected(sessionId).pipe(
      Effect.flatMap((sandbox) => call(operation, sessionId, () => f(sandbox))),
      Effect.tapError(() => forget(sessionId)),
    )

  const guestScript = (sessionId: SessionId, operation: string, script: string) =>
    withSandbox(sessionId, operation, (sandbox) => sandbox.shell(script)).pipe(
      Effect.flatMap((output) =>
        output.code === 0
          ? Effect.void
          : Effect.fail(
              new SandboxBackendError({
                operation,
                message: `exit ${output.code}: ${output.stderr().trim() || output.stdout().trim()}`,
              }),
            ),
      ),
    )

  const startDocker = (sessionId: SessionId) =>
    guestScript(sessionId, "start dockerd", startDockerScript)

  /** Stops Docker's containers cleanly. A failure is logged, not fatal: the VM stops regardless. */
  const stopDocker = (sessionId: SessionId) =>
    guestScript(sessionId, "stop Docker", stopDockerScript).pipe(
      Effect.timeout("90 seconds"),
      Effect.catch((error) =>
        Effect.logWarning(`Docker did not stop cleanly in Session ${sessionId}`, error),
      ),
    )

  const ensureVolumes = Effect.fnUntraced(function* (spec: SandboxSpec) {
    for (const volume of specVolumes(spec)) {
      const name = volumeName(spec.sessionId, volume.key)
      yield* call("create volume", spec.sessionId, () =>
        Volume.builder(name)
          .disk()
          .size(volume.sizeMib)
          .label("claude-hub.session", spec.sessionId)
          .label("claude-hub.volume", volume.key)
          .create(),
      ).pipe(
        // An existing volume holds the Session's data from before: keep it as it is.
        Effect.catchIf(
          (error) =>
            error._tag === "SandboxBackendError" && isCode("volumeAlreadyExists")(error.cause),
          () => Effect.void,
        ),
      )
    }
  })

  /**
   * Checks the host mounts and resolves their paths (microsandbox can't mount a path through a
   * symlink, such as macOS's /var), and makes the mount points volumes inside them need.
   */
  const prepareHost = Effect.fnUntraced(function* (spec: SandboxSpec) {
    const mounts: Array<Mount> = []
    for (const mount of spec.mounts) {
      if (mount._tag !== "Host") {
        mounts.push(mount)
        continue
      }
      const hostPath = yield* Effect.promise(() =>
        realpath(mount.hostPath).then(
          async (path) => ((await stat(path)).isDirectory() ? path : undefined),
          () => undefined,
        ),
      )
      if (hostPath === undefined)
        return yield* new InvalidSandboxSpec({
          message: `host path ${mount.hostPath} is not a directory`,
        })
      mounts.push({ ...mount, hostPath })
    }
    const resolved: SandboxSpec = { ...spec, mounts }
    for (const dir of hostMountPoints(resolved))
      yield* call("create mount point", spec.sessionId, () => mkdir(dir, { recursive: true }))
    return resolved
  })

  const create: SandboxBackendShape["create"] = Effect.fn("SandboxBackend.create")(function* (
    spec: SandboxSpec,
  ) {
    const { sessionId } = spec
    yield* checkSpec(spec)
    const existing = yield* handle(sessionId).pipe(Effect.option)
    if (Option.isSome(existing)) return yield* new SandboxAlreadyExists({ sessionId })
    const resolved = yield* prepareHost(spec)
    yield* ensureVolumes(spec)
    const sandbox = yield* call("create Sandbox", sessionId, () => boot(resolved)).pipe(
      // A VM that fails to boot is still recorded; remove it so create can be retried. In 0.7.6
      // the SDK records it again as crashed when this process exits, which the next Runner's
      // reconcile then reports; Spec.ts refuses the one cause of this we know of.
      Effect.tapError((error) =>
        error._tag === "SandboxAlreadyExists"
          ? Effect.void
          : Effect.promise(() => Sandbox.remove(sandboxName(sessionId)).catch(() => undefined)),
      ),
    )
    yield* remember(sessionId, sandbox)
    yield* startDocker(sessionId)
  })

  const start: SandboxBackendShape["start"] = Effect.fn("SandboxBackend.start")(function* (
    sessionId: SessionId,
  ) {
    const h = yield* handle(sessionId)
    if (!isRunning(h.status)) {
      const sandbox = yield* call("start Sandbox", sessionId, () =>
        Sandbox.startDetached(sandboxName(sessionId)),
      )
      yield* remember(sessionId, sandbox)
    }
    yield* startDocker(sessionId)
  })

  const stop: SandboxBackendShape["stop"] = Effect.fn("SandboxBackend.stop")(function* (
    sessionId: SessionId,
  ) {
    const h = yield* handle(sessionId)
    if (!isRunning(h.status)) return yield* forget(sessionId)
    yield* stopDocker(sessionId)
    yield* call("stop Sandbox", sessionId, () => h.stop())
    yield* forget(sessionId)
  })

  const destroy: SandboxBackendShape["destroy"] = Effect.fn("SandboxBackend.destroy")(function* (
    sessionId: SessionId,
    options?: { readonly keepVolumes?: boolean },
  ) {
    const keepVolumes = options?.keepVolumes === true
    const h = yield* handle(sessionId).pipe(
      Effect.map(Option.some),
      Effect.catchTag("SandboxNotFound", () => Effect.succeedNone),
    )
    if (Option.isSome(h)) {
      // Kept volumes must be left consistent; doomed ones needn't be.
      if (keepVolumes && isRunning(h.value.status)) yield* stopDocker(sessionId)
      yield* forget(sessionId)
      yield* call("destroy Sandbox", sessionId, () => h.value.destroy())
    }
    if (keepVolumes) return
    const volumes = yield* call("list volumes", sessionId, () => Volume.list())
    for (const volume of volumes) {
      if (parseVolumeName(volume.name)?.sessionId !== sessionId) continue
      yield* call("remove volume", sessionId, () => Volume.remove(volume.name)).pipe(
        Effect.catchIf(
          (error) => error._tag === "SandboxBackendError" && isCode("volumeNotFound")(error.cause),
          () => Effect.void,
        ),
      )
    }
  })

  const list: SandboxBackendShape["list"] = Effect.gen(function* () {
    const listings = new Map<SessionId, { state: SandboxState; volumes: Array<string> }>()
    const entry = (sessionId: SessionId) => {
      const existing = listings.get(sessionId)
      if (existing !== undefined) return existing
      const created = { state: "Destroyed" as SandboxState, volumes: [] as Array<string> }
      listings.set(sessionId, created)
      return created
    }
    let cursor: string | undefined
    do {
      const page = yield* call("list Sandboxes", undefined, () =>
        Sandbox.listWith((l) => (cursor === undefined ? l : l.cursor(cursor))),
      )
      for (const sandbox of page.sandboxes) {
        const sessionId = parseSandboxName(sandbox.name)
        if (sessionId !== undefined) entry(sessionId).state = stateOf(sandbox.status)
      }
      cursor = page.nextCursor
    } while (cursor !== undefined)
    const volumes = yield* call("list volumes", undefined, () => Volume.list())
    for (const volume of volumes) {
      if (!volume.name.startsWith(prefix)) continue
      const parsed = parseVolumeName(volume.name)
      if (parsed !== undefined) entry(parsed.sessionId).volumes.push(volume.name)
    }
    return [...listings].map(([sessionId, found]): SandboxListing => ({ sessionId, ...found }))
  })

  /**
   * Starts a command, killed when the scope closes unless it has exited. Its stdin is a pipe left
   * open for writing, or `request.stdin` (if any) followed by end of input.
   */
  const startExec = (sessionId: SessionId, request: ExecRequest, stdin: "Pipe" | "Request") =>
    Effect.gen(function* () {
      const status = { exited: false }
      const running = yield* Effect.acquireRelease(
        withSandbox(sessionId, "exec", (sandbox) =>
          sandbox.execStreamWith(request.command, (b) => {
            let options = b.args([...(request.args ?? [])])
            if (request.cwd !== undefined) options = options.cwd(request.cwd)
            if (request.user !== undefined) options = options.user(request.user)
            if (request.env !== undefined) options = options.envs({ ...request.env })
            if (stdin === "Pipe") return options.stdinPipe()
            return request.stdin === undefined
              ? options.stdinNull()
              : options.stdinBytes(Buffer.from(request.stdin))
          }),
        ),
        // Interrupted before the command finished: don't leave it running.
        (running) =>
          status.exited ? Effect.void : Effect.promise(() => running.kill().catch(() => undefined)),
      )
      const events = Stream.fromAsyncIterable(running, toError("exec", sessionId)).pipe(
        Stream.flatMap((event): Stream.Stream<ExecEvent> => {
          switch (event.kind) {
            case "stdout":
              return Stream.succeed({ _tag: "Stdout", data: event.data })
            case "stderr":
              return Stream.succeed({ _tag: "Stderr", data: event.data })
            case "exited":
              status.exited = true
              return Stream.succeed({ _tag: "Exit", exitCode: event.code })
            case "started":
              return Stream.empty
          }
        }),
      )
      return { running, events }
    })

  const execStream: SandboxBackendShape["execStream"] = (sessionId, request) =>
    Stream.unwrap(Effect.map(startExec(sessionId, request, "Request"), (started) => started.events))

  const spawn: SandboxBackendShape["spawn"] = (sessionId, request) =>
    Effect.gen(function* () {
      const { running, events } = yield* startExec(sessionId, request, "Pipe")
      const sink = yield* call("open stdin", sessionId, () => running.takeStdin())
      if (sink === null)
        return yield* new SandboxBackendError({ operation: "open stdin", message: "stdin taken" })
      let isClosed = false
      return {
        events,
        write: (data: string | Uint8Array) =>
          call("write stdin", sessionId, () => sink.write(data)),
        closeStdin: Effect.suspend(() => {
          if (isClosed) return Effect.void
          isClosed = true
          return Effect.promise(() => sink.close().catch(() => undefined))
        }),
      }
    })

  const backend: SandboxBackendShape = {
    create,
    start,
    stop,
    destroy,
    state,
    list,
    execStream,
    spawn,
    exec: (sessionId, request) => collectExec(execStream(sessionId, request)),
    readFile: (sessionId, path) =>
      withSandbox(sessionId, "read file", (sandbox) => sandbox.fs().read(path)),
    writeFile: (sessionId, path, data) =>
      withSandbox(sessionId, "write file", async (sandbox) => {
        const fs = sandbox.fs()
        const parent = posix.dirname(path)
        if (!(await fs.exists(parent))) await fs.mkdir(parent)
        await fs.write(path, data)
      }),
    metrics: (sessionId) =>
      Effect.gen(function* () {
        const h = yield* handle(sessionId)
        if (!isRunning(h.status)) return Option.none()
        return yield* call("read metrics", sessionId, () => h.metrics()).pipe(
          Effect.map((m) =>
            Option.some({
              cpuPercent: Number(m.cpuPercent),
              memoryBytes: Number(m.memoryBytes),
              memoryLimitBytes: Number(m.memoryLimitBytes),
              hostResidentBytes:
                m.memoryHostResidentBytes === null ? null : Number(m.memoryHostResidentBytes),
              uptimeMs: Number(m.uptimeMs),
            }),
          ),
          // For about 2 s after boot there are none yet ("no verified live metrics slot").
          Effect.catchTag("SandboxBackendError", () => Effect.succeedNone),
        )
      }),
    snapshots: Option.none(),
  }
  return backend
})

/** The microsandbox backend. Needs `msb` installed for the user running the Runner. */
export const layer = Layer.effect(SandboxBackend, make)
