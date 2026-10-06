// Tunnels (#177): the Runner's leg on its own, then end to end through a real Hub and Runner,
// with the Sandbox's ports served by Bun on the host (testTunnels.ts). The end-to-end tests run
// the Session in real tmux, so they are skipped when tmux isn't installed.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { BunSocket } from "@effect/platform-bun"
import {
  type OpenTunnel,
  type RunnerToHub,
  SessionId,
  TunnelCloseCode,
  TunnelId,
} from "@kndl/protocol"
import { Effect, Layer, Redacted } from "effect"
import { HubLink } from "./HubLink.ts"
import { RunnerConfig } from "./RunnerConfig.ts"
import { connectHostTcp, makeFake } from "./sandbox/FakeSandboxBackend.ts"
import { SandboxBackend, SandboxBackendError } from "./sandbox/SandboxBackend.ts"
import { Sessions } from "./Sessions.ts"
import {
  forwardLocally,
  openTunnel,
  removeTunnelScenes,
  stopTunnelScenes,
  tmuxMissing,
  tunnelScene,
} from "./testTunnels.ts"
import { TunnelBufferCap, Tunnels, TunnelStallMs, TunnelsLive } from "./Tunnels.ts"

// Bun doesn't say why a test was skipped, so this does.
if (tmuxMissing) console.warn("Skipping the tunnel end-to-end tests: tmux isn't installed")

afterEach(stopTunnelScenes)
afterAll(removeTunnelScenes)

const sessionId = SessionId.make("s-1")
const MiB = 1024 * 1024

/** Bytes 0, 1, ..., 255, 0, 1, ...: so a test sees a byte lost or out of order. */
const pattern = (size: number) => {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) bytes[i] = i & 0xff
  return bytes
}

const isPattern = (bytes: Uint8Array) => bytes.every((byte, i) => byte === (i & 0xff))

/** The body of an HTTP/1.1 response, after its headers. */
const httpBody = (response: Uint8Array) => {
  const text = Buffer.from(response)
  const at = text.indexOf("\r\n\r\n")
  return at < 0 ? new Uint8Array() : response.subarray(at + 4)
}

const httpGet = (path: string) =>
  new TextEncoder().encode(`GET ${path} HTTP/1.1\r\nHost: guest\r\nConnection: close\r\n\r\n`)

/** A server standing in for one in the Sandbox: `/n/<bytes>` answers that many pattern bytes. */
function guestServer(hostname: "127.0.0.1" | "::1", name = hostname) {
  const bodies = new Map<number, Uint8Array>()
  const server = Bun.serve({
    hostname,
    port: 0,
    fetch(request, srv) {
      const url = new URL(request.url)
      if (url.pathname === "/ws" && srv.upgrade(request, { data: undefined })) return
      const size = /^\/n\/(\d+)$/.exec(url.pathname)?.[1]
      if (size !== undefined) {
        const n = Number(size)
        const body = bodies.get(n) ?? pattern(n)
        bodies.set(n, body)
        return new Response(body)
      }
      // The same bytes, written 256 KiB a millisecond at most: about as fast as agentd hands a real
      // Sandbox's on, where an in-process server here hands them on as fast as memory.
      const paced = /^\/paced\/(\d+)$/.exec(url.pathname)?.[1]
      if (paced !== undefined) {
        const body = pattern(Number(paced))
        let offset = 0
        return new Response(
          new ReadableStream({
            async pull(controller) {
              if (offset >= body.byteLength) return controller.close()
              controller.enqueue(body.subarray(offset, offset + 256 * 1024))
              offset += 256 * 1024
              await Bun.sleep(1)
            },
          }),
        )
      }
      return new Response(`hello from ${name}`)
    },
    websocket: {
      // An hour, so only the tunnel could end it.
      idleTimeout: 960,
      message: (ws, message) => void ws.send(`echo: ${String(message)}`),
    },
  })
  servers.push(server)
  const port = server.port
  if (port === undefined) throw new Error("the guest server has no port")
  return { port, stop: (closeActive?: boolean) => server.stop(closeActive) }
}

const servers: Array<ReturnType<typeof Bun.serve>> = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)))
})

/** TunnelsLive with the Hub link and the Sessions faked: what it tells the Hub. */
async function runnerTunnels(
  connectTcp = makeFake().backend.connectTcp,
  running: ReadonlyArray<SessionId> = [sessionId],
) {
  const sent: Array<RunnerToHub> = []
  const layer = TunnelsLive.pipe(
    Layer.provide([
      Layer.succeed(
        RunnerConfig,
        RunnerConfig.of({
          hubUrl: new URL("http://127.0.0.1:1"),
          name: "mac",
          token: Redacted.make("runner-token"),
          sessionsRoot: "/unused",
          modDir: "/unused",
          tmuxSocket: "unused",
          repoUrlTemplate: "unused",
        }),
      ),
      Layer.succeed(SandboxBackend, SandboxBackend.of({ ...makeFake().backend, connectTcp })),
      Layer.succeed(
        HubLink,
        HubLink.of({
          send: (message) => Effect.sync(() => void sent.push(message)),
          connect: () => Effect.void,
          disconnect: Effect.void,
        }),
      ),
      Layer.succeed(Sessions, { running: Effect.succeed(running) } as Sessions["Service"]),
      BunSocket.layerWebSocketConstructor,
    ]),
  )
  const open = (request: Partial<OpenTunnel>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const tunnels = yield* Tunnels
        yield* tunnels.open({
          _tag: "OpenTunnel",
          tunnelId: TunnelId.make("t-1"),
          sessionId,
          port: 3000,
          address: "127.0.0.1",
          ...request,
        })
        yield* Effect.sleep("100 millis")
      }).pipe(Effect.provide(layer)),
    )
  return { sent, open }
}

describe("the Runner's leg", () => {
  test("connects to loopback only, and only in a Sandbox of a Session it runs", async () => {
    const connects: Array<string> = []
    const { sent, open } = await runnerTunnels((_id, address, port, events) => {
      connects.push(`${address}:${port}`)
      return connectHostTcp(address, port, events)
    })
    await open({ address: "10.0.0.1" })
    await open({ address: "localhost" })
    await open({ sessionId: SessionId.make("s-elsewhere") })
    expect(connects).toEqual([])
    expect(sent).toEqual([
      {
        _tag: "TunnelFailed",
        tunnelId: TunnelId.make("t-1"),
        message: "The Runner connects tunnels to 127.0.0.1 or ::1 only, not 10.0.0.1.",
      },
      {
        _tag: "TunnelFailed",
        tunnelId: TunnelId.make("t-1"),
        message: "The Runner connects tunnels to 127.0.0.1 or ::1 only, not localhost.",
      },
      {
        _tag: "TunnelFailed",
        tunnelId: TunnelId.make("t-1"),
        message: "The Session isn't running on this Runner.",
      },
    ])
  })

  test("answers a port it can't connect to with a TunnelFailed saying why", async () => {
    const { sent, open } = await runnerTunnels(() =>
      Effect.fail(
        new SandboxBackendError({
          operation: "connect to port 3000",
          message: "Connection refused",
        }),
      ),
    )
    await open({})
    expect(sent).toEqual([
      {
        _tag: "TunnelFailed",
        tunnelId: TunnelId.make("t-1"),
        message: "Could not connect to port 3000: Connection refused",
      },
    ])
  })
})

describe.skipIf(tmuxMissing)("through the Hub and the Runner", () => {
  test("HTTP reaches a server bound to 127.0.0.1 and one bound to ::1, each in its family", async () => {
    const v4 = guestServer("127.0.0.1")
    const v6 = guestServer("::1")
    const scene = await tunnelScene({
      ports: [
        { port: 3000, addresses: ["127.0.0.1"], hostPort: v4.port },
        { port: 3001, addresses: ["::1"], hostPort: v6.port },
        // Bound to every address: both families, so IPv4's loopback.
        { port: 3002, addresses: ["0.0.0.0", "::"], hostPort: v4.port },
      ],
    })
    const forwards = await Promise.all(
      [3000, 3001, 3002].map((port) => forwardLocally(scene.tunnelUrl(port), scene.headers)),
    )
    const texts = await Promise.all(
      forwards.map((forward) =>
        fetch(`http://127.0.0.1:${forward.port}/`).then((response) => response.text()),
      ),
    )
    expect(texts).toEqual(["hello from 127.0.0.1", "hello from ::1", "hello from 127.0.0.1"])
    expect(scene.connects.map(({ address, port }) => `${address} ${port}`).toSorted()).toEqual([
      "127.0.0.1 3000",
      "127.0.0.1 3002",
      "::1 3001",
    ])
    // Every byte, in order.
    const large = await fetch(`http://127.0.0.1:${forwards[0]?.port}/n/${3 * MiB + 7}`)
    const body = new Uint8Array(await large.arrayBuffer())
    expect(body.byteLength).toBe(3 * MiB + 7)
    expect(isPattern(body)).toBe(true)
  }, 30_000)

  test("a port nothing listens on fails cleanly, as PortUnreachable", async () => {
    const gone = guestServer("127.0.0.1")
    const hostPort = gone.port
    await gone.stop(true)
    const scene = await tunnelScene({
      ports: [{ port: 3000, addresses: ["127.0.0.1"], hostPort }],
    })
    const tunnel = openTunnel(scene.tunnelUrl(3000), scene.headers)
    const closed = await tunnel.closed
    expect(closed.code).toBe(TunnelCloseCode.PortUnreachable)
    expect(closed.reason).toStartWith("Could not connect to port 3000: ")
  }, 30_000)

  test("a WebSocket served in the Sandbox stays up for over a minute", async () => {
    const guest = guestServer("127.0.0.1")
    const scene = await tunnelScene({
      ports: [{ port: 3000, addresses: ["127.0.0.1"], hostPort: guest.port }],
    })
    const forward = await forwardLocally(scene.tunnelUrl(3000), scene.headers)
    const socket = new WebSocket(`ws://127.0.0.1:${forward.port}/ws`)
    const messages: Array<string> = []
    let closed = false
    socket.addEventListener("message", (event) => messages.push(String(event.data)))
    socket.addEventListener("close", () => (closed = true))
    await new Promise((resolve) => socket.addEventListener("open", resolve))
    socket.send("hello")
    // Quiet for over a minute, then still answering.
    await Bun.sleep(65_000)
    socket.send("still there?")
    const deadline = Date.now() + 2_000
    while (messages.length < 2 && Date.now() < deadline) await Bun.sleep(10)
    expect(messages).toEqual(["echo: hello", "echo: still there?"])
    expect(closed).toBe(false)
    expect(forward.closes).toEqual([])
    socket.close()
  }, 90_000)

  test("one stalled reader doesn't slow the others, and one that takes nothing is closed alone", async () => {
    const guest = guestServer("127.0.0.1")
    const scene = await tunnelScene({
      ports: [{ port: 3000, addresses: ["127.0.0.1"], hostPort: guest.port }],
    })
    const url = scene.tunnelUrl(3000)

    // A reader that takes nothing for 6 s, with less coming than the Runner keeps for it.
    const { promise: stalled, resolve: resume } = Promise.withResolvers<void>()
    const slow = openTunnel(url, scene.headers, () => stalled)
    slow.end.send(httpGet(`/n/${4 * MiB}`))
    // One that never takes anything, with more coming than that: closed once the Runner keeps
    // its cap for it.
    const flooded = openTunnel(url, scene.headers, () => new Promise(() => {}))
    flooded.end.send(httpGet(`/n/${20 * MiB}`))
    // And one that never takes anything, with less coming: closed after TunnelStallMs.
    const stuck = openTunnel(url, scene.headers, () => new Promise(() => {}))
    stuck.end.send(httpGet(`/n/${3 * MiB}`))

    // Meanwhile other connections to the Session are served at once.
    const forward = await forwardLocally(url, scene.headers)
    const timings: Array<number> = []
    const fetchFor = async (ms: number) => {
      const started = Date.now()
      while (Date.now() - started < ms) {
        const t0 = Date.now()
        const response = await fetch(`http://127.0.0.1:${forward.port}/n/${256 * 1024}`)
        expect(isPattern(new Uint8Array(await response.arrayBuffer()))).toBe(true)
        timings.push(Date.now() - t0)
      }
    }
    await fetchFor(6_000)
    expect(await flooded.closed).toEqual({
      code: TunnelCloseCode.TooSlow,
      reason: "The client read too slowly: the Runner held too much for it.",
    })
    expect(flooded.received()).toBeLessThan(TunnelBufferCap)

    // The one that stalled for a while, reading again, gets every byte.
    resume()
    const deadline = Date.now() + 10_000
    while (httpBody(slow.bytes()).byteLength < 4 * MiB && Date.now() < deadline) await Bun.sleep(20)
    const body = httpBody(slow.bytes())
    expect(body.byteLength).toBe(4 * MiB)
    expect(isPattern(body)).toBe(true)

    const [closed] = await Promise.all([stuck.closed, fetchFor(TunnelStallMs - 6_000)])
    expect(closed).toEqual({
      code: TunnelCloseCode.TooSlow,
      reason: `The client took nothing for ${TunnelStallMs / 1000} s.`,
    })
    // All along the others were served as quickly.
    expect(timings.length).toBeGreaterThan(50)
    expect(Math.max(...timings)).toBeLessThan(1_000)
    expect(forward.closes).toEqual([])
  }, 60_000)

  test("a 50 MiB download doesn't delay the Session's terminal frames", async () => {
    const guest = guestServer("127.0.0.1")
    const scene = await tunnelScene({
      ports: [{ port: 3000, addresses: ["127.0.0.1"], hostPort: guest.port }],
    })
    const { web } = scene
    web.send({ _tag: "OpenTerminal", sessionId: scene.sessionId })
    await web.next("TerminalFrame", (frame) => String(frame["data"]).includes("fake claude ready"))

    /** How long a line typed at the terminal takes to come back echoed. */
    const echo = async (n: number) => {
      const sent = Date.now()
      web.send({ _tag: "TerminalInput", sessionId: scene.sessionId, data: `ping ${n}\r` })
      const { at } = await web.nextTimed("TerminalFrame", (frame) =>
        String(frame["data"]).includes(`you said: ping ${n}`),
      )
      return at - sent
    }
    const before = await echo(0)

    const forward = await forwardLocally(scene.tunnelUrl(3000), scene.headers)
    let done = false
    const download = fetch(`http://127.0.0.1:${forward.port}/paced/${50 * MiB}`)
      .then((response) => response.arrayBuffer())
      .finally(() => (done = true))
    const during: Array<number> = []
    for (let n = 1; ; n++) {
      if (done && during.length >= 3) break
      during.push(await echo(n))
    }
    const body = new Uint8Array(await download)
    expect(body.byteLength).toBe(50 * MiB)
    expect(isPattern(body)).toBe(true)
    expect(forward.closes.filter(({ code }) => code !== TunnelCloseCode.Closed)).toEqual([])
    // Echoes came as quickly during the download as before it, give or take.
    expect(Math.max(...during)).toBeLessThan(Math.max(before * 4, 500))
  }, 60_000)
})
