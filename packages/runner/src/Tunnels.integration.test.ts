// KNDL_SANDBOX_IT=1: tunnels into a real microsandbox Sandbox (#177). One Sandbox on
// oven/bun:1, named it-177-…, serves HTTP and a WebSocket on 127.0.0.1 and on ::1; a real Hub and
// Runner (testTunnels.ts) carry each connection to it through agentd, as a Session's would be. It
// needs `msb` installed for the current user, the oven/bun:1 image (pulled on first run), and
// tmux, for the Session the scene runs. The Sandbox is removed at the end, pass or fail; no other
// Sandbox is touched.
//
//   KNDL_SANDBOX_IT=1 bun test packages/runner/src/Tunnels.integration.test.ts

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { TunnelCloseCode } from "@kndl/protocol"
import { Effect } from "effect"
import { Sandbox } from "microsandbox"
import { makeAgentTcp } from "./sandbox/AgentTcp.ts"
import { SandboxBackendError, type SandboxBackendShape } from "./sandbox/SandboxBackend.ts"
import {
  forwardLocally,
  openTunnel,
  removeTunnelScenes,
  stopTunnelScenes,
  tmuxMissing,
  tunnelScene,
} from "./testTunnels.ts"
import { TunnelBufferCap } from "./Tunnels.ts"

const enabled = process.env.KNDL_SANDBOX_IT === "1" && !tmuxMissing
if (process.env.KNDL_SANDBOX_IT === "1" && tmuxMissing) {
  console.warn("Skipping the real-Sandbox tunnel tests: tmux isn't installed")
}

const MiB = 1024 * 1024
const name = `it-177-${Date.now().toString(36)}`

const isPattern = (bytes: Uint8Array) => bytes.every((byte, i) => byte === (i & 0xff))

/** The body of an HTTP/1.1 response, after its headers. */
const httpBody = (response: Uint8Array) => {
  const at = Buffer.from(response).indexOf("\r\n\r\n")
  return at < 0 ? new Uint8Array() : response.subarray(at + 4)
}

const httpGet = (path: string) =>
  new TextEncoder().encode(`GET ${path} HTTP/1.1\r\nHost: guest\r\nConnection: close\r\n\r\n`)

/**
 * The guest's servers: on 127.0.0.1:3000 and [::1]:3001, `/n/<bytes>` answers that many bytes
 * 0, 1, ..., 255, 0, ...; `/ws` echoes; anything else says which address it was served on.
 */
const serverScript = `
const bodies = new Map()
const pattern = (n) => {
  const bytes = new Uint8Array(n)
  for (let i = 0; i < n; i++) bytes[i] = i & 0xff
  return bytes
}
for (const [hostname, port] of [["127.0.0.1", 3000], ["::1", 3001]]) {
  Bun.serve({
    hostname,
    port,
    idleTimeout: 0,
    fetch(request, server) {
      const url = new URL(request.url)
      if (url.pathname === "/ws" && server.upgrade(request, { data: undefined })) return
      const size = /^\\/n\\/(\\d+)$/.exec(url.pathname)?.[1]
      if (size !== undefined) {
        const n = Number(size)
        if (!bodies.has(n)) bodies.set(n, pattern(n))
        return new Response(bodies.get(n))
      }
      return new Response("hello from " + hostname)
    },
    websocket: { idleTimeout: 960, message: (ws, message) => void ws.send("echo: " + message) },
  })
}
`

const agentTcp = makeAgentTcp()

/** The Runner's connections, into the test's Sandbox whichever Session asks. */
const intoSandbox: SandboxBackendShape["connectTcp"] = (_sessionId, address, port, events) =>
  Effect.tryPromise({
    try: () => agentTcp.connect(name, address, port, events),
    catch: (error) =>
      new SandboxBackendError({
        operation: `connect to port ${port}`,
        message: error instanceof Error ? error.message : String(error),
      }),
  }).pipe(
    Effect.map((connection) => ({
      write: (data: Uint8Array) =>
        Effect.tryPromise({
          try: () => connection.write(data),
          catch: (error) =>
            new SandboxBackendError({ operation: `write to port ${port}`, message: String(error) }),
        }),
      end: Effect.promise(() => connection.end()),
      close: Effect.promise(() => connection.close()),
    })),
  )

const ports = [
  { port: 3000, addresses: ["127.0.0.1"], hostPort: 0 },
  { port: 3001, addresses: ["::1"], hostPort: 0 },
]

const scene = (stallMs?: number) =>
  tunnelScene({ ports, connectTcp: intoSandbox, ...(stallMs !== undefined && { stallMs }) })

let sandbox: Sandbox | undefined

beforeAll(async () => {
  if (!enabled) return
  sandbox = await Sandbox.builder(name)
    .image("oven/bun:1")
    .cpus(2)
    .memory(1024)
    .logLevel("warn")
    .create()
  await sandbox.fs().write("/tmp/servers.js", serverScript)
  await sandbox.exec("sh", ["-c", "nohup bun /tmp/servers.js >/tmp/servers.log 2>&1 &"])
  // Up once both answer.
  const deadline = Date.now() + 30_000
  for (;;) {
    const up = await sandbox.exec("sh", [
      "-c",
      `bun -e 'await fetch("http://127.0.0.1:3000/"); await fetch("http://[::1]:3001/")'`,
    ])
    if (up.code === 0) break
    if (Date.now() > deadline) throw new Error("the guest's servers didn't come up")
    await Bun.sleep(250)
  }
}, 180_000)

afterEach(stopTunnelScenes)

afterAll(async () => {
  removeTunnelScenes()
  if (!enabled) return
  await agentTcp.dropAll()
  await sandbox?.kill().catch(() => undefined)
  await Sandbox.remove(name).catch(() => undefined)
}, 60_000)

describe.skipIf(!enabled)("tunnels into a real Sandbox", () => {
  test("HTTP reaches a server bound to 127.0.0.1 and one bound to ::1 in the guest", async () => {
    const { tunnelUrl, headers } = await scene()
    const v4 = await forwardLocally(tunnelUrl(3000), headers)
    const v6 = await forwardLocally(tunnelUrl(3001), headers)
    expect(await (await fetch(`http://127.0.0.1:${v4.port}/`)).text()).toBe("hello from 127.0.0.1")
    expect(await (await fetch(`http://127.0.0.1:${v6.port}/`)).text()).toBe("hello from ::1")
    // Every byte, in order.
    for (const forward of [v4, v6]) {
      const large = await fetch(`http://127.0.0.1:${forward.port}/n/${3 * MiB + 7}`)
      const body = new Uint8Array(await large.arrayBuffer())
      expect(body.byteLength).toBe(3 * MiB + 7)
      expect(isPattern(body)).toBe(true)
    }
  }, 60_000)

  test("a port nothing listens on in the guest fails cleanly, as PortUnreachable", async () => {
    const { tunnelUrl, headers } = await tunnelScene({
      ports: [{ port: 3999, addresses: ["127.0.0.1"], hostPort: 0 }],
      connectTcp: intoSandbox,
    })
    const closed = await openTunnel(tunnelUrl(3999), headers).closed
    expect(closed.code).toBe(TunnelCloseCode.PortUnreachable)
    expect(closed.reason).toStartWith("Could not connect to port 3999: ")
  }, 60_000)

  test("a WebSocket served in the guest stays up past Bun's 10 s idle timeout", async () => {
    const { tunnelUrl, headers } = await scene()
    const forward = await forwardLocally(tunnelUrl(3001), headers)
    const socket = new WebSocket(`ws://127.0.0.1:${forward.port}/ws`)
    const messages: Array<string> = []
    let closed = false
    socket.addEventListener("message", (event) => messages.push(String(event.data)))
    socket.addEventListener("close", () => (closed = true))
    await new Promise((resolve) => socket.addEventListener("open", resolve))
    socket.send("hello")
    // Longer than Bun's default 10 s idle timeout, which would close it on any hop that kept it
    // (ADR 0016).
    await Bun.sleep(12_000)
    socket.send("still there?")
    const deadline = Date.now() + 5_000
    while (messages.length < 2 && Date.now() < deadline) await Bun.sleep(10)
    expect(messages).toEqual(["echo: hello", "echo: still there?"])
    expect(closed).toBe(false)
    expect(forward.closes).toEqual([])
    socket.close()
  }, 60_000)

  test("one stalled reader doesn't slow the others, and one that takes nothing is closed alone", async () => {
    // agentd holds up every connection into the Sandbox behind one read slowly, new ones too, so
    // the Runner reads each as it comes and keeps what its client hasn't taken, to a cap.
    const stallMs = 10_000
    const { tunnelUrl, headers } = await scene(stallMs)
    const url = tunnelUrl(3000)

    const { promise: stalled, resolve: resume } = Promise.withResolvers<void>()
    const slow = openTunnel(url, headers, () => stalled)
    slow.end.send(httpGet(`/n/${4 * MiB}`))
    const flooded = openTunnel(url, headers, () => new Promise(() => {}))
    flooded.end.send(httpGet(`/n/${20 * MiB}`))
    const stuck = openTunnel(url, headers, () => new Promise(() => {}))
    stuck.end.send(httpGet(`/n/${3 * MiB}`))

    const forward = await forwardLocally(url, headers)
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
    await fetchFor(2_000)
    expect((await flooded.closed).code).toBe(TunnelCloseCode.TooSlow)
    expect(flooded.received()).toBeLessThan(TunnelBufferCap)

    resume()
    const deadline = Date.now() + 30_000
    while (httpBody(slow.bytes()).byteLength < 4 * MiB && Date.now() < deadline) await Bun.sleep(20)
    const body = httpBody(slow.bytes())
    expect(body.byteLength).toBe(4 * MiB)
    expect(isPattern(body)).toBe(true)

    const [closed] = await Promise.all([stuck.closed, fetchFor(stallMs - 2_000)])
    expect(closed).toEqual({
      code: TunnelCloseCode.TooSlow,
      reason: `The client took nothing for ${stallMs / 1000} s.`,
    })
    expect(timings.length).toBeGreaterThan(5)
    expect(Math.max(...timings)).toBeLessThan(1_500)
    expect(forward.closes).toEqual([])
  }, 60_000)

  test("a 50 MiB download doesn't delay the Session's terminal frames", async () => {
    const { web, sessionId, tunnelUrl, headers } = await scene()
    web.send({ _tag: "OpenTerminal", sessionId })
    await web.next("TerminalFrame", (frame) => String(frame["data"]).includes("fake claude ready"))
    const echo = async (n: number) => {
      const sent = Date.now()
      web.send({ _tag: "TerminalInput", sessionId, data: `ping ${n}\r` })
      const { at } = await web.nextTimed("TerminalFrame", (frame) =>
        String(frame["data"]).includes(`you said: ping ${n}`),
      )
      return at - sent
    }
    const before = await echo(0)

    const forward = await forwardLocally(tunnelUrl(3000), headers)
    let done = false
    const download = fetch(`http://127.0.0.1:${forward.port}/n/${50 * MiB}`)
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
    expect(Math.max(...during)).toBeLessThan(Math.max(before * 4, 500))
  }, 120_000)
})
