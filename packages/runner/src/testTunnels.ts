// Tunnels end to end, for tests (#177): a real Hub and a real Runner, whose Session runs in real
// tmux with its Workspace and Sandbox faked, and whose "guest" ports are servers on the host, which
// a test may open and close as it goes. Also the client's side: a tunnel's socket, a local listener
// that carries each connection through one, as `kndl forward` does (#180), and the CLI token
// it does it with. Not part of the Runner.

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunServices, BunSocket } from "@effect/platform-bun"
import {
  type OpenPort,
  Participant,
  ParticipantId,
  ProtocolVersion,
  RunnerToHub,
  type SessionId,
  tunnelPath,
} from "@kndl/protocol"
import { TunnelEnd } from "@kndl/protocol/tunnel-end"
import { Effect, Fiber, Layer, Option, Redacted, References } from "effect"
import { CliTokens, pkceChallenge } from "../../hub/src/CliTokens.ts"
import { RunnerTokens } from "../../hub/src/RunnerTokens.ts"
import { generateSecretsKey } from "../../hub/src/Secrets.ts"
import {
  cookieFrom,
  devSignIn,
  seedEnvironment,
  startHub,
  stopHubs,
  type TestHub,
  webOrigin,
} from "../../hub/src/testSupport.ts"
import { StaticClaudeModels } from "./ClaudeModels.ts"
import { HubClaudeCredentialLive } from "./HubClaudeCredential.ts"
import { HubGitLive } from "./HubGit.ts"
import { HubLink, HubLinkLive } from "./HubLink.ts"
import { HubVariablesLive } from "./HubVariables.ts"
import { OpenPorts } from "./OpenPorts.ts"
import { runRunner } from "./Runner.ts"
import { RunnerConfig } from "./RunnerConfig.ts"
import { connectHostTcp, makeFake } from "./sandbox/FakeSandboxBackend.ts"
import { SandboxBackend, type SandboxBackendShape } from "./sandbox/SandboxBackend.ts"
import { workspaceGuestPath } from "./sandbox/SessionLayout.ts"
import { SessionsLive } from "./Sessions.ts"
import {
  FakeCredentialProxy,
  FakeSandboxes,
  FakeWorkspaceGit,
  FakeWorkspaces,
  hostTmuxBackend,
  writeFakeMod,
} from "./testSupport.ts"
import { makeTmux, Tmux } from "./Tmux.ts"
import { TunnelsLive } from "./Tunnels.ts"
import { Updater } from "./Updater.ts"

export const tmuxMissing = Bun.which("tmux") === null

const tmuxSocket = `kndl-tunnel-test-${process.pid}`
let made: string | undefined

/**
 * The scenes' folder, with a stand-in for Claude Code in it that says it's ready and echoes each
 * line. Made on first use, and again after removeTunnelScenes: test files share this module in one
 * `bun test`, and each removes the scenes after itself.
 */
const sceneDir = () => {
  if (made !== undefined) return made
  const dir = mkdtempSync(join(tmpdir(), "kndl-tunnels-"))
  writeFileSync(
    join(dir, "fake-claude"),
    `#!${process.execPath}
process.stdout.write("fake claude ready\\n")
for await (const line of console) process.stdout.write(\`you said: \${line}\\n\`)
`,
  )
  chmodSync(join(dir, "fake-claude"), 0o755)
  made = dir
  return dir
}

type Tagged = { readonly _tag: string; readonly [key: string]: unknown }

/** A web client: a WebSocket to the Hub that keeps what it receives, and when. */
export class Web {
  readonly received: Array<{ readonly message: Tagged; readonly at: number }> = []

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      this.received.push({ message: JSON.parse(String(event.data)) as Tagged, at: Date.now() })
    })
  }

  static async open(hub: TestHub, cookie: string): Promise<Web> {
    const socket = new WebSocket(`${hub.url.replace(/^http/, "ws")}/ws/web`, {
      headers: { cookie, origin: webOrigin },
    })
    const web = new Web(socket)
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve())
      socket.addEventListener("error", () => reject(new Error("could not open /ws/web")))
    })
    web.send({ _tag: "WebHello", protocolVersion: ProtocolVersion })
    await web.next("WebWelcome")
    return web
  }

  send(message: Tagged) {
    this.socket.send(JSON.stringify(message))
  }

  /** Waits for a message of this kind, matching `where`, that came after everything taken. */
  async next(
    tag: string,
    where: (message: Tagged) => boolean = () => true,
    timeoutMs = 5_000,
  ): Promise<Tagged> {
    return (await this.nextTimed(tag, where, timeoutMs)).message
  }

  /** As {@link next}, with when it came. */
  async nextTimed(
    tag: string,
    where: (message: Tagged) => boolean = () => true,
    timeoutMs = 5_000,
  ): Promise<{ readonly message: Tagged; readonly at: number }> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const index = this.received.findIndex(({ message }) => message._tag === tag && where(message))
      const found = index >= 0 ? this.received.splice(0, index + 1).at(-1) : undefined
      if (found !== undefined) return found
      if (Date.now() > deadline) {
        throw new Error(
          `No ${tag} came; got ${JSON.stringify(this.received.slice(-5).map((r) => r.message))}`,
        )
      }
      await Bun.sleep(5)
    }
  }

  close() {
    this.socket.close(1000)
  }
}

/** A port in the Session's "Sandbox": the guest's port, and the host's server it reaches. */
export interface GuestPort {
  readonly port: number
  readonly addresses: ReadonlyArray<string>
  /** The host port of the server standing in for the guest's. */
  readonly hostPort: number
}

/** The guest connections the Runner asked for. */
export interface GuestConnect {
  readonly sessionId: SessionId
  readonly address: string
  readonly port: number
}

export interface TunnelScene {
  readonly hub: TestHub
  readonly cookie: string
  readonly web: Web
  readonly sessionId: SessionId
  /** Every connection the Runner made into the Sandbox. */
  readonly connects: Array<GuestConnect>
  /** Where a client opens a tunnel to the guest port. */
  readonly tunnelUrl: (port: number) => string
  /** The headers a signed-in client opens it with. */
  readonly headers: Record<string, string>
  /** Opens and closes ports in the Sandbox: the Runner reports these as its Open ports now. */
  readonly setPorts: (ports: ReadonlyArray<GuestPort>) => Promise<void>
  /** A CLI token for `login`, signed in on the web already, as `kndl login` on `machine` gets. */
  readonly cliToken: (login: string, machine: string) => Promise<string>
}

const runners: Array<Fiber.Fiber<never, unknown>> = []
const webs: Array<Web> = []
const listeners: Array<{ readonly stop: () => void }> = []

/** Stops what the scenes started: pass to `afterEach`. */
export async function stopTunnelScenes() {
  for (const listener of listeners.splice(0)) listener.stop()
  for (const web of webs.splice(0)) web.close()
  for (const runner of runners.splice(0)) await Effect.runPromise(Fiber.interrupt(runner))
  await stopHubs()
}

/** Removes the scenes' tmux server and files: pass to `afterAll`. */
export function removeTunnelScenes() {
  if (made !== undefined) rmSync(made, { recursive: true, force: true })
  made = undefined
  if (!tmuxMissing) Bun.spawnSync(["tmux", "-L", tmuxSocket, "kill-server"])
}

/**
 * A real Hub and Runner, and an Active Session alice made, whose Sandbox has `ports` open. The
 * Runner connects into the Sandbox with `connectTcp`; by default to the host's server for the port.
 */
export async function tunnelScene(options: {
  readonly ports: ReadonlyArray<GuestPort>
  readonly connectTcp?: SandboxBackendShape["connectTcp"]
  /** How long the Hub lets an idle Session be before it puts it to sleep. */
  readonly sleepAfterMs?: number
}): Promise<TunnelScene> {
  const hub = await startHub({
    config: {
      devLogin: true,
      secretsKey: Option.some(Redacted.make(generateSecretsKey())),
      ...(options.sleepAfterMs !== undefined && { sleepAfterMs: options.sleepAfterMs }),
    },
  })
  const { token } = await hub.run(Effect.flatMap(RunnerTokens, (tokens) => tokens.issue("mac")))
  const connects: Array<GuestConnect> = []
  const hostPorts = new Map(options.ports.map((port) => [port.port, port.hostPort]))
  const connectTcp: SandboxBackendShape["connectTcp"] = (sessionId, address, port, events) => {
    connects.push({ sessionId, address, port })
    return (
      options.connectTcp?.(sessionId, address, port, events) ??
      connectHostTcp(address, hostPorts.get(port) ?? port, events)
    )
  }
  const reportOf = (ports: ReadonlyArray<GuestPort>): ReadonlyArray<OpenPort> =>
    ports.map(({ port, addresses }) => ({ port, addresses: [...addresses], process: "bun server" }))
  let reported = reportOf(options.ports)
  /** Reports the ports of each Session watched, on its Runner's link. */
  const watched = new Map<SessionId, () => Promise<void>>()
  // Every Session's Sandbox has the ports open as it starts.
  const openPorts = Layer.effect(
    OpenPorts,
    Effect.map(HubLink, (hubLink) => {
      const report = (sessionId: SessionId) =>
        hubLink.send(RunnerToHub.cases.SessionPorts.make({ sessionId, ports: [...reported] }))
      return OpenPorts.of({
        watch: (sessionId) =>
          Effect.andThen(
            Effect.sync(() => watched.set(sessionId, () => Effect.runPromise(report(sessionId)))),
            report(sessionId),
          ),
        unwatch: (sessionId) => Effect.sync(() => void watched.delete(sessionId)),
        resendAll: Effect.void,
      })
    }),
  )
  const dir = sceneDir()
  const fakeClaude = join(dir, "fake-claude")
  const sessionsRoot = join(dir, `sessions-${Date.now()}`)
  const layer = TunnelsLive.pipe(
    Layer.provideMerge(SessionsLive.pipe(Layer.provide(openPorts))),
    Layer.provide(
      Layer.succeed(SandboxBackend, SandboxBackend.of({ ...makeFake().backend, connectTcp })),
    ),
    Layer.provideMerge(HubGitLive),
    Layer.provideMerge(HubVariablesLive),
    Layer.provideMerge(HubClaudeCredentialLive),
    Layer.provideMerge(HubLinkLive),
    Layer.provideMerge(StaticClaudeModels(undefined)),
    Layer.provide([
      Layer.succeed(
        Tmux,
        Tmux.of({
          ...makeTmux(
            hostTmuxBackend({ socket: tmuxSocket, paths: { [workspaceGuestPath]: dir } }),
          ),
          retireHostServer: Effect.void,
        }),
      ),
      new FakeWorkspaces(sessionsRoot).layer,
      new FakeSandboxes(fakeClaude).layer,
      new FakeWorkspaceGit().layer,
      new FakeCredentialProxy().layer,
    ]),
    Layer.provideMerge(
      Layer.succeed(
        RunnerConfig,
        RunnerConfig.of({
          hubUrl: new URL(hub.url),
          name: "mac",
          token: Redacted.make(token),
          sessionsRoot,
          modDir: writeFakeMod(join(dir, "mod")),
          tmuxSocket,
          repoUrlTemplate: "unused",
        }),
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(BunServices.layer, BunSocket.layerWebSocketConstructor)),
    Layer.merge(Updater.manual()),
  )
  runners.push(
    Effect.runFork(
      runRunner().pipe(
        Effect.provide(layer),
        Effect.provideService(References.MinimumLogLevel, "None"),
      ),
    ),
  )

  const cookie = cookieFrom(await devSignIn(hub, "alice"))
  await seedEnvironment(hub, "acme/app", "dev:alice")
  const web = await Web.open(hub, cookie)
  webs.push(web)
  await web.next(
    "RunnerList",
    (message) => Array.isArray(message["runners"]) && message["runners"].length > 0,
  )
  // A fake Claude credential, which the Runner, having none of its own, starts the Session on.
  web.send({
    _tag: "SetClaudeCredential",
    requestId: "r-0",
    secret: "sk-ant-oat01-FAKE_TOKEN_FOR_TESTS_ONLY_9f3b",
    plan: "max5x",
  })
  await web.next("ClaudeCredentialState", (message) => message["requestId"] === "r-0")
  web.send({ _tag: "CreateSession", requestId: "r-1", repo: "acme/app", baseBranch: "main" })
  const created = await web.next("SessionCreated")
  const sessionId = (created["session"] as { id: SessionId }).id
  const isActive = (message: Tagged) => {
    const session = message["session"] as { state: string; openPorts?: Array<unknown> }
    return session.state === "Active" && (reported.length === 0 || session.openPorts !== undefined)
  }
  await web.next("SessionUpdated", isActive, 10_000)
  return {
    hub,
    cookie,
    web,
    sessionId,
    connects,
    tunnelUrl: (port) => `${hub.url.replace(/^http/, "ws")}${tunnelPath(sessionId, port)}`,
    headers: { cookie },
    setPorts: async (ports) => {
      hostPorts.clear()
      for (const port of ports) hostPorts.set(port.port, port.hostPort)
      reported = reportOf(ports)
      await Promise.all([...watched.values()].map((report) => report()))
    },
    cliToken: async (login, machine) => {
      const signedIn = await hub.run(
        Effect.gen(function* () {
          const cli = yield* CliTokens
          const verifier = "v".repeat(43)
          const who = Participant.make({
            id: ParticipantId.make(`dev:${login}`),
            login,
            name: login,
          })
          const { code } = yield* cli.approve(who, machine, pkceChallenge(verifier))
          return yield* cli.redeem(code, verifier)
        }),
      )
      return signedIn.token
    },
  }
}

/** A client's tunnel: its socket's end, what came through it, and how it closed. */
export interface TunnelClient {
  readonly end: TunnelEnd
  /** How many bytes came. */
  readonly received: () => number
  /** Everything that came, joined. */
  readonly bytes: () => Uint8Array
  readonly opened: Promise<void>
  /** Settles when the other side says it sends no more. */
  readonly eof: Promise<void>
  readonly closed: Promise<{ readonly code: number; readonly reason: string }>
}

/**
 * Opens a tunnel at `url`. `read` takes each chunk as it comes: its promise holds back the
 * acknowledgement, and so the sender, as a slow reader would.
 */
export function openTunnel(
  url: string,
  headers: Record<string, string>,
  read?: (bytes: Uint8Array) => void | Promise<void>,
): TunnelClient {
  const socket = new WebSocket(url, { headers })
  const chunks: Array<Uint8Array> = []
  let received = 0
  const eof = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<{ readonly code: number; readonly reason: string }>()
  const end = new TunnelEnd(socket, {
    data: (bytes) => {
      chunks.push(bytes.slice())
      received += bytes.byteLength
      return read?.(bytes)
    },
    eof: () => eof.resolve(),
    closed: (code, reason) => closed.resolve({ code, reason }),
  })
  return {
    end,
    received: () => received,
    bytes: () => Buffer.concat(chunks),
    opened: new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve())
      socket.addEventListener("close", () => reject(new Error("the tunnel closed unopened")))
    }),
    eof: eof.promise,
    closed: closed.promise,
  }
}

/** How each tunnel a {@link forwardLocally} listener opened closed. */
export interface ForwardedClose {
  readonly code: number
  readonly reason: string
}

/**
 * Listens on 127.0.0.1 and carries each connection through a tunnel of its own to `url`, as
 * `kndl forward` will: so a test can `fetch` a server in the Sandbox, or open a WebSocket
 * to it.
 */
export async function forwardLocally(url: string, headers: Record<string, string>) {
  const closes: Array<ForwardedClose> = []
  const server = createServer({ allowHalfOpen: true }, (local) => {
    let paused = false
    const end = new TunnelEnd(new WebSocket(url, { headers }), {
      data: (bytes) =>
        new Promise<void>((resolve) => {
          if (local.destroyed || local.write(bytes)) return resolve()
          local.once("drain", resolve)
          local.once("close", resolve)
        }),
      eof: () => void local.end(),
      closed: (code, reason) => {
        closes.push({ code, reason })
        local.destroy()
      },
      drained: () => {
        if (!paused) return
        paused = false
        local.resume()
      },
    })
    local.on("data", (data: Buffer) => {
      if (end.send(new Uint8Array(data))) return
      paused = true
      local.pause()
    })
    local.on("end", () => end.end())
    local.on("close", () => end.close())
    local.on("error", () => {})
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("expected a TCP address")
  const forward = { port: address.port, closes, stop: () => void server.close() }
  listeners.push(forward)
  return forward
}
