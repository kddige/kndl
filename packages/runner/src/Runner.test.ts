// The Runner against a fake Hub WebSocket server, with tmux, the Workspace and the Sandbox faked.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, posix } from "node:path"
import { BunServices, BunSocket } from "@effect/platform-bun"
import {
  ClaudeSessionId,
  type GatewayServer,
  ProtocolVersion,
  SessionId,
  TestBuildId,
} from "@kndl/protocol"
import { readBuildVersion } from "@kndl/protocol/checkout"
import type { ServerWebSocket } from "bun"
import { Context, Effect, Fiber, Layer, Redacted, References } from "effect"
import { gatewayMcpServers } from "./ClaudeLaunch.ts"
import { type ClaudeModels, StaticClaudeModels } from "./ClaudeModels.ts"
import { HubClaudeCredentialLive } from "./HubClaudeCredential.ts"
import { HubGit, HubGitLive } from "./HubGit.ts"
import { HubLinkLive } from "./HubLink.ts"
import { HubVariablesLive } from "./HubVariables.ts"
import { runRunner } from "./Runner.ts"
import { RunnerConfig, type RunnerSettings } from "./RunnerConfig.ts"
import { modGuestPath } from "./sandbox/SessionLayout.ts"
import { SessionsLive } from "./Sessions.ts"
import {
  eventually,
  FakeCredentialProxy,
  fakeSandboxClaudePath,
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

/** What the Runner's Claude Code takes, as it says in its hello (#128). */
const models = {
  default: { alias: "default", id: "claude-opus-5-5", label: "Opus 5.5", effort: true },
  models: [{ alias: "sonnet", id: "claude-sonnet-5-5", label: "Sonnet 5.5", effort: true }],
  efforts: ["low", "medium", "high"],
} as const

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
   * What the Hub answers a FetchClaudeCredential with, but for its requestId: by default, that
   * the Session's Creator has no Claude credential, so it runs on the Runner's own.
   */
  claudeCredential: Record<string, unknown> = { _tag: "ClaudeCredentialFetched" }
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
        if (message._tag === "RunnerHello") socket.send(JSON.stringify(this.answer(message)))
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
}

interface Harness {
  readonly hub: FakeHub
  readonly tmux: FakeTmux
  readonly workspaces: FakeWorkspaces
  readonly sandboxes: FakeSandboxes
  readonly proxy: FakeCredentialProxy
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

/** What the Session's copy of the mod that its Claude Code was `launched` with says. */
function sessionMod(h: Harness, launched: number) {
  const pluginDir = h.tmux.launched[launched]?.argv[4] ?? ""
  const copy = posix.relative(modGuestPath, posix.dirname(pluginDir))
  const hook = join(h.settings.sessionsRoot, "s-1", "mod", copy, "hub-link", "hooks", "hook.js")
  return readFileSync(hook, "utf8")
}

function startRunner(
  setup: (h: { hub: FakeHub; tmux: FakeTmux }) => void = () => {},
  updater: Layer.Layer<Updater> = Updater.manual(),
  claudeModels: Layer.Layer<ClaudeModels> = StaticClaudeModels(models),
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
  )
}

/**
 * Restarts the Runner on the same machine, as `kndl restart` or a crash would: what runs in
 * tmux and the Sandboxes runs on, and the Hub is the same. The new Runner has a new credential
 * proxy: only the old one's memory held its Session tokens.
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

/** Runs a Runner on `machine`, with a credential proxy of its own. */
function runOn(
  machine: Pick<Harness, "hub" | "tmux" | "sandboxes" | "workspaces" | "settings">,
  updater: Layer.Layer<Updater> = Updater.manual(),
  claudeModels: Layer.Layer<ClaudeModels> = StaticClaudeModels(models),
): Harness {
  const { hub, tmux, sandboxes, workspaces, settings } = machine
  const proxy = new FakeCredentialProxy()
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
    Layer.provide([tmux.layer, workspaces.layer, sandboxes.layer, proxy.layer]),
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
    proxy,
    openPorts,
    hubGit: () => {
      if (hubGit === undefined) throw new Error("the Runner's layer isn't built yet")
      return hubGit
    },
    runner,
    settings,
  }
}

/** Gives the Session a transcript of Claude Code's conversation `conversation`, as once it ran. */
function writeTranscript(h: Harness, conversation: string): void {
  h.sandboxes.transcripts.add(conversation)
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
  test("says hello with the Runner token, its name and its own Claude credential, here none", async () => {
    const h = startRunner()
    await connected(h)

    expect(h.hub.authorizations).toEqual([`Bearer ${token}`])
    expect(h.hub.current.received[0]).toEqual({
      _tag: "RunnerHello",
      protocolVersion: ProtocolVersion,
      name: "mac",
      // Its own Claude credential, here none; sent even so, as a Hub from before requires it.
      login: { account: "No Claude credential" },
      sessions: [],
      // The commit this checkout is at, when it is a git checkout (ADR 0011).
      ...(buildVersion !== undefined && { version: buildVersion }),
      // It asks how to clone each Test build (#104).
      asksCloneAccess: true,
      // Whether it updates itself when the Hub asks (#87).
      updater: { self: false, reason: "it runs in a test" },
      // What its Claude Code takes, and that it restarts Claude Code on a new model (#128).
      models,
      relaunches: true,
      // Whether it has a Claude credential of its own, for Sessions whose Creator has none (#150).
      ownClaudeCredential: false,
      // It opens tunnels to a Session's Open ports (#177).
      forwardsPorts: true,
      // It gives Claude Code the MCP servers of its Session's Installations (#221).
      relaysMcpServers: true,
    })
  })

  test("leaves the models out of its hello when Claude Code couldn't say", async () => {
    const h = startRunner(undefined, undefined, StaticClaudeModels(undefined))
    await connected(h)

    expect(h.hub.current.received[0]).not.toHaveProperty("models")
    expect(h.hub.current.received[0]).toMatchObject({ relaunches: true })
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

    // The Session exits while the Runner is between connections.
    h.hub.current.socket.close(1001, "Hub restarting")
    h.tmux.pane("s-1").output("lost while disconnected")
    h.tmux.pane("s-1").emit({ _tag: "Exited", exitCode: 0 })
    await eventually(() => h.hub.connections.length === 2 && h.hub.current.received.length > 0)
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

/** A Runner running Session s-1, and the Session token its Claude Code holds. */
const withSession = async () => {
  const h = startRunner()
  await connected(h)
  h.hub.send(startSession("s-1"))
  await eventually(() => h.hub.all("SessionStarted").length === 1)
  const kept = h.tmux.launched[0]?.env["KNDL_MOD_TOKEN"] as string
  return { h, kept }
}

describe("restarting under running Sessions (#157)", () => {
  test("keeps a running Session running, holding its Session token until the Hub sends a mod token", async () => {
    const { h, kept } = await withSession()
    const after = await restartRunner(h)

    // Claude Code runs on: nothing is started or stopped, and its terminal streams again.
    expect(h.hub.current.received[0]).toMatchObject({
      _tag: "RunnerHello",
      sessions: ["s-1"],
      withoutModToken: ["s-1"],
    })
    expect(h.sandboxes.reconciled.at(-1)).toEqual([sessionId("s-1")])
    expect(h.sandboxes.calls).toEqual(["start s-1"])
    expect(h.tmux.launched).toHaveLength(1)
    await eventually(() =>
      h.hub.current.received.some((m) => m._tag === "TerminalFrame" && m.kind === "Snapshot"),
    )
    h.tmux.pane("s-1").output("still here")
    await eventually(() => h.hub.current.received.some((m) => m.data === "still here"))

    // The token is held for s-1 alone: Claude Code is asked to retry, and nothing is relayed.
    const find = (presented: string) => Effect.runSync(after.proxy.tokens.find(presented))
    expect(find(kept)).toBe("Held")
    expect(after.proxy.grants).toEqual([])

    h.hub.send({ _tag: "ModTokenReissued", sessionId: "s-1", modToken: "chm_mod.reissued" })
    await eventually(() => h.sandboxes.calls.includes("keep s-1"))

    // The same token now stands for the new mod token, and no other token gets in.
    expect(find(kept)).toMatchObject({ sessionId: "s-1" })
    expect(Redacted.value(after.proxy.grants[0]?.modToken as Redacted.Redacted)).toBe(
      "chm_mod.reissued",
    )
    expect(find(`${kept.slice(0, -1)}x`)).toBeUndefined()
    expect(h.tmux.launched).toHaveLength(1)
    expect(h.hub.all("SessionStopped")).toEqual([])

    // The next hello asks for nothing more.
    h.hub.current.socket.close(1001, "Hub restarting")
    await eventually(() => h.hub.connections.length === 3 && h.hub.current.received.length > 0)
    expect(h.hub.current.received[0]).toMatchObject({ sessions: ["s-1"] })
    expect(h.hub.current.received[0]).not.toHaveProperty("withoutModToken")
  })

  test("restarts a kept Session's Claude Code on a new model in the Sandbox it took back", async () => {
    const { h } = await withSession()
    await restartRunner(h)
    h.hub.send({ _tag: "ModTokenReissued", sessionId: "s-1", modToken: "chm_mod.reissued" })
    await eventually(() => h.sandboxes.calls.includes("keep s-1"))
    writeTranscript(h, "3c1f6f0e-8a2b-4c7d-9e1f-2a3b4c5d6e7f")

    h.hub.send({
      _tag: "RelaunchSession",
      sessionId: "s-1",
      repo: "acme/app",
      workBranch: "claude/s-1",
      resume: "3c1f6f0e-8a2b-4c7d-9e1f-2a3b4c5d6e7f",
      modToken: "chm_mod.third",
      model: "opus[1m]",
    })
    await eventually(() => h.hub.all("SessionStarted").length === 2)

    expect(h.tmux.launched[1]?.argv).toContain("opus[1m]")
    expect(h.sandboxes.calls).toEqual(["start s-1", "keep s-1"])
  })

  test("puts to sleep a Session whose Claude Code exited while the Runner was down", async () => {
    const { h } = await withSession()
    await Effect.runPromise(Fiber.interrupt(h.runner))
    h.tmux.pane("s-1").emit({ _tag: "Exited", exitCode: 0 })
    await restartRunner(h)

    // Its Sandbox is stopped, and the Hub has the Session Asleep once the hello leaves it out.
    expect(h.sandboxes.reconciled.at(-1)).toEqual([])
    expect(h.sandboxes.running.size).toBe(0)
    expect(h.hub.current.received[0]).toMatchObject({ sessions: [] })
    expect(h.hub.current.received[0]).not.toHaveProperty("withoutModToken")
  })

  test("ignores a mod token for a Session that wasn't waiting for one", async () => {
    const { h } = await withSession()
    h.hub.send({ _tag: "ModTokenReissued", sessionId: "s-1", modToken: "chm_mod.reissued" })
    h.hub.send({ _tag: "ModTokenReissued", sessionId: "s-2", modToken: "chm_mod.reissued" })
    h.hub.send({ _tag: "RequestTerminalSnapshot", sessionId: "s-1" })
    await eventually(() => h.hub.all("TerminalFrame").length === 2)

    expect(h.sandboxes.calls).toEqual(["start s-1"])
    expect(h.proxy.grants.map((grant) => Redacted.value(grant.modToken))).toEqual([
      "chm_mod.secret",
    ])
  })
})

describe("Sessions", () => {
  test("starts Claude Code in its Sandbox's tmux with the mod and a Session token, then streams it", async () => {
    const h = startRunner()
    await connected(h)
    const gitIdentity = { name: "Ada Lovelace", email: "1+ada@users.noreply.github.com" }
    h.hub.send(startSession("s-1", { gitIdentity }))
    await eventually(() => h.hub.all("SessionStarted").length === 1)

    const [spec] = h.tmux.launched
    expect(spec?.cwd).toBe("/workspace")
    expect(spec?.argv).toEqual([
      fakeSandboxClaudePath,
      "--session-id",
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      "--plugin-dir",
      expect.stringMatching(new RegExp(`^${modGuestPath}/[0-9a-z]+/hub-link$`)),
      "--plugin-dir",
      expect.stringMatching(new RegExp(`^${modGuestPath}/[0-9a-z]+/hub-link-commands$`)),
      "--dangerously-skip-permissions",
    ])
    const sessionToken = spec?.env["KNDL_MOD_TOKEN"] ?? ""
    expect(sessionToken).toStartWith("chp_")
    expect(spec?.env).toEqual({
      // What the Sandbox says Claude Code runs with.
      CLAUDE_CONFIG_DIR: "/claude",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_DISABLE_AGENT_VIEW: "1",
      DISABLE_INSTALLATION_CHECKS: "1",
      KNDL_SESSION_ID: "s-1",
      // The credential proxy, for Anthropic's API and the Hub alike, and the Session token for
      // both: never the mod token, nor a Claude credential (ADR 0013).
      ANTHROPIC_BASE_URL: "http://host.microsandbox.internal:7778",
      KNDL_URL: "http://host.microsandbox.internal:7778",
      KNDL_MOD_TOKEN: sessionToken,
      CLAUDE_CODE_OAUTH_TOKEN: sessionToken,
      CLAUDE_CODE_OAUTH_SCOPES: expect.any(String),
      _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    })
    expect(JSON.stringify(spec)).not.toContain("chm_mod.secret")
    expect(h.workspaces.prepared).toMatchObject([{ sessionId: "s-1", workBranch: "claude/s-1" }])
    expect(h.sandboxes.calls).toEqual(["start s-1"])
    // With the git identity the Hub sent.
    expect(h.sandboxes.targets).toEqual([{ repo: "acme/app", gitIdentity }])

    // A snapshot first, then output as it comes.
    h.tmux.pane("s-1").output("hello")
    await eventually(() => h.hub.all("TerminalFrame").length === 2)
    expect(h.hub.all("TerminalFrame").map((f) => [f.kind, f.data])).toEqual([
      ["Snapshot", "screen of s-1"],
      ["Output", "hello"],
    ])
  })

  test("starts Claude Code with its Installations' MCP servers, at the Gateway (#221)", async () => {
    const h = startRunner()
    await connected(h)
    const mcpServers = [{ installationId: "inst-1", server: "docs" }]
    h.hub.send(startSession("s-1", { mcpServers }))
    await eventually(() => h.hub.all("SessionStarted").length === 1)

    const argv = h.tmux.launched[0]?.argv ?? []
    const pluginDir = argv[argv.indexOf("--dangerously-skip-permissions") - 1] ?? ""
    expect(posix.basename(pluginDir)).toBe("kndl")
    const copy = posix.relative(modGuestPath, posix.dirname(pluginDir))
    const config = readFileSync(
      join(h.settings.sessionsRoot, "s-1", "mod", copy, "kndl", ".mcp.json"),
      "utf8",
    )
    expect(JSON.parse(config)).toEqual(
      gatewayMcpServers(mcpServers as unknown as ReadonlyArray<GatewayServer>),
    )
    // The Session token alone reaches it, by the variable the proxy's environment sets.
    expect(config).not.toContain("chm_mod.secret")
  })

  test("restarts Claude Code alone on a new model, resuming its conversation (#128)", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.send(startSession("s-1"))
    await eventually(() => h.hub.all("SessionStarted").length === 1)
    const first = h.tmux.pane("s-1")
    writeTranscript(h, "3c1f6f0e-8a2b-4c7d-9e1f-2a3b4c5d6e7f")

    h.hub.send({
      _tag: "RelaunchSession",
      sessionId: "s-1",
      repo: "acme/app",
      workBranch: "claude/s-1",
      resume: "3c1f6f0e-8a2b-4c7d-9e1f-2a3b4c5d6e7f",
      modToken: "chm_mod.second",
      model: "opus[1m]",
      effort: "max",
    })
    await eventually(() => h.hub.all("SessionStarted").length === 2)

    expect(first.terminated).toBe(true)
    const relaunched = h.tmux.launched[1]
    expect(relaunched?.argv.slice(1, 3)).toEqual([
      "--resume",
      "3c1f6f0e-8a2b-4c7d-9e1f-2a3b4c5d6e7f",
    ])
    expect(relaunched?.argv.slice(-4)).toEqual(["--model", "opus[1m]", "--effort", "max"])
    expect(relaunched?.cwd).toBe("/workspace")
    expect(relaunched?.env).toMatchObject({ CLAUDE_CONFIG_DIR: "/claude" })
    // A new Session token, for the new mod token.
    expect(relaunched?.env["KNDL_MOD_TOKEN"]).toStartWith("chp_")
    expect(relaunched?.env["KNDL_MOD_TOKEN"]).not.toBe(h.tmux.launched[0]?.env["KNDL_MOD_TOKEN"])
    // The Sandbox and the Workspace are left as they are.
    expect(h.sandboxes.calls).toEqual(["start s-1"])
    expect(h.workspaces.prepared).toHaveLength(1)
    // Its exit was asked for, so it isn't reported as Claude Code exiting on its own.
    expect(h.hub.all("SessionStopped")).toEqual([])

    // The new Claude Code streams as the first did.
    h.tmux.pane("s-1").output("on opus")
    await eventually(() => h.hub.all("TerminalFrame").some((frame) => frame.data === "on opus"))
  })

  test("keeps the mod a Session's Claude Code started with until it starts again (#159)", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.send(startSession("s-1"))
    await eventually(() => h.hub.all("SessionStarted").length === 1)
    expect(sessionMod(h, 0)).toBe("// built 1\n")

    // An update builds the Runner's mod anew while Claude Code runs: its copy is left alone.
    writeFakeMod(h.settings.modDir, "built 2")
    expect(sessionMod(h, 0)).toBe("// built 1\n")

    // Claude Code starts again on a new copy, of the new mod, under a new name.
    writeTranscript(h, "3c1f6f0e-8a2b-4c7d-9e1f-2a3b4c5d6e7f")
    h.hub.send({
      _tag: "RelaunchSession",
      sessionId: "s-1",
      repo: "acme/app",
      workBranch: "claude/s-1",
      resume: "3c1f6f0e-8a2b-4c7d-9e1f-2a3b4c5d6e7f",
      modToken: "chm_mod.second",
      model: "sonnet",
    })
    await eventually(() => h.hub.all("SessionStarted").length === 2)
    expect(h.tmux.launched[1]?.argv[4]).not.toBe(h.tmux.launched[0]?.argv[4])
    expect(sessionMod(h, 1)).toBe("// built 2\n")
    // The old copy is gone.
    expect(readdirSync(join(h.settings.sessionsRoot, "s-1", "mod"))).toHaveLength(1)
  })

  test("says a relaunch failed when Claude Code wasn't running", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.send({
      _tag: "RelaunchSession",
      sessionId: "s-1",
      repo: "acme/app",
      workBranch: "claude/s-1",
      resume: "3c1f6f0e-8a2b-4c7d-9e1f-2a3b4c5d6e7f",
      modToken: "chm_mod.second",
    })
    await eventually(() => h.hub.all("SessionStartFailed").length === 1)

    expect(h.tmux.launched).toEqual([])
  })

  test("admits a Session with its Creator's Claude credential, asked of the Hub as it starts (#150)", async () => {
    const h = startRunner()
    await connected(h)
    const fake = "sk-ant-oat01-FAKE_TOKEN_FOR_TESTS_ONLY_9f3b"
    h.hub.claudeCredential = {
      _tag: "ClaudeCredentialFetched",
      credential: { _tag: "OAuthToken", token: fake, plan: { subscriptionType: "pro" } },
    }
    h.hub.send(startSession("s-1"))
    await eventually(() => h.hub.all("SessionStarted").length === 1)

    expect(h.hub.all("FetchClaudeCredential")).toEqual([
      { _tag: "FetchClaudeCredential", requestId: expect.any(String), sessionId: "s-1" },
    ])
    const credential = h.proxy.grants[0]?.credential
    expect(credential?._tag === "OAuthToken" && Redacted.value(credential.token)).toBe(fake)
    expect(credential?._tag === "OAuthToken" && credential.plan).toEqual({
      subscriptionType: "pro",
    })
  })

  test("runs a Session on the Runner's own Claude credential when its Creator has none, or the Hub refuses", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.send(startSession("s-1"))
    await eventually(() => h.hub.all("SessionStarted").length === 1)
    h.hub.claudeCredential = { _tag: "ClaudeCredentialRefused", message: "no" }
    h.hub.send(startSession("s-2", { workBranch: "claude/s-2" }))
    await eventually(() => h.hub.all("SessionStarted").length === 2)

    expect(h.proxy.grants.map((grant) => `${grant.sessionId}: ${grant.credential?._tag}`)).toEqual([
      "s-1: undefined",
      "s-2: undefined",
    ])
  })

  test("starts a new conversation with the same id when Claude Code never wrote one to resume", async () => {
    const h = startRunner()
    await connected(h)
    // Claude Code exited before its first turn, as in a deleted working directory (#105).
    h.hub.send(startSession("s-1", { resume: "3c1f6f0e-8a2b-4c7d-9e1f-2a3b4c5d6e7f" }))
    await eventually(() => h.hub.all("SessionStarted").length === 1)

    // The same id, so the Hub's stays right for the next wake.
    expect(h.tmux.launched[0]?.argv.slice(1, 3)).toEqual([
      "--session-id",
      "3c1f6f0e-8a2b-4c7d-9e1f-2a3b4c5d6e7f",
    ])
    // The Session's history still shows the conversation, so it says Claude Code forgot it (#191).
    expect(h.hub.all("SandboxNote")).toEqual([
      {
        _tag: "SandboxNote",
        sessionId: "s-1",
        message: expect.stringContaining("couldn't resume its conversation"),
      },
    ])
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

  test("applies terminal input, resizes and snapshot requests", async () => {
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

    const pane = h.tmux.pane("s-1")
    expect(pane.inputs).toEqual(["hi\r"])
    expect(pane.resizes).toEqual([{ cols: 100, rows: 30 }])
    expect(h.hub.all("TerminalFrame").slice(1)).toMatchObject([
      { kind: "Snapshot", size: { cols: 100, rows: 30 } },
      { kind: "Snapshot", size: { cols: 100, rows: 30 } },
    ])
  })

  test("stops a Session when asked, and its Sandbox the way asked", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.send(startSession("s-1"))
    await eventually(() => h.hub.all("SessionStarted").length === 1)
    const pane = h.tmux.pane("s-1")

    h.hub.send({ _tag: "StopSession", sessionId: "s-1", reason: "Archive" })
    await eventually(() => h.hub.all("SessionStopped").length === 1)

    expect(pane.terminated).toBe(true)
    expect(h.hub.all("SessionStopped")).toEqual([
      { _tag: "SessionStopped", sessionId: "s-1", reason: "Requested", exitCode: 143 },
    ])
    expect(h.tmux.panes.size).toBe(0)
    expect(h.sandboxes.calls).toEqual(["start s-1", "stop s-1 Archive"])
    // Nothing is pushed (#194): the Runner didn't even ask how to reach the Repo.
    expect(h.hub.all("GitRequest")).toEqual([])
  })

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
    const pane = h.tmux.pane("s-1")

    h.hub.send({ _tag: "PurgeSession", sessionId: "s-1" })
    await eventually(() => h.hub.all("SessionPurged").length === 1)

    expect(pane.terminated).toBe(true)
    expect(h.tmux.panes.size).toBe(0)
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

  test("ignores a purge of a Session id it can't name a directory after", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.send({ _tag: "PurgeSession", sessionId: "../etc" })
    h.hub.send({ _tag: "PurgeSession", sessionId: "s-2" })
    await eventually(() => h.hub.all("SessionPurged").length === 1)
    expect(h.hub.all("SessionPurged")).toEqual([{ _tag: "SessionPurged", sessionId: "s-2" }])
    expect(h.sandboxes.calls).toEqual(["purge s-2"])
  })

  test("puts a Session to sleep, keeping its Workspace and Sandbox, and wakes it resuming on its model (#128)", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.send(startSession("s-1"))
    await eventually(() => h.hub.all("SessionStarted").length === 1)
    const pane = h.tmux.pane("s-1")

    h.hub.send({ _tag: "StopSession", sessionId: "s-1", reason: "Sleep" })
    await eventually(() => h.hub.all("SessionStopped").length === 1)
    expect(pane.terminated).toBe(true)
    expect(h.hub.all("SessionStopped")).toEqual([
      { _tag: "SessionStopped", sessionId: "s-1", reason: "Requested", exitCode: 143 },
    ])
    expect(h.tmux.panes.size).toBe(0)
    // The Sandbox is stopped, not destroyed: its volumes stay for the wake. Nothing is pushed.
    expect(h.sandboxes.calls).toEqual(["start s-1", "stop s-1 Sleep"])
    expect(h.hub.all("GitRequest")).toEqual([])

    writeTranscript(h, "3c1f6f0e-8a2b-4c7d-9e1f-2a3b4c5d6e7f")
    h.hub.send(
      startSession("s-1", {
        modToken: "chm_woken.secret",
        resume: "3c1f6f0e-8a2b-4c7d-9e1f-2a3b4c5d6e7f",
        model: "sonnet",
        effort: "high",
      }),
    )
    await eventually(() => h.hub.all("SessionStarted").length === 2)
    expect(h.sandboxes.calls).toEqual(["start s-1", "stop s-1 Sleep", "start s-1"])
    expect(h.workspaces.prepared.map((start) => start.resume)).toEqual([
      undefined,
      ClaudeSessionId.make("3c1f6f0e-8a2b-4c7d-9e1f-2a3b4c5d6e7f"),
    ])
    const woken = h.tmux.launched[1]
    expect(woken?.cwd).toBe("/workspace")
    expect(woken?.argv.slice(1, 3)).toEqual(["--resume", "3c1f6f0e-8a2b-4c7d-9e1f-2a3b4c5d6e7f"])
    expect(woken?.argv.slice(-4)).toEqual(["--model", "sonnet", "--effort", "high"])
    expect(woken?.env["KNDL_MOD_TOKEN"]).toStartWith("chp_")
    expect(h.hub.all("SandboxNote")).toEqual([])
  })

  test("leaves Sessions running in tmux when the Runner stops", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.send(startSession("s-1"))
    await eventually(() => h.hub.all("SessionStarted").length === 1)

    await Effect.runPromise(Fiber.interrupt(h.runner))

    expect([...h.tmux.panes.keys()]).toEqual([sessionId("s-1")])
    // Only the clean-up of leftovers before launching.
    expect(h.tmux.killed).toEqual([sessionId("s-1")])
    expect(h.sandboxes.calls).toEqual(["start s-1"])
  })

  test("reports a Session whose Claude Code exited on its own", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.send(startSession("s-1"))
    await eventually(() => h.hub.all("SessionStarted").length === 1)

    // What it printed goes with it, read before its tmux session is killed, without its Session
    // token.
    const sessionToken = h.tmux.launched[0]?.env["KNDL_MOD_TOKEN"] ?? ""
    h.tmux
      .pane("s-1")
      .output("\u001b[31mError:\u001b[0m The current working directory was deleted\r\n")
    h.tmux.pane("s-1").output(`token ${sessionToken}\r\n`)
    h.tmux.pane("s-1").emit({ _tag: "Exited", exitCode: 1 })
    await eventually(() => h.hub.all("SessionStopped").length === 1)

    expect(h.hub.all("SessionStopped")[0]).toEqual({
      _tag: "SessionStopped",
      sessionId: "s-1",
      reason: "Exited",
      exitCode: 1,
      output: `Error: The current working directory was deleted\ntoken ${"*".repeat(sessionToken.length)}`,
    })
    expect(h.tmux.panes.size).toBe(0)
    expect(h.sandboxes.calls).toEqual(["start s-1", "stop s-1 Sleep"])
    expect(h.hub.all("GitRequest")).toEqual([])

    // One that printed nothing sends no output.
    h.hub.send(startSession("s-2"))
    await eventually(() => h.hub.all("SessionStarted").length === 2)
    h.tmux.pane("s-2").emit({ _tag: "Exited", exitCode: 0 })
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
