// Tunnels through the Hub (#177, ADR 0016), end to end: a real Hub, a fake Runner that dials back
// for each tunnel and plays the guest's server itself, and clients over WebSockets as the CLI and
// the web UI open them.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { connect } from "node:net"
import {
  Participant,
  ParticipantId,
  ProtocolVersion,
  TunnelCloseCode,
  TunnelMaxFrame,
  TunnelWindow,
} from "@kndl/protocol"
import { Effect, Option, Redacted } from "effect"
import { signInCookie } from "./Auth.ts"
import { CliTokens, pkceChallenge } from "./CliTokens.ts"
import { SignIns } from "./SignIns.ts"
import {
  type Connection,
  issueRunnerToken,
  openRunner,
  openWeb,
  stopAll,
  type ToRunner,
} from "./testChannels.ts"
import { appId, appKeyPair, StandInGitHub } from "./testGitHubApi.ts"
import { bearer, seedEnvironment, startHub, type TestHub, webOrigin } from "./testSupport.ts"

afterEach(async () => {
  await Promise.all([...Pipe.live].map((pipe) => pipe.close()))
  await stopAll()
})

const repo = "kddige/kndl"

/** The bytes 0..n-1 of a pattern a test can check arrived whole and in order. */
const pattern = (from: number, length: number) => {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) bytes[i] = (from + i) % 251
  return bytes
}

/**
 * One side of a tunnel: a WebSocket that keeps what it receives, acknowledges the bytes it is
 * sent unless told not to, and keeps to the window when it sends.
 */
class Pipe {
  static readonly live = new Set<Pipe>()
  readonly socket: WebSocket
  readonly texts: Array<string> = []
  /** The bytes received, kept unless `keep` is off. */
  private readonly chunks: Array<Uint8Array> = []
  /** How many bytes came, in all. */
  received = 0
  /** Whether each byte that came was the pattern's next. */
  inPattern = true
  /** Bytes sent and not acknowledged. */
  unacked = 0
  /** Whether it acknowledges what it receives. */
  acking = true
  keep = true
  private wake: Array<() => void> = []
  readonly opened: Promise<boolean>
  readonly closed: Promise<{ readonly code: number; readonly reason: string }>

  constructor(url: string, headers: Record<string, string>) {
    this.socket = new WebSocket(url, { headers })
    this.socket.binaryType = "arraybuffer"
    Pipe.live.add(this)
    this.opened = new Promise((resolve) => {
      this.socket.addEventListener("open", () => resolve(true))
      this.socket.addEventListener("error", () => resolve(false))
    })
    this.closed = new Promise((resolve) =>
      this.socket.addEventListener("close", (event) => {
        Pipe.live.delete(this)
        resolve({ code: event.code, reason: event.reason })
        this.notify()
      }),
    )
    this.socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        this.texts.push(event.data)
        const control = JSON.parse(event.data) as { _tag: string; bytes?: number }
        if (control._tag === "Ack") this.unacked -= control.bytes ?? 0
      } else {
        const bytes = new Uint8Array(event.data as ArrayBuffer)
        for (let i = 0; i < bytes.byteLength && this.inPattern; i++) {
          if (bytes[i] !== (this.received + i) % 251) this.inPattern = false
        }
        this.received += bytes.byteLength
        if (this.keep) this.chunks.push(bytes)
        if (this.acking) this.ack(bytes.byteLength)
      }
      this.notify()
    })
  }

  private notify() {
    for (const wake of this.wake.splice(0)) wake()
  }

  ack(bytes: number) {
    this.socket.send(JSON.stringify({ _tag: "Ack", bytes }))
  }

  /** The bytes received, as text. */
  text() {
    return new TextDecoder().decode(Buffer.concat(this.chunks))
  }

  send(bytes: Uint8Array | string) {
    const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes
    this.unacked += data.byteLength
    this.socket.send(data)
  }

  /** Waits until `done` says so, failing after `ms`. */
  async until(done: () => boolean, what: string, ms = 5_000) {
    const deadline = Date.now() + ms
    while (!done()) {
      const left = deadline - Date.now()
      if (left <= 0) throw new Error(`timed out waiting for ${what}`)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(left, 100))
        this.wake.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }

  /** Sends `total` bytes of the pattern in full frames, keeping to the window. */
  async pump(total: number) {
    for (let sent = 0; sent < total;) {
      if (this.socket.readyState !== WebSocket.OPEN) throw new Error("the socket closed")
      const length = Math.min(TunnelMaxFrame, total - sent)
      await this.until(() => this.unacked + length <= TunnelWindow, "room in the window", 30_000)
      this.send(pattern(sent, length))
      sent += length
    }
  }

  async close() {
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.close(1000)
    await this.closed
  }
}

const wsUrl = (hub: TestHub, path: string) => `${hub.url.replace(/^http/, "ws")}${path}`

/** A client's socket to a port of a Session, opened with `headers`. */
const openClient = (
  hub: TestHub,
  sessionId: string,
  port: number | string,
  headers: Record<string, string>,
) => new Pipe(wsUrl(hub, `/tunnel/${sessionId}/${port}`), headers)

/** The Runner's socket for a tunnel, dialed back with its token. */
const dialBack = async (hub: TestHub, runnerToken: string, tunnelId: string) => {
  const pipe = new Pipe(wsUrl(hub, `/runner/tunnel/${tunnelId}`), bearer(runnerToken))
  expect(await pipe.opened).toBe(true)
  return pipe
}

/**
 * The HTTP status an upgrade to `path` is answered with: `101` when it is taken, or the status
 * of a refusal, which a WebSocket client can't read.
 */
function upgradeStatus(hub: TestHub, path: string, headers: Record<string, string> = {}) {
  const url = new URL(hub.url)
  return new Promise<number>((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname, () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: ${url.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Key: ${btoa("0123456789abcdef")}`,
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      ]
      socket.write(`${lines.join("\r\n")}\r\n\r\n`)
    })
    let head = ""
    socket.on("data", (data) => {
      head += data.toString("latin1")
      const status = /^HTTP\/1\.1 (\d{3})/.exec(head)
      if (status !== null) {
        socket.destroy()
        resolve(Number(status[1]))
      }
    })
    socket.on("error", reject)
  })
}

const ports = [
  { port: 3000, addresses: ["127.0.0.1"], process: "bun server" },
  { port: 5173, addresses: ["::1"], process: "node vite" },
  { port: 8080, addresses: ["0.0.0.0", "::"] },
]

/**
 * A Hub with an online Runner that forwards ports, and an Active Session of `repo` with the
 * Open ports above, created by alice on the web.
 */
async function tunnelScene(
  hub?: TestHub,
  options: { readonly forwardsPorts?: boolean; readonly creator?: string } = {},
) {
  const theHub = hub ?? (await startHub({ config: { devLogin: true } }))
  const runnerToken = (await issueRunnerToken(theHub)).token
  const runner = await openRunner(
    theHub,
    runnerToken,
    [],
    undefined,
    true,
    options.forwardsPorts === false ? {} : { forwardsPorts: true },
  )
  const web = await openWeb(theHub, "alice")
  await seedEnvironment(theHub, repo, "dev:alice")
  web.send({
    _tag: "CreateSession",
    requestId: "req-1",
    repo,
    branch: { _tag: "Existing", name: "main", newWorkBranch: true },
  })
  const start = await runner.take("StartSession")
  const sessionId = (await web.take("SessionCreated")).session.id
  const modHeaders = { ...bearer(start.modToken), "content-type": "application/json" }
  const hello = await fetch(`${theHub.url}/mod/hello`, {
    method: "POST",
    headers: modHeaders,
    body: JSON.stringify({
      _tag: "ModHello",
      protocolVersion: ProtocolVersion,
      sessionId,
      conversationId: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
      model: "claude-opus",
    }),
  })
  expect(hello.status).toBe(200)
  runner.send({ _tag: "SessionStarted", sessionId, environmentVersion: 1 })
  await web.take("SessionUpdated", (m) => m.session.id === sessionId && !m.session.starting)
  runner.send({ _tag: "SessionPorts", sessionId, ports })
  await web.take("SessionUpdated", (m) => m.session.openPorts !== undefined)
  /** A mod's events, posted as the Session's mod. */
  const modPost = async (...messages: ReadonlyArray<unknown>) => {
    const response = await fetch(`${theHub.url}/mod/events`, {
      method: "POST",
      headers: modHeaders,
      body: JSON.stringify({ messages }),
    })
    expect(response.status).toBe(204)
  }
  /** alice's sign-in, as the web UI sends it. */
  const asAlice = { cookie: web.cookie, origin: webOrigin }
  return { hub: theHub, runner, runnerToken, web, sessionId, modPost, asAlice }
}

/** The OpenTunnel the Runner is sent, and its socket dialed back for it. */
async function accept(runner: Connection<ToRunner>, hub: TestHub, runnerToken: string) {
  const open = await runner.take("OpenTunnel")
  return { open, guest: await dialBack(hub, runnerToken, open.tunnelId) }
}

/** A client's tunnel to `port`, opened, with the Runner's end of it. */
async function tunnelTo(
  scene: Awaited<ReturnType<typeof tunnelScene>>,
  port = 3000,
  headers: Record<string, string> = scene.asAlice,
) {
  const client = openClient(scene.hub, scene.sessionId, port, headers)
  expect(await client.opened).toBe(true)
  const { open, guest } = await accept(scene.runner, scene.hub, scene.runnerToken)
  return { client, guest, open }
}

describe("the client's endpoint", () => {
  test("is a WebSocket, for a credential from the web UI or a CLI token only", async () => {
    const { hub, sessionId, web } = await tunnelScene()
    const path = `/tunnel/${sessionId}/3000`
    expect((await fetch(`${hub.url}${path}`)).status).toBe(426)
    expect(await upgradeStatus(hub, path)).toBe(401)
    expect(await upgradeStatus(hub, path, bearer("chc_not.a-token"))).toBe(401)
    expect(
      await upgradeStatus(hub, path, { cookie: web.cookie, origin: "https://evil.example" }),
    ).toBe(403)
    expect(await upgradeStatus(hub, path, { cookie: web.cookie, origin: webOrigin })).toBe(101)
  })

  test("pairs the client with the Runner's dial-back, and pipes bytes, Acks and Eof both ways", async () => {
    const scene = await tunnelScene()
    const { client, guest, open } = await tunnelTo(scene)
    expect(open).toEqual({
      _tag: "OpenTunnel",
      tunnelId: open.tunnelId,
      sessionId: scene.sessionId,
      port: 3000,
      address: "127.0.0.1",
    })

    client.send("GET / HTTP/1.1\r\n\r\n")
    await guest.until(() => guest.text() === "GET / HTTP/1.1\r\n\r\n", "the request")
    await client.until(() => client.unacked === 0, "the guest's Ack")
    client.socket.send(JSON.stringify({ _tag: "Eof" }))
    await guest.until(() => guest.texts.includes('{"_tag":"Eof"}'), "the client's Eof")

    guest.send("HTTP/1.1 200 OK\r\n\r\nhello")
    await client.until(() => client.text() === "HTTP/1.1 200 OK\r\n\r\nhello", "the response")
    await guest.until(() => guest.unacked === 0, "the client's Ack")
    guest.socket.send(JSON.stringify({ _tag: "Eof" }))
    await client.until(() => client.texts.includes('{"_tag":"Eof"}'), "the guest's Eof")

    // The server closing closes the client, as it closed.
    guest.socket.close(1000)
    expect((await client.closed).code).toBe(TunnelCloseCode.Closed)
  })

  test("connects in the port's address family, and passes on a close's own code", async () => {
    const scene = await tunnelScene()
    const six = await tunnelTo(scene, 5173)
    expect(six.open.address).toBe("::1")
    const both = await tunnelTo(scene, 8080)
    expect(both.open.address).toBe("127.0.0.1")

    six.client.socket.close(1000)
    expect((await six.guest.closed).code).toBe(TunnelCloseCode.Closed)
    both.guest.socket.close(TunnelCloseCode.TooSlow, "The client took nothing for 30 s.")
    expect(await both.client.closed).toEqual({
      code: TunnelCloseCode.TooSlow,
      reason: "The client took nothing for 30 s.",
    })
  })

  test("takes a CLI token, checked again on each connection: a revoked one is refused", async () => {
    const scene = await tunnelScene()
    const verifier = "v".repeat(43)
    const signedIn = await scene.hub.run(
      Effect.gen(function* () {
        const cli = yield* CliTokens
        const alice = Participant.make({
          id: ParticipantId.make("dev:alice"),
          login: "alice",
          name: "alice",
        })
        const { code } = yield* cli.approve(alice, "laptop", pkceChallenge(verifier))
        return yield* cli.redeem(code, verifier)
      }),
    )
    // The CLI sends no Origin.
    const { client, guest } = await tunnelTo(scene, 3000, bearer(signedIn.token))
    guest.send("over a CLI token")
    await client.until(() => client.text() === "over a CLI token", "the bytes")

    await scene.hub.run(
      Effect.flatMap(CliTokens, (cli) => cli.revoke(ParticipantId.make("dev:alice"), signedIn.id)),
    )
    const path = `/tunnel/${scene.sessionId}/3000`
    expect(await upgradeStatus(scene.hub, path, bearer(signedIn.token))).toBe(401)
    expect(await scene.runner.untaken("OpenTunnel")).toEqual([])
  })

  test("refuses a Session that doesn't exist, or a port that isn't one, before the Runner is asked", async () => {
    const scene = await tunnelScene()
    const nowhere = openClient(scene.hub, "no-such-session", 3000, scene.asAlice)
    expect((await nowhere.closed).code).toBe(TunnelCloseCode.NoSuchSession)
    const notAPort = openClient(scene.hub, scene.sessionId, "http", scene.asAlice)
    expect((await notAPort.closed).code).toBe(TunnelCloseCode.PortNotOpen)
    const closedPort = openClient(scene.hub, scene.sessionId, 4000, scene.asAlice)
    expect(await closedPort.closed).toEqual({
      code: TunnelCloseCode.PortNotOpen,
      reason: "Nothing listens on port 4000 in the Session's Sandbox.",
    })
    expect(await scene.runner.untaken("OpenTunnel")).toEqual([])
  })

  test("says why a Session can't take a tunnel: Asleep, its Runner offline or too old", async () => {
    const old = await tunnelScene(undefined, { forwardsPorts: false })
    const tooOld = openClient(old.hub, old.sessionId, 3000, old.asAlice)
    expect((await tooOld.closed).code).toBe(TunnelCloseCode.RunnerTooOld)
    expect(await old.runner.untaken("OpenTunnel")).toEqual([])

    const scene = await tunnelScene()
    const { runner, web, sessionId } = scene
    web.send({ _tag: "SleepSession", sessionId })
    await runner.take("StopSession")
    const goingToSleep = openClient(scene.hub, sessionId, 3000, scene.asAlice)
    expect((await goingToSleep.closed).code).toBe(TunnelCloseCode.NotActive)
    runner.send({ _tag: "SessionStopped", sessionId, reason: "Requested", exitCode: 143 })
    await web.take("SessionUpdated", (m) => m.session.state === "Asleep")
    const asleep = openClient(scene.hub, sessionId, 3000, scene.asAlice)
    expect(await asleep.closed).toEqual({
      code: TunnelCloseCode.NotActive,
      reason: "The Session is Asleep: wake it first.",
    })

    const frozen = await tunnelScene()
    await frozen.runner.close()
    await frozen.web.take("SessionUpdated", (m) => m.session.state === "Frozen")
    const offline = openClient(frozen.hub, frozen.sessionId, 3000, frozen.asAlice)
    expect((await offline.closed).code).toBe(TunnelCloseCode.RunnerOffline)
  })

  test("fails a tunnel the Runner couldn't open, or that its Runner went offline before opening", async () => {
    const scene = await tunnelScene()
    const refused = openClient(scene.hub, scene.sessionId, 3000, scene.asAlice)
    const open = await scene.runner.take("OpenTunnel")
    scene.runner.send({
      _tag: "TunnelFailed",
      tunnelId: open.tunnelId,
      message: "Could not connect to port 3000: Connection refused",
    })
    expect(await refused.closed).toEqual({
      code: TunnelCloseCode.PortUnreachable,
      reason: "Could not connect to port 3000: Connection refused",
    })
    // It can't be dialed for after that.
    expect(
      await upgradeStatus(scene.hub, `/runner/tunnel/${open.tunnelId}`, bearer(scene.runnerToken)),
    ).toBe(404)

    const waiting = openClient(scene.hub, scene.sessionId, 3000, scene.asAlice)
    await scene.runner.take("OpenTunnel")
    await scene.runner.close()
    expect((await waiting.closed).code).toBe(TunnelCloseCode.RunnerOffline)
  })

  test("fails a tunnel its Runner's old connection was asked to open, when a new one replaces it (#243)", async () => {
    const scene = await tunnelScene()
    const waiting = openClient(scene.hub, scene.sessionId, 3000, scene.asAlice)
    await scene.runner.take("OpenTunnel")
    await openRunner(scene.hub, scene.runnerToken, [scene.sessionId], undefined, true, {
      forwardsPorts: true,
    })
    expect((await waiting.closed).code).toBe(TunnelCloseCode.RunnerOffline)
  })

  test("closes a tunnel whose side breaks the protocol, on both sides", async () => {
    const scene = await tunnelScene()
    const pastWindow = await tunnelTo(scene)
    pastWindow.client.acking = false
    // The Hub counts what it passed toward the client: one byte past the window is too many.
    await pastWindow.guest.pump(TunnelWindow)
    await pastWindow.client.until(() => pastWindow.client.received === TunnelWindow, "the window")
    pastWindow.guest.send(new Uint8Array(1))
    expect((await pastWindow.client.closed).code).toBe(TunnelCloseCode.ProtocolError)
    expect(await pastWindow.guest.closed).toEqual({
      code: TunnelCloseCode.ProtocolError,
      reason: "The runner sent past the window.",
    })

    const tooLarge = await tunnelTo(scene)
    tooLarge.client.send(new Uint8Array(TunnelMaxFrame + 1))
    expect((await tooLarge.guest.closed).code).toBe(TunnelCloseCode.ProtocolError)

    const notControl = await tunnelTo(scene)
    notControl.client.socket.send("hello")
    expect((await notControl.client.closed).code).toBe(TunnelCloseCode.ProtocolError)

    const overAcked = await tunnelTo(scene)
    overAcked.guest.ack(10)
    expect((await overAcked.guest.closed).reason).toBe(
      "The runner acknowledged bytes it wasn't sent.",
    )
  })

  test("pairs a tunnel only with the Runner it was sent to", async () => {
    const scene = await tunnelScene()
    const other = (await issueRunnerToken(scene.hub, "other")).token
    const client = openClient(scene.hub, scene.sessionId, 3000, scene.asAlice)
    const open = await scene.runner.take("OpenTunnel")
    const path = `/runner/tunnel/${open.tunnelId}`
    expect(await upgradeStatus(scene.hub, path)).toBe(401)
    expect(await upgradeStatus(scene.hub, path, bearer(other))).toBe(404)
    expect(await upgradeStatus(scene.hub, path, scene.asAlice)).toBe(401)
    // The Runner it was sent to still can, once.
    const guest = await dialBack(scene.hub, scene.runnerToken, open.tunnelId)
    guest.send("ok")
    await client.until(() => client.text() === "ok", "the bytes")
    expect(await upgradeStatus(scene.hub, path, bearer(scene.runnerToken))).toBe(404)
  })
})

describe("backpressure", () => {
  test("a client that reads nothing holds up its own tunnel, and no other", async () => {
    const scene = await tunnelScene()
    const stuck = await tunnelTo(scene)
    stuck.client.acking = false
    const stuckPump = stuck.guest.pump(8 * TunnelWindow).catch(() => undefined)
    await stuck.client.until(() => stuck.client.received === TunnelWindow, "the window")

    const busy = await tunnelTo(scene, 5173)
    busy.client.keep = false
    const started = performance.now()
    await busy.guest.pump(20 * 1024 * 1024)
    await busy.client.until(() => busy.client.received === 20 * 1024 * 1024, "20 MiB", 20_000)
    expect(busy.client.inPattern).toBe(true)
    expect(performance.now() - started).toBeLessThan(15_000)

    // The stuck one got its window and no more; it gets the rest once it reads.
    expect(stuck.client.received).toBe(TunnelWindow)
    stuck.client.acking = true
    stuck.client.ack(TunnelWindow)
    await stuck.client.until(() => stuck.client.received === 8 * TunnelWindow, "the rest", 10_000)
    expect(stuck.client.inPattern).toBe(true)
    await stuckPump
  }, 30_000)

  test("50 MiB through a tunnel doesn't hold up terminal frames or Turn events", async () => {
    const scene = await tunnelScene()
    const { runner, web, sessionId, modPost } = scene
    web.send({ _tag: "JoinSession", sessionId })
    await web.take("SessionHistory")
    web.send({ _tag: "OpenTerminal", sessionId })
    await runner.take("RequestTerminalSnapshot")

    const { client, guest } = await tunnelTo(scene)
    client.keep = false
    const total = 50 * 1024 * 1024
    const pumped = guest.pump(total)

    const latencies: Array<number> = []
    for (let i = 0; client.received < total && i < 200; i++) {
      const sent = performance.now()
      runner.send({
        _tag: "TerminalFrame",
        sessionId,
        kind: "Output",
        data: `frame ${i}`,
        size: { cols: 80, rows: 24 },
      })
      await web.take("TerminalFrame", (m) => m.data === `frame ${i}`)
      await modPost({
        _tag: "TurnStarted",
        turnId: `t-${i}`,
        text: "",
        sender: { _tag: "FromTerminal" },
      })
      await web.take("SessionUpdated", (m) => m.session.currentTurn === `t-${i}`)
      await modPost({ _tag: "TurnEnded", turnId: `t-${i}`, reason: "stop", durationMs: 1 })
      latencies.push(performance.now() - sent)
    }
    await pumped
    await client.until(() => client.received === total, "50 MiB", 30_000)
    expect(client.inPattern).toBe(true)
    // Each measured while the bytes flowed, and each prompt.
    expect(latencies.length).toBeGreaterThan(0)
    expect(Math.max(...latencies)).toBeLessThan(500)
  }, 60_000)
})

/** The sign-in cookie of someone signed in with GitHub, as the web UI sends it. */
async function signedInWithGitHub(hub: TestHub, who: { id: string; login: string }) {
  const { token } = await hub.run(
    Effect.flatMap(SignIns, (signIns) =>
      signIns.signIn(
        Participant.make({ id: ParticipantId.make(who.id), login: who.login, name: who.login }),
      ),
    ),
  )
  return { cookie: `${signInCookie}=${token}`, origin: webOrigin }
}

describe("Repo access", () => {
  const keys = appKeyPair()
  let github: StandInGitHub

  beforeAll(() => {
    github = StandInGitHub.start(keys.publicKey)
  })
  afterAll(() => github.stop())

  const accessHub = () => {
    github.reset()
    github.installedOn.add(repo)
    return startHub({
      config: {
        devLogin: true,
        githubAppId: Option.some(appId),
        githubAppPrivateKey: Option.some(Redacted.make(keys.privateKeyPem)),
        githubApiUrl: github.url,
        repoAccessTtlMs: 1,
      },
    })
  }

  test("someone without access to the Session's Repo is refused before the Runner is asked", async () => {
    const scene = await tunnelScene(await accessHub())
    const octocat = await signedInWithGitHub(scene.hub, { id: "github:1", login: "octocat" })
    const hubot = await signedInWithGitHub(scene.hub, { id: "github:2", login: "hubot" })
    github.grant(repo, "hubot")

    const refused = openClient(scene.hub, scene.sessionId, 3000, octocat)
    // Alike with a Session that doesn't exist: the refusal says nothing of what does.
    expect(await refused.closed).toEqual({
      code: TunnelCloseCode.NoSuchSession,
      reason: "There is no such Session.",
    })
    expect(await scene.runner.untaken("OpenTunnel")).toEqual([])

    const { client, guest } = await tunnelTo(scene, 3000, hubot)
    guest.send("for hubot")
    await client.until(() => client.text() === "for hubot", "the bytes")

    // Access is checked on each connection: taken away, the next is refused.
    github.revoke(repo, "hubot")
    const after = openClient(scene.hub, scene.sessionId, 3000, hubot)
    expect((await after.closed).code).toBe(TunnelCloseCode.NoSuchSession)
    expect(await scene.runner.untaken("OpenTunnel")).toEqual([])
  })

  test("says to try again when GitHub can't say", async () => {
    const scene = await tunnelScene(await accessHub())
    const octocat = await signedInWithGitHub(scene.hub, { id: "github:1", login: "octocat" })
    github.collaboratorsDown = true
    const unknown = openClient(scene.hub, scene.sessionId, 3000, octocat)
    expect((await unknown.closed).code).toBe(TunnelCloseCode.AccessUnknown)
    expect(await scene.runner.untaken("OpenTunnel")).toEqual([])
    github.collaboratorsDown = false
  })
})
