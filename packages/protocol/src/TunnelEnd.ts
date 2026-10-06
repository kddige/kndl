import { Schema } from "effect"
import {
  TunnelCloseCode,
  TunnelControl,
  type TunnelControl as TunnelControlMessage,
  TunnelMaxFrame,
  TunnelWindow,
} from "./Tunnel.ts"

// One end of a tunnel's WebSocket (Tunnel.ts), for whatever carries a connection's bytes over it:
// the Runner, which joins it to the connection in the Sandbox, and a client of the Hub. It keeps
// to the window as it sends, acknowledges bytes once they are delivered, and checks the other side
// keeps to the window too.

/** What a {@link TunnelEnd} hands on. */
export interface TunnelEndEvents {
  /**
   * Bytes from the other side, in order, one call at a time. They are acknowledged once the
   * returned promise settles, so a slow consumer holds back the sender, by the window. A rejected
   * promise closes the tunnel.
   */
  readonly data: (bytes: Uint8Array) => void | Promise<void>
  /** The other side sends no more bytes; it may still read. After all its data. */
  readonly eof?: () => void
  /** The socket closed, from either side; after all the data that came before. Called once. */
  readonly closed: (code: number, reason: string) => void
  /** Everything {@link TunnelEnd.send} was given has gone out. */
  readonly drained?: () => void
  /** The other side acknowledged bytes: it is taking what it is sent. */
  readonly acknowledged?: () => void
}

/**
 * What a {@link TunnelEnd} needs of its WebSocket: a browser's or Bun's, or what Effect's
 * WebSocketConstructor makes.
 */
export interface TunnelSocket {
  binaryType?: string
  readonly readyState: number
  addEventListener(
    type: "open" | "message" | "close",
    listener: (event: {
      readonly data?: unknown
      readonly code?: number
      readonly reason?: string
    }) => void,
  ): void
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
}

const decodeControl = Schema.decodeUnknownOption(TunnelControl)
const encodeControl = (message: TunnelControlMessage) => JSON.stringify(message)

const Open = 1

export class TunnelEnd {
  /** Bytes given to `send` that wait for the window, oldest first. */
  private readonly queue: Array<Uint8Array> = []
  private queued = 0
  /** Bytes sent and not yet acknowledged. */
  private unacked = 0
  /** Bytes received and not yet acknowledged: delivered or waiting to be. */
  private unackedIn = 0
  /** Bytes delivered and not yet acknowledged. */
  private toAck = 0
  private ackScheduled = false
  private eofQueued = false
  private eofSent = false
  private closing: { readonly code: number; readonly reason: string } | undefined
  private done = false
  /** What came in, delivered in order: data, an Eof, or the close. */
  private delivery: Promise<void> = Promise.resolve()

  constructor(
    private readonly socket: TunnelSocket,
    private readonly events: TunnelEndEvents,
  ) {
    socket.binaryType = "arraybuffer"
    socket.addEventListener("open", () => this.pump())
    socket.addEventListener("message", (event) => this.receive(event.data))
    socket.addEventListener("close", (event) =>
      this.closedBy(event.code ?? 1005, event.reason ?? ""),
    )
  }

  /**
   * Sends bytes, now if the window allows, or once the other side acknowledges what it has.
   * Returns whether they all went out now; `drained` says when they did.
   */
  send(bytes: Uint8Array): boolean {
    if (this.done || this.eofQueued || this.closing !== undefined) return false
    if (bytes.byteLength === 0) return this.queued === 0
    this.queue.push(bytes)
    this.queued += bytes.byteLength
    this.pump()
    return this.queued === 0
  }

  /** The bytes given to `send` that haven't gone out yet, held back by the window. */
  get waiting(): number {
    return this.queued
  }

  /** Whether the socket has closed, or is closing. */
  get closed(): boolean {
    return this.done || this.closing !== undefined
  }

  /** Sends no more bytes once those waiting have gone: a half-close. */
  end(): void {
    if (this.done || this.eofQueued) return
    this.eofQueued = true
    this.pump()
  }

  /**
   * Closes the tunnel: with the default code once what waits has gone out, so the other side
   * gets every byte, or at once with any other.
   */
  close(code: number = TunnelCloseCode.Closed, reason = ""): void {
    if (this.done || this.closing !== undefined) return
    this.closing = { code, reason }
    if (code !== TunnelCloseCode.Closed) {
      this.queue.length = 0
      this.queued = 0
    }
    this.pump()
  }

  private pump(): void {
    if (this.done || this.socket.readyState !== Open) return
    const hadWaiting = this.queued > 0
    while (this.unacked < TunnelWindow) {
      const head = this.queue[0]
      if (head === undefined) break
      const size = Math.min(head.byteLength, TunnelMaxFrame, TunnelWindow - this.unacked)
      const chunk = size === head.byteLength ? head : head.subarray(0, size)
      if (size === head.byteLength) this.queue.shift()
      else this.queue[0] = head.subarray(size)
      this.queued -= size
      this.unacked += size
      this.socket.send(chunk)
    }
    if (this.queue.length > 0) return
    if (this.eofQueued && !this.eofSent) {
      this.eofSent = true
      this.socket.send(encodeControl({ _tag: "Eof" }))
    }
    if (this.closing !== undefined) {
      this.socket.close(this.closing.code, this.closing.reason)
      return
    }
    if (hadWaiting) this.events.drained?.()
  }

  private receive(data: unknown): void {
    if (this.done) return
    if (typeof data === "string") {
      const control = decodeControl(parseJson(data))
      if (control._tag === "None") return this.violated("a text message that isn't control")
      if (control.value._tag === "Ack") {
        if (control.value.bytes > this.unacked) return this.violated("an Ack past what was sent")
        this.unacked -= control.value.bytes
        this.pump()
        return this.events.acknowledged?.()
      }
      return this.deliver(() => this.events.eof?.())
    }
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : toBytes(data)
    if (bytes === undefined) return this.violated("a message of an unknown kind")
    if (bytes.byteLength > TunnelMaxFrame) return this.violated("a frame too large")
    this.unackedIn += bytes.byteLength
    if (this.unackedIn > TunnelWindow) return this.violated("more than the window")
    this.deliver(async () => {
      await this.events.data(bytes)
      this.acknowledge(bytes.byteLength)
    })
  }

  private deliver(step: () => void | Promise<void>): void {
    this.delivery = this.delivery.then(async () => {
      if (this.done) return
      try {
        await step()
      } catch {
        this.close()
      }
    })
  }

  private acknowledge(bytes: number): void {
    this.toAck += bytes
    if (this.ackScheduled) return
    this.ackScheduled = true
    queueMicrotask(() => {
      this.ackScheduled = false
      const taken = this.toAck
      this.toAck = 0
      this.unackedIn -= taken
      if (taken > 0 && !this.done && this.socket.readyState === Open) {
        this.socket.send(encodeControl({ _tag: "Ack", bytes: taken }))
      }
    })
  }

  private violated(what: string): void {
    this.close(TunnelCloseCode.ProtocolError, `The other side sent ${what}.`)
  }

  private closedBy(code: number, reason: string): void {
    const finish = () => {
      if (this.done) return
      this.done = true
      this.queue.length = 0
      this.queued = 0
      this.events.closed(code, reason)
    }
    // A connection that ended is delivered to its last byte first; one that broke, at once.
    if (code === TunnelCloseCode.Closed) this.delivery = this.delivery.then(finish)
    else finish()
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function toBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  return undefined
}
