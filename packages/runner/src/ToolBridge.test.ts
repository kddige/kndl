import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolBridgeReply, ToolCallReplyEncoded } from "@claude-hub/protocol"
import { Deferred, Effect } from "effect"
import type { Duration } from "effect"
import type { FakeOptions } from "./sandbox/FakeSandboxBackend.ts"
import { FakeSandboxBackend } from "./sandbox/FakeSandboxBackend.ts"
import { SandboxBackend } from "./sandbox/SandboxBackend.ts"
import { sessionSandboxSpec } from "./sandbox/SessionLayout.ts"
import { echoTools, fakeMcpServer, sessionId } from "./testSupport.ts"
import { makeToolEngine, prepareScript, serveToolBridge, toolServerEnv } from "./ToolBridge.ts"
import type { ToolCallsOptions } from "./ToolCalls.ts"

const s1 = sessionId("s-1")
const claudePath = "/opt/claude-hub/claude-code/2.1.287/claude"

/**
 * Runs `body` against a bridge on a fake Sandbox, then checks that closing the bridge removed its
 * socket.
 */
/** One exchange with the bridge's long-call endpoints. */
type Send = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ status: number; reply: ToolCallReplyEncoded }>

const withBridge = async <A, E>(
  body: (
    call: (body: unknown) => Promise<{ status: number; reply: ToolBridgeReply }>,
    socket: string,
    send: Send,
  ) => Effect.Effect<A, E, SandboxBackend | FakeSandboxBackend>,
  options: FakeOptions & {
    readonly readyTimeout?: Duration.Input
    readonly running?: boolean
    readonly calls?: ToolCallsOptions
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
        ...(options.calls === undefined ? {} : { calls: options.calls }),
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
      const send: Send = async (method, path, request) => {
        const response = await fetch(`http://bridge${path}`, {
          method,
          unix: socket,
          ...(request === undefined ? {} : { body: JSON.stringify(request) }),
        })
        return { status: response.status, reply: (await response.json()) as ToolCallReplyEncoded }
      }
      return yield* body(call, socket, send)
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

  test("a call in flight when the server dies may have run, and the server is started again", () => {
    const started = Deferred.makeUnsafe<void>()
    let generation = 0
    return withBridge(
      (call) =>
        Effect.gen(function* () {
          const world = yield* FakeSandboxBackend
          const inFlight = call({ tool: "Bash", input: { command: "crash" } })
          yield* Deferred.await(started)
          // It reached the server, so it may have run: never "did not run".
          const lost = yield* Effect.promise(() => inFlight)
          expect(lost.status).toBe(200)
          expect(lost.reply).toMatchObject({ _tag: "ToolFailed" })
          expect((lost.reply as { message: string }).message).toContain("may have run")
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

  describe("long calls (#109)", () => {
    const sleepCall = { callId: "toolu_1-a", tool: "Bash", input: { command: "sleep 45" } }

    test("a call outlives the exchange that started it, and is waited for in steps", () => {
      const release = Deferred.makeUnsafe<void>()
      let runs = 0
      return withBridge(
        (_call, _socket, send) =>
          Effect.gen(function* () {
            const started = yield* Effect.promise(() =>
              send("POST", "/tools/calls?waitMs=20", sleepCall),
            )
            expect(started).toEqual({
              status: 202,
              reply: { _tag: "ToolRunning", callId: "toolu_1-a" },
            })
            for (let step = 0; step < 3; step++) {
              const waited = yield* Effect.promise(() =>
                send("GET", "/tools/calls/toolu_1-a?waitMs=20"),
              )
              expect(waited.status).toBe(202)
            }
            // Starting it again finds the running call: it runs once.
            const again = yield* Effect.promise(() =>
              send("POST", "/tools/calls?waitMs=0", sleepCall),
            )
            expect(again.reply._tag).toBe("ToolRunning")

            const ended = send("GET", "/tools/calls/toolu_1-a?waitMs=20000")
            yield* Deferred.succeed(release, undefined)
            expect(yield* Effect.promise(() => ended)).toEqual({
              status: 200,
              reply: {
                _tag: "ToolRan",
                result: { tool: "Bash", args: { command: "sleep 45" } },
              },
            })
            // Its result is kept for a while, for an answer that went astray.
            const kept = yield* Effect.promise(() => send("GET", "/tools/calls/toolu_1-a"))
            expect(kept.reply._tag).toBe("ToolRan")
            expect(runs).toBe(1)
          }),
        {
          onSpawn: (_call, io) =>
            fakeMcpServer((name, args) =>
              Effect.sync(() => runs++).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(echoTools(name, args)),
              ),
            )(io),
        },
      )
    })

    test("a call that ends quickly is answered by the exchange that started it", () =>
      withBridge(
        (_call, _socket, send) =>
          Effect.gen(function* () {
            const { status, reply } = yield* Effect.promise(() =>
              send("POST", "/tools/calls?waitMs=5000", {
                callId: "c1",
                tool: "Read",
                input: { file_path: "/workspace/a" },
              }),
            )
            expect(status).toBe(200)
            expect(reply._tag).toBe("ToolRan")
          }),
        { onSpawn: (_call, io) => fakeMcpServer(echoTools)(io) },
      ))

    test("cancelling a call stops its process in the Sandbox", () => {
      const cancelled: Array<number> = []
      const killed = Deferred.makeUnsafe<void>()
      return withBridge(
        (_call, _socket, send) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => send("POST", "/tools/calls?waitMs=20", sleepCall))
            const waiting = send("GET", "/tools/calls/toolu_1-a?waitMs=20000")
            const { status, reply } = yield* Effect.promise(() =>
              send("DELETE", "/tools/calls/toolu_1-a"),
            )
            expect(status).toBe(200)
            expect(reply._tag).toBe("ToolLost")
            yield* Deferred.await(killed)
            // The request the server had: the handshake was 1, this call 2.
            expect(cancelled).toEqual([2])
            // Whoever waited hears at once, with the same answer.
            expect((yield* Effect.promise(() => waiting)).reply).toEqual(reply)
          }),
        {
          onSpawn: (_call, io) =>
            fakeMcpServer(
              () =>
                Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(killed, undefined))),
              (id) => cancelled.push(id),
            )(io),
        },
      )
    })

    test("a call nothing waits for is cancelled", () => {
      const cancelled: Array<number> = []
      return withBridge(
        (_call, _socket, send) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => send("POST", "/tools/calls?waitMs=0", sleepCall))
            yield* Effect.sleep("300 millis")
            expect(cancelled).toEqual([2])
            const { reply } = yield* Effect.promise(() => send("GET", "/tools/calls/toolu_1-a"))
            expect(reply).toMatchObject({ _tag: "ToolLost" })
          }),
        {
          calls: { abandonAfter: "100 millis" },
          onSpawn: (_call, io) =>
            fakeMcpServer(
              () => Effect.never,
              (id) => cancelled.push(id),
            )(io),
        },
      )
    })

    test("closing the bridge, as the Session stops, cancels the calls still running", async () => {
      const cancelled: Array<number> = []
      await withBridge(
        (_call, _socket, send) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => send("POST", "/tools/calls?waitMs=0", sleepCall))
            yield* Effect.promise(() =>
              send("POST", "/tools/calls?waitMs=0", { ...sleepCall, callId: "toolu_2-b" }),
            )
          }),
        {
          onSpawn: (_call, io) =>
            fakeMcpServer(
              () => Effect.never,
              (id) => cancelled.push(id),
            )(io),
        },
      )
      expect(cancelled.toSorted()).toEqual([2, 3])
    })

    test("a call in flight when the server dies is lost, not refused", () => {
      const started = Deferred.makeUnsafe<void>()
      return withBridge(
        (_call, _socket, send) =>
          Effect.gen(function* () {
            const inFlight = send("POST", "/tools/calls?waitMs=20000", sleepCall)
            yield* Deferred.await(started)
            const { status, reply } = yield* Effect.promise(() => inFlight)
            expect(status).toBe(200)
            expect(reply).toMatchObject({ _tag: "ToolLost" })
          }),
        {
          onSpawn: (_call, io) =>
            Effect.race(
              fakeMcpServer(() =>
                Effect.andThen(Deferred.succeed(started, undefined), Effect.never),
              )(io),
              Effect.andThen(Deferred.await(started), Effect.succeed(1)),
            ),
        },
      )
    })

    test("refuses a call it could not send as unavailable", () =>
      withBridge(
        (_call, _socket, send) =>
          Effect.gen(function* () {
            const { status, reply } = yield* Effect.promise(() =>
              send("POST", "/tools/calls?waitMs=1000", sleepCall),
            )
            expect(status).toBe(503)
            expect(reply._tag).toBe("BridgeUnavailable")
          }),
        { running: false, readyTimeout: "100 millis" },
      ))

    test("answers an unknown call with 404, and refuses what doesn't decode", () =>
      withBridge(
        (_call, _socket, send) =>
          Effect.gen(function* () {
            const unknown = yield* Effect.promise(() => send("GET", "/tools/calls/nope"))
            expect(unknown.status).toBe(404)
            expect(unknown.reply._tag).toBe("ToolLost")
            const unknownCancel = yield* Effect.promise(() => send("DELETE", "/tools/calls/nope"))
            expect(unknownCancel.status).toBe(404)

            for (const [method, path, body] of [
              ["POST", "/tools/calls?waitMs=soon", sleepCall],
              ["POST", "/tools/calls", { ...sleepCall, callId: "has space" }],
              ["POST", "/tools/calls", { ...sleepCall, tool: "WebFetch" }],
              ["GET", "/tools/calls/bad%20id", undefined],
              ["GET", "/tools/calls/c1?waitMs=-1", undefined],
            ] as const) {
              const { status, reply } = yield* Effect.promise(() => send(method, path, body))
              expect(status).toBe(400)
              expect(reply._tag).toBe("BridgeUnavailable")
            }
          }),
        { onSpawn: (_call, io) => fakeMcpServer(echoTools)(io) },
      ))
  })
})
