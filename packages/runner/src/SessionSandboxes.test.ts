import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RunnerToHub, SandboxStateReport, SessionId } from "@claude-hub/protocol"
import { Effect, Layer, Schedule } from "effect"
import { HubGit } from "./HubGit.ts"
import { HubLink } from "./HubLink.ts"
import { Sandboxes } from "./Sandbox.ts"
import { FakeSandboxBackend } from "./sandbox/FakeSandboxBackend.ts"
import type { FakeOptions } from "./sandbox/FakeSandboxBackend.ts"
import { SandboxBackend } from "./sandbox/SandboxBackend.ts"
import { SandboxClaudeError, sandboxClaudeGuestDir } from "./sandbox/SandboxClaude.ts"
import { workspaceGuestPath } from "./sandbox/SessionLayout.ts"
import { ghHostsPath, tokenPath } from "./SandboxGitHub.ts"
import type { SandboxTokenSource } from "./SandboxGitHub.ts"
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

const s1 = sessionId("s-1")

/** Runs `body` with live Sandboxes on the fake backend, recording what goes to the Hub. */
const withSandboxes = async (
  body: (
    root: string,
    sent: Array<RunnerToHub>,
  ) => Effect.Effect<void, unknown, Sandboxes | FakeSandboxBackend | SandboxBackend>,
  options: FakeOptions & {
    readonly sandboxClaude?: Effect.Effect<string, SandboxClaudeError>
    readonly githubToken?: SandboxTokenSource
  } = {
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
      claudeCacheDir: join(root, "claude-code"),
      sandboxClaude: () => options.sandboxClaude ?? Effect.succeed("2.1.287"),
      ...sandboxesDefaults,
      bridge: { readyTimeout: "2 seconds", restartDelay: () => "10 millis" },
      ...(options.githubToken === undefined ? {} : { githubToken: options.githubToken }),
    }),
  )
  try {
    await body(root, sent).pipe(
      Effect.provide(
        sandboxes.pipe(
          Layer.provideMerge(FakeSandboxBackend.layer({ checkHostPaths: true, ...options })),
        ),
      ),
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

/** Asks the Hub for a Sandbox token. */
const hubGitAsk = (id: SessionId) =>
  Effect.flatMap(HubGit, (hubGit) => hubGit.ask(id, { _tag: "SandboxToken" }))

/** Waits, polling, until `check` holds; fails the test after a second. */
const eventually = (check: Effect.Effect<boolean, unknown>) =>
  check.pipe(
    Effect.flatMap((held) => (held ? Effect.void : Effect.fail("not yet" as const))),
    Effect.retry({ schedule: Schedule.spaced("5 millis"), times: 200 }),
  )

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
            hostPath: join(root, "claude-code"),
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

  test("keeps a running Sandbox with its own GitHub token, fresh at each start and wake", () => {
    const hubGit = new FakeHubGit("acme/app")
    hubGit.useToken("ghs_HOSTonly", {
      name: "app[bot]",
      email: "9+app[bot]@users.noreply.github.com",
    })
    return withSandboxes(
      (root) =>
        Effect.gen(function* () {
          const sandboxes = yield* Sandboxes
          const world = yield* FakeSandboxBackend
          const backend = yield* SandboxBackend
          const tokenFile = Effect.suspend(() => backend.readFile(s1, tokenPath)).pipe(
            Effect.map((bytes) => new TextDecoder().decode(bytes)),
            Effect.orElseSucceed(() => undefined),
          )
          const directories = yield* directoriesIn(root)

          yield* sandboxes.start(s1, directories)
          yield* eventually(Effect.map(tokenFile, (token) => token === "sandbox-1"))
          expect(new TextDecoder().decode(yield* backend.readFile(s1, ghHostsPath))).toContain(
            'oauth_token: "sandbox-1"',
          )

          yield* sandboxes.stop(s1, "Sleep")
          yield* sandboxes.start(s1, directories)
          yield* eventually(Effect.map(tokenFile, (token) => token === "sandbox-2"))
          expect(hubGit.asked.map((asked) => asked.ask._tag)).toEqual([
            "SandboxToken",
            "SandboxToken",
          ])

          // Neither its settings nor any command it ran were given a token.
          const seen = JSON.stringify({
            specs: [...world.sandboxes.values()].map((sandbox) => sandbox.spec),
            exec: world.execCalls,
            spawn: world.spawnCalls,
          })
          for (const token of ["ghs_HOSTonly", ...hubGit.sandboxTokens]) {
            expect(seen).not.toContain(token)
          }
        }),
      {
        onSpawn: (_call, io) => fakeMcpServer(echoTools)(io),
        githubToken: (id) => Effect.provide(hubGitAsk(id), hubGit.layer),
      },
    )
  })

  test("a Sandbox that gets no GitHub token, as without a GitHub App, starts all the same", () => {
    const hubGit = new FakeHubGit("acme/app")
    return withSandboxes(
      (root, sent) =>
        Effect.gen(function* () {
          const sandboxes = yield* Sandboxes
          const backend = yield* SandboxBackend
          yield* sandboxes.start(s1, yield* directoriesIn(root))
          yield* eventually(Effect.sync(() => hubGit.asked.length === 1))
          expect(states(sent)).toEqual(["Starting", "Running"])
          expect(
            yield* backend.readFile(s1, tokenPath).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            ),
          ).toBe(false)
        }),
      {
        onSpawn: (_call, io) => fakeMcpServer(echoTools)(io),
        githubToken: (id) => Effect.provide(hubGitAsk(id), hubGit.layer),
      },
    )
  })
})
