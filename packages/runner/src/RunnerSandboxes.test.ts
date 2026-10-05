// Runners restarting next to each other on one host, sharing one Sandbox backend (#38): each
// re-adopts its own Sessions, with their Sandboxes and tool bridges, and leaves the others alone.
// tmux and the Workspace are faked; the Sandboxes are the live ones on the fake backend.

import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RunnerToHub, SandboxStateReport, SessionId } from "@claude-hub/protocol"
import { Effect, Layer, Redacted, References } from "effect"
import { NoClaudeTrust } from "./ClaudeTrust.ts"
import { HubGitLive } from "./HubGit.ts"
import { HubLink } from "./HubLink.ts"
import { RunnerConfig } from "./RunnerConfig.ts"
import { Sandboxes } from "./Sandbox.ts"
import { FakeSandboxBackend, makeFakeWorld } from "./sandbox/FakeSandboxBackend.ts"
import type { FakeSandboxWorld } from "./sandbox/FakeSandboxBackend.ts"
import { runnerMark } from "./sandbox/Naming.ts"
import { sessionDirectories } from "./SessionNames.ts"
import { Sessions, SessionsLive } from "./Sessions.ts"
import { makeSessionSandboxes } from "./SessionSandboxes.ts"
import {
  echoTools,
  FakeHubVariables,
  FakeTmux,
  FakeCredentialProxy,
  FakeWorkspaceGit,
  FakeWorkspaces,
  fakeMcpServer,
  sandboxesDefaults,
  sessionId,
} from "./testSupport.ts"

const dirs: Array<string> = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** A Runner on the shared host: its own tmux server and sessions root, and so its own mark. */
interface RunnerHost {
  readonly tmuxSocket: string
  readonly sessionsRoot: string
  readonly tmux: FakeTmux
  readonly sent: Array<RunnerToHub>
}

async function runnerHost(tmuxSocket: string): Promise<RunnerHost> {
  const dir = await mkdtemp(join(tmpdir(), "claude-hub-rs-"))
  dirs.push(dir)
  return { tmuxSocket, sessionsRoot: dir, tmux: new FakeTmux(), sent: [] }
}

/** The Session's directories, as its Workspace left them. */
const directories = async (host: RunnerHost, id: SessionId) => {
  const found = sessionDirectories(host.sessionsRoot, id)
  await mkdir(found.workspace, { recursive: true })
  await mkdir(found.claude, { recursive: true })
  return found
}

/** Runs `body` in one run of the Runner's process on `world`; the process ends with it. */
const runProcess = <A>(
  world: FakeSandboxWorld,
  host: RunnerHost,
  body: Effect.Effect<A, unknown, Sessions | Sandboxes>,
) => {
  const hub = Layer.succeed(
    HubLink,
    HubLink.of({
      send: (message) => Effect.sync(() => void host.sent.push(message)),
      connect: () => Effect.void,
      disconnect: Effect.void,
    }),
  )
  const config = Layer.succeed(
    RunnerConfig,
    RunnerConfig.of({
      hubUrl: new URL("http://127.0.0.1:7777"),
      name: host.tmuxSocket,
      token: Redacted.make("chr_test.secret"),
      login: undefined,
      sessionsRoot: host.sessionsRoot,
      modDir: "/opt/claude-hub/packages/mod",
      claudeBin: "/usr/local/bin/claude",
      tmuxSocket: host.tmuxSocket,
      repoUrlTemplate: "unused",
    }),
  )
  const backend = FakeSandboxBackend.layer({
    world,
    runner: runnerMark(host),
    onSpawn: (_call, io) => fakeMcpServer(echoTools)(io),
  })
  const variables = new FakeHubVariables().layer
  const sandboxes = Layer.effect(
    Sandboxes,
    makeSessionSandboxes({
      image: "docker:dind",
      claudeCacheDir: join(host.sessionsRoot, "claude-code"),
      sandboxClaude: () => Effect.succeed("2.1.287"),
      ...sandboxesDefaults,
      bridge: { readyTimeout: "2 seconds", restartDelay: () => "10 millis" },
    }),
  ).pipe(Layer.provide([backend, variables]))
  const layer = SessionsLive.pipe(
    Layer.provideMerge(sandboxes),
    Layer.provide([
      host.tmux.layer,
      new FakeWorkspaces(host.sessionsRoot).layer,
      NoClaudeTrust,
      new FakeWorkspaceGit().layer,
      new FakeCredentialProxy().layer,
      HubGitLive,
    ]),
    Layer.provide([hub, config, variables]),
  )
  return body.pipe(
    Effect.provide(layer),
    Effect.scoped,
    Effect.provideService(References.MinimumLogLevel, "None"),
    Effect.runPromise,
  )
}

const adopt = Effect.gen(function* () {
  yield* (yield* Sessions).adopt
})

/** Runs `f` with the Runner's Sandboxes. */
const withSandboxes = <A, E>(f: (sandboxes: Sandboxes["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* f(yield* Sandboxes)
  })

/** Asks the Session's tool bridge to run a tool, as the mod does. */
const callTool = async (socket: string) => {
  const response = await fetch("http://bridge/tools/call", {
    method: "POST",
    unix: socket,
    body: JSON.stringify({ tool: "Bash", input: { command: "ls" } }),
  })
  return (await response.json()) as unknown
}

const sandboxStates = (host: RunnerHost, id: SessionId) =>
  host.sent
    .filter((m): m is SandboxStateReport => m._tag === "SandboxStateReport" && m.sessionId === id)
    .map((m) => m.state)

const stateIn = (world: FakeSandboxWorld, id: SessionId) => world.sandboxes.get(id)?.state

test("a re-adopted Session whose Sandbox was stopped gets it started again, and its tools back", async () => {
  const world = makeFakeWorld()
  const host = await runnerHost("claude-hub-dev")
  const s1 = sessionId("s-1")
  const dirs1 = await directories(host, s1)

  // The Runner started the Session's Sandbox, then went away leaving Claude Code in tmux; since
  // then the Sandbox was stopped, as another Runner's reconcile did before #38.
  await runProcess(
    world,
    host,
    withSandboxes((s) => s.start(s1, dirs1)),
  )
  host.tmux.leaveRunning(s1)
  const stopped = world.sandboxes.get(s1)
  if (stopped === undefined) throw new Error("no Sandbox")
  stopped.state = "Stopped"
  host.sent.length = 0

  await runProcess(
    world,
    host,
    Effect.gen(function* () {
      yield* adopt
      expect(stateIn(world, s1)).toBe("Running")
      expect(sandboxStates(host, s1)).toEqual(["Starting", "Running"])
      expect(yield* Effect.promise(() => callTool(dirs1.toolsSocket))).toEqual({
        _tag: "ToolRan",
        result: { tool: "Bash", args: { command: "ls" } },
      })
    }),
  )
})

test("Runners restarting side by side on one host each keep to their own Sandboxes", async () => {
  const world = makeFakeWorld()
  // An installed Runner and a dev one, on their default sockets.
  const a = await runnerHost("claude-hub")
  const b = await runnerHost("claude-hub-dev")
  const sa = sessionId("s-a")
  const sb = sessionId("s-b")
  const asleep = sessionId("s-asleep")
  const dirsA = await directories(a, sa)
  const dirsB = await directories(b, sb)
  const dirsAsleep = await directories(b, asleep)

  // Runner a runs s-a. Runner b runs s-b, and had s-asleep running when it crashed, though its
  // Claude Code has since gone.
  await runProcess(
    world,
    a,
    withSandboxes((s) => s.start(sa, dirsA)),
  )
  await runProcess(
    world,
    b,
    withSandboxes((s) => Effect.andThen(s.start(sb, dirsB), s.start(asleep, dirsAsleep))),
  )
  a.tmux.leaveRunning(sa)
  b.tmux.leaveRunning(sb)
  // And one Sandbox from before Runner marks, whose Session no Runner here knows.
  const legacy = sessionId("s-legacy")
  const template = world.sandboxes.get(sa)
  if (template === undefined) throw new Error("no Sandbox")
  world.sandboxes.set(legacy, { ...template, runner: undefined, rootfs: new Map() })

  // Runner b restarts: it stops only its own Sandbox of no running Session.
  await runProcess(world, b, adopt)
  expect(stateIn(world, sb)).toBe("Running")
  expect(stateIn(world, asleep)).toBe("Stopped")
  expect(stateIn(world, sa)).toBe("Running")
  expect(stateIn(world, legacy)).toBe("Running")

  // Runner a restarts too, and leaves b's Sessions as b left them.
  await runProcess(
    world,
    a,
    Effect.gen(function* () {
      yield* adopt
      expect(yield* Effect.promise(() => callTool(dirsA.toolsSocket))).toMatchObject({
        _tag: "ToolRan",
      })
    }),
  )
  expect(stateIn(world, sa)).toBe("Running")
  expect(stateIn(world, sb)).toBe("Running")
  expect(stateIn(world, asleep)).toBe("Stopped")
  expect(stateIn(world, legacy)).toBe("Running")
})
