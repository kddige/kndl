// A Session's Open ports (GLOSSARY.md, ADR 0016): the TCP ports something in its Sandbox listens
// on, noticed by polling while the Session is awake and sent to the Hub when they change.
//
// From spike #170:
// - The LISTEN rows of the guest's /proc/net/tcp and /proc/net/tcp6, read through the backend's
//   file API, which starts no process in the guest; `ss` and `netstat` aren't in every image.
// - Which process owns a socket takes an exec (`ls -l /proc/*/fd`), so it is asked only when the
//   set of listening sockets changes, and only for the new ones.
// - Claude Code's own listener, the callback of its /login, is left out: the one owned by the
//   Claude Code the Runner installs, never a process it started, such as a dev server run by its
//   Bash tool. A port Docker publishes is kept; docker-proxy listens on it.
// - A process is named by its program and, for a runtime, its script (`node vite`), never by its
//   whole command line, whose arguments may hold secrets; `comm` is `MainThread` for Node 22+.

import type { OpenPort, SessionId } from "@kndl/protocol"
import { RunnerToHub } from "@kndl/protocol"
import { Context, Data, Duration, Effect, Fiber, Layer, Schedule, Semaphore } from "effect"
import { HubLink } from "./HubLink.ts"
import { SandboxBackend } from "./sandbox/SandboxBackend.ts"
import { sandboxClaudeGuestDir } from "./sandbox/SandboxClaude.ts"

/** How often an awake Session's Sandbox is asked for its listening sockets. */
export const OpenPortsInterval = Duration.seconds(2)

// ── Reading /proc ──────────────────────────────────────────────────────────

/** A socket in the LISTEN state, from one row of /proc/net/tcp or /proc/net/tcp6. */
export interface ListeningSocket {
  readonly port: number
  readonly address: string
  /** The socket's inode, which names it among a process's file descriptors. */
  readonly inode: string
}

/** The `st` column's value for a socket in the LISTEN state. */
const Listen = "0A"

/** The bytes of a little-endian 32-bit word, in memory order, from its 8 hex digits. */
const wordBytes = (hex: string) =>
  [6, 4, 2, 0].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16))

/** An IPv4 address as /proc writes it: one little-endian word, so `0100007F` is 127.0.0.1. */
export const ipv4FromHex = (hex: string): string => wordBytes(hex).join(".")

/**
 * An IPv6 address as /proc writes it: four little-endian words. Written the usual way, with the
 * longest run of zero groups as `::`, and an IPv4-mapped one as `::ffff:a.b.c.d`.
 */
export const ipv6FromHex = (hex: string): string => {
  const bytes = [0, 8, 16, 24].flatMap((offset) => wordBytes(hex.slice(offset, offset + 8)))
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff)
    return `::ffff:${bytes.slice(12).join(".")}`
  const groups = Array.from({ length: 8 }, (_, g) =>
    (((bytes[2 * g] ?? 0) << 8) | (bytes[2 * g + 1] ?? 0)).toString(16),
  )
  let best = { start: -1, length: 0 }
  for (let i = 0; i < 8;) {
    if (groups[i] !== "0") {
      i++
      continue
    }
    let j = i
    while (j < 8 && groups[j] === "0") j++
    if (j - i > best.length) best = { start: i, length: j - i }
    i = j
  }
  if (best.length < 2) return groups.join(":")
  const head = groups.slice(0, best.start).join(":")
  const tail = groups.slice(best.start + best.length).join(":")
  return `${head}::${tail}`
}

/** The listening sockets in the text of /proc/net/tcp (`family` 4) or /proc/net/tcp6 (6). */
export const parseProcNetTcp = (text: string, family: 4 | 6): Array<ListeningSocket> => {
  const sockets: Array<ListeningSocket> = []
  for (const line of text.split("\n")) {
    // sl local_address rem_address st tx:rx tr:when retrnsmt uid timeout inode ...
    const fields = line.trim().split(/\s+/)
    if (fields.length < 10 || fields[3] !== Listen) continue
    const [addressHex = "", portHex = ""] = (fields[1] ?? "").split(":")
    const port = Number.parseInt(portHex, 16)
    const inode = fields[9] ?? ""
    if (!/^[0-9a-fA-F]+$/.test(portHex) || !(port > 0 && port <= 65535)) continue
    if (addressHex.length !== (family === 4 ? 8 : 32) || !/^\d+$/.test(inode)) continue
    const address = family === 4 ? ipv4FromHex(addressHex) : ipv6FromHex(addressHex)
    sockets.push({ port, address, inode })
  }
  return sockets
}

// ── Who owns a socket ──────────────────────────────────────────────────────

/** A process with a listening socket open. */
export interface SocketOwner {
  readonly pid: number
  /** Where its program is, from /proc/<pid>/exe; empty when it can't be read. */
  readonly exe: string
  readonly comm: string
  readonly argv0: string
  readonly argv1: string
}

/**
 * Prints the processes holding any of the socket inodes it is given as arguments, one line each:
 * `inode pid exe comm argv0 argv1`, tab-separated. Only the first two arguments of a command line
 * are printed. Runs as root in the guest, which sees every process; busybox's sh and awk will do.
 */
export const socketOwnersScript = `want=" $* "
ls -l /proc/[0-9]*/fd 2>/dev/null | awk -v want="$want" '
  /^\\/proc\\/[0-9]+\\/fd:$/ { split($0, p, "/"); pid = p[3]; next }
  pid != "" && match($0, /socket:\\[[0-9]+\\]$/) {
    inode = substr($0, RSTART + 8, RLENGTH - 9)
    if (index(want, " " inode " ")) print inode, pid
  }' | while read -r inode pid; do
  exe=$(readlink "/proc/$pid/exe" 2>/dev/null)
  comm=$(cat "/proc/$pid/comm" 2>/dev/null)
  argv=$(tr '\\000' '\\n' < "/proc/$pid/cmdline" 2>/dev/null | head -n 2 | tr '\\n' '\\t')
  printf '%s\\t%s\\t%s\\t%s\\t%s\\n' "$inode" "$pid" "$exe" "$comm" "$argv"
done
`

/** Parses {@link socketOwnersScript}'s output: each inode's owners, lowest pid first. */
export const parseSocketOwners = (output: string): Map<string, Array<SocketOwner>> => {
  const owners = new Map<string, Array<SocketOwner>>()
  for (const line of output.split("\n")) {
    const [inode = "", pid = "", exe = "", comm = "", argv0 = "", argv1 = ""] = line.split("\t")
    if (!/^\d+$/.test(inode) || !/^\d+$/.test(pid)) continue
    const list = owners.get(inode) ?? []
    list.push({ pid: Number(pid), exe, comm, argv0, argv1 })
    owners.set(inode, list)
  }
  for (const list of owners.values()) list.sort((a, b) => a.pid - b.pid)
  return owners
}

/** The longest a process's name is sent as. */
export const MaxProcessNameLength = 64

const runtimes = new Set(["node", "bun", "deno", "python", "python3", "ruby", "php", "java"])

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1)

/**
 * A process as the Session view shows it: its program, and for a runtime its script without the
 * extension, as `node vite` for `node /app/node_modules/vite/bin/vite.js`. Absent when nothing
 * names it.
 */
export const processName = (owner: SocketOwner): string | undefined => {
  const program = basename(owner.argv0) || basename(owner.exe) || owner.comm
  const script = basename(owner.argv1).replace(/\.(c|m)?(js|ts)$|\.py$/, "")
  const name =
    runtimes.has(program) && script !== "" && !owner.argv1.startsWith("-")
      ? `${program} ${script}`
      : program
  return name === "" ? undefined : name.slice(0, MaxProcessNameLength)
}

/** Whether a process is the Claude Code the Runner runs in every Sandbox, from its cache. */
export const isClaudeCode = (owner: SocketOwner) =>
  [owner.exe, owner.argv0].some((path) => path.startsWith(`${sandboxClaudeGuestDir}/`))

/**
 * Processes of the Sandbox itself rather than the project. None was seen listening on TCP in
 * spike #170; they are left out in case a configuration changes that.
 */
const sandboxOwn = new Set(["dockerd", "containerd", "tmux", "init.krun"])

/**
 * The Open ports to report: one per port, by port, with every address it listens on (IPv4 ones
 * first, as /proc/net/tcp is read first). Leaves out Claude Code's own listener, and one of the
 * Sandbox's own processes.
 */
export const openPortsOf = (
  sockets: ReadonlyArray<ListeningSocket>,
  owners: ReadonlyMap<string, ReadonlyArray<SocketOwner>>,
): Array<OpenPort> => {
  const byPort = new Map<number, { addresses: Array<string>; process: string | undefined }>()
  for (const socket of sockets) {
    const held = owners.get(socket.inode) ?? []
    if (held.some(isClaudeCode)) continue
    const owner = held[0]
    const process = owner === undefined ? undefined : processName(owner)
    if (process !== undefined && sandboxOwn.has(process)) continue
    const entry = byPort.get(socket.port) ?? { addresses: [], process }
    if (!entry.addresses.includes(socket.address)) entry.addresses.push(socket.address)
    entry.process ??= process
    byPort.set(socket.port, entry)
  }
  return [...byPort]
    .toSorted(([a], [b]) => a - b)
    .map(([port, { addresses, process }]) => ({
      port,
      addresses,
      ...(process === undefined ? {} : { process }),
    }))
}

/** Whether two reports list the same Open ports. */
export const samePorts = (a: ReadonlyArray<OpenPort>, b: ReadonlyArray<OpenPort>) =>
  JSON.stringify(a) === JSON.stringify(b)

// ── The service ────────────────────────────────────────────────────────────

/**
 * Watches the Open ports of each awake Session, and tells the Hub (SessionPorts): the whole list,
 * whenever it changes.
 */
export class OpenPorts extends Context.Service<
  OpenPorts,
  {
    /**
     * Starts polling the Session's running Sandbox, at once and then every
     * {@link OpenPortsInterval}. Does nothing if it is already watched.
     */
    readonly watch: (sessionId: SessionId) => Effect.Effect<void>
    /**
     * Stops polling, as the Session goes to sleep, and tells the Hub it has no Open ports if it
     * had any.
     */
    readonly unwatch: (sessionId: SessionId) => Effect.Effect<void>
    /** Sends each watched Session's Open ports again, as after reconnecting to the Hub. */
    readonly resendAll: Effect.Effect<void>
  }
>()("@kndl/runner/OpenPorts") {}

/** The exec naming the owners of the Sandbox's sockets failed. */
class SocketOwnersUnknown extends Data.TaggedError("SocketOwnersUnknown")<{
  readonly message: string
}> {}

interface Watched {
  fiber: Fiber.Fiber<unknown> | undefined
  /** What the Hub was last told; undefined before the first poll. */
  sent: ReadonlyArray<OpenPort> | undefined
  /** The owners of each listening socket seen at the last poll; an empty list when none was found. */
  readonly owners: Map<string, ReadonlyArray<SocketOwner>>
  /** Set while polls fail, so a failing Sandbox is logged about once. */
  failing: boolean
}

/** {@link OpenPorts}, polling every `interval`. */
export const makeOpenPorts = (interval: Duration.Input = OpenPortsInterval) =>
  Effect.gen(function* () {
    const backend = yield* SandboxBackend
    const hub = yield* HubLink
    const scope = yield* Effect.scope
    const watched = new Map<SessionId, Watched>()
    // A report is sent, and recorded as sent, one at a time, so a resend never overtakes it.
    const sending = yield* Semaphore.make(1)

    const send = (sessionId: SessionId, entry: Watched, ports: ReadonlyArray<OpenPort>) =>
      sending.withPermit(
        Effect.suspend(() => {
          if (entry.sent !== undefined && samePorts(entry.sent, ports)) return Effect.void
          entry.sent = ports
          return hub.send(RunnerToHub.cases.SessionPorts.make({ sessionId, ports }))
        }),
      )

    const read = (sessionId: SessionId, path: string) => backend.readTextFile(sessionId, path)

    const poll = (sessionId: SessionId, entry: Watched) =>
      Effect.gen(function* () {
        const tcp = yield* read(sessionId, "/proc/net/tcp")
        // A guest without IPv6 has no tcp6.
        const tcp6 = yield* read(sessionId, "/proc/net/tcp6").pipe(Effect.orElseSucceed(() => ""))
        const sockets = [...parseProcNetTcp(tcp, 4), ...parseProcNetTcp(tcp6, 6)]
        const inodes = new Set(sockets.map((socket) => socket.inode))
        for (const inode of entry.owners.keys()) if (!inodes.has(inode)) entry.owners.delete(inode)
        const unknown = [...inodes].filter((inode) => !entry.owners.has(inode))
        if (unknown.length > 0) {
          const result = yield* backend.exec(sessionId, {
            command: "sh",
            args: ["-c", socketOwnersScript, "owners", ...unknown],
          })
          // Without owners, Claude Code's own port can't be told apart: nothing is sent.
          if (result.exitCode !== 0) {
            return yield* new SocketOwnersUnknown({
              message: `naming the owners of its sockets exited with ${result.exitCode}`,
            })
          }
          const found = parseSocketOwners(result.stdout)
          for (const inode of unknown) entry.owners.set(inode, found.get(inode) ?? [])
        }
        yield* send(sessionId, entry, openPortsOf(sockets, entry.owners))
        entry.failing = false
      }).pipe(
        Effect.catch((error) =>
          Effect.suspend(() => {
            if (entry.failing) return Effect.void
            entry.failing = true
            return Effect.logWarning(
              `Session ${sessionId}: could not read its Open ports: ${error.message || error._tag}`,
            )
          }),
        ),
      )

    const watch = (sessionId: SessionId) =>
      Effect.gen(function* () {
        if (watched.has(sessionId)) return
        const entry: Watched = {
          fiber: undefined,
          sent: undefined,
          owners: new Map(),
          failing: false,
        }
        watched.set(sessionId, entry)
        entry.fiber = yield* poll(sessionId, entry).pipe(
          Effect.repeat(Schedule.spaced(interval)),
          Effect.forkIn(scope),
        )
      })

    const unwatch = (sessionId: SessionId) =>
      Effect.gen(function* () {
        const entry = watched.get(sessionId)
        if (entry === undefined) return
        watched.delete(sessionId)
        if (entry.fiber !== undefined) yield* Fiber.interrupt(entry.fiber)
        if (entry.sent !== undefined && entry.sent.length > 0) yield* send(sessionId, entry, [])
      })

    const resendAll = sending.withPermit(
      Effect.suspend(() =>
        Effect.forEach(
          [...watched].flatMap(([sessionId, entry]) =>
            entry.sent === undefined ? [] : [{ sessionId, ports: entry.sent }],
          ),
          (report) => hub.send(RunnerToHub.cases.SessionPorts.make(report)),
          { discard: true },
        ),
      ),
    )

    return OpenPorts.of({ watch, unwatch, resendAll })
  })

/** {@link OpenPorts} on the Runner's Sandbox backend. */
export const OpenPortsLive = Layer.effect(OpenPorts, makeOpenPorts())
