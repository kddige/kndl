// The Runner against a fake Hub WebSocket server, with tmux, the Workspace and the Sandbox faked.
import { afterEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ClaudeSessionId, ProtocolVersion, TestBuildId } from "@claude-hub/protocol"
import { readBuildVersion } from "@claude-hub/protocol/checkout"
import { BunServices, BunSocket } from "@effect/platform-bun"
import type { ServerWebSocket } from "bun"
import { Context, Effect, Fiber, Layer, Redacted, References } from "effect"
import { ClaudeProjectsDir, claudeProjectDirName } from "./ClaudeConfig.ts"
import { ClaudeTrustLive } from "./ClaudeTrust.ts"
import { HubGit, HubGitLive } from "./HubGit.ts"
import { HubLinkLive } from "./HubLink.ts"
import { HubVariablesLive } from "./HubVariables.ts"
import { runRunner } from "./Runner.ts"
import { RunnerConfig, type RunnerSettings } from "./RunnerConfig.ts"
import { SessionsLive } from "./Sessions.ts"
import {
  eventually,
  FakeSandboxes,
  FakeTmux,
  FakeWorkspaceGit,
  FakeWorkspaces,
  sessionId,
} from "./testSupport.ts"
import { Updater } from "./Updater.ts"

const token = "chr_test.secret"

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
  readonly git: FakeWorkspaceGit
  /** The Runner's HubGit, once its layer is built. */
  readonly hubGit: () => HubGit["Service"]
  readonly runner: Fiber.Fiber<never, unknown>
  readonly settings: RunnerSettings
  /** Claude Code's config file, which the Runner trusts its sessions root in. */
  readonly claudeConfig: string
  /** Where Claude Code keeps its transcripts, for the Runner to tell whether one exists. */
  readonly projectsDir: string
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

function startRunner(
  setup: (h: { hub: FakeHub; tmux: FakeTmux }) => void = () => {},
  updater: Layer.Layer<Updater> = Updater.manual(),
): Harness {
  const dir = mkdtempSync(join(tmpdir(), "claude-hub-runner-"))
  const sessionsRoot = join(dir, "sessions")
  const claudeConfig = join(dir, ".claude.json")
  const projectsDir = join(dir, "projects")
  writeFileSync(
    claudeConfig,
    JSON.stringify({
      oauthAccount: { emailAddress: "alice@example.com" },
      projects: { "/elsewhere": { allowedTools: [] } },
    }),
  )
  const hub = new FakeHub()
  const tmux = new FakeTmux()
  setup({ hub, tmux })
  const workspaces = new FakeWorkspaces(sessionsRoot)
  const sandboxes = new FakeSandboxes()
  // One record of Sandbox and git calls, in the order they ran.
  const git = new FakeWorkspaceGit(sandboxes.calls)
  const settings: RunnerSettings = {
    hubUrl: hub.url,
    name: "mac",
    token: Redacted.make(token),
    login: undefined,
    sessionsRoot,
    modDir: "/opt/claude-hub/packages/mod",
    claudeBin: "/usr/local/bin/claude",
    tmuxSocket: "unused",
    repoUrlTemplate: "unused",
  }
  let hubGit: HubGit["Service"] | undefined
  const layer = SessionsLive.pipe(
    Layer.provideMerge(
      HubGitLive.pipe(
        Layer.tap((context) => Effect.sync(() => void (hubGit = Context.get(context, HubGit)))),
      ),
    ),
    Layer.provideMerge(HubVariablesLive),
    Layer.provideMerge(updater),
    Layer.provideMerge(HubLinkLive),
    Layer.provideMerge(ClaudeTrustLive(claudeConfig)),
    Layer.provide([tmux.layer, workspaces.layer, sandboxes.layer, git.layer]),
    Layer.provideMerge(Layer.succeed(RunnerConfig, RunnerConfig.of(settings))),
    Layer.provideMerge(Layer.mergeAll(BunServices.layer, BunSocket.layerWebSocketConstructor)),
  )
  const runner = Effect.runFork(
    runRunner({
      claudeConfigPath: claudeConfig,
      backoff: { initial: "20 millis", max: "100 millis", rejected: "50 millis" },
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(ClaudeProjectsDir, projectsDir),
      Effect.provideService(References.MinimumLogLevel, "None"),
    ),
  )
  running.push({ hub, runner })
  return {
    hub,
    tmux,
    workspaces,
    sandboxes,
    git,
    hubGit: () => {
      if (hubGit === undefined) throw new Error("the Runner's layer isn't built yet")
      return hubGit
    },
    runner,
    settings,
    claudeConfig,
    projectsDir,
  }
}

/** Gives Session `id` a transcript of Claude Code's conversation `conversation`, as once it ran. */
function writeTranscript(h: Harness, id: string, conversation: string): void {
  const name = claudeProjectDirName(join(h.settings.sessionsRoot, id, "claude"))
  if (name === undefined) throw new Error("the sessions root is too long to name")
  mkdirSync(join(h.projectsDir, name), { recursive: true })
  writeFileSync(join(h.projectsDir, name, `${conversation}.jsonl`), "{}\n")
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
  test("says hello with the Runner token, its name and the login from Claude Code's config", async () => {
    const h = startRunner()
    await connected(h)

    expect(h.hub.authorizations).toEqual([`Bearer ${token}`])
    expect(h.hub.current.received[0]).toEqual({
      _tag: "RunnerHello",
      protocolVersion: ProtocolVersion,
      name: "mac",
      login: { account: "alice@example.com" },
      sessions: [],
      // The commit this checkout is at, when it is a git checkout (ADR 0011).
      ...(buildVersion !== undefined && { version: buildVersion }),
      // It asks how to clone each Test build (#104).
      asksCloneAccess: true,
      // Whether it updates itself when the Hub asks (#87).
      updater: { self: false, reason: "it runs in a test" },
    })
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
    // A service would only restart a Runner that exits, in a loop: it keeps trying, slowly.
    await eventually(() => h.hub.connections.length >= 2)

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

  test("re-adopts Sessions left running in tmux and snapshots them once welcomed", async () => {
    const h = startRunner(({ tmux }) => {
      tmux.leaveRunning(sessionId("s-old"))
    })
    await eventually(() => h.hub.all("TerminalFrame").length > 0)

    expect(h.hub.current.received[0]).toMatchObject({ sessions: ["s-old"] })
    expect(h.hub.all("TerminalFrame")[0]).toEqual({
      _tag: "TerminalFrame",
      sessionId: "s-old",
      kind: "Snapshot",
      data: "screen of s-old",
      size: { cols: 80, rows: 24 },
    })
    // Its Sandbox and tool bridge come back, and Sandboxes of no running Session are reconciled.
    expect(h.sandboxes.calls).toEqual(["start s-old"])
    expect(h.sandboxes.reconciled).toEqual([[sessionId("s-old")]])
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

const projects = (h: Harness) =>
  (JSON.parse(readFileSync(h.claudeConfig, "utf8")) as { projects: Record<string, unknown> })
    .projects

describe("trust", () => {
  test("trusts the sessions root, by its real path, at startup", async () => {
    const h = startRunner()
    await connected(h)

    expect(projects(h)).toEqual({
      "/elsewhere": { allowedTools: [] },
      [realpathSync(h.settings.sessionsRoot)]: { hasTrustDialogAccepted: true },
    })
  })

  test("trusts it again before launching Claude Code if the flag was dropped", async () => {
    const h = startRunner()
    await connected(h)
    writeFileSync(
      h.claudeConfig,
      JSON.stringify({ oauthAccount: { emailAddress: "alice@example.com" }, projects: {} }),
    )
    h.hub.send(startSession("s-1"))
    await eventually(() => h.hub.all("SessionStarted").length === 1)

    expect(projects(h)).toEqual({
      [realpathSync(h.settings.sessionsRoot)]: { hasTrustDialogAccepted: true },
    })
  })
})

describe("Sessions", () => {
  test("starts the Sandbox with the git identity the Hub sent", async () => {
    const h = startRunner()
    await connected(h)
    const gitIdentity = { name: "Ada Lovelace", email: "1+ada@users.noreply.github.com" }
    h.hub.send(startSession("s-1", { gitIdentity }))
    await eventually(() => h.hub.all("SessionStarted").length === 1)
    expect(h.sandboxes.targets).toEqual([{ repo: "acme/app", gitIdentity }])
  })

  test("starts Claude Code in tmux with the hardened flags and the mod, then streams it", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.send(startSession("s-1"))
    await eventually(() => h.hub.all("SessionStarted").length === 1)

    const [spec] = h.tmux.launched
    expect(spec?.cwd).toBe(join(h.settings.sessionsRoot, "s-1", "claude"))
    expect(spec?.argv).toEqual([
      "/usr/local/bin/claude",
      "--session-id",
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      "--plugin-dir",
      "/opt/claude-hub/packages/mod",
      "--plugin-dir",
      join(h.settings.sessionsRoot, "s-1", "repo", ".claude"),
      "--tools",
      "Bash,Read,Write,Edit,NotebookEdit,Glob,Grep,WebSearch",
      "--strict-mcp-config",
      "--setting-sources",
      "",
      "--settings",
      '{"disableSkillShellExecution":true,"autoMemoryEnabled":false}',
    ])
    expect(spec?.env).toEqual({
      CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_HUB_URL: h.hub.url.href,
      CLAUDE_HUB_SESSION_ID: "s-1",
      CLAUDE_HUB_MOD_TOKEN: "chm_mod.secret",
      CLAUDE_HUB_TOOLS_SOCKET: join(h.settings.sessionsRoot, "s-1", "tools.sock"),
      CLAUDE_HUB_WORKSPACE: "/workspace",
      CLAUDE_HUB_REPO: "acme/app",
      CLAUDE_HUB_WORK_BRANCH: "claude/s-1",
      CLAUDE_HUB_REPO_FILES: join(h.settings.sessionsRoot, "s-1", "repo"),
    })
    expect(h.workspaces.prepared).toMatchObject([{ sessionId: "s-1", workBranch: "claude/s-1" }])
    expect(h.sandboxes.calls).toEqual(["start s-1"])

    // A snapshot first, then output as it comes.
    h.tmux.pane("s-1").output("hello")
    await eventually(() => h.hub.all("TerminalFrame").length === 2)
    expect(h.hub.all("TerminalFrame").map((f) => [f.kind, f.data])).toEqual([
      ["Snapshot", "screen of s-1"],
      ["Output", "hello"],
    ])
  })

  test("resumes Claude Code's conversation when waking a Session", async () => {
    const h = startRunner()
    await connected(h)
    writeTranscript(h, "s-1", "3c1f6f0e-claude")
    h.hub.send(startSession("s-1", { resume: "3c1f6f0e-claude" }))
    await eventually(() => h.hub.all("SessionStarted").length === 1)

    expect(h.tmux.launched[0]?.argv.slice(1, 3)).toEqual(["--resume", "3c1f6f0e-claude"])
  })

  test("copies the Repo's skills and CLAUDE.md for Claude Code at each start, over the last ones", async () => {
    const h = startRunner()
    await connected(h)
    const repoFiles = join(h.settings.sessionsRoot, "s-1", "repo")
    // Left by an earlier start, or by anything else: it goes.
    mkdirSync(join(repoFiles, ".claude", "skills", "old"), { recursive: true })
    writeFileSync(join(repoFiles, ".claude", "skills", "old", "SKILL.md"), "stale")
    h.sandboxes.repo = {
      instructions: [
        { path: "CLAUDE.md", content: "Use bun.\n" },
        { path: "AGENTS.md", content: "Be brief.\n", parent: "CLAUDE.md" },
      ],
      skills: [{ name: "deploy", content: '---\nname: "deploy"\n---\nShip it.\n' }],
      skipped: [],
    }
    h.hub.send(startSession("s-1"))
    await eventually(() => h.hub.all("SessionStarted").length === 1)

    expect(h.sandboxes.repoFilesRead).toEqual(["s-1"])
    expect(readFileSync(join(repoFiles, ".claude", "skills", "deploy", "SKILL.md"), "utf8")).toBe(
      '---\nname: "deploy"\n---\nShip it.\n',
    )
    expect(existsSync(join(repoFiles, ".claude", "skills", "old"))).toBe(false)
    expect(
      JSON.parse(readFileSync(join(repoFiles, ".claude", ".claude-plugin", "plugin.json"), "utf8")),
    ).toMatchObject({ name: "repo" })
    expect(JSON.parse(readFileSync(join(repoFiles, "instructions.json"), "utf8"))).toEqual({
      instructions: [
        { path: "/workspace/CLAUDE.md", content: "Use bun.\n" },
        { path: "/workspace/AGENTS.md", content: "Be brief.\n", parent: "/workspace/CLAUDE.md" },
      ],
    })
  })

  test("starts a new conversation with the same id when Claude Code never wrote one to resume", async () => {
    const h = startRunner()
    await connected(h)
    // Claude Code exited before its first turn, as in a deleted working directory (#105).
    h.hub.send(startSession("s-1", { resume: "3c1f6f0e-claude" }))
    await eventually(() => h.hub.all("SessionStarted").length === 1)

    // The same id, so the Hub's stays right for the next wake.
    expect(h.tmux.launched[0]?.argv.slice(1, 3)).toEqual(["--session-id", "3c1f6f0e-claude"])
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
    // The Workspace's WIP ref is pushed before the Sandbox goes: the archive hook.
    expect(h.sandboxes.calls).toEqual(["start s-1", "pushWip s-1 Archive", "stop s-1 Archive"])
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
    expect(h.sandboxes.calls).toEqual(["pushWip s-1 Archive", "stop s-1 Archive"])
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
    expect(h.sandboxes.calls).toEqual([
      "start s-1",
      "pushWip s-1 Archive",
      "stop s-1 Archive",
      "purge s-1",
    ])
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

  test("puts a Session to sleep, keeping its Workspace and Sandbox, and wakes it resuming", async () => {
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
    // The WIP ref is pushed first; then the Sandbox is stopped, not destroyed: its volumes stay
    // for the wake.
    expect(h.sandboxes.calls).toEqual(["start s-1", "pushWip s-1 Sleep", "stop s-1 Sleep"])

    writeTranscript(h, "s-1", "3c1f6f0e-claude")
    h.hub.send(startSession("s-1", { modToken: "chm_woken.secret", resume: "3c1f6f0e-claude" }))
    await eventually(() => h.hub.all("SessionStarted").length === 2)
    expect(h.sandboxes.calls).toEqual([
      "start s-1",
      "pushWip s-1 Sleep",
      "stop s-1 Sleep",
      "start s-1",
    ])
    expect(h.workspaces.prepared.map((start) => start.resume)).toEqual([
      undefined,
      ClaudeSessionId.make("3c1f6f0e-claude"),
    ])
    const woken = h.tmux.launched[1]
    expect(woken?.cwd).toBe(join(h.settings.sessionsRoot, "s-1", "claude"))
    expect(woken?.argv.slice(1, 3)).toEqual(["--resume", "3c1f6f0e-claude"])
    expect(woken?.env["CLAUDE_HUB_MOD_TOKEN"]).toBe("chm_woken.secret")
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

    // What it printed goes with it, read before its tmux session is killed, without its mod token.
    h.tmux
      .pane("s-1")
      .output("\u001b[31mError:\u001b[0m The current working directory was deleted\r\n")
    h.tmux.pane("s-1").output("token chm_mod.secret\r\n")
    h.tmux.pane("s-1").emit({ _tag: "Exited", exitCode: 1 })
    await eventually(() => h.hub.all("SessionStopped").length === 1)

    expect(h.hub.all("SessionStopped")[0]).toEqual({
      _tag: "SessionStopped",
      sessionId: "s-1",
      reason: "Exited",
      exitCode: 1,
      output: "Error: The current working directory was deleted\ntoken **************",
    })
    expect(h.tmux.panes.size).toBe(0)
    expect(h.sandboxes.calls).toEqual(["start s-1", "pushWip s-1 Sleep", "stop s-1 Sleep"])
  })

  test("sends no output for a Session that exited without printing anything", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.send(startSession("s-1"))
    await eventually(() => h.hub.all("SessionStarted").length === 1)

    h.tmux.pane("s-1").emit({ _tag: "Exited", exitCode: 0 })
    await eventually(() => h.hub.all("SessionStopped").length === 1)

    expect(h.hub.all("SessionStopped")[0]).not.toHaveProperty("output")
  })

  test("makes the tmux server its own before re-adopting Sessions", async () => {
    const h = startRunner(({ tmux }) => {
      tmux.claim = { _tag: "Refreshed", sessions: 1, changed: ["PWD was /gone"] }
      tmux.leaveRunning(sessionId("s-old"))
    })
    await connected(h)

    expect(h.tmux.claims).toBe(1)
  })

  test("pushes a running Session's WIP ref when the Hub says its Turn ended", async () => {
    const h = startRunner()
    await connected(h)
    h.hub.send(startSession("s-1"))
    await eventually(() => h.hub.all("SessionStarted").length === 1)

    h.hub.send({ _tag: "SessionTurnEnded", sessionId: "s-1" })
    h.hub.send({ _tag: "SessionTurnEnded", sessionId: "s-unknown" })
    await eventually(() => h.git.calls.includes("pushWip s-1 TurnEnded"))

    expect(h.git.calls).toEqual(["start s-1", "pushWip s-1 TurnEnded"])
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
