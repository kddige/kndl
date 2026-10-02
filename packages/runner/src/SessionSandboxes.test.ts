import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RunnerToHub, SandboxStateReport } from "@claude-hub/protocol"
import { Effect, Layer } from "effect"
import { HubLink } from "./HubLink.ts"
import { Sandboxes } from "./Sandbox.ts"
import { FakeSandboxBackend } from "./sandbox/FakeSandboxBackend.ts"
import type { FakeOptions } from "./sandbox/FakeSandboxBackend.ts"
import { SandboxClaudeError, sandboxClaudeGuestDir } from "./sandbox/SandboxClaude.ts"
import { workspaceGuestPath } from "./sandbox/SessionLayout.ts"
import { sessionDirectories } from "./SessionNames.ts"
import { makeSessionSandboxes } from "./SessionSandboxes.ts"
import { echoTools, fakeMcpServer, sessionId } from "./testSupport.ts"

const s1 = sessionId("s-1")

/** Runs `body` with live Sandboxes on the fake backend, recording what goes to the Hub. */
const withSandboxes = async (
  body: (
    root: string,
    sent: Array<RunnerToHub>,
  ) => Effect.Effect<void, unknown, Sandboxes | FakeSandboxBackend>,
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
      sandboxClaude: options.sandboxClaude ?? Effect.succeed("2.1.287"),
      bridge: { readyTimeout: "2 seconds", restartDelay: () => "10 millis" },
    }),
  )
  try {
    await body(root, sent).pipe(
      Effect.provide(sandboxes.pipe(Layer.provideMerge(FakeSandboxBackend.layer(options)))),
      Effect.provide(hub),
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
})
