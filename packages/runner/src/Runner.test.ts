// The Runner against a fake Hub WebSocket server, with tmux, the Workspace and the Sandbox faked.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, readlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, posix } from "node:path"
import { BunServices, BunSocket } from "@effect/platform-bun"
import { ConversationId, ProtocolVersion, SessionId, TestBuildId } from "@kndl/protocol"
import { readBuildVersion } from "@kndl/protocol/checkout"
import type { ServerWebSocket } from "bun"
import { Context, Effect, Fiber, Layer, Redacted, References } from "effect"
import { KeptOutOfClaude } from "./ClaudeEnvironment.ts"
import { type ClaudeModels, StaticClaudeModels } from "./ClaudeModels.ts"
import { HubClaudeCredentialLive } from "./HubClaudeCredential.ts"
import { HubGit, HubGitLive } from "./HubGit.ts"
import { HubLinkLive } from "./HubLink.ts"
import { HubVariablesLive } from "./HubVariables.ts"
import { type PiBundle, StaticPiBundle } from "./PiBundle.ts"
import { runRunner } from "./Runner.ts"
import { RunnerConfig, type RunnerSettings } from "./RunnerConfig.ts"
import { modGuestPath } from "./sandbox/SessionLayout.ts"
import { SessionsLive } from "./Sessions.ts"
import {
  eventually,
  FakeModRelay,
  fakeSandboxClaudePath,
  fakeSandboxNodePath,
  FakeOpenPorts,
  FakeSandboxes,
  FakeTmux,
  FakeWorkspaces,
  sessionId,
  writeFakeMod,
} from "./testSupport.ts"
import { Tunnels } from "./Tunnels.ts"
import { Updater } from "./Updater.ts"

const token = "chr_test.secret"

/** The Creator's setup token the fake Hub hands out: fake, valid nowhere. */
const setupToken = "sk-ant-oat01-FAKE_TOKEN_FOR_TESTS_ONLY_9f3b"

/** What the Runner's Claude Code takes, as it says in its hello (#128). */
const models = {
  default: { alias: "default", id: "claude-opus-5-5", label: "Opus 5.5", reasoning: true },
  models: [{ alias: "sonnet", id: "claude-sonnet-5-5", label: "Sonnet 5.5", reasoning: true }],
  thinkingLevels: ["low", "medium", "high"],
} as const

/** The pi bundle the Runner has ready, unless a test says it has none. */
const piReady = { nodeModules: "/opt/kndl/pi/pi-1.3.0-abc/node_modules" }

/** A message the fake Hub received. */
interface Received {
  readonly _tag: string
  readonly [key: string]: unknown
}

/** A Hub that welcomes any Runner with the right token, and records what each connection got. */
class FakeHub {
  readonly connections: Array<{ socket: ServerWebSocket; received: Array<Received> }> = []
  readonly authorizations: Array<string | null> = []
  /** Answers the next upgrades with 401, as for a bad token. */
  refuseNext = 0
  /**
   * What the Hub answers a FetchClaudeCredential with, but for its requestId: by default, the
   * Session's Creator's setup token, a fake one.
   */
  claudeCredential: Record<string, unknown> = {
    _tag: "ClaudeCredentialFetched",
    credential: { _tag: "OAuthToken", token: setupToken },
  }
  /** Set to keep the welcome back from the next hellos, until {@link welcome}. */
  holdWelcome = false
  private readonly held: Array<{ socket: ServerWebSocket; hello: Received }> = []
  /** What the Hub answers a hello with. */
  answer: (hello: Received) => unknown = () => ({
    _tag: "RunnerWelcome",
    protocolVersion: ProtocolVersion,
    runnerId: "runner-1",
  })

  readonly server = Bun.serve({
    port: 0,
    fetch: (request, server) => {
      this.authorizations.push(request.headers.get("authorization"))
      const authorized = request.headers.get("authorization") === `Bearer ${token}`
      if (this.refuseNext > 0 || !authorized || new URL(request.url).pathname !== "/ws/runner") {
        this.refuseNext = Math.max(0, this.refuseNext - 1)
        return new Response("Unauthorized", { status: 401 })
      }
      return server.upgrade(request) ? undefined : new Response("no upgrade", { status: 400 })
    },
    websocket: {
      open: (socket) => {
        this.connections.push({ socket, received: [] })
      },
      message: (socket, data) => {
        const connection = this.connections.find((c) => c.socket === socket)
        const message = JSON.parse(String(data)) as Received
        connection?.received.push(message)
        if (message._tag === "RunnerHello") {
          if (this.holdWelcome) this.held.push({ socket, hello: message })
          else socket.send(JSON.stringify(this.answer(message)))
        }
        if (message._tag === "FetchClaudeCredential")
          socket.send(JSON.stringify({ ...this.claudeCredential, requestId: message["requestId"] }))
      },
    },
  })

  get url() {
    return new URL(`http://127.0.0.1:${this.server.port}`)
  }

  get current() {
    const connection = this.connections.at(-1)
    if (connection === undefined) throw new Error("no connection yet")
    return connection
  }

  /** Every message of `tag` on any connection. */
  all(tag: string): Array<Received> {
    return this.connections.flatMap((c) => c.received.filter((m) => m._tag === tag))
  }

  send(message: unknown): void {
    this.current.socket.send(JSON.stringify(message))
  }

  /** Answers the hellos held back, and those to come. */
  welcome(): void {
    this.holdWelcome = false
    for (const { socket, hello } of this.held.splice(0))
      socket.send(JSON.stringify(this.answer(hello)))
  }
}

interface Harness {
  readonly hub: FakeHub
  readonly tmux: FakeTmux
  readonly workspaces: FakeWorkspaces
  readonly sandboxes: FakeSandboxes
  readonly relay: FakeModRelay
  readonly openPorts: FakeOpenPorts
  /** The Runner's HubGit, once its layer is built. */
  readonly hubGit: () => HubGit["Service"]
  readonly runner: Fiber.Fiber<never, unknown>
  readonly settings: RunnerSettings
}

const running: Array<{ hub: FakeHub; runner: Fiber.Fiber<never, unknown> }> = []

afterEach(async () => {
  for (const { hub, runner } of running.splice(0)) {
    await Effect.runPromise(Fiber.interrupt(runner))
    hub.server.stop(true)
  }
})

/** An Updater that records what the connection asked of it. */
class FakeUpdater {
  readonly handled: Array<unknown> = []
  readonly rejected: Array<unknown> = []
  welcomed = 0
  readonly layer = Layer.succeed(
    Updater,
    Updater.of({
      hello: Effect.succeed({
        updater: { self: true },
        lastUpdate: {
          target: { commit: "b".repeat(40) },
          message: "Updating failed",
          rolledBack: true,
          at: 1,
        },
      }),
      boot: Effect.void,
      welcomed: Effect.sync(() => void this.welcomed++),
      handle: (message) => Effect.sync(() => void this.handled.push(message)),
      rejected: (hub) => Effect.sync(() => void this.rejected.push(hub)),
    }),
  )
}

/** The directory, on the host, of the Session's copy of the mod its agent was `launched` with. */
function sessionMod(h: Harness, launched: number) {
  const agent = h.tmux.launched[launched]?.argv[1] ?? ""
  return join(h.settings.sessionsRoot, "s-1", "mod", posix.relative(modGuestPath, agent), "..")
}

function startRunner(
  setup: (h: { hub: FakeHub; tmux: FakeTmux }) => void = () => {},
  updater: Layer.Layer<Updater> = Updater.manual(),
  claudeModels: Layer.Layer<ClaudeModels> = StaticClaudeModels(models),
  pi: Layer.Layer<PiBundle> = StaticPiBundle(piReady),
): Harness {
  const dir = mkdtempSync(join(tmpdir(), "kndl-runner-"))
  const sessionsRoot = join(dir, "sessions")
  const hub = new FakeHub()
  const tmux = new FakeTmux()
  setup({ hub, tmux })
  const sandboxes = new FakeSandboxes()
  const settings: RunnerSettings = {
    hubUrl: hub.url,
    name: "mac",
    token: Redacted.make(token),
    sessionsRoot,
    modDir: writeFakeMod(join(dir, "mod"), "built 1"),
    tmuxSocket: "unused",
    repoUrlTemplate: "unused",
  }
  return runOn(
    { hub, tmux, sandboxes, workspaces: new FakeWorkspaces(sessionsRoot), settings },
    updater,
    claudeModels,
    pi,
  )
}

/**
 * Restarts the Runner on the same machine, as `kndl restart` or a crash would: what runs in
 * tmux and the Sandboxes runs on, and the Hub is the same. The new Runner has a new mod relay:
 * only the old one's memory held its Session tokens.
 */
async function restartRunner(h: Harness): Promise<Harness> {
  await Effect.runPromise(Fiber.interrupt(h.runner))
  const connections = h.hub.connections.length
  const next = runOn(h)
  await eventually(
    () => h.hub.connections.length > connections && h.hub.current.received.length > 0,
  )
  return next
}

/** Runs a Runner on `machine`, with a mod relay of its own. */
function runOn(
  machine: Pick<Harness, "hub" | "tmux" | "sandboxes" | "workspaces" | "settings">,
  updater: Layer.Layer<Updater> = Updater.manual(),
  claudeModels: Layer.Layer<ClaudeModels> = StaticClaudeModels(models),
  pi: Layer.Layer<PiBundle> = StaticPiBundle(piReady),
): Harness {
  const { hub, tmux, sandboxes, workspaces, settings } = machine
  const relay = new FakeModRelay()
  const openPorts = new FakeOpenPorts()
  let hubGit: HubGit["Service"] | undefined
  const layer = SessionsLive.pipe(
    Layer.provide(openPorts.layer),
    Layer.provideMerge(Tunnels.refusing),
    Layer.provideMerge(
      HubGitLive.pipe(
        Layer.tap((context) => Effect.sync(() => void (hubGit = Context.get(context, HubGit)))),
      ),
    ),
    Layer.provideMerge(HubVariablesLive),
    Layer.provideMerge(HubClaudeCredentialLive),
    Layer.provideMerge(updater),
    Layer.provideMerge(HubLinkLive),
    Layer.provideMerge(claudeModels),
    Layer.provideMerge(pi),
    Layer.provide([tmux.layer, workspaces.layer, sandboxes.layer, relay.layer]),
    Layer.provideMerge(Layer.succeed(RunnerConfig, RunnerConfig.of(settings))),
    Layer.provideMerge(Layer.mergeAll(BunServices.layer, BunSocket.layerWebSocketConstructor)),
  )
  const runner = Effect.runFork(
    runRunner({
      backoff: { initial: "20 millis", max: "100 millis", rejected: "50 millis" },
    }).pipe(Effect.provide(layer), Effect.provideService(References.MinimumLogLevel, "None")),
  )
  running.push({ hub, runner })
  return {
    hub,
    tmux,
    workspaces,
    sandboxes,
    relay,
    openPorts,
    hubGit: () => {
      if (hubGit === undefined) throw new Error("the Runner's layer isn't built yet")
      return hubGit
    },
    runner,
    settings,
  }
}

const startSession = (id: string, extra: Record<string, unknown> = {}) => ({
  _tag: "StartSession",
  sessionId: id,
  repo: "acme/app",
  baseBranch: "main",
  workBranch: "claude/s-1",
  modToken: "chm_mod.secret",
  ...extra,
})

const buildVersion = readBuildVersion()

/** Waits for the welcome, so the Hub can send. */
const connected = (h: Harness) =>
  eventually(() => h.hub.connections.length > 0 && h.hub.current.received.length > 0)

describe("connecting", () => {
  test("says hello with the Runner token and its name, and no Claude credential of its own", async () => {
    const h = startRunner()
    await connected(h)

    expect(h.hub.authorizations).toEqual([`Bearer ${token}`])
    expect(h.hub.current.received[0]).toEqual({
      _tag: "RunnerHello",
      protocolVersion: ProtocolVersion,
      name: "mac",
      sessions: [],
      // The commit this checkout is at, when it is a git checkout (ADR 0011).
      ...(buildVersion !== undefined && { version: buildVersion }),
      // It asks how to clone each Test build (#104).
      asksCloneAccess: true,
      // Whether it updates itself when the Hub asks (#87).
      updater: { self: false, reason: "it runs in a test" },
      // What the Claude Code its agents' Claude bridge runs takes, and that it restarts an agent
      // on a new model (#128).
      models,
      // Every Session runs the durable agent, which is pi to the Hub, once its pi bundle is ready.
      harnesses: ["Pi"],
      relaunches: true,
      // It opens tunnels to a Session's Open ports (#177).
      forwardsPorts: true,
      // It gives Claude Code the MCP servers of its Session's Installations (#221).
      relaysMcpServers: true,
      measuresDisk: true,
    })
  })

  test("sends the Hub its host's sysinfo once it is welcomed, and again on every connection (#350)", async () => {
    const h = startRunner()
    await connected(h)

    await eventually(() => h.hub.current.received.some((m) => m._tag === "RunnerSysinfo"))
    const [hello, ...rest] = h.hub.current.received
    expect(hello).toMatchObject({ _tag: "RunnerHello" })
    expect(rest.find((m) => m._tag === "RunnerSysinfo")).toMatchObject({
      os: process.platform,
      arch: process.arch,
    })

    h.hub.current.socket.close(1001, "Hub restarting")
    await eventually(() => h.hub.connections.length === 2 && h.hub.all("RunnerSysinfo").length >= 2)
  })

  test("leaves the models out of its hello when Claude Code couldn't say", async () => {
    const h = startRunner(undefined, undefined, StaticClaudeModels(undefined))
    await connected(h)

    expect(h.hub.current.received[0]).not.toHaveProperty("models")
    expect(h.hub.current.received[0]).toMatchObject({ relaunches: true })
  })

  test("leaves its Harnesses out when its pi bundle isn't ready, as it runs no Sessions", async () => {
    const h = startRunner(undefined, undefined, undefined, StaticPiBundle(undefined))
    await connected(h)

    expect(h.hub.current.received[0]).toMatchObject({ _tag: "RunnerHello", models })
    expect(h.hub.current.received[0]).not.toHaveProperty("harnesses")
  })

  test("says in its hello that it updates itself, and how its last update failed", async () => {
    const updater = new FakeUpdater()
    const h = startRunner(undefined, updater.layer)
    await connected(h)

    expect(h.hub.current.received[0]).toMatchObject({
      updater: { self: true },
      lastUpdate: { target: { commit: "b".repeat(40) }, rolledBack: true },
    })
    await eventually(() => updater.welcomed === 1)
  })

  test("hands the Hub's update messages to the Updater", async () => {
    const updater = new FakeUpdater()
    const h = startRunner(undefined, updater.layer)
    await connected(h)
    const target = { commit: "c".repeat(40), branch: "main" }
    h.hub.send({ _tag: "CheckUpdate", target })
    h.hub.send({ _tag: "ApplyUpdate", target })
    await eventually(() => updater.handled.length === 2)

    expect(updater.handled).toEqual([
      { _tag: "CheckUpdate", target },
      { _tag: "ApplyUpdate", target },
    ])
  })

  test("never hands the Updater a commit git could read as an option", async () => {
    const updater = new FakeUpdater()
    const h = startRunner(undefined, updater.layer)
    await connected(h)
    for (const commit of ["--upload-pack=touch /tmp/pwned", "c".repeat(12), "C".repeat(40)]) {
      h.hub.send({ _tag: "ApplyUpdate", target: { commit, branch: "main" } })
    }
    // A good message after them arrives, so the bad ones were read and dropped, not still queued.
    const target = { commit: "c".repeat(40), branch: "main" }
    h.hub.send({ _tag: "CheckUpdate", target })
    await eventually(() => updater.handled.length === 1)

    expect(updater.handled).toEqual([{ _tag: "CheckUpdate", target }])
  })

  test("retries with backoff while the Hub refuses the token", async () => {
    const h = startRunner(({ hub }) => {
      hub.refuseNext = 2
    })
    await connected(h)

    expect(h.hub.authorizations).toHaveLength(3)
  })

  test("never exits when the Hub rejects the handshake: tells the Updater the Hub's commit and retries", async () => {
    const hubVersion = { commit: "d".repeat(40), branch: "main" }
    const updater = new FakeUpdater()
    const h = startRunner(({ hub }) => {
      hub.answer = () => ({
        _tag: "HandshakeRejected",
        reason: "ProtocolVersionMismatch",
        protocolVersion: ProtocolVersion + 1,
        message: "Update the Runner.",
        hubVersion,
      })
    }, updater.layer)
    // A service would only restart a Runner that exits, in a loop: it keeps trying, slowly. Waits
    // for the second rejection itself: the Hub sees the second connection before the Runner has
    // read the answer to it.
    await eventually(() => updater.rejected.length >= 2)

    expect(h.hub.connections.length).toBeGreaterThanOrEqual(2)
    expect(updater.rejected.slice(0, 2)).toEqual([hubVersion, hubVersion])
    expect(h.runner.pollUnsafe()).toBeUndefined()
  })

  test("refuses a welcome from another protocol version, and keeps trying", async () => {
    const updater = new FakeUpdater()
    const h = startRunner(({ hub }) => {
      hub.answer = () => ({
        _tag: "RunnerWelcome",
        protocolVersion: ProtocolVersion + 1,
        runnerId: "r",
      })
    }, updater.layer)
    await eventually(() => h.hub.connections.length >= 2)

    // An older Hub says no commit: the Updater only says how to update by hand.
    expect(updater.rejected[0]).toBeUndefined()
    expect(updater.welcomed).toBe(0)
    expect(h.runner.pollUnsafe()).toBeUndefined()
  })

  test("starts with nothing running when no Sandbox is", async () => {
    const h = startRunner()
    await connected(h)

    expect(h.tmux.retired).toBe(1)
    expect(h.sandboxes.reconciled).toEqual([[]])
    expect(h.hub.current.received[0]).toMatchObject({ sessions: [] })
    expect(h.hub.current.received[0]).not.toHaveProperty("withoutModToken")
  })

  test("after a reconnect, lists running Sessions, snapshots them and sends what waited", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.send(startSession("s-1"))
    await eventually(() => h.hub.all("SessionStarted").length === 1)

    // The Session's agent exits while the Runner is between connections: it has said hello again,
    // and waits for the welcome.
    h.hub.holdWelcome = true
    h.hub.current.socket.close(1001, "Hub restarting")
    await eventually(() => h.hub.connections.length === 2 && h.hub.current.received.length > 0)
    h.tmux.agent("s-1").output("lost while disconnected")
    h.tmux.agent("s-1").exit(0)
    await eventually(() => h.sandboxes.calls.includes("stop s-1 Sleep"))
    h.hub.welcome()
    await eventually(() => h.hub.current.received.some((m) => m._tag === "SessionStopped"))

    const second = h.hub.current.received
    expect(second[0]).toMatchObject({ _tag: "RunnerHello" })
    expect(second.filter((m) => m._tag === "TerminalFrame")).toEqual([])
    expect(second.find((m) => m._tag === "SessionStopped")).toEqual({
      _tag: "SessionStopped",
      sessionId: "s-1",
      reason: "Exited",
      exitCode: 0,
      output: "lost while disconnected",
    })
  })
})

/** A Runner running Session s-1, and the Session token its agent holds. */
const withSession = async () => {
  const h = startRunner()
  await connected(h)
  h.hub.send(startSession("s-1"))
  await eventually(() => h.hub.all("SessionStarted").length === 1)
  const kept = h.tmux.launched[0]?.env["KNDL_MOD_TOKEN"] as string
  return { h, kept }
}

/** A RelaunchSession for Session s-1, resuming `resume`, on `model`, with `extra`. */
const relaunchSession = (
  resume: string,
  model: string,
  modToken = "chm_mod.second",
  extra: Record<string, unknown> = {},
) => ({
  _tag: "RelaunchSession",
  sessionId: "s-1",
  repo: "acme/app",
  workBranch: "claude/s-1",
  resume,
  modToken,
  harness: "Pi",
  model,
  ...extra,
})

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** A conversation the Hub knows Session s-1's by. */
const conversation = "3c1f6f0e-8a2b-4c7d-9e1f-2a3b4c5d6e7f"

describe("restarting under running Sessions (#157)", () => {
  test("keeps a running Session running, holding its Session token until the Hub sends a mod token", async () => {
    const { h, kept } = await withSession()
    const after = await restartRunner(h)

    // The agent runs on: nothing is started or stopped, and its terminal streams again.
    expect(h.hub.current.received[0]).toMatchObject({
      _tag: "RunnerHello",
      sessions: ["s-1"],
      withoutModToken: ["s-1"],
    })
    expect(h.sandboxes.reconciled.at(-1)).toEqual([sessionId("s-1")])
    expect(h.sandboxes.calls).toEqual(["start s-1"])
    expect(h.tmux.launched).toHaveLength(1)
    expect(h.tmux.launchedTerminals).toHaveLength(1)
    await eventually(() =>
      h.hub.current.received.some((m) => m._tag === "TerminalFrame" && m.kind === "Snapshot"),
    )
    h.tmux.terminal("s-1").output("still here")
    await eventually(() => h.hub.current.received.some((m) => m.data === "still here"))

    // The token is held for s-1 alone: the agent is asked to retry, and nothing is relayed.
    const find = (presented: string) => Effect.runSync(after.relay.tokens.find(presented))
    expect(find(kept)).toBe("Held")
    expect(after.relay.grants).toEqual([])

    h.hub.send({ _tag: "ModTokenReissued", sessionId: "s-1", modToken: "chm_mod.reissued" })
    await eventually(() => h.sandboxes.calls.includes("keep s-1"))

    // The same token now stands for the new mod token, and no other token gets in.
    expect(find(kept)).toMatchObject({ sessionId: "s-1" })
    expect(Redacted.value(after.relay.grants[0]?.modToken as Redacted.Redacted)).toBe(
      "chm_mod.reissued",
    )
    expect(find(`${kept.slice(0, -1)}x`)).toBeUndefined()
    expect(h.tmux.launched).toHaveLength(1)
    expect(h.hub.all("SessionStopped")).toEqual([])
    // The agent runs on with the setup token it started with: none is fetched again.
    expect(h.hub.all("FetchClaudeCredential")).toHaveLength(1)

    // The next hello asks for nothing more.
    h.hub.current.socket.close(1001, "Hub restarting")
    await eventually(() => h.hub.connections.length === 3 && h.hub.current.received.length > 0)
    expect(h.hub.current.received[0]).toMatchObject({ sessions: ["s-1"] })
    expect(h.hub.current.received[0]).not.toHaveProperty("withoutModToken")
  })

  test("restarts a kept Session's agent on a new model in the Sandbox it took back", async () => {
    const { h } = await withSession()
    await restartRunner(h)
    h.hub.send({ _tag: "ModTokenReissued", sessionId: "s-1", modToken: "chm_mod.reissued" })
    await eventually(() => h.sandboxes.calls.includes("keep s-1"))

    h.hub.send(relaunchSession(conversation, "xai/grok-5", "chm_mod.third"))
    await eventually(() => h.hub.all("SessionStarted").length === 2)

    expect(h.tmux.launched[1]?.argv).toEqual(h.tmux.launched[0]?.argv.map(() => expect.any(String)))
    expect(h.tmux.launched[1]?.env).toMatchObject({ KNDL_MODEL: "xai/grok-5", KNDL_HARNESS: "Pi" })
    expect(h.sandboxes.calls).toEqual(["start s-1", "keep s-1"])
    // Its terminal, taken back as it was, stays.
    expect(h.tmux.launchedTerminals).toHaveLength(1)
  })

  test("keeps the tokens a kept Session's agent holds out of what it prints as it exits", async () => {
    const { h, kept } = await withSession()
    await restartRunner(h)
    h.tmux.agent("s-1").output(`${kept} ${setupToken}\r\n`)
    h.tmux.agent("s-1").exit(1)
    await eventually(() => h.hub.all("SessionStopped").length === 1)

    expect(h.hub.all("SessionStopped")[0]).toMatchObject({
      output: `${"*".repeat(kept.length)} ${"*".repeat(setupToken.length)}`,
    })
  })

  test("puts to sleep a Session whose agent exited while the Runner was down", async () => {
    const { h } = await withSession()
    await Effect.runPromise(Fiber.interrupt(h.runner))
    h.tmux.agent("s-1").exit(0)
    await restartRunner(h)

    // Its Sandbox is stopped, and the Hub has the Session Asleep once the hello leaves it out.
    expect(h.sandboxes.reconciled.at(-1)).toEqual([])
    expect(h.sandboxes.running.size).toBe(0)
    expect(h.hub.current.received[0]).toMatchObject({ sessions: [] })
    expect(h.hub.current.received[0]).not.toHaveProperty("withoutModToken")
  })

  test("keeps a Session whose terminal's tmux session is gone, with a new terminal", async () => {
    const { h } = await withSession()
    await Effect.runPromise(Fiber.interrupt(h.runner))
    h.tmux.killTerminal("s-1")
    await restartRunner(h)

    // Its agent runs on, so it is not put to sleep for it.
    expect(h.hub.current.received[0]).toMatchObject({ sessions: ["s-1"] })
    expect(h.sandboxes.reconciled.at(-1)).toEqual([sessionId("s-1")])
    expect(h.sandboxes.running.has(sessionId("s-1"))).toBe(true)
    expect(h.tmux.launchedTerminals).toHaveLength(2)
    expect(h.tmux.agent("s-1").terminated).toBe(false)
    h.hub.send({ _tag: "TerminalInput", sessionId: "s-1", data: "ls\r" })
    await eventually(() => h.tmux.terminal("s-1").inputs.length === 1)
  })

  test("puts to sleep a Session that ran a Harness from before the durable agent, to wake on it", async () => {
    const { h } = await withSession()
    await Effect.runPromise(Fiber.interrupt(h.runner))
    // A Runner from before the agent ran Claude Code or pi in the one tmux session: there is no
    // agent's to read a Session token from.
    h.tmux.agents.delete(sessionId("s-1"))
    await restartRunner(h)

    expect(h.sandboxes.reconciled.at(-1)).toEqual([])
    expect(h.hub.current.received[0]).toMatchObject({ sessions: [] })

    // The Hub wakes it on its next prompt: the agent starts as in a new Session.
    h.hub.send(startSession("s-1", { modToken: "chm_woken.secret", resume: conversation }))
    await eventually(() => h.hub.all("SessionStarted").length === 2)
    expect(h.tmux.launched[1]?.env["KNDL_CONVERSATION_ID"]).toBe(conversation)
  })

  test("ignores a mod token for a Session that wasn't waiting for one", async () => {
    const { h } = await withSession()
    h.hub.send({ _tag: "ModTokenReissued", sessionId: "s-1", modToken: "chm_mod.reissued" })
    h.hub.send({ _tag: "ModTokenReissued", sessionId: "s-2", modToken: "chm_mod.reissued" })
    h.hub.send({ _tag: "RequestTerminalSnapshot", sessionId: "s-1" })
    await eventually(() => h.hub.all("TerminalFrame").length === 2)

    expect(h.sandboxes.calls).toEqual(["start s-1"])
    expect(h.relay.grants.map((grant) => Redacted.value(grant.modToken))).toEqual([
      "chm_mod.secret",
    ])
  })
})

describe("Sessions", () => {
  test("starts the durable agent in its Sandbox's tmux, with the Session token and the Claude bridge, beside a shell for its terminal", async () => {
    const h = startRunner()
    await connected(h)
    const gitIdentity = { name: "Ada Lovelace", email: "1+ada@users.noreply.github.com" }
    h.hub.send(
      startSession("s-1", {
        gitIdentity,
        harness: "Pi",
        model: "openai/gpt-6-sol",
        thinkingLevel: "high",
      }),
    )
    await eventually(() => h.hub.all("SessionStarted").length === 1)

    const [spec] = h.tmux.launched
    expect(spec?.cwd).toBe("/workspace")
    expect(spec?.argv).toEqual([
      fakeSandboxNodePath,
      expect.stringMatching(new RegExp(`^${modGuestPath}/[0-9a-f]{8}/durable/agent\\.js$`)),
    ])
    const sessionToken = spec?.env["KNDL_MOD_TOKEN"] ?? ""
    expect(sessionToken).toStartWith("chp_")
    expect(spec?.env).toEqual({
      // What the Sandbox says the agent runs with.
      LANG: "C.UTF-8",
      // Its storage, on the Session's claude volume.
      KNDL_STATE_DIR: "/var/lib/kndl/claude",
      KNDL_SESSION_ID: "s-1",
      // A new conversation, which the agent says in its hello (#321).
      KNDL_CONVERSATION_ID: expect.stringMatching(uuid),
      KNDL_HARNESS: "Pi",
      KNDL_MODEL: "openai/gpt-6-sol",
      KNDL_THINKING: "high",
      // The mod relay, for the Hub, and the Session token for it: never the mod token (ADR 0026).
      KNDL_URL: "http://host.microsandbox.internal:7778",
      KNDL_MOD_TOKEN: sessionToken,
      // The Creator's Claude credential, for the Claude bridge, which runs the pinned Claude Code.
      KNDL_CLAUDE_CODE: fakeSandboxClaudePath,
      CLAUDE_CONFIG_DIR: "/var/lib/kndl/claude",
      IS_SANDBOX: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_OAUTH_TOKEN: setupToken,
    })
    // Kept out even where the tmux server has them.
    expect(spec?.unset).toEqual(KeptOutOfClaude)
    expect(h.hub.all("FetchClaudeCredential")).toEqual([
      { _tag: "FetchClaudeCredential", requestId: expect.any(String), sessionId: "s-1" },
    ])
    expect(JSON.stringify(spec)).not.toContain("chm_mod.secret")

    // The Session's copy of the mod holds the agent the Runner's mod built, which finds pi's
    // packages through the bundle's node_modules, where the Sandbox mounts it.
    const mod = sessionMod(h, 0)
    expect(readFileSync(join(mod, "agent.js"), "utf8")).toBe("// agent built 1\n")
    expect(readlinkSync(join(mod, "node_modules"))).toBe(piReady.nodeModules)

    // The terminal is a shell in the Workspace, with the Sandbox's environment and none of the
    // agent's secrets.
    expect(h.tmux.launchedTerminals).toEqual([
      {
        sessionId: sessionId("s-1"),
        cwd: "/workspace",
        env: { LANG: "C.UTF-8" },
        size: { cols: 120, rows: 40 },
      },
    ])
    expect(JSON.stringify(h.tmux.launchedTerminals)).not.toContain(sessionToken)
    expect(JSON.stringify(h.tmux.launchedTerminals)).not.toContain(setupToken)

    expect(h.workspaces.prepared).toMatchObject([{ sessionId: "s-1", workBranch: "claude/s-1" }])
    expect(h.sandboxes.calls).toEqual(["start s-1"])
    // With the git identity the Hub sent.
    expect(h.sandboxes.targets).toEqual([{ repo: "acme/app", gitIdentity }])

    // A snapshot of the terminal first, then output as it comes.
    h.tmux.terminal("s-1").output("hello")
    await eventually(() => h.hub.all("TerminalFrame").length === 2)
    expect(h.hub.all("TerminalFrame").map((f) => [f.kind, f.data])).toEqual([
      ["Snapshot", "screen of s-1"],
      ["Output", "hello"],
    ])
  })

  test("runs the durable agent whatever Harness the Hub names", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.send(startSession("s-1", { harness: "ClaudeCode" }))
    h.hub.send(startSession("s-2"))
    await eventually(() => h.hub.all("SessionStarted").length === 2)

    for (const spec of h.tmux.launched) {
      expect(spec.argv[1]).toEndWith("/durable/agent.js")
      expect(spec.env["KNDL_HARNESS"]).toBe("Pi")
    }
    // A relaunch onto Claude Code runs the agent again, in the same Sandbox.
    h.hub.send(
      relaunchSession(conversation, "anthropic/claude-opus-5-5", "chm_mod.second", {
        harness: "ClaudeCode",
      }),
    )
    await eventually(() => h.hub.all("SessionStarted").length === 3)
    expect(h.tmux.launched[2]?.argv[1]).toEndWith("/durable/agent.js")
    expect(h.tmux.launched[2]?.env["KNDL_HARNESS"]).toBe("Pi")
    expect(h.sandboxes.calls).toEqual(["start s-1", "start s-2"])
  })

  test("starts the agent without Claude's Models when the Hub refuses the Claude credential", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.claudeCredential = {
      _tag: "ClaudeCredentialRefused",
      message: "Ada has no Claude setup token.",
    }
    h.sandboxes.piEnv = { LANG: "C.UTF-8", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-a-Variable" }
    h.hub.send(startSession("s-1"))
    await eventually(() => h.hub.all("SessionStarted").length === 1)

    // Claude's Models just aren't there: no setup token, not even a Variable's, and no bridge.
    const env = h.tmux.launched[0]?.env ?? {}
    expect(Object.keys(env).filter((name) => name.includes("CLAUDE"))).toEqual([])
    expect(env).not.toHaveProperty("IS_SANDBOX")
    expect(h.tmux.launched[0]?.unset).toEqual([...KeptOutOfClaude, "CLAUDE_CODE_OAUTH_TOKEN"])
    expect(h.hub.all("SessionStartFailed")).toEqual([])
  })

  test("gives the agent its Installations' MCP servers, for it to add at the Gateway (ADR 0020)", async () => {
    const h = startRunner()
    await connected(h)
    const mcpServers = [{ installationId: "inst-1", server: "docs" }]
    h.hub.send(startSession("s-1", { mcpServers }))
    await eventually(() => h.hub.all("SessionStarted").length === 1)

    const env = h.tmux.launched[0]?.env ?? {}
    expect(JSON.parse(env["KNDL_MCP_SERVERS"] ?? "null")).toEqual(mcpServers)
    // The Session token alone reaches them, by the variable the launch sets for the mod relay.
    expect(env["KNDL_MCP_SERVERS"]).not.toContain("chm_mod.secret")
  })

  test("fails a start, before its Sandbox starts, when the Runner has no pi bundle", async () => {
    const h = startRunner(undefined, undefined, undefined, StaticPiBundle(undefined))
    await connected(h)
    h.hub.send(startSession("s-1"))
    await eventually(() => h.hub.all("SessionStartFailed").length === 1)

    expect(h.hub.all("SessionStartFailed")[0]).toMatchObject({
      message: expect.stringContaining("can't run Sessions"),
    })
    expect(h.tmux.launched).toEqual([])
    expect(h.tmux.launchedTerminals).toEqual([])
    expect(h.workspaces.prepared).toEqual([])
  })

  test("restarts the agent alone on a new model, keeping its Sandbox and its terminal (#128)", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.send(startSession("s-1"))
    await eventually(() => h.hub.all("SessionStarted").length === 1)
    const first = h.tmux.agent("s-1")
    const terminal = h.tmux.terminal("s-1")

    h.hub.send({
      ...relaunchSession(conversation, "anthropic/claude-opus-5-5"),
      thinkingLevel: "max",
    })
    await eventually(() => h.hub.all("SessionStarted").length === 2)

    // SIGTERM, so it closes its storage, and its tmux session alone is killed.
    expect(first.terminated).toBe(true)
    expect(h.tmux.killedAgents).toEqual([sessionId("s-1")])
    const relaunched = h.tmux.launched[1]
    expect(relaunched?.cwd).toBe("/workspace")
    expect(relaunched?.argv[0]).toBe(fakeSandboxNodePath)
    expect(relaunched?.env).toMatchObject({
      KNDL_MODEL: "anthropic/claude-opus-5-5",
      KNDL_THINKING: "max",
      KNDL_CONVERSATION_ID: conversation,
      CLAUDE_CODE_OAUTH_TOKEN: setupToken,
    })
    // A new Session token, for the new mod token.
    expect(relaunched?.env["KNDL_MOD_TOKEN"]).toStartWith("chp_")
    expect(relaunched?.env["KNDL_MOD_TOKEN"]).not.toBe(h.tmux.launched[0]?.env["KNDL_MOD_TOKEN"])
    // The Sandbox, the Workspace and the terminal are left as they are.
    expect(h.sandboxes.calls).toEqual(["start s-1"])
    expect(h.workspaces.prepared).toHaveLength(1)
    expect(h.tmux.launchedTerminals).toHaveLength(1)
    expect(h.tmux.terminal("s-1")).toBe(terminal)
    // Its exit was asked for, so it isn't reported as the agent exiting on its own.
    expect(h.hub.all("SessionStopped")).toEqual([])

    // The terminal streams on, and the new agent's exit is watched as the first's was.
    terminal.output("still here")
    await eventually(() => h.hub.all("TerminalFrame").some((frame) => frame.data === "still here"))
    h.tmux.agent("s-1").exit(1)
    await eventually(() => h.hub.all("SessionStopped").length === 1)
    expect(h.hub.all("SessionStopped")[0]).toMatchObject({ reason: "Exited", exitCode: 1 })
  })

  test("never lets an earlier agent's queued exit stop its replacement", async () => {
    const h = startRunner()
    h.openPorts.watchTakes = "300 millis"
    await connected(h)
    h.hub.send(startSession("s-1"))
    await eventually(() => h.openPorts.calls.includes("watch s-1"))
    // The first start still holds the Session lock. Queue a relaunch ahead of its exit cleanup.
    h.hub.send(relaunchSession(conversation, "xai/grok-5"))
    await Bun.sleep(30)
    h.tmux.agent("s-1").exit(1)
    await eventually(() => h.hub.all("SessionStarted").length === 2)
    await Bun.sleep(50)

    expect(h.tmux.launched).toHaveLength(2)
    expect(h.tmux.agent("s-1").exited).toBe(false)
    expect(h.sandboxes.calls).toEqual(["start s-1"])
    expect(h.hub.all("SessionStopped")).toEqual([])
    expect(h.hub.all("SessionStartFailed")).toEqual([])
    h.tmux.agent("s-1").exit(2)
    await eventually(() => h.hub.all("SessionStopped").length === 1)
    expect(h.hub.all("SessionStopped")[0]).toMatchObject({ reason: "Exited", exitCode: 2 })
  })

  test("keeps the mod a Session's agent started with until it starts again (#159)", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.send(startSession("s-1"))
    await eventually(() => h.hub.all("SessionStarted").length === 1)
    const agentOf = (launched: number) =>
      readFileSync(join(sessionMod(h, launched), "agent.js"), "utf8")
    expect(agentOf(0)).toBe("// agent built 1\n")

    // An update builds the Runner's mod anew while the agent runs: its copy is left alone.
    writeFakeMod(h.settings.modDir, "built 2")
    expect(agentOf(0)).toBe("// agent built 1\n")

    // The agent starts again on a new copy, of the new mod, under a new name.
    h.hub.send(relaunchSession(conversation, "openai/gpt-6-sol"))
    await eventually(() => h.hub.all("SessionStarted").length === 2)
    expect(h.tmux.launched[1]?.argv[1]).not.toBe(h.tmux.launched[0]?.argv[1])
    expect(agentOf(1)).toBe("// agent built 2\n")
    // The old copy is gone.
    expect(readdirSync(join(h.settings.sessionsRoot, "s-1", "mod"))).toHaveLength(1)
  })

  test("says a relaunch failed when the agent wasn't running", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.send(relaunchSession(conversation, "openai/gpt-6-sol"))
    await eventually(() => h.hub.all("SessionStartFailed").length === 1)

    expect(h.tmux.launched).toEqual([])
  })

  test("fails a relaunch whose agent can't be copied, leaving the Session asleep", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.send(startSession("s-1"))
    await eventually(() => h.hub.all("SessionStarted").length === 1)
    // The Runner's mod is gone, as in the middle of a rebuild.
    const mod = h.settings.modDir
    await Bun.$`rm -rf ${mod}/durable`.quiet()

    h.hub.send(relaunchSession(conversation, "openai/gpt-6-sol"))
    await eventually(() => h.hub.all("SessionStartFailed").length === 1)

    expect(h.hub.all("SessionStartFailed")[0]).toMatchObject({
      sessionId: "s-1",
      message: expect.stringContaining("could not copy the mod"),
    })
    expect(h.tmux.launched).toHaveLength(1)
    expect(h.tmux.terminals.size).toBe(0)
    expect(h.sandboxes.calls).toEqual(["start s-1", "stop s-1 Sleep"])
    expect(h.relay.calls).toContain("revoke s-1")
  })

  test("keeps out of the agent the variables that would sign Claude Code in another way, or send it elsewhere", async () => {
    const h = startRunner()
    await connected(h)
    h.sandboxes.piEnv = {
      LANG: "C.UTF-8",
      ANTHROPIC_API_KEY: "sk-ant-api03-FAKE_KEY_FOR_TESTS_ONLY",
      ANTHROPIC_BASE_URL: "https://elsewhere.example",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-FROM_A_VARIABLE",
      DATABASE_URL: "postgres://db",
    }
    h.hub.send(startSession("s-1"))
    await eventually(() => h.hub.all("SessionStarted").length === 1)

    const env = h.tmux.launched[0]?.env ?? {}
    for (const name of KeptOutOfClaude) expect(env).not.toHaveProperty(name)
    // The launch's setup token wins over a Variable's, and other Variables are left as they are.
    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe(setupToken)
    expect(env["DATABASE_URL"]).toBe("postgres://db")
    // The terminal is the person's own: it gets the Variables as they are.
    expect(h.tmux.launchedTerminals[0]?.env).toEqual(h.sandboxes.piEnv)
  })

  test("wakes the agent with the conversation the Hub names, as its storage resumes it", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.send(startSession("s-1", { resume: "claude-conversation-" }))
    await eventually(() => h.hub.all("SessionStarted").length === 1)

    // Whatever its id: the agent's state is its storage, not the conversation's id.
    expect(h.tmux.launched[0]?.env["KNDL_CONVERSATION_ID"]).toBe("claude-conversation-")
    expect(h.tmux.launched[0]?.argv).toHaveLength(2)
    expect(h.hub.all("SandboxNote")).toEqual([])
  })

  test("reports a start that failed and leaves nothing running", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.send(startSession("s-1", { repo: "broken/repo" }))
    await eventually(() => h.hub.all("SessionStartFailed").length === 1)

    expect(h.hub.all("SessionStartFailed")[0]).toEqual({
      _tag: "SessionStartFailed",
      sessionId: "s-1",
      message: "could not clone broken/repo",
    })
    expect(h.tmux.launched).toEqual([])
    expect(h.sandboxes.calls).toEqual(["stop s-1 Sleep"])
  })

  test("refuses a Session id it can't name a directory after", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.send(startSession("../escape"))
    await eventually(() => h.hub.all("SessionStartFailed").length === 1)

    expect(h.workspaces.prepared).toEqual([])
  })

  test("starting a running Session again only says it started", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.send(startSession("s-1"))
    h.hub.send(startSession("s-1"))
    await eventually(() => h.hub.all("SessionStarted").length === 2)

    expect(h.tmux.launched).toHaveLength(1)
    expect(h.tmux.launchedTerminals).toHaveLength(1)
  })

  test("says which Environment version a Session's Sandbox runs", async () => {
    const h = startRunner()
    await connected(h)
    const environment = {
      version: 4,
      buildVersion: 3,
      recipe: {
        image: "node:22",
        bootstrapScript: "",
        docker: false,
        dependencyFolders: [],
        resources: { cpus: 2, memoryMib: 2048 },
        variables: [],
      },
    }
    h.hub.send(startSession("s-1", { environment }))
    await eventually(() => h.hub.all("SessionStarted").length === 1)
    expect(h.hub.all("SessionStarted")[0]).toMatchObject({ environmentVersion: 4 })
    // Started again while running, it says so again.
    h.hub.send(startSession("s-1", { environment }))
    await eventually(() => h.hub.all("SessionStarted").length === 2)
    expect(h.hub.all("SessionStarted")[1]).toMatchObject({ environmentVersion: 4 })
  })

  test("runs a Test build, streaming its log, and reports how it ended", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.send({
      _tag: "RunTestBuild",
      testBuildId: "tb-1",
      repo: "acme/app",
      recipe: {
        image: "node:22",
        bootstrapScript: "true",
        docker: false,
        dependencyFolders: [],
        resources: { cpus: 2, memoryMib: 2048 },
        variables: [],
      },
    })
    await eventually(() => h.hub.all("TestBuildFinished").length === 1)
    expect(h.hub.all("TestBuildLog")).toEqual([
      expect.objectContaining({ testBuildId: "tb-1", data: "built\n" }),
    ])
    expect(h.hub.all("TestBuildFinished")[0]).toMatchObject({
      testBuildId: "tb-1",
      result: "Passed",
    })
  })

  test("applies terminal input, resizes and snapshot requests to the terminal", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.send(startSession("s-1"))
    await eventually(() => h.hub.all("SessionStarted").length === 1)

    h.hub.send({ _tag: "TerminalInput", sessionId: "s-1", data: "hi\r" })
    h.hub.send({ _tag: "TerminalResize", sessionId: "s-1", size: { cols: 100, rows: 30 } })
    h.hub.send({ _tag: "RequestTerminalSnapshot", sessionId: "s-1" })
    h.hub.send({ _tag: "TerminalInput", sessionId: "s-unknown", data: "ignored" })
    // The first snapshot is from attaching, the second from the resize, the third was asked for.
    await eventually(() => h.hub.all("TerminalFrame").length === 3)

    const terminal = h.tmux.terminal("s-1")
    expect(terminal.inputs).toEqual(["hi\r"])
    expect(terminal.resizes).toEqual([{ cols: 100, rows: 30 }])
    expect(h.hub.all("TerminalFrame").slice(1)).toMatchObject([
      { kind: "Snapshot", size: { cols: 100, rows: 30 } },
      { kind: "Snapshot", size: { cols: 100, rows: 30 } },
    ])
  })

  test("never takes the terminal going for the agent stopping", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.send(startSession("s-1"))
    await eventually(() => h.hub.all("SessionStarted").length === 1)

    // As though someone killed the shell's tmux session from inside it.
    h.tmux.terminal("s-1").detach()
    await Bun.sleep(50)

    expect(h.hub.all("SessionStopped")).toEqual([])
    expect(h.sandboxes.calls).toEqual(["start s-1"])
    expect(h.tmux.agent("s-1").terminated).toBe(false)
  })

  test("brings the terminal back when its tmux session is gone, while its agent runs", async () => {
    const { h } = await withSession()

    h.tmux.killTerminal("s-1")
    await eventually(() => h.tmux.launchedTerminals.length === 2)
    await eventually(() => h.tmux.terminals.get(sessionId("s-1"))?.attached === true)

    // The Session goes on: its input reaches the new terminal, and what it prints, the Hub.
    h.hub.send({ _tag: "TerminalInput", sessionId: "s-1", data: "ls\r" })
    await eventually(() => h.tmux.terminal("s-1").inputs.length === 1)
    await eventually(() =>
      h.hub
        .all("TerminalFrame")
        .some((frame) => frame.sessionId === "s-1" && frame.kind === "Snapshot"),
    )
    h.tmux.terminal("s-1").output("back")
    await eventually(() => h.hub.current.received.some((m) => m.data === "back"))
    expect(h.tmux.terminal("s-1").inputs).toEqual(["ls\r"])
    expect(h.hub.all("SessionStopped")).toEqual([])
    expect(h.tmux.agent("s-1").terminated).toBe(false)
  })

  test("doesn't bring a stopped Session's terminal back", async () => {
    const { h } = await withSession()
    h.hub.send({ _tag: "StopSession", sessionId: "s-1", reason: "Sleep" })
    await eventually(() => h.hub.all("SessionStopped").length === 1)
    await Bun.sleep(1_300)

    expect(h.tmux.launchedTerminals).toHaveLength(1)
    expect(h.tmux.terminals.size).toBe(0)
  })

  test("stops a Session when asked: its agent with SIGTERM, then both tmux sessions and its Sandbox", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.send(startSession("s-1"))
    await eventually(() => h.hub.all("SessionStarted").length === 1)
    const agent = h.tmux.agent("s-1")

    h.hub.send({ _tag: "StopSession", sessionId: "s-1", reason: "Archive" })
    await eventually(() => h.hub.all("SessionStopped").length === 1)

    expect(agent.terminated).toBe(true)
    expect(h.hub.all("SessionStopped")).toEqual([
      { _tag: "SessionStopped", sessionId: "s-1", reason: "Requested", exitCode: 143 },
    ])
    expect(h.tmux.agents.size).toBe(0)
    expect(h.tmux.terminals.size).toBe(0)
    expect(h.sandboxes.calls).toEqual(["start s-1", "stop s-1 Archive"])
    // Nothing is pushed (#194): the Runner didn't even ask how to reach the Repo.
    expect(h.hub.all("GitRequest")).toEqual([])
  })

  test("kills both tmux sessions after the grace period when the agent ignores SIGTERM", async () => {
    const { h } = await withSession()
    const agent = h.tmux.agent("s-1")
    agent.ignoreTerminate = true
    const killed = h.tmux.killed.length
    h.hub.send({ _tag: "StopSession", sessionId: "s-1", reason: "Sleep" })
    await eventually(() => agent.terminated)
    expect(h.tmux.killed).toHaveLength(killed)
    expect(h.hub.all("SessionStopped")).toEqual([])
    await eventually(() => h.hub.all("SessionStopped").length === 1, 12_000)

    expect(h.tmux.killed).toHaveLength(killed + 1)
    expect(h.tmux.terminals.has(sessionId("s-1"))).toBe(false)
    expect(h.tmux.agents.has(sessionId("s-1"))).toBe(false)
    expect(h.sandboxes.calls).toEqual(["start s-1", "stop s-1 Sleep"])
    expect(h.hub.all("SessionStopped")).toEqual([
      { _tag: "SessionStopped", sessionId: "s-1", reason: "Requested" },
    ])
  }, 15_000)

  test("reports a running Session's Open ports, and none before it says it stopped (#175)", async () => {
    const h = startRunner()
    await connected(h)
    const ports = [{ port: 3000, addresses: ["0.0.0.0"], process: "node server" }]
    h.openPorts.ports.set(SessionId.make("s-1"), ports)
    h.hub.send(startSession("s-1"))
    await eventually(() => h.hub.all("SessionPorts").length === 1)
    expect(h.hub.all("SessionPorts")[0]).toEqual({ _tag: "SessionPorts", sessionId: "s-1", ports })

    h.hub.send({ _tag: "StopSession", sessionId: "s-1", reason: "Sleep" })
    await eventually(() => h.hub.all("SessionStopped").length === 1)

    const tags = h.hub.current.received.map((m) => m._tag)
    expect(tags.lastIndexOf("SessionPorts")).toBeLessThan(tags.indexOf("SessionStopped"))
    expect(h.hub.all("SessionPorts").at(-1)).toEqual({
      _tag: "SessionPorts",
      sessionId: "s-1",
      ports: [],
    })
    expect(h.openPorts.calls).toEqual(["watch s-1", "unwatch s-1"])
  })

  test("archives a stopped Session too, destroying what is left of its Sandbox", async () => {
    const h = startRunner()
    await connected(h)

    // As for a Session archived while Asleep, or while the Runner was offline.
    h.hub.send({ _tag: "StopSession", sessionId: "s-1", reason: "Archive" })
    await eventually(() => h.hub.all("SessionStopped").length === 1)

    expect(h.hub.all("SessionStopped")).toEqual([
      { _tag: "SessionStopped", sessionId: "s-1", reason: "Requested" },
    ])
    expect(h.sandboxes.calls).toEqual(["stop s-1 Archive"])
    expect(h.hub.all("GitRequest")).toEqual([])
  })

  test("purges a Session: its Sandbox and volumes, then its directory and Claude Code state", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.send(startSession("s-1"))
    await eventually(() => h.hub.all("SessionStarted").length === 1)
    h.hub.send({ _tag: "StopSession", sessionId: "s-1", reason: "Archive" })
    await eventually(() => h.hub.all("SessionStopped").length === 1)

    h.hub.send({ _tag: "PurgeSession", sessionId: "s-1" })
    await eventually(() => h.hub.all("SessionPurged").length === 1)

    expect(h.hub.all("SessionPurged")).toEqual([{ _tag: "SessionPurged", sessionId: "s-1" }])
    expect(h.sandboxes.calls).toEqual(["start s-1", "stop s-1 Archive", "purge s-1"])
    expect(h.workspaces.removed).toEqual([sessionId("s-1")])
  })

  test("stops a Session still running before purging it", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.send(startSession("s-1"))
    await eventually(() => h.hub.all("SessionStarted").length === 1)
    const agent = h.tmux.agent("s-1")

    h.hub.send({ _tag: "PurgeSession", sessionId: "s-1" })
    await eventually(() => h.hub.all("SessionPurged").length === 1)

    expect(agent.terminated).toBe(true)
    expect(h.tmux.agents.size).toBe(0)
    expect(h.tmux.terminals.size).toBe(0)
    // Purged, not exited on its own: nothing is pushed and no SessionStopped is sent.
    expect(h.hub.all("SessionStopped")).toEqual([])
    expect(h.sandboxes.calls).toEqual(["start s-1", "purge s-1"])
    expect(h.workspaces.removed).toEqual([sessionId("s-1")])
  })

  test("doesn't say a Session is purged when its files could not be deleted", async () => {
    const h = startRunner()
    await connected(h)
    h.workspaces.removeFails = true

    h.hub.send({ _tag: "PurgeSession", sessionId: "s-1" })
    await eventually(() => h.sandboxes.calls.includes("purge s-1"))
    await Bun.sleep(50)
    expect(h.hub.all("SessionPurged")).toEqual([])

    // The Hub asks again, as on the next connection.
    h.workspaces.removeFails = false
    h.hub.send({ _tag: "PurgeSession", sessionId: "s-1" })
    await eventually(() => h.hub.all("SessionPurged").length === 1)
    expect(h.workspaces.removed).toEqual([sessionId("s-1")])
  })

  test("measures the disk Sessions take: their directory and their Sandbox volumes (#352)", async () => {
    const h = startRunner()
    await connected(h)
    h.workspaces.usages.set(sessionId("s-1"), 1000)
    h.sandboxes.diskUsages.set(sessionId("s-1"), 500)
    h.workspaces.usages.set(sessionId("s-2"), 40)
    // An Archived Session has no volumes but Claude Code's, and one purged long ago has nothing.

    h.hub.send({ _tag: "MeasureSessionDisks", requestId: "d-1", sessionIds: ["s-1", "s-2", "s-3"] })
    await eventually(() => h.hub.all("SessionDisksMeasured").length === 1)

    expect(h.hub.all("SessionDisksMeasured")).toEqual([
      {
        _tag: "SessionDisksMeasured",
        requestId: "d-1",
        sizes: [
          { sessionId: "s-1", bytes: 1500 },
          { sessionId: "s-2", bytes: 40 },
          { sessionId: "s-3", bytes: 0 },
        ],
      },
    ])
  })

  test("leaves a size out when it can't measure a Session, or can't name its directory", async () => {
    const h = startRunner()
    await connected(h)
    h.workspaces.usages.set(sessionId("s-1"), 1000)
    h.sandboxes.diskUsageFails.add(sessionId("s-1"))
    h.workspaces.usages.set(sessionId("s-2"), 7)

    h.hub.send({
      _tag: "MeasureSessionDisks",
      requestId: "d-1",
      sessionIds: ["s-1", "../etc", "s-2"],
    })
    await eventually(() => h.hub.all("SessionDisksMeasured").length === 1)

    expect(h.hub.all("SessionDisksMeasured")[0]?.sizes).toEqual([
      { sessionId: "s-1" },
      { sessionId: "../etc" },
      { sessionId: "s-2", bytes: 7 },
    ])
  })

  test("ignores a purge of a Session id it can't name a directory after", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.send({ _tag: "PurgeSession", sessionId: "../etc" })
    h.hub.send({ _tag: "PurgeSession", sessionId: "s-2" })
    await eventually(() => h.hub.all("SessionPurged").length === 1)
    expect(h.hub.all("SessionPurged")).toEqual([{ _tag: "SessionPurged", sessionId: "s-2" }])
    expect(h.sandboxes.calls).toEqual(["purge s-2"])
  })

  test("puts a Session to sleep, keeping its Workspace and Sandbox, and wakes its agent on its model (#128)", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.send(startSession("s-1"))
    await eventually(() => h.hub.all("SessionStarted").length === 1)
    const agent = h.tmux.agent("s-1")

    h.hub.send({ _tag: "StopSession", sessionId: "s-1", reason: "Sleep" })
    await eventually(() => h.hub.all("SessionStopped").length === 1)
    expect(agent.terminated).toBe(true)
    expect(h.hub.all("SessionStopped")).toEqual([
      { _tag: "SessionStopped", sessionId: "s-1", reason: "Requested", exitCode: 143 },
    ])
    expect(h.tmux.agents.size).toBe(0)
    expect(h.tmux.terminals.size).toBe(0)
    // The Sandbox is stopped, not destroyed: its volumes, with the agent's storage, stay for the
    // wake. Nothing is pushed.
    expect(h.sandboxes.calls).toEqual(["start s-1", "stop s-1 Sleep"])
    expect(h.hub.all("GitRequest")).toEqual([])

    h.hub.send(
      startSession("s-1", {
        modToken: "chm_woken.secret",
        resume: conversation,
        model: "anthropic/claude-sonnet-5-5",
        thinkingLevel: "high",
      }),
    )
    await eventually(() => h.hub.all("SessionStarted").length === 2)
    expect(h.sandboxes.calls).toEqual(["start s-1", "stop s-1 Sleep", "start s-1"])
    expect(h.workspaces.prepared.map((start) => start.resume)).toEqual([
      undefined,
      ConversationId.make(conversation),
    ])
    const woken = h.tmux.launched[1]
    expect(woken?.cwd).toBe("/workspace")
    expect(woken?.argv).toHaveLength(2)
    expect(woken?.env).toMatchObject({
      KNDL_CONVERSATION_ID: conversation,
      KNDL_MODEL: "anthropic/claude-sonnet-5-5",
      KNDL_THINKING: "high",
      KNDL_STATE_DIR: "/var/lib/kndl/claude",
    })
    expect(woken?.env["KNDL_MOD_TOKEN"]).toStartWith("chp_")
    expect(h.tmux.launchedTerminals).toHaveLength(2)
    expect(h.hub.all("SandboxNote")).toEqual([])
  })

  test("leaves Sessions running in tmux when the Runner stops", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.send(startSession("s-1"))
    await eventually(() => h.hub.all("SessionStarted").length === 1)

    await Effect.runPromise(Fiber.interrupt(h.runner))

    expect([...h.tmux.agents.keys()]).toEqual([sessionId("s-1")])
    expect([...h.tmux.terminals.keys()]).toEqual([sessionId("s-1")])
    expect(h.tmux.agent("s-1").terminated).toBe(false)
    // Only the clean-up of leftovers before launching.
    expect(h.tmux.killed).toEqual([sessionId("s-1")])
    expect(h.sandboxes.calls).toEqual(["start s-1"])
  })

  test("reports a Session whose agent exited on its own, with what it printed, not the terminal", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.send(startSession("s-1"))
    await eventually(() => h.hub.all("SessionStarted").length === 1)

    // What it printed goes with it, read before its tmux session is killed, without its Session
    // token or its setup token; what the terminal shows doesn't.
    const sessionToken = h.tmux.launched[0]?.env["KNDL_MOD_TOKEN"] ?? ""
    h.tmux.terminal("s-1").output("$ ls\r\n")
    const agent = h.tmux.agent("s-1")
    agent.output("\u001b[31mError:\u001b[0m could not open its storage\r\n")
    agent.output(`token ${sessionToken}\r\n`)
    agent.output(`setup ${setupToken}\r\n`)
    agent.exit(1)
    await eventually(() => h.hub.all("SessionStopped").length === 1)

    expect(h.hub.all("SessionStopped")[0]).toEqual({
      _tag: "SessionStopped",
      sessionId: "s-1",
      reason: "Exited",
      exitCode: 1,
      output: `Error: could not open its storage\ntoken ${"*".repeat(sessionToken.length)}\nsetup ${"*".repeat(setupToken.length)}`,
    })
    expect(h.tmux.agents.size).toBe(0)
    expect(h.tmux.terminals.size).toBe(0)
    expect(h.sandboxes.calls).toEqual(["start s-1", "stop s-1 Sleep"])
    expect(h.hub.all("GitRequest")).toEqual([])

    // One that printed nothing sends no output.
    h.hub.send(startSession("s-2"))
    await eventually(() => h.hub.all("SessionStarted").length === 2)
    h.tmux.agent("s-2").exit(0)
    await eventually(() => h.hub.all("SessionStopped").length === 2)
    expect(h.hub.all("SessionStopped")[1]).toEqual({
      _tag: "SessionStopped",
      sessionId: "s-2",
      reason: "Exited",
      exitCode: 0,
    })
    expect(h.hub.all("SessionStopped")[1]).not.toHaveProperty("output")
  })

  test("asks the Hub git questions and matches its replies", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.send(startSession("s-1"))
    await eventually(() => h.hub.all("SessionStarted").length === 1)

    const asked = Effect.runPromise(h.hubGit().ask(sessionId("s-1"), { _tag: "SandboxToken" }))
    await eventually(() => h.hub.all("GitRequest").length === 1)
    const requestId = String(h.hub.all("GitRequest")[0]?.["requestId"])
    expect(h.hub.all("GitRequest")[0]).toMatchObject({
      sessionId: "s-1",
      ask: { _tag: "SandboxToken" },
    })
    h.hub.send({
      _tag: "GitReply",
      requestId: "someone-else",
      answer: { _tag: "GitFailed", message: "x" },
    })
    h.hub.send({
      _tag: "GitReply",
      requestId,
      answer: { _tag: "SandboxToken", token: "ghs_sandbox", expiresAt: 1_000 },
    })

    const answer = await asked
    expect(answer._tag === "SandboxToken" && Redacted.value(answer.token)).toBe("ghs_sandbox")
  })

  test("asks the Hub how to clone a Test build, and takes its reply", async () => {
    const h = startRunner()
    await connected(h)

    const asked = Effect.runPromise(h.hubGit().cloneAccess(TestBuildId.make("t-1")))
    await eventually(() => h.hub.all("FetchCloneAccess").length === 1)
    const request = h.hub.all("FetchCloneAccess")[0]
    expect(request).toMatchObject({ testBuildId: "t-1" })
    h.hub.send({
      _tag: "GitReply",
      requestId: String(request?.["requestId"]),
      answer: {
        _tag: "CloneAccess",
        credentials: { _tag: "CloneToken", token: "ghs_clone", expiresAt: 1_000 },
      },
    })

    const answer = await asked
    expect(
      answer._tag === "CloneAccess" &&
        answer.credentials._tag === "CloneToken" &&
        Redacted.value(answer.credentials.token),
    ).toBe("ghs_clone")
  })
})
