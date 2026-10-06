import { afterEach, describe, expect, test } from "bun:test"
import { TunnelCloseCode, TunnelMaxFrame, TunnelWindow } from "./Tunnel.ts"
import { TunnelEnd, type TunnelEndEvents } from "./TunnelEnd.ts"

// Two TunnelEnds joined by a server that passes each message to the other side as is, as the Hub
// does, counting the binary bytes it passes.

const servers: Array<ReturnType<typeof Bun.serve>> = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

interface Side {
  other?: Bun.ServerWebSocket<Side> | undefined
  pending: Array<string | Uint8Array>
}

const opened = (socket: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve())
    socket.addEventListener("error", () => reject(new Error("could not connect")))
  })

/** Collects what one end receives. */
const collector = (options: { readonly stalled?: Promise<void> } = {}) => {
  const chunks: Array<Uint8Array> = []
  let eof = false
  let closedWith: { code: number; reason: string } | undefined
  let onClosed: (() => void) | undefined
  const closed = new Promise<void>((resolve) => (onClosed = resolve))
  const events: TunnelEndEvents = {
    data: async (bytes) => {
      if (options.stalled !== undefined) await options.stalled
      chunks.push(bytes.slice())
    },
    eof: () => {
      eof = true
    },
    closed: (code, reason) => {
      closedWith = { code, reason }
      onClosed?.()
    },
  }
  return {
    events,
    closed,
    bytes: () => Buffer.concat(chunks),
    eof: () => eof,
    closedWith: () => closedWith,
  }
}

/** Two ends, a and b, through a relay; a connects first. */
const pairUp = async (eventsA: TunnelEndEvents, eventsB: TunnelEndEvents) => {
  let passed = 0
  let aSocket: Bun.ServerWebSocket<Side> | undefined
  let waiting: Bun.ServerWebSocket<Side> | undefined
  const server = Bun.serve<Side>({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request, srv) =>
      srv.upgrade(request, { data: { pending: [] } })
        ? undefined
        : new Response("no", { status: 400 }),
    websocket: {
      open(ws) {
        if (aSocket === undefined) {
          aSocket = ws
          waiting = ws
          return
        }
        const other = waiting
        if (other === undefined) return
        ws.data.other = other
        other.data.other = ws
        for (const message of other.data.pending.splice(0)) ws.send(message)
        waiting = undefined
      },
      message(ws, message) {
        if (typeof message !== "string" && ws === aSocket) passed += message.byteLength
        if (ws.data.other === undefined) ws.data.pending.push(message)
        else ws.data.other.send(message)
      },
      close(ws, code, reason) {
        ws.data.other?.close(code === 1005 || code === 1006 ? 4502 : code, reason)
      },
    },
  })
  servers.push(server)
  const url = `ws://127.0.0.1:${server.port}`
  const socketA = new WebSocket(url)
  await opened(socketA)
  const a = new TunnelEnd(socketA, eventsA)
  const socketB = new WebSocket(url)
  const b = new TunnelEnd(socketB, eventsB)
  await opened(socketB)
  return { a, b, passed: () => passed, socketB }
}

const bytesOf = (size: number, seed = 1) => {
  const out = new Uint8Array(size)
  for (let i = 0; i < size; i++) out[i] = (i * 31 + seed) & 0xff
  return out
}

const until = async (check: () => boolean, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out")
    await Bun.sleep(5)
  }
}

describe("TunnelEnd", () => {
  test("carries bytes both ways, in order, with a half-close and a close after them", async () => {
    const atA = collector()
    const atB = collector()
    const { a, b } = await pairUp(atA.events, atB.events)
    const big = bytesOf(3 * TunnelMaxFrame + 17)
    a.send(big)
    a.end()
    b.send(new TextEncoder().encode("hello"))
    await until(() => atB.eof())
    expect(atB.bytes()).toEqual(Buffer.from(big))
    b.close()
    await atA.closed
    await atB.closed
    expect(new TextDecoder().decode(atA.bytes())).toBe("hello")
    expect(atA.closedWith()?.code).toBe(TunnelCloseCode.Closed)
  })

  test("keeps to the window while the other side doesn't deliver", async () => {
    const { promise: stalled, resolve: release } = Promise.withResolvers<void>()
    const atB = collector({ stalled })
    const { a, passed } = await pairUp(collector().events, atB.events)
    const total = 4 * TunnelWindow
    expect(a.send(bytesOf(total))).toBe(false)
    await Bun.sleep(200)
    // Only the window went out; the rest waits at the sender.
    expect(passed()).toBe(TunnelWindow)
    expect(a.waiting).toBe(total - TunnelWindow)
    release()
    await until(() => atB.bytes().byteLength === total)
    expect(a.waiting).toBe(0)
    expect(atB.bytes()).toEqual(Buffer.from(bytesOf(total)))
  })

  test("says when what waited has gone out", async () => {
    const { promise: stalled, resolve: release } = Promise.withResolvers<void>()
    let drained = 0
    const { a } = await pairUp(
      { data: () => {}, closed: () => {}, drained: () => drained++ },
      collector({ stalled }).events,
    )
    a.send(bytesOf(TunnelWindow + 1))
    await Bun.sleep(50)
    expect(drained).toBe(0)
    release()
    await until(() => drained === 1)
  })

  test("closes a tunnel whose other side sends past the window", async () => {
    const atA = collector({ stalled: new Promise(() => {}) })
    const { socketB } = await pairUp(atA.events, collector().events)
    // A raw sender that ignores the window, in place of b's TunnelEnd.
    for (let sent = 0; sent <= TunnelWindow; sent += TunnelMaxFrame) {
      socketB.send(bytesOf(TunnelMaxFrame))
    }
    await atA.closed
    expect(atA.closedWith()?.code).toBe(TunnelCloseCode.ProtocolError)
  })

  test("closes a tunnel whose other side sends a frame too large, or text that isn't control", async () => {
    const atA = collector()
    const first = await pairUp(atA.events, collector().events)
    first.socketB.send(bytesOf(TunnelMaxFrame + 1))
    await atA.closed
    expect(atA.closedWith()?.code).toBe(TunnelCloseCode.ProtocolError)

    const atA2 = collector()
    const second = await pairUp(atA2.events, collector().events)
    second.socketB.send("hello")
    await atA2.closed
    expect(atA2.closedWith()?.code).toBe(TunnelCloseCode.ProtocolError)
  })

  test("closes at once, dropping what waits, with any code but the default", async () => {
    const atB = collector({ stalled: new Promise(() => {}) })
    const atA = collector()
    const { a } = await pairUp(atA.events, atB.events)
    a.send(bytesOf(2 * TunnelWindow))
    a.close(TunnelCloseCode.TooSlow, "too slow")
    expect(a.waiting).toBe(0)
    await atB.closed
    expect(atB.closedWith()).toEqual({ code: TunnelCloseCode.TooSlow, reason: "too slow" })
  })
})
