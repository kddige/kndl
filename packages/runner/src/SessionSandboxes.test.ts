import { describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RunnerToHub, SandboxStateReport } from "@claude-hub/protocol"
import { wipRef } from "@claude-hub/protocol"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer, Redacted, References } from "effect"
import { authorizationHeader } from "./HostGit.ts"
import { HubLink } from "./HubLink.ts"
import { RunnerConfig } from "./RunnerConfig.ts"
import { Sandboxes } from "./Sandbox.ts"
import { FakeSandboxBackend } from "./sandbox/FakeSandboxBackend.ts"
import type { FakeOptions } from "./sandbox/FakeSandboxBackend.ts"
import { SandboxBackend } from "./sandbox/SandboxBackend.ts"
import { SandboxClaudeError, sandboxClaudeGuestDir } from "./sandbox/SandboxClaude.ts"
import { workspaceGuestPath } from "./sandbox/SessionLayout.ts"
import { sessionDirectories } from "./SessionNames.ts"
import { makeSessionSandboxes } from "./SessionSandboxes.ts"
import {
  echoTools,
  FakeHubGit,
  FakeHubVariables,
  fakeMcpServer,
  sandboxesDefaults,
  sessionId,
} from "./testSupport.ts"
import { Workspaces, WorkspacesGitClone } from "./Workspace.ts"
import { WorkspaceGit, WorkspaceGitLive } from "./WorkspaceGit.ts"

const s1 = sessionId("s-1")

/** Runs `body` with live Sandboxes on the fake backend, recording what goes to the Hub. */
const withSandboxes = async (
  body: (
    root: string,
    sent: Array<RunnerToHub>,
  ) => Effect.Effect<void, unknown, Sandboxes | FakeSandboxBackend | SandboxBackend>,
  options: FakeOptions & { readonly sandboxClaude?: Effect.Effect<string, SandboxClaudeError> } = {
    onSpawn: (_call, io) => fakeMcpServer(echoTools)(io),
  },
) => {
  const root = await mkdtemp(join(tmpdir(), "claude-hub-sandboxes-"))
  const sent: Array<RunnerToHub> = []
  const hub = Layer.succeed(
    HubLink,
    HubLink.of({
      send: (message) => Effect.sync(() => void sent.push(message)),
      connect: () => Effect.void,
      disconnect: Effect.void,
    }),
  )
  const sandboxes = Layer.effect(
    Sandboxes,
    makeSessionSandboxes({
      image: "docker:dind",
      claudeCacheDir: "/host/claude-code",
      sandboxClaude: () => options.sandboxClaude ?? Effect.succeed("2.1.287"),
      ...sandboxesDefaults,
      bridge: { readyTimeout: "2 seconds", restartDelay: () => "10 millis" },
    }),
  )
  try {
    await body(root, sent).pipe(
      Effect.provide(sandboxes.pipe(Layer.provideMerge(FakeSandboxBackend.layer(options)))),
      Effect.provide(hub),
      Effect.provide(new FakeHubVariables().layer),
      Effect.scoped,
      Effect.runPromise,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const states = (sent: ReadonlyArray<RunnerToHub>) =>
  sent.filter((m): m is SandboxStateReport => m._tag === "SandboxStateReport").map((m) => m.state)

const directoriesIn = (root: string) =>
  Effect.promise(async () => {
    const directories = sessionDirectories(root, s1)
    await mkdir(directories.workspace, { recursive: true })
    await mkdir(directories.claude, { recursive: true })
    return directories
  })

const callTool = (socket: string, body: unknown) =>
  Effect.promise(async () => {
    const response = await fetch("http://bridge/tools/call", {
      method: "POST",
      unix: socket,
      body: JSON.stringify(body),
    })
    return (await response.json()) as unknown
  })

/** Real git in `cwd`, as a test user. */
function gitIn(cwd: string, ...args: Array<string>) {
  const result = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

const callGit = (socket: string, body: unknown) =>
  Effect.promise(async () => {
    const response = await fetch("http://bridge/git/call", {
      method: "POST",
      unix: socket,
      body: JSON.stringify(body),
    })
    return (await response.json()) as unknown
  })

const exists = (path: string) =>
  Effect.promise(() =>
    stat(path).then(
      () => true,
      () => false,
    ),
  )

describe("SessionSandboxes", () => {
  test("boots the Session's Sandbox around its Workspace and serves its tools, then stops it", () =>
    withSandboxes((root, sent) =>
      Effect.gen(function* () {
        const sandboxes = yield* Sandboxes
        const world = yield* FakeSandboxBackend
        const directories = yield* directoriesIn(root)

        yield* sandboxes.start(s1, directories)
        const spec = world.sandboxes.get(s1)?.spec
        expect(spec?.mounts).toContainEqual(
          expect.objectContaining({
            _tag: "Host",
            hostPath: directories.workspace,
            guestPath: workspaceGuestPath,
          }),
        )
        // Claude Code for `mcp serve`, read-only; and nothing of the host's Claude configuration.
        expect(spec?.mounts).toContainEqual(
          expect.objectContaining({
            hostPath: "/host/claude-code",
            guestPath: sandboxClaudeGuestDir,
            readOnly: true,
          }),
        )
        expect(JSON.stringify(spec)).not.toContain(".claude.json")
        expect(states(sent)).toEqual(["Starting", "Running"])
        expect((yield* Effect.promise(() => stat(directories.session))).mode & 0o777).toBe(0o700)

        const reply = yield* callTool(directories.toolsSocket, {
          tool: "Bash",
          input: { command: "ls" },
        })
        expect(reply).toEqual({
          _tag: "ToolRan",
          result: { tool: "Bash", args: { command: "ls" } },
        })
        // The model's paths, under the directory Claude Code runs in, lead to the Workspace.
        expect(world.execCalls[0]?.request.env?.["CLAUDE_HUB_ALIAS"]).toBe(directories.claude)

        yield* sandboxes.stop(s1, "Sleep")
        expect(world.sandboxes.get(s1)?.state).toBe("Stopped")
        expect(yield* exists(directories.toolsSocket)).toBe(false)

        // Waking starts the same Sandbox again rather than creating another.
        yield* sandboxes.start(s1, directories)
        expect(world.sandboxes.get(s1)?.state).toBe("Running")
        expect(yield* exists(directories.toolsSocket)).toBe(true)
        // Starting a running one changes nothing.
        yield* sandboxes.start(s1, directories)

        yield* sandboxes.stop(s1, "Archive")
        expect(world.sandboxes.has(s1)).toBe(false)
        expect(states(sent)).toEqual([
          "Starting",
          "Running",
          "Stopping",
          "Stopped",
          "Starting",
          "Running",
          "Stopping",
          "Destroyed",
        ])
      }),
    ))

  test("a Sandbox that can't get Claude Code fails to start, and the next start tries again", () => {
    let attempts = 0
    return withSandboxes(
      (root, sent) =>
        Effect.gen(function* () {
          const sandboxes = yield* Sandboxes
          const world = yield* FakeSandboxBackend
          const directories = yield* directoriesIn(root)

          const failed = yield* Effect.flip(sandboxes.start(s1, directories))
          expect(failed.message).toContain("registry said 404")
          expect(sent).toContainEqual(
            expect.objectContaining({ _tag: "SandboxStateReport", state: "Failed" }),
          )
          expect(world.sandboxes.size).toBe(0)

          yield* sandboxes.start(s1, directories)
          expect(attempts).toBe(2)
          expect(world.sandboxes.get(s1)?.state).toBe("Running")
        }),
      {
        onSpawn: (_call, io) => fakeMcpServer(echoTools)(io),
        sandboxClaude: Effect.suspend(() => {
          attempts += 1
          return attempts === 1
            ? Effect.fail(new SandboxClaudeError({ message: "registry said 404" }))
            : Effect.succeed("2.1.287")
        }),
      },
    )
  })

  test("archiving destroys the Sandbox and its volumes; a restored Session wakes on fresh ones", () =>
    withSandboxes((root) =>
      Effect.gen(function* () {
        const sandboxes = yield* Sandboxes
        const world = yield* FakeSandboxBackend
        const directories = yield* directoriesIn(root)
        yield* sandboxes.start(s1, directories)
        const volumes = [...world.volumes.keys()]
        expect(volumes.length).toBeGreaterThan(0)
        for (const name of volumes) world.volumes.get(name)?.set("/kept", new Uint8Array([1]))

        yield* sandboxes.stop(s1, "Archive")
        expect(world.sandboxes.has(s1)).toBe(false)
        expect(world.volumes.size).toBe(0)

        // Woken after a restore: a new Sandbox on the kept Workspace, with empty volumes.
        yield* sandboxes.start(s1, directories)
        expect(world.sandboxes.get(s1)?.state).toBe("Running")
        expect(world.sandboxes.get(s1)?.spec.mounts).toContainEqual(
          expect.objectContaining({ _tag: "Host", hostPath: directories.workspace }),
        )
        expect([...world.volumes.keys()].toSorted()).toEqual([...volumes].toSorted())
        for (const files of world.volumes.values()) expect(files.has("/kept")).toBe(false)
      }),
    ))

  test("purging destroys whatever is left: the Sandbox, or only its volumes", () =>
    withSandboxes((root, sent) =>
      Effect.gen(function* () {
        const sandboxes = yield* Sandboxes
        const world = yield* FakeSandboxBackend
        const directories = yield* directoriesIn(root)
        yield* sandboxes.start(s1, directories)
        yield* sandboxes.purge(s1)
        expect(world.sandboxes.has(s1)).toBe(false)
        expect(world.volumes.size).toBe(0)
        expect(yield* exists(directories.toolsSocket)).toBe(false)

        // Volumes left over from a Sandbox destroyed while keeping them.
        yield* sandboxes.start(s1, directories)
        const backend = yield* SandboxBackend
        yield* backend.destroy(s1, { keepVolumes: true })
        expect(world.volumes.size).toBeGreaterThan(0)
        yield* sandboxes.purge(s1)
        expect(world.volumes.size).toBe(0)

        // Nothing left is fine.
        const before = sent.length
        yield* sandboxes.purge(s1)
        expect(sent.length).toBe(before)
      }),
    ))

  test("reconciling stops Sandboxes of Sessions that aren't running", () =>
    withSandboxes((root) =>
      Effect.gen(function* () {
        const sandboxes = yield* Sandboxes
        const world = yield* FakeSandboxBackend
        yield* sandboxes.start(s1, yield* directoriesIn(root))
        yield* sandboxes.reconcile([])
        expect(world.sandboxes.get(s1)?.state).toBe("Stopped")
      }),
    ))

  test.skipIf(Bun.which("git") === null)(
    "serves the git tools on the host, and their token never reaches the Sandbox",
    async () => {
      const token = "ghs_NEVERinTHEsandbox0123456789"
      const root = await mkdtemp(join(tmpdir(), "claude-hub-sandbox-git-"))
      const origin = join(root, "acme", "origin")
      await mkdir(origin, { recursive: true })
      gitIn(origin, "init", "--quiet", "--bare", "--initial-branch=main")
      gitIn(root, "clone", "--quiet", origin, join(root, "seed"))
      writeFileSync(join(root, "seed", "README.md"), "hello\n")
      gitIn(join(root, "seed"), "add", ".")
      gitIn(join(root, "seed"), "commit", "--quiet", "-m", "first")
      gitIn(join(root, "seed"), "push", "--quiet", "origin", "HEAD:main")

      const hubGit = new FakeHubGit({
        repo: "acme/origin",
        baseBranch: "main",
        workBranch: "claude/s-1",
      })
      hubGit.useToken(token, { name: "app[bot]", email: "9+app[bot]@users.noreply.github.com" })
      const config = Layer.succeed(
        RunnerConfig,
        RunnerConfig.of({
          hubUrl: new URL("http://hub.test"),
          name: "test",
          token: Redacted.make("runner-token"),
          login: undefined,
          sessionsRoot: join(root, "sessions"),
          modDir: root,
          claudeBin: "claude",
          tmuxSocket: "unused",
          repoUrlTemplate: `${root}/{repo}`,
        }),
      )
      const git = Layer.mergeAll(WorkspaceGitLive, WorkspacesGitClone).pipe(
        Layer.provide(hubGit.layer),
        Layer.provide(config),
        Layer.provide(BunServices.layer),
      )
      const hub = Layer.succeed(
        HubLink,
        HubLink.of({
          send: () => Effect.void,
          connect: () => Effect.void,
          disconnect: Effect.void,
        }),
      )
      try {
        await Effect.gen(function* () {
          const workspaceGit = yield* WorkspaceGit
          const world = yield* FakeSandboxBackend
          const directories = yield* (yield* Workspaces).prepare({
            _tag: "StartSession",
            sessionId: s1,
            repo: "acme/origin" as never,
            baseBranch: "main" as never,
            workBranch: "claude/s-1" as never,
            modToken: "m",
          })
          const sandboxes = yield* makeSessionSandboxes({
            image: "docker:dind",
            claudeCacheDir: "/host/claude-code",
            sandboxClaude: () => Effect.succeed("2.1.287"),
            ...sandboxesDefaults,
            bridge: { readyTimeout: "2 seconds", restartDelay: () => "10 millis" },
            git: workspaceGit,
          })
          yield* sandboxes.start(s1, directories)

          writeFileSync(join(directories.workspace, "a.txt"), "a\n")
          expect(
            yield* callGit(directories.toolsSocket, {
              tool: "git_commit",
              input: { message: "Add a", all: true },
            }),
          ).toMatchObject({ _tag: "ToolRan" })
          expect(
            yield* callGit(directories.toolsSocket, { tool: "git_push", input: {} }),
          ).toMatchObject({ _tag: "ToolRan" })
          expect(
            yield* callGit(directories.toolsSocket, { tool: "rm_rf", input: {} }),
          ).toMatchObject({
            _tag: "BridgeUnavailable",
          })
          expect(
            yield* callTool(directories.toolsSocket, {
              tool: "Bash",
              input: { command: "git log" },
            }),
          ).toMatchObject({ _tag: "ToolRan" })
          writeFileSync(join(directories.workspace, "b.txt"), "b\n")
          yield* workspaceGit.pushWip(s1, directories, "Sleep")
          yield* sandboxes.stop(s1, "Sleep")

          // The commit and both pushes happened, on the host.
          expect(gitIn(origin, "rev-parse", "claude/s-1")).toBe(
            gitIn(directories.workspace, "rev-parse", "HEAD"),
          )
          expect(gitIn(origin, "rev-parse", "--verify", wipRef(s1))).not.toBe("")
          // The Sandbox saw neither the token nor the header carrying it: not in its spec (env,
          // mounts), not in any command it ran or the environment it ran it with.
          const header = authorizationHeader(Redacted.make(token))
          const seen = JSON.stringify({
            specs: [...world.sandboxes.values()].map((sandbox) => sandbox.spec),
            exec: world.execCalls,
            spawn: world.spawnCalls,
          })
          expect(seen).toContain("mcp")
          expect(seen).not.toContain(token)
          expect(seen).not.toContain(header.slice("Authorization: Basic ".length))
          expect(readFileSync(join(directories.workspace, ".git", "config"), "utf8")).not.toContain(
            token,
          )
          expect(readFileSync(join(directories.hostGit, "config"), "utf8")).not.toContain(token)
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              FakeSandboxBackend.layer({ onSpawn: (_call, io) => fakeMcpServer(echoTools)(io) }),
              git,
              hub,
              new FakeHubVariables().layer,
            ),
          ),
          Effect.scoped,
          Effect.provideService(References.MinimumLogLevel, "None"),
          Effect.runPromise,
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )
})
