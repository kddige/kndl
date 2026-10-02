import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolBridgeReply } from "@claude-hub/protocol"
import { Deferred, Effect } from "effect"
import type { Duration } from "effect"
import type { FakeOptions } from "./sandbox/FakeSandboxBackend.ts"
import { FakeSandboxBackend } from "./sandbox/FakeSandboxBackend.ts"
import { SandboxBackend } from "./sandbox/SandboxBackend.ts"
import { sessionSandboxSpec } from "./sandbox/SessionLayout.ts"
import { echoTools, fakeMcpServer, sessionId } from "./testSupport.ts"
import { makeToolEngine, prepareScript, serveToolBridge, toolServerEnv } from "./ToolBridge.ts"

const s1 = sessionId("s-1")
const claudePath = "/opt/claude-hub/claude-code/2.1.287/claude"

/**
 * Runs `body` against a bridge on a fake Sandbox, then checks that closing the bridge removed its
 * socket.
 */
const withBridge = async <A, E>(
  body: (
    call: (body: unknown) => Promise<{ status: number; reply: ToolBridgeReply }>,
    socket: string,
  ) => Effect.Effect<A, E, SandboxBackend | FakeSandboxBackend>,
  options: FakeOptions & {
    readonly readyTimeout?: Duration.Input
    readonly running?: boolean
  } = {},
) => {
  const dir = await mkdtemp(join(tmpdir(), "claude-hub-bridge-"))
  const socket = join(dir, "tools.sock")
  try {
    await Effect.gen(function* () {
      const backend = yield* SandboxBackend
      yield* backend.create(
        sessionSandboxSpec({ sessionId: s1, image: "docker:dind", workspaceHostPath: dir }),
      )
      if (options.running === false) yield* backend.stop(s1)
      const engine = yield* makeToolEngine({
        sessionId: s1,
        claudePath,
        workspaceAlias: "/host/sessions/s-1/claude",
        readyTimeout: options.readyTimeout ?? "2 seconds",
        restartDelay: () => "10 millis",
      })
      yield* serveToolBridge(socket, engine)
      const call = async (request: unknown) => {
        const response = await fetch("http://bridge/tools/call", {
          method: "POST",
          unix: socket,
          body: typeof request === "string" ? request : JSON.stringify(request),
        })
        return { status: response.status, reply: (await response.json()) as ToolBridgeReply }
      }
      return yield* body(call, socket)
    }).pipe(Effect.scoped, Effect.provide(FakeSandboxBackend.layer(options)), Effect.runPromise)
    expect(await stat(socket).catch(() => "gone")).toBe("gone")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("the tool bridge", () => {
  test("runs tool calls through claude mcp serve in the Sandbox, over a 0600 socket", () =>
    withBridge(
      (call, socket) =>
        Effect.gen(function* () {
          const world = yield* FakeSandboxBackend
          const ran = yield* Effect.promise(() =>
            call({ tool: "Read", input: { file_path: "/workspace/a.ts" } }),
          )
          expect(ran).toEqual({
            status: 200,
            reply: {
              _tag: "ToolRan",
              result: { tool: "Read", args: { file_path: "/workspace/a.ts" } },
            },
          })
          expect((yield* Effect.promise(() => stat(socket))).mode & 0o777).toBe(0o600)

          // Prepared, then started once, with no credentials and none of the Runner's environment.
          expect(world.execCalls.map((c) => c.request.args?.[1])).toEqual([prepareScript])
          expect(world.execCalls[0]?.request.env).toEqual({
            CLAUDE_HUB_CLAUDE: claudePath,
            CLAUDE_HUB_ALIAS: "/host/sessions/s-1/claude",
          })
          expect(world.spawnCalls.map((c) => c.request)).toEqual([
            { command: claudePath, args: ["mcp", "serve"], cwd: "/workspace", env: toolServerEnv },
          ])
        }),
      { onSpawn: (_call, io) => fakeMcpServer(echoTools)(io) },
    ))

  test("reports a tool's own error as ToolFailed", () =>
    withBridge(
      (call) =>
        Effect.gen(function* () {
          const failed = yield* Effect.promise(() =>
            call({ tool: "Bash", input: { command: "exit 2" } }),
          )
          expect(failed).toEqual({
            status: 200,
            reply: { _tag: "ToolFailed", message: "Exit code 2" },
          })
        }),
      { onSpawn: (_call, io) => fakeMcpServer(echoTools)(io) },
    ))

  test("refuses background Bash without running it", () =>
    withBridge(
      (call) =>
        Effect.gen(function* () {
          const world = yield* FakeSandboxBackend
          const { reply } = yield* Effect.promise(() =>
            call({ tool: "Bash", input: { command: "sleep 9", run_in_background: true } }),
          )
          expect(reply._tag).toBe("ToolFailed")
          expect(world.spawnCalls.length).toBeLessThanOrEqual(1)
        }),
      { onSpawn: (_call, io) => fakeMcpServer(() => Effect.die("must not run"))(io) },
    ))

  test("refuses calls that don't decode, and tools it doesn't run", () =>
    withBridge(
      (call) =>
        Effect.gen(function* () {
          for (const body of ["not json", { tool: "WebFetch", input: {} }, { tool: "Bash" }]) {
            const { status, reply } = yield* Effect.promise(() => call(body))
            expect(status).toBe(400)
            expect(reply._tag).toBe("BridgeUnavailable")
          }
        }),
      { onSpawn: (_call, io) => fakeMcpServer(echoTools)(io) },
    ))

  test("a call in flight when the server dies is refused, and the server is started again", () => {
    const started = Deferred.makeUnsafe<void>()
    let generation = 0
    return withBridge(
      (call) =>
        Effect.gen(function* () {
          const world = yield* FakeSandboxBackend
          const inFlight = call({ tool: "Bash", input: { command: "crash" } })
          yield* Deferred.await(started)
          const lost = yield* Effect.promise(() => inFlight)
          expect(lost.status).toBe(503)
          expect(lost.reply).toMatchObject({ _tag: "BridgeUnavailable" })
          expect((lost.reply as { message: string }).message).toContain("exited with 1")

          const again = yield* Effect.promise(() =>
            call({ tool: "Bash", input: { command: "ls" } }),
          )
          expect(again.reply._tag).toBe("ToolRan")
          expect(world.spawnCalls.length).toBe(2)
        }),
      {
        onSpawn: (_call, io) => {
          generation += 1
          if (generation > 1) return fakeMcpServer(echoTools)(io)
          // The first server crashes in the middle of its first tool call.
          return Effect.race(
            fakeMcpServer(() => Effect.andThen(Deferred.succeed(started, undefined), Effect.never))(
              io,
            ),
            Effect.andThen(Deferred.await(started), io.stderr("boom")).pipe(Effect.as(1)),
          )
        },
      },
    )
  })

  test("refuses calls while the Sandbox is not running", () =>
    withBridge(
      (call) =>
        Effect.gen(function* () {
          const { status, reply } = yield* Effect.promise(() =>
            call({ tool: "Read", input: { file_path: "/workspace/a" } }),
          )
          expect(status).toBe(503)
          expect(reply._tag).toBe("BridgeUnavailable")
          expect((reply as { message: string }).message).toContain("not up")
        }),
      { running: false, readyTimeout: "100 millis" },
    ))

  test("refuses calls when the Sandbox can't be prepared", () =>
    withBridge(
      (call) =>
        Effect.gen(function* () {
          const { reply } = yield* Effect.promise(() =>
            call({ tool: "Read", input: { file_path: "/workspace/a" } }),
          )
          expect(reply).toEqual({
            _tag: "BridgeUnavailable",
            message:
              "the Sandbox's tool server is not up: preparing the Sandbox failed: the Sandbox image has no bash",
          })
        }),
      {
        readyTimeout: "200 millis",
        onExec: () => Effect.succeed({ exitCode: 1, stderr: "the Sandbox image has no bash\n" }),
      },
    ))
})
