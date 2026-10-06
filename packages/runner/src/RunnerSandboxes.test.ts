// Runners restarting next to each other on one host, sharing one Sandbox backend (#38): each puts
// its own Sessions to sleep, stopping their Sandboxes, and leaves the others alone. tmux and the
// Workspace are faked; the Sandboxes are the live ones on the fake backend.

import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RepoName, RunnerToHub, SessionId } from "@claude-hub/protocol"
import { Effect, Layer, Redacted, References } from "effect"
import { NoHubClaudeCredential } from "./HubClaudeCredential.ts"
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
  FakeHubVariables,
  FakeTmux,
  FakeCredentialProxy,
  FakeWorkspaceGit,
  FakeWorkspaces,
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
      sessionsRoot: host.sessionsRoot,
      modDir: "/opt/claude-hub/packages/mod",
      tmuxSocket: host.tmuxSocket,
      repoUrlTemplate: "unused",
    }),
  )
  const backend = FakeSandboxBackend.layer({ world, runner: runnerMark(host) })
  const variables = new FakeHubVariables().layer
  const sandboxes = Layer.effect(
    Sandboxes,
    makeSessionSandboxes({
      image: "docker:dind",
      claudeCacheDir: join(host.sessionsRoot, "claude-code"),
      sandboxClaude: () => Effect.succeed("2.1.287"),
      modDir: host.sessionsRoot,
      ...sandboxesDefaults,
    }),
  ).pipe(Layer.provide([backend, variables]))
  const layer = SessionsLive.pipe(
    Layer.provideMerge(sandboxes),
    Layer.provide([
      host.tmux.layer,
      new FakeWorkspaces(host.sessionsRoot).layer,
      new FakeWorkspaceGit().layer,
      new FakeCredentialProxy().layer,
      HubGitLive,
      NoHubClaudeCredential,
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

/** What each Session's Sandbox is started for. */
const target = { repo: "acme/app" as RepoName }

const stateIn = (world: FakeSandboxWorld, id: SessionId) => world.sandboxes.get(id)?.state

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

  // Runner a ran s-a. Runner b ran s-b, and s-asleep, whose Claude Code has since gone.
  await runProcess(
    world,
    a,
    withSandboxes((s) => s.start(sa, dirsA, target)),
  )
  await runProcess(
    world,
    b,
    withSandboxes((s) =>
      Effect.andThen(s.start(sb, dirsB, target), s.start(asleep, dirsAsleep, target)),
    ),
  )
  // And one Sandbox from before Runner marks, whose Session no Runner here knows.
  const legacy = sessionId("s-legacy")
  const template = world.sandboxes.get(sa)
  if (template === undefined) throw new Error("no Sandbox")
  world.sandboxes.set(legacy, { ...template, runner: undefined, rootfs: new Map() })

  // Runner b restarts: it puts its own Sessions to sleep, and stops only their Sandboxes, as no
  // Session runs on it until the Hub wakes one.
  await runProcess(world, b, adopt)
  expect(b.tmux.retired).toBe(1)
  expect(stateIn(world, sb)).toBe("Stopped")
  expect(stateIn(world, asleep)).toBe("Stopped")
  expect(stateIn(world, sa)).toBe("Running")
  expect(stateIn(world, legacy)).toBe("Running")

  // Runner a restarts too, and leaves b's Sessions as b left them.
  await runProcess(world, a, adopt)
  expect(stateIn(world, sa)).toBe("Stopped")
  expect(stateIn(world, sb)).toBe("Stopped")
  expect(stateIn(world, asleep)).toBe("Stopped")
  expect(stateIn(world, legacy)).toBe("Running")
})
