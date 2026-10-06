// The local side of `claude-hub forward` (#180): a listener for each port forwarded, on 127.0.0.1
// and ::1 (or the address `--bind` gives), whose every connection is a tunnel of its own through
// the Hub to the port in the Session's Sandbox (Tunnel.ts). The ports follow the Session's Open
// ports as the Hub reports them, or those named, while they are open.
//
// A local port something else holds is skipped, saying what holds it, and tried again every few
// seconds until it is free. A port the OS refuses (one below 1024, without the privilege) is
// skipped for good.
import { createServer, type Server, type Socket } from "node:net"
import { type OpenPort, type SessionId, tunnelPath } from "@claude-hub/protocol"
import { TunnelEnd } from "@claude-hub/protocol/tunnel-end"
import type { PortMapping } from "./ForwardArgs.ts"
import { socketUrl } from "./ForwardHub.ts"

/** Where a forwarded port is at. */
export type PortState =
  /** Listening here, forwarded. */
  | { readonly _tag: "Forwarding" }
  /** Something here holds the local port: tried again until it's free. */
  | { readonly _tag: "Taken"; readonly holder: string | undefined }
  /** The OS won't let the CLI listen on it. */
  | { readonly _tag: "Refused"; readonly message: string }
  /** Named, and nothing listens on it in the Session yet. */
  | { readonly _tag: "NotOpen" }

export interface ForwardedPort extends PortMapping {
  /** The port in the Session's Sandbox, as last reported; absent while it isn't open. */
  readonly open: OpenPort | undefined
  readonly state: PortState
  /** Local connections forwarded now. */
  readonly connections: number
}

/** Says what holds a local port, as "node (pid 4242)", or `undefined` when it can't tell. */
export type WhoHolds = (port: number) => Promise<string | undefined>

/** Asks lsof; says nothing when there's no lsof, or it doesn't know. */
export const lsofHolder: WhoHolds = async (port) => {
  try {
    const lsof = Bun.spawn(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const timer = setTimeout(() => lsof.kill(), 3_000)
    const output = await new Response(lsof.stdout).text()
    clearTimeout(timer)
    return holderFromLsof(output)
  } catch {
    return undefined
  }
}

/** The first process in `lsof -F pc` output, as "node (pid 4242)". */
export function holderFromLsof(output: string): string | undefined {
  const pid = /^p(\d+)$/m.exec(output)?.[1]
  const command = /^c(.+)$/m.exec(output)?.[1]
  if (pid === undefined) return undefined
  return command === undefined ? `pid ${pid}` : `${command} (pid ${pid})`
}

export interface ForwarderOptions {
  readonly hub: string
  readonly token: string
  readonly sessionId: SessionId
  /** The addresses to listen on, each port on all of them. */
  readonly addresses: ReadonlyArray<string>
  /** The ports named: only these are forwarded. Absent: every Open port, to the same port here. */
  readonly named: ReadonlyArray<PortMapping> | undefined
  /** Something changed that the list shows. */
  readonly changed: () => void
  readonly whoHolds?: WhoHolds
  /** How often a taken port is tried again. */
  readonly retryMs?: number
}

interface Entry {
  readonly mapping: PortMapping
  open: OpenPort | undefined
  state: PortState
  servers: Array<Server>
  readonly sockets: Set<Socket>
  /** Whether listening is under way, so it isn't started twice. */
  binding: boolean
}

type Bound =
  | { readonly _tag: "Listening"; readonly servers: Array<Server> }
  | { readonly _tag: "Taken" }
  | { readonly _tag: "Refused"; readonly message: string }

/** Listens on `port` on every address, or on none: half a port would reach something else. */
async function listenAll(
  addresses: ReadonlyArray<string>,
  port: number,
  onConnection: (socket: Socket) => void,
): Promise<Bound> {
  const servers: Array<Server> = []
  let unavailable = 0
  for (const host of addresses) {
    const server = createServer({ allowHalfOpen: true, pauseOnConnect: false }, onConnection)
    const error = await new Promise<NodeJS.ErrnoException | undefined>((resolve) => {
      server.once("error", resolve)
      server.listen({ port, host, exclusive: true }, () => resolve(undefined))
    })
    if (error === undefined) {
      servers.push(server)
      continue
    }
    server.close()
    // A machine without IPv6 has no ::1: 127.0.0.1 alone will do.
    if (addresses.length > 1 && (error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT")) {
      unavailable++
      continue
    }
    for (const open of servers) open.close()
    if (error.code === "EADDRINUSE") return { _tag: "Taken" }
    if (error.code === "EACCES") {
      return {
        _tag: "Refused",
        message:
          port < 1024
            ? `Port ${port} needs privileges here: forward it to a higher port, as ${port}:${port + 8000}.`
            : `Not allowed to listen on port ${port} here.`,
      }
    }
    return { _tag: "Refused", message: `Couldn't listen on ${host} port ${port}: ${error.message}` }
  }
  if (unavailable === addresses.length) {
    return { _tag: "Refused", message: `None of ${addresses.join(", ")} is an address here.` }
  }
  return { _tag: "Listening", servers }
}

/** The ports of one Session forwarded here, kept to its Open ports. */
export class Forwarder {
  private readonly entries = new Map<number, Entry>()
  private readonly retry: ReturnType<typeof setInterval>
  private closed = false

  constructor(private readonly options: ForwarderOptions) {
    for (const mapping of options.named ?? []) {
      this.entries.set(mapping.remote, this.entry(mapping))
    }
    this.retry = setInterval(() => this.retryTaken(), options.retryMs ?? 2_000)
  }

  /** The ports, by the Session's port. */
  get ports(): ReadonlyArray<ForwardedPort> {
    return [...this.entries.values()]
      .toSorted((a, b) => a.mapping.remote - b.mapping.remote)
      .map((entry) => ({
        ...entry.mapping,
        open: entry.open,
        state: entry.state,
        connections: entry.sockets.size,
      }))
  }

  /** The Session's Open ports now: forwards those that opened, and stops those that closed. */
  update(openPorts: ReadonlyArray<OpenPort>): void {
    if (this.closed) return
    const open = new Map(openPorts.map((port) => [port.port, port]))
    if (this.options.named === undefined) {
      for (const port of openPorts) {
        if (!this.entries.has(port.port)) {
          this.entries.set(port.port, this.entry({ remote: port.port, local: port.port }))
        }
      }
    }
    for (const [remote, entry] of this.entries) {
      entry.open = open.get(remote)
      if (entry.open !== undefined) {
        if (entry.state._tag === "NotOpen") this.bind(entry)
        continue
      }
      this.unbind(entry)
      if (this.options.named === undefined) this.entries.delete(remote)
      else entry.state = { _tag: "NotOpen" }
    }
    this.options.changed()
  }

  /** Stops listening, and ends every connection. */
  close(): void {
    if (this.closed) return
    this.closed = true
    clearInterval(this.retry)
    for (const entry of this.entries.values()) {
      this.unbind(entry)
      for (const socket of entry.sockets) socket.destroy()
    }
  }

  private entry(mapping: PortMapping): Entry {
    return {
      mapping,
      open: undefined,
      state: { _tag: "NotOpen" },
      servers: [],
      sockets: new Set(),
      binding: false,
    }
  }

  private bind(entry: Entry): void {
    if (entry.binding || this.closed) return
    entry.binding = true
    const { local } = entry.mapping
    void listenAll(this.options.addresses, local, (socket) => this.carry(entry, socket)).then(
      async (bound) => {
        entry.binding = false
        // Closed, or the port closed in the Session, while it bound.
        if (
          this.closed ||
          entry.open === undefined ||
          this.entries.get(entry.mapping.remote) !== entry
        ) {
          if (bound._tag === "Listening") for (const server of bound.servers) server.close()
          return
        }
        switch (bound._tag) {
          case "Listening":
            entry.servers = bound.servers
            entry.state = { _tag: "Forwarding" }
            break
          case "Refused":
            entry.state = { _tag: "Refused", message: bound.message }
            break
          case "Taken": {
            const before = entry.state
            entry.state = {
              _tag: "Taken",
              holder: before._tag === "Taken" ? before.holder : undefined,
            }
            // Asked once, and again when it's tried after it was free a moment.
            if (before._tag !== "Taken") {
              const holder = await (this.options.whoHolds ?? lsofHolder)(local)
              if (entry.state._tag === "Taken") entry.state = { _tag: "Taken", holder }
            }
            break
          }
        }
        this.options.changed()
      },
    )
  }

  private unbind(entry: Entry): void {
    for (const server of entry.servers) server.close()
    entry.servers = []
    if (entry.state._tag !== "Refused") entry.state = { _tag: "NotOpen" }
  }

  private retryTaken(): void {
    for (const entry of this.entries.values()) {
      if (entry.state._tag === "Taken" && entry.open !== undefined) this.bind(entry)
    }
  }

  /** One local connection: a tunnel of its own to the port in the Sandbox. */
  private carry(entry: Entry, local: Socket): void {
    entry.sockets.add(local)
    this.options.changed()
    let paused = false
    const { hub, token, sessionId } = this.options
    const end = new TunnelEnd(
      new WebSocket(socketUrl(hub, tunnelPath(sessionId, entry.mapping.remote)), {
        headers: { authorization: `Bearer ${token}` },
      }),
      {
        data: (bytes) =>
          new Promise<void>((resolve) => {
            if (local.destroyed || local.write(bytes)) return resolve()
            local.once("drain", resolve)
            local.once("close", resolve)
          }),
        eof: () => void local.end(),
        closed: () => void local.destroy(),
        drained: () => {
          if (!paused) return
          paused = false
          local.resume()
        },
      },
    )
    local.on("data", (data: Buffer) => {
      if (end.send(new Uint8Array(data))) return
      paused = true
      local.pause()
    })
    local.on("end", () => end.end())
    local.on("close", () => {
      end.close()
      entry.sockets.delete(local)
      if (!this.closed) this.options.changed()
    })
    local.on("error", () => {})
  }
}
