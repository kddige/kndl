// The terminal mirror end to end: a real Hub, a real Runner with real tmux, and a web client
// over the Hub's WebSocket. The Session's "Claude Code" is a small Bun script, never `claude`;
// the Workspace and Sandbox are faked, with tmux run on the host in the Sandbox's place. Skipped
// when tmux isn't installed.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type HubToWeb, ProtocolVersion } from "@claude-hub/protocol"
import { BunServices, BunSocket } from "@effect/platform-bun"
import { Effect, Fiber, Layer, Option, Redacted, References } from "effect"
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
import { HubLinkLive } from "./HubLink.ts"
import { HubVariablesLive } from "./HubVariables.ts"
import { runRunner } from "./Runner.ts"
import { RunnerConfig } from "./RunnerConfig.ts"
import { workspaceGuestPath } from "./sandbox/SessionLayout.ts"
import { SessionsLive } from "./Sessions.ts"
import {
  FakeCredentialProxy,
  FakeSandboxes,
  FakeWorkspaceGit,
  FakeWorkspaces,
  hostTmuxBackend,
} from "./testSupport.ts"
import { makeTmux, Tmux } from "./Tmux.ts"
import { Updater } from "./Updater.ts"

const tmuxSocket = `claude-hub-mirror-test-${process.pid}`
const tmuxMissing = Bun.which("tmux") === null
// Bun doesn't say why a test was skipped, so this does.
if (tmuxMissing) console.warn("Skipping the terminal mirror test: tmux isn't installed")
const dir = mkdtempSync(join(tmpdir(), "claude-hub-mirror-"))

/**
 * Stands in for Claude Code: ignores its flags, says it's ready, echoes each line, prints the
 * terminal's size when asked, and survives Ctrl-C, saying so.
 *
 * It is a Bun script rather than a shell loop: macOS's `/bin/sh` is bash 3.2, whose `read`, after
 * running an INT trap, now and then drops the last byte of the next line when the resize's
 * SIGWINCH lands, so `size` arrived as `siz` and the test waited for an answer that never came.
 */
const fakeClaude = join(dir, "fake-claude")
writeFileSync(
  fakeClaude,
  `#!${process.execPath}
process.on("SIGINT", () => process.stdout.write("interrupted\\n"))
process.stdout.write("fake claude ready\\n")
for await (const line of console) {
  if (line === "size") {
    const [cols, rows] = process.stdout.getWindowSize()
    process.stdout.write(\`\${rows} \${cols}\\n\`)
  } else {
    process.stdout.write(\`you said: \${line}\\n\`)
  }
}
`,
)
chmodSync(fakeClaude, 0o755)

type Frame = Extract<typeof HubToWeb.Encoded, { _tag: "TerminalFrame" }>
type Tagged = { readonly _tag: string; readonly [key: string]: unknown }

/** A web client: a WebSocket to the Hub that keeps what it receives. */
class Web {
  readonly received: Array<Tagged> = []

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      this.received.push(JSON.parse(String(event.data)) as Tagged)
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
  async next(tag: string, where: (message: Tagged) => boolean = () => true): Promise<Tagged> {
    const deadline = Date.now() + 5_000
    for (;;) {
      const index = this.received.findIndex((message) => message._tag === tag && where(message))
      if (index >= 0) return this.received.splice(0, index + 1).at(-1) as Tagged
      if (Date.now() > deadline) {
        throw new Error(`No ${tag} came; got ${JSON.stringify(this.received.slice(-5))}`)
      }
      await Bun.sleep(10)
    }
  }

  /** The terminal frames received so far, taken. */
  frames(): Array<Frame> {
    const frames = this.received.filter((message) => message._tag === "TerminalFrame")
    this.received.splice(0)
    return frames as unknown as Array<Frame>
  }

  close() {
    this.socket.close(1000)
  }
}

/** Waits until the frames since the last call contain `text`, and returns them. */
async function framesUntil(web: Web, text: string): Promise<Array<Frame>> {
  const seen: Array<Frame> = []
  const deadline = Date.now() + 5_000
  while (!seen.some((frame) => frame.data.includes(text))) {
    if (Date.now() > deadline) {
      throw new Error(`"${text}" never came; got ${JSON.stringify(seen.map((f) => f.data))}`)
    }
    await Bun.sleep(20)
    seen.push(...web.frames())
  }
  return seen
}

const runners: Array<Fiber.Fiber<never, unknown>> = []
const webs: Array<Web> = []

afterEach(async () => {
  for (const web of webs.splice(0)) web.close()
  for (const runner of runners.splice(0)) await Effect.runPromise(Fiber.interrupt(runner))
  await stopHubs()
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
  if (tmuxMissing) return
  const socketPath = Bun.spawnSync([
    "tmux",
    "-L",
    tmuxSocket,
    "display-message",
    "-p",
    "#{socket_path}",
  ])
    .stdout.toString()
    .trim()
  Bun.spawnSync(["tmux", "-L", tmuxSocket, "kill-server"])
  if (socketPath !== "") rmSync(socketPath, { force: true })
})

/** Runs the real Runner against `hub`, with real tmux and the Workspace and Sandbox faked. */
async function startRunner(hub: TestHub, proxy = new FakeCredentialProxy()) {
  const { token } = await hub.run(Effect.flatMap(RunnerTokens, (tokens) => tokens.issue("mac")))
  const claudeConfig = join(dir, ".claude.json")
  writeFileSync(claudeConfig, JSON.stringify({ oauthAccount: { emailAddress: "a@example.com" } }))
  const sessionsRoot = join(dir, "sessions")
  const layer = SessionsLive.pipe(
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
      proxy.layer,
    ]),
    Layer.provideMerge(
      Layer.succeed(
        RunnerConfig,
        RunnerConfig.of({
          hubUrl: new URL(hub.url),
          name: "mac",
          token: Redacted.make(token),
          login: undefined,
          sessionsRoot,
          modDir: dir,
          claudeBin: fakeClaude,
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
      runRunner({ claudeConfigPath: claudeConfig }).pipe(
        Effect.provide(layer),
        Effect.provideService(References.MinimumLogLevel, "None"),
      ),
    ),
  )
}

describe.skipIf(tmuxMissing)("the terminal mirror", () => {
  test("shows a Session's terminal live, takes keystrokes and resizes, and redraws on reopening", async () => {
    const hub = await startHub({
      config: { devLogin: true, secretsKey: Option.some(Redacted.make(generateSecretsKey())) },
    })
    // A Runner with no Claude credential of its own.
    const proxy = new FakeCredentialProxy()
    await startRunner(hub, proxy)
    const cookie = cookieFrom(await devSignIn(hub, "alice"))
    await seedEnvironment(hub, "acme/app", "dev:alice")
    const web = await Web.open(hub, cookie)
    webs.push(web)
    await web.next(
      "RunnerList",
      (message) => Array.isArray(message["runners"]) && message["runners"].length > 0,
    )

    // alice's Claude credential, a fake one, which her Session's Runner is given (#150).
    const fake = "sk-ant-oat01-FAKE_TOKEN_FOR_TESTS_ONLY_9f3b"
    web.send({ _tag: "SetClaudeCredential", requestId: "r-0", secret: fake, plan: "max5x" })
    await web.next("ClaudeCredentialState", (message) => message["requestId"] === "r-0")
    web.send({ _tag: "CreateSession", requestId: "r-1", repo: "acme/app", baseBranch: "main" })
    const created = await web.next("SessionCreated")
    const sessionId = (created["session"] as { id: string }).id
    await web.next(
      "SessionUpdated",
      (message) => (message["session"] as { state: string }).state === "Active",
    )

    // Opening it gets a snapshot of the screen as it is, then what it prints.
    web.send({ _tag: "OpenTerminal", sessionId })
    const opened = await framesUntil(web, "fake claude ready")
    // It was started on alice's Claude credential, fetched from the Hub.
    const credential = proxy.grants[0]?.credential
    expect(credential?._tag === "OAuthToken" && Redacted.value(credential.token)).toBe(fake)
    expect(opened.some((frame) => frame.kind === "Snapshot")).toBe(true)
    web.send({ _tag: "CloseTerminal", sessionId })
    web.send({ _tag: "OpenTerminal", sessionId })
    expect((await framesUntil(web, "fake claude ready")).at(-1)).toMatchObject({
      kind: "Snapshot",
      size: { cols: 120, rows: 40 },
    })

    // Keystrokes, Enter and Ctrl-C reach the process; what it prints comes back as Output.
    web.send({ _tag: "TerminalInput", sessionId, data: "hello\r" })
    const echoed = await framesUntil(web, "you said: hello")
    expect(echoed.every((frame) => frame.kind === "Output")).toBe(true)
    web.send({ _tag: "TerminalInput", sessionId, data: "\u0003" })
    await framesUntil(web, "interrupted")

    // A resize redraws every viewer from a snapshot at the new size, and the process sees it.
    web.send({ _tag: "TerminalResize", sessionId, size: { cols: 100, rows: 30 } })
    const resized = await framesUntil(web, "you said: hello")
    expect(resized.find((frame) => frame.data.includes("you said: hello"))).toMatchObject({
      kind: "Snapshot",
      size: { cols: 100, rows: 30 },
    })
    web.send({ _tag: "TerminalInput", sessionId, data: "size\r" })
    expect((await framesUntil(web, "30 100")).at(-1)).toMatchObject({
      kind: "Output",
      size: { cols: 100, rows: 30 },
    })

    // Another connection, as after a dropped socket, gets one fresh snapshot with everything
    // on screen once: nothing replayed after it.
    web.close()
    const again = await Web.open(hub, cookie)
    webs.push(again)
    again.send({ _tag: "OpenTerminal", sessionId })
    const reopened = await framesUntil(again, "30 100")
    expect(reopened.map((frame) => frame.kind)).toEqual(["Snapshot"])
    const screen = reopened[0]?.data ?? ""
    expect(screen.split("you said: hello")).toHaveLength(2)
    expect(reopened[0]?.size).toEqual({ cols: 100, rows: 30 })
  }, 30_000)
})
