// AgentTcp against a stand-in for agentd's relay: the messages it sends, a client per connection,
// and how long it holds a connection back for a consumer.

import { describe, expect, test } from "bun:test"
import { FLAG_SESSION_START, FLAG_TERMINAL } from "microsandbox"
import {
  type AgentLike,
  type AgentStreamLike,
  AgentTcpChunk,
  AgentTcpFailed,
  makeAgentTcp,
} from "./AgentTcp.ts"
import { type CborValue, decodeCbor, encodeCbor } from "./Cbor.ts"

interface Message {
  readonly t: string
  readonly p: CborValue
}

const decode = (body: Uint8Array): Message & { readonly v: CborValue } => {
  const { v, t, p } = decodeCbor(body) as { v: CborValue; t: string; p: Uint8Array }
  return { v, t, p: decodeCbor(p) }
}

const frame = (t: string, p: { readonly [key: string]: CborValue } = {}, flags = 0) => ({
  flags,
  body: Buffer.from(encodeCbor({ v: 2, t, p: encodeCbor(p) })),
})

/** A stream agentd answers on, fed by the test. */
class FakeStream implements AgentStreamLike {
  private readonly frames: Array<() => Promise<IteratorResult<{ flags: number; body: Buffer }>>> =
    []
  private waiting:
    | ((result: Promise<IteratorResult<{ flags: number; body: Buffer }>>) => void)
    | undefined
  /** How many frames the reader has taken. */
  taken = 0
  closed = false

  constructor(
    readonly id: number,
    readonly opened: Message & { readonly v: CborValue },
    readonly flags: number,
  ) {}

  push(result: IteratorResult<{ flags: number; body: Buffer }>) {
    this.feed(() => Promise.resolve(result))
  }

  /** The client breaks: the read fails. */
  fail() {
    this.feed(() => Promise.reject(new Error("the agent client is closed")))
  }

  private feed(next: () => Promise<IteratorResult<{ flags: number; body: Buffer }>>) {
    const waiting = this.waiting
    if (waiting !== undefined) {
      this.waiting = undefined
      this.taken++
      waiting(next())
    } else this.frames.push(next)
  }

  next() {
    const queued = this.frames.shift()
    if (queued !== undefined) {
      this.taken++
      return queued()
    }
    return new Promise<IteratorResult<{ flags: number; body: Buffer }>>((resolve) => {
      this.waiting = resolve
    })
  }

  async close() {
    this.closed = true
  }
}

/** A Sandbox's client of agentd's relay, which answers each connect as `answer` says. */
class FakeAgent implements AgentLike {
  readonly sent: Array<Message & { readonly id: number }> = []
  readonly streams: Array<FakeStream> = []
  closed = false

  constructor(private readonly answer: (stream: FakeStream) => void) {}

  readyBytes = () => Buffer.from(encodeCbor({ v: 2 }))

  async stream(flags: number, body: Buffer) {
    const stream = new FakeStream(this.streams.length + 1, decode(body), flags)
    this.streams.push(stream)
    this.answer(stream)
    return stream
  }

  async send(id: number, _flags: number, body: Buffer) {
    this.sent.push({ id, ...decode(body) })
  }

  async close() {
    this.closed = true
  }
}

const connected = (stream: FakeStream) =>
  stream.push({ done: false, value: frame("core.tcp.connected") })

/** AgentTcp over fake clients, each answering connects as `answer` says. */
function scene(answer: (stream: FakeStream) => void = connected, maxConnections = 64) {
  const agents: Array<FakeAgent> = []
  const tcp = makeAgentTcp(
    async () => {
      const agent = new FakeAgent(answer)
      agents.push(agent)
      return agent
    },
    { maxConnections },
  )
  return { tcp, agents }
}

/** What a connection hands on, kept. */
function recorder() {
  const events = {
    received: [] as Array<string>,
    eof: false,
    closed: undefined as boolean | undefined,
  }
  return {
    events,
    handlers: {
      data: (bytes: Uint8Array) => {
        events.received.push(new TextDecoder().decode(bytes))
      },
      eof: () => {
        events.eof = true
      },
      closed: (lost: boolean) => {
        events.closed = lost
      },
    },
  }
}

const until = async (done: () => boolean, ms = 2_000) => {
  const deadline = Date.now() + ms
  while (!done()) {
    if (Date.now() > deadline) throw new Error("timed out")
    await Bun.sleep(5)
  }
}

const data = (text: string) => ({
  done: false as const,
  value: frame("core.tcp.data", { data: new TextEncoder().encode(text) }),
})

describe("a connection into a Sandbox", () => {
  test("opens a stream on the Sandbox's client, and speaks agentd's core.tcp messages", async () => {
    const { tcp, agents } = scene()
    const { events, handlers } = recorder()
    const connection = await tcp.connect("kndl-s1", "::1", 5173, handlers)
    const [agent] = agents
    const stream = agent?.streams[0] as FakeStream
    expect(stream.opened).toEqual({ v: 2, t: "core.tcp.connect", p: { host: "::1", port: 5173 } })
    expect(stream.flags).toBe(FLAG_SESSION_START)

    // What goes in is cut into messages agentd takes.
    await connection.write(new Uint8Array(AgentTcpChunk * 2 + 1))
    await connection.end()
    expect(
      agent?.sent.map((m) => [
        m.id,
        m.t,
        m.p instanceof Object && "data" in m.p ? (m.p.data as Uint8Array).byteLength : 0,
      ]),
    ).toEqual([
      [1, "core.tcp.data", AgentTcpChunk],
      [1, "core.tcp.data", AgentTcpChunk],
      [1, "core.tcp.data", 1],
      [1, "core.tcp.eof", 0],
    ])

    // What comes out is handed on, in order, then the end.
    stream.push(data("hello"))
    stream.push({ done: false, value: frame("core.tcp.eof") })
    stream.push({ done: false, value: frame("core.tcp.closed", {}, FLAG_TERMINAL) })
    await until(() => events.closed !== undefined)
    expect(events).toMatchObject({ received: ["hello"], eof: true, closed: false })
    expect(tcp.openCount("kndl-s1")).toBe(0)
  })

  test("shares one client among a Sandbox's connections, closed after the last", async () => {
    const { tcp, agents } = scene()
    const one = await tcp.connect("kndl-s1", "127.0.0.1", 3000, recorder().handlers)
    const two = await tcp.connect("kndl-s1", "::1", 5173, recorder().handlers)
    expect(agents).toHaveLength(1)
    expect(agents[0]?.streams.map((stream) => stream.id)).toEqual([1, 2])
    // Another Sandbox has its own.
    await tcp.connect("kndl-s2", "127.0.0.1", 3000, recorder().handlers)
    expect(agents).toHaveLength(2)

    await one.close()
    expect(agents[0]?.sent.at(-1)).toMatchObject({ id: 1, t: "core.tcp.close" })
    expect(agents[0]?.closed).toBe(false)
    await two.close()
    await until(() => agents[0]?.closed === true)
    expect(agents[1]?.closed).toBe(false)

    // The next connection makes a new one.
    await tcp.connect("kndl-s1", "127.0.0.1", 3000, recorder().handlers)
    expect(agents).toHaveLength(3)
  })

  test("reads every stream as it comes, whatever its consumer does", async () => {
    // agentd holds up every stream of a Sandbox behind one read slowly, so none is.
    const { tcp, agents } = scene()
    const busy = recorder()
    const other = recorder()
    await tcp.connect("kndl-s1", "127.0.0.1", 3000, busy.handlers)
    await tcp.connect("kndl-s1", "127.0.0.1", 3000, other.handlers)
    const [first, second] = agents[0]?.streams ?? []
    for (let n = 0; n < 100; n++) first?.push(data(`${n}`))
    second?.push(data("hello"))
    await until(() => busy.events.received.length === 100 && other.events.received.length === 1)
    expect(first?.taken).toBe(101)
  })

  test("fails as agentd says when nothing listens there, and leaves nothing open", async () => {
    const { tcp, agents } = scene((stream) =>
      stream.push({
        done: false,
        value: frame("core.tcp.failed", { message: "Connection refused" }, FLAG_TERMINAL),
      }),
    )
    const failed = tcp.connect("kndl-s1", "127.0.0.1", 3000, recorder().handlers)
    await expect(failed).rejects.toThrow(new AgentTcpFailed("Connection refused"))
    await until(() => agents[0]?.closed === true)
    expect(tcp.openCount("kndl-s1")).toBe(0)
  })

  test("takes so many connections into one Sandbox at once, and no more", async () => {
    const { tcp } = scene(connected, 2)
    const first = await tcp.connect("kndl-s1", "127.0.0.1", 3000, recorder().handlers)
    await tcp.connect("kndl-s1", "127.0.0.1", 3000, recorder().handlers)
    await expect(tcp.connect("kndl-s1", "127.0.0.1", 3000, recorder().handlers)).rejects.toThrow(
      AgentTcpFailed,
    )
    // Another Sandbox has its own.
    await tcp.connect("kndl-s2", "127.0.0.1", 3000, recorder().handlers)
    // One closed makes room.
    await first.close()
    await tcp.connect("kndl-s1", "127.0.0.1", 3000, recorder().handlers)
    expect(tcp.openCount("kndl-s1")).toBe(2)
  })

  test("tells a connection that ended from one that was lost", async () => {
    const { tcp, agents } = scene()
    const ended = recorder()
    await tcp.connect("kndl-s1", "127.0.0.1", 3000, ended.handlers)
    agents[0]?.streams[0]?.push({ done: false, value: frame("core.tcp.closed") })
    await until(() => ended.events.closed !== undefined)
    expect(ended.events.closed).toBe(false)

    const lost = recorder()
    await tcp.connect("kndl-s1", "127.0.0.1", 3000, lost.handlers)
    agents.at(-1)?.streams.at(-1)?.push({ done: true, value: undefined })
    await until(() => lost.events.closed !== undefined)
    expect(lost.events.closed).toBe(true)
  })

  test("a client that breaks loses its connections, and the next connection makes a new one", async () => {
    const { tcp, agents } = scene()
    const one = recorder()
    const two = recorder()
    await tcp.connect("kndl-s1", "127.0.0.1", 3000, one.handlers)
    await tcp.connect("kndl-s1", "127.0.0.1", 3000, two.handlers)
    for (const stream of agents[0]?.streams ?? []) stream.fail()
    await until(() => one.events.closed !== undefined && two.events.closed !== undefined)
    expect([one.events.closed, two.events.closed]).toEqual([true, true])
    await until(() => agents[0]?.closed === true)

    await tcp.connect("kndl-s1", "127.0.0.1", 3000, recorder().handlers)
    expect(agents).toHaveLength(2)
  })

  test("closes every connection into a Sandbox when it stops, telling agentd and each consumer", async () => {
    const { tcp, agents } = scene()
    const one = recorder()
    const two = recorder()
    const other = recorder()
    await tcp.connect("kndl-s1", "127.0.0.1", 3000, one.handlers)
    await tcp.connect("kndl-s1", "::1", 5173, two.handlers)
    await tcp.connect("kndl-s2", "127.0.0.1", 3000, other.handlers)
    await tcp.drop("kndl-s1")
    expect([one.events.closed, two.events.closed, other.events.closed]).toEqual([
      false,
      false,
      undefined,
    ])
    expect(agents[0]?.sent.map((m) => [m.id, m.t])).toEqual([
      [1, "core.tcp.close"],
      [2, "core.tcp.close"],
    ])
    await until(() => agents[0]?.closed === true)
    expect(agents[1]?.closed).toBe(false)
    expect(tcp.openCount("kndl-s1")).toBe(0)
    await tcp.dropAll()
    expect(other.events.closed).toBe(false)
    expect(tcp.openCount("kndl-s2")).toBe(0)
  })
})
