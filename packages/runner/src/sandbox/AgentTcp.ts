// TCP connections into a microsandbox guest through agentd's own `core.tcp` streams (#177, spike
// #169), the way msb's SSH port forwarding reaches the guest: from inside it, so a server bound to
// 127.0.0.1 or ::1 is reached, with nothing installed in the guest.
//
// - The SDK's AgentClient carries raw frames; the messages are CBOR envelopes `{v, t, p}` whose `p`
//   is itself CBOR (Cbor.ts). `core.tcp.connect {host, port}` opens a stream, answered by
//   `core.tcp.connected` or `core.tcp.failed`; then `core.tcp.data {data}`, `core.tcp.eof` and
//   `core.tcp.close` go in, and `core.tcp.data`, `core.tcp.eof` and `core.tcp.closed` come out.
//   These are agentd's internal protocol, not the SDK's API: microsandbox stays pinned.
// - In this (non-bulk) mode agentd has no flow control per stream, and a stream read slowly holds
//   up every other: on its client, and on 0.7.6 every other client of the Sandbox's relay too, so
//   a new connection doesn't even open (measured: blocked for as long as one stream was read one
//   frame per 2 s). So every stream is read as fast as it comes, always, and each frame handed on
//   at once: what it carries is the consumer's to keep or drop (Tunnels.ts, ADR 0016).
// - The connections into a Sandbox share one AgentClient, apart from the Runner's commands, made
//   for the first and closed after the last. The relay takes 128 clients per Sandbox, so this
//   takes one, whatever the number of connections.
// - A data message carries at most AgentTcpChunk bytes.

import { AgentClient, FLAG_SESSION_START, FLAG_TERMINAL } from "microsandbox"
import { type CborValue, decodeCbor, encodeCbor } from "./Cbor.ts"

/** The most bytes one `core.tcp.data` message carries, under agentd's frame limit. */
export const AgentTcpChunk = 64 * 1024

/** The most connections into one Sandbox at once. */
export const AgentTcpMaxConnections = 128

/** How long agentd has to say whether it connected. */
const ConnectTimeoutMs = 10_000

/** The part of the SDK's AgentClient this uses, so tests can stand in for agentd. */
export interface AgentLike {
  readonly stream: (flags: number, body: Buffer) => Promise<AgentStreamLike>
  readonly send: (id: number, flags: number, body: Buffer) => Promise<void>
  readonly readyBytes: () => Buffer
  readonly close: () => Promise<void>
}

export interface AgentStreamLike {
  readonly id: number
  readonly next: () => Promise<IteratorResult<{ readonly flags: number; readonly body: Buffer }>>
  readonly close: () => Promise<void>
}

/** What a connection hands on, as it comes; see GuestTcpEvents. */
export interface AgentTcpEvents {
  readonly data: (bytes: Uint8Array) => void
  readonly eof: () => void
  readonly closed: (lost: boolean) => void
}

export interface AgentTcpConnection {
  readonly write: (data: Uint8Array) => Promise<void>
  readonly end: () => Promise<void>
  readonly close: () => Promise<void>
}

/** agentd refused the connection: nothing listens there, or it can't be reached. */
export class AgentTcpFailed extends Error {}

interface Envelope {
  readonly t: string
  readonly p: CborValue
}

const decodeEnvelope = (body: Uint8Array): Envelope => {
  const message = decodeCbor(body)
  if (typeof message !== "object" || message === null || message instanceof Uint8Array) {
    return { t: "", p: undefined }
  }
  const { t, p } = message as Record<string, CborValue>
  return {
    t: typeof t === "string" ? t : "",
    p: p instanceof Uint8Array ? decodeCbor(p) : p,
  }
}

const field = (payload: CborValue, key: string): CborValue =>
  typeof payload === "object" && payload !== null && !(payload instanceof Uint8Array)
    ? (payload as Record<string, CborValue>)[key]
    : undefined

/** What a `core.tcp.failed` says, as text. */
const failure = (payload: CborValue) => {
  for (const key of ["message", "error", "reason"]) {
    const value = field(payload, key)
    if (typeof value === "string") return value
  }
  return "agentd could not connect"
}

type Payload = { readonly [key: string]: CborValue }

/** A Sandbox's AgentClient, shared by its connections, and how to make its messages. */
interface Client {
  readonly agent: AgentLike
  readonly message: (t: string, p: Payload) => Buffer
}

interface Shared {
  readonly client: Promise<Client>
  /** The connections using it, open or being opened. */
  users: number
}

/** Connections into Sandboxes, those into one Sandbox sharing an AgentClient. */
export const makeAgentTcp = (
  connectAgent: (sandboxName: string) => Promise<AgentLike> = (sandboxName) =>
    AgentClient.connectSandbox(sandboxName, { timeoutMs: ConnectTimeoutMs }),
  options: { readonly maxConnections?: number } = {},
) => {
  const maxConnections = options.maxConnections ?? AgentTcpMaxConnections
  /** How to close each connection open or being opened, by Sandbox. */
  const open = new Map<string, Set<() => Promise<void>>>()
  const clients = new Map<string, Shared>()

  /** The Sandbox's client, made if it has none; `release` once done with it. */
  const use = (sandboxName: string): Shared => {
    const existing = clients.get(sandboxName)
    if (existing !== undefined) {
      existing.users++
      return existing
    }
    const shared: Shared = {
      client: connectAgent(sandboxName).then((agent) => {
        const ready = decodeCbor(agent.readyBytes())
        const readyVersion = field(ready, "v")
        const version = typeof readyVersion === "number" ? readyVersion : 1
        return {
          agent,
          message: (t: string, p: Payload) =>
            Buffer.from(encodeCbor({ v: version, t, p: encodeCbor(p) })),
        }
      }),
      users: 1,
    }
    // One that couldn't be made isn't kept: the next connection tries again.
    shared.client.catch(() => forget(sandboxName, shared))
    clients.set(sandboxName, shared)
    return shared
  }

  /** Makes the next connection into the Sandbox use a new client. */
  const forget = (sandboxName: string, shared: Shared) => {
    if (clients.get(sandboxName) === shared) clients.delete(sandboxName)
  }

  const release = (sandboxName: string, shared: Shared) => {
    shared.users--
    if (shared.users > 0) return
    forget(sandboxName, shared)
    void shared.client.then(
      ({ agent }) => agent.close().catch(() => undefined),
      () => undefined,
    )
  }

  const connect = async (
    sandboxName: string,
    host: string,
    port: number,
    events: AgentTcpEvents,
  ): Promise<AgentTcpConnection> => {
    const closers = open.get(sandboxName) ?? new Set<() => Promise<void>>()
    if (closers.size >= maxConnections) {
      throw new AgentTcpFailed(`the Sandbox has ${maxConnections} connections open already`)
    }
    open.set(sandboxName, closers)
    const shared = use(sandboxName)

    let client: Client | undefined
    let stream: AgentStreamLike | undefined
    let shut = false
    let over = false
    // What goes in is sent one message at a time, in order.
    let sending: Promise<void> = Promise.resolve()
    const send = (t: string, p: Payload = {}) => {
      const sent = sending.then(() => {
        if (client === undefined || stream === undefined) throw new AgentTcpFailed("not connected")
        return client.agent.send(stream.id, 0, client.message(t, p))
      })
      sending = sent.catch(() => undefined)
      return sent
    }
    const finish = (lost: boolean) => {
      if (over) return
      over = true
      events.closed(lost)
      void shutdown()
    }
    /** Closes the connection, and the client after the last; once. Before it connected, `connect` fails. */
    const shutdown = async () => {
      if (shut) return
      shut = true
      closers.delete(shutdown)
      if (closers.size === 0 && open.get(sandboxName) === closers) open.delete(sandboxName)
      if (stream !== undefined && !over) {
        await send("core.tcp.close").catch(() => undefined)
        await stream.close().catch(() => undefined)
        finish(false)
      }
      release(sandboxName, shared)
    }
    closers.add(shutdown)

    try {
      client = await shared.client
      if (shut) throw new AgentTcpFailed("the Sandbox stopped")
      const opening = await client.agent.stream(
        FLAG_SESSION_START,
        client.message("core.tcp.connect", { host, port }),
      )
      let timer: ReturnType<typeof setTimeout> | undefined
      const first = await Promise.race([
        opening.next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new AgentTcpFailed("agentd did not answer the connect in time")),
            ConnectTimeoutMs,
          )
        }),
      ]).finally(() => clearTimeout(timer))
      if (first.done) throw new AgentTcpFailed("agentd ended the stream before connecting")
      const reply = decodeEnvelope(first.value.body)
      if (reply.t !== "core.tcp.connected") {
        await opening.close().catch(() => undefined)
        throw new AgentTcpFailed(
          reply.t === "core.tcp.failed" ? failure(reply.p) : `agentd answered ${reply.t}`,
        )
      }
      if (shut) {
        await opening.close().catch(() => undefined)
        throw new AgentTcpFailed("the Sandbox stopped")
      }
      stream = opening
    } catch (error) {
      await shutdown()
      throw error
    }

    // Reads the stream to its end, as fast as it comes, whatever the consumer does with it.
    const reading = stream
    void (async () => {
      let lost = true
      try {
        for (;;) {
          // `over` is set by `finish`, as when the connection is closed from this side.
          if (over) break
          const frame = await reading.next()
          if (frame.done) break
          const incoming = decodeEnvelope(frame.value.body)
          if (incoming.t === "core.tcp.data") {
            const data = field(incoming.p, "data")
            if (data instanceof Uint8Array && data.byteLength > 0) events.data(data)
          } else if (incoming.t === "core.tcp.eof") {
            events.eof()
          } else if (incoming.t === "core.tcp.closed" || incoming.t === "core.tcp.failed") {
            lost = false
            break
          }
          if ((frame.value.flags & FLAG_TERMINAL) !== 0) {
            lost = false
            break
          }
        }
      } catch {
        // The client broke, as when its Sandbox stopped: the next connection makes a new one.
        forget(sandboxName, shared)
      }
      finish(lost && !shut)
    })()

    return {
      write: async (data) => {
        for (let offset = 0; offset < data.byteLength; offset += AgentTcpChunk) {
          await send("core.tcp.data", { data: data.subarray(offset, offset + AgentTcpChunk) })
        }
      },
      end: () => send("core.tcp.eof").catch(() => undefined),
      close: shutdown,
    }
  }

  /** Closes every connection into the Sandbox, as when it stops. */
  const drop = async (sandboxName: string) => {
    const closers = open.get(sandboxName)
    if (closers === undefined) return
    await Promise.all([...closers].map((close) => close()))
  }

  return {
    connect,
    drop,
    dropAll: () => Promise.all([...open.keys()].map(drop)).then(() => undefined),
    /** How many connections into the Sandbox are open or being opened. */
    openCount: (sandboxName: string) => open.get(sandboxName)?.size ?? 0,
  }
}

export type AgentTcp = ReturnType<typeof makeAgentTcp>
