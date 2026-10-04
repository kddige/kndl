// The tool bridge (ADR 0001): Claude Code runs on the host, and the mod answers its file and
// command tools from the Session's Sandbox by calling this bridge.
//
// Per Session, the Runner keeps one `claude mcp serve` running inside the Sandbox, restarting it
// whenever it exits, and serves `POST /tools/call` (see the protocol's ToolBridge.ts) on a Unix
// socket in the Session's directory that only the Runner's user can open. The same socket serves
// `POST /git/call` for the mod's git tools, which run on the host (the protocol's Git.ts).
//
// The server in the Sandbox runs with no Claude credentials and no host configuration: it gets
// the Sandbox's own environment, its login shell's environment and the Environment's variables
// (ADR 0009, #67) and the few variables below, nothing of the Runner's. They are passed to the
// server's process alone, so the commands it runs inherit them while the VM's stored settings
// never hold them. Claude Code's Bash tool sources ~/.bashrc for its functions and aliases, but
// takes PATH from the server's own environment, so the login environment's PATH must be there.

import { chmod, rm } from "node:fs/promises"
import type { SessionId } from "@claude-hub/protocol"
import { GitToolCall, ToolBridgeCall, ToolBridgeReply } from "@claude-hub/protocol"
import { Data, Deferred, Duration, Effect, Exit, Schema } from "effect"
import type { Scope } from "effect"
import { connectMcp } from "./McpClient.ts"
import type { McpError, McpSession } from "./McpClient.ts"
import { SandboxBackend, shell } from "./sandbox/SandboxBackend.ts"
import type { SandboxError } from "./sandbox/SandboxBackend.ts"
import { workspaceGuestPath } from "./sandbox/SessionLayout.ts"

export class ToolBridgeError extends Data.TaggedError("ToolBridgeError")<{
  readonly message: string
}> {}

export interface ToolEngineOptions {
  readonly sessionId: SessionId
  /** The `claude` binary inside the Sandbox. */
  readonly claudePath: string
  /**
   * A host path the model knows the Workspace by, such as the directory Claude Code runs in. It
   * is made a link to /workspace in the Sandbox, so the paths the model uses work there too.
   */
  readonly workspaceAlias?: string
  /**
   * More environment for the server and every command it runs, such as the Sandbox's login
   * environment and the Environment's variables, read each time the server starts. A failure
   * keeps it down until the next try.
   */
  readonly env?: Effect.Effect<Readonly<Record<string, string>>, ToolBridgeError>
  /** How long a call waits for the server to come up. */
  readonly readyTimeout?: Duration.Input
  /** How long to wait before starting the server again after its `attempt`th failure in a row. */
  readonly restartDelay?: (attempt: number) => Duration.Input
}

export interface ToolEngine {
  /** Runs one tool call in the Sandbox. Never fails: problems come back as `BridgeUnavailable`. */
  readonly call: (call: ToolBridgeCall) => Effect.Effect<ToolBridgeReply>
}

/** For the server in the Sandbox: no updates, no telemetry, no background tasks. */
export const toolServerEnv = {
  DISABLE_AUTOUPDATER: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  SHELL: "/bin/bash",
} as const

/**
 * Readies the Sandbox for the server: checks the binary is there, installs bash where the image
 * lacks it (Claude Code's Bash tool needs it, and the default `docker:dind` is Alpine without
 * it), and links the Workspace alias to /workspace.
 */
export const prepareScript = `set -e
test -x "$CLAUDE_HUB_CLAUDE" || { echo "no Claude Code at $CLAUDE_HUB_CLAUDE" >&2; exit 1; }
if ! command -v bash >/dev/null 2>&1; then
  if command -v apk >/dev/null 2>&1; then apk add --no-cache --quiet bash >&2
  else echo "the Sandbox image has no bash" >&2; exit 1; fi
fi
if [ -n "$CLAUDE_HUB_ALIAS" ] && [ "$CLAUDE_HUB_ALIAS" != "${workspaceGuestPath}" ]; then
  mkdir -p "$(dirname "$CLAUDE_HUB_ALIAS")"
  [ -L "$CLAUDE_HUB_ALIAS" ] || rmdir "$CLAUDE_HUB_ALIAS" 2>/dev/null || true
  ln -sfn ${workspaceGuestPath} "$CLAUDE_HUB_ALIAS"
fi`

const defaultRestartDelay = (attempt: number) =>
  Duration.millis(Math.min(250 * 2 ** Math.min(attempt, 6), 10_000))

/** A server that stayed up this long counts as healthy: the next failure starts the backoff over. */
const healthyAfter = Duration.seconds(30)

const unavailable = (message: string) => ToolBridgeReply.cases.BridgeUnavailable.make({ message })

/** Turns `tools/call`'s answer into the bridge's reply. */
export const replyFromMcp = (result: unknown): ToolBridgeReply => {
  const { content, isError } = (result ?? {}) as { content?: unknown; isError?: unknown }
  const text = Array.isArray(content)
    ? content
        .filter((block): block is { type: "text"; text: string } => block?.type === "text")
        .map((block) => block.text)
        .join("\n")
    : undefined
  if (text === undefined) return unavailable("the tool server's answer had no content")
  if (isError === true) return ToolBridgeReply.cases.ToolFailed.make({ message: text })
  // `claude mcp serve` answers with the tool's own record, JSON-encoded in one text block.
  try {
    return ToolBridgeReply.cases.ToolRan.make({ result: JSON.parse(text) })
  } catch {
    return unavailable(`the tool server's answer was not a tool record: ${text.slice(0, 500)}`)
  }
}

/** Why the server couldn't be started, in words. */
const describeFailure = (exit: Exit.Exit<unknown, SandboxError | McpError | ToolBridgeError>) => {
  const error = Exit.findErrorOption(exit)
  if (error._tag === "None") return "the tool server failed to start"
  switch (error.value._tag) {
    case "SandboxNotRunning":
      return `the Sandbox is ${error.value.state}`
    case "SandboxNotFound":
      return "the Session has no Sandbox"
    default:
      return error.value.message
  }
}

/**
 * Keeps `claude mcp serve` running in the Session's Sandbox for as long as the scope is open,
 * starting it again whenever it exits, and runs tool calls through it.
 */
export const makeToolEngine = (
  options: ToolEngineOptions,
): Effect.Effect<ToolEngine, never, SandboxBackend | Scope.Scope> =>
  Effect.gen(function* () {
    const backend = yield* SandboxBackend
    const { sessionId } = options
    const readyTimeout = options.readyTimeout ?? Duration.seconds(60)
    const restartDelay = options.restartDelay ?? defaultRestartDelay

    /** The server calls go to: completed once it is up, replaced once it is gone. */
    let current = yield* Deferred.make<McpSession>()
    let lastProblem: string | undefined

    /** Starts the server, and waits until it exits. Returns why it went away. */
    const runOnce = Effect.gen(function* () {
      const prepared = yield* backend.exec(
        sessionId,
        shell(prepareScript, {
          env: {
            CLAUDE_HUB_CLAUDE: options.claudePath,
            CLAUDE_HUB_ALIAS: options.workspaceAlias ?? "",
          },
        }),
      )
      if (prepared.exitCode !== 0)
        return yield* new ToolBridgeError({
          message: `preparing the Sandbox failed: ${prepared.stderr.trim() || prepared.exitCode}`,
        })
      const env = options.env === undefined ? {} : yield* options.env
      const command = yield* backend.spawn(sessionId, {
        command: options.claudePath,
        args: ["mcp", "serve"],
        cwd: workspaceGuestPath,
        env: { ...env, ...toolServerEnv },
      })
      const session = yield* connectMcp(command, "claude-hub-runner")
      yield* Deferred.succeed(current, session)
      lastProblem = undefined
      yield* Effect.logInfo(`Session ${sessionId}: tool server up`)
      const why = yield* Deferred.await(session.closed)
      yield* command.closeStdin
      return why
    }).pipe(Effect.scoped)

    const supervise = Effect.gen(function* () {
      let attempt = 0
      while (true) {
        const started = Date.now()
        const exit = yield* Effect.exit(runOnce)
        const problem = Exit.isSuccess(exit) ? exit.value : describeFailure(exit)
        // Said once per new problem, not on every retry.
        if (problem !== lastProblem)
          yield* Effect.logWarning(`Session ${sessionId}: tool server down: ${problem}`)
        lastProblem = problem
        if (yield* Deferred.isDone(current)) current = yield* Deferred.make<McpSession>()
        attempt = Date.now() - started >= Duration.toMillis(healthyAfter) ? 0 : attempt + 1
        yield* Effect.sleep(restartDelay(attempt))
      }
    })
    yield* Effect.forkScoped(supervise)

    const call = (request: ToolBridgeCall): Effect.Effect<ToolBridgeReply> =>
      Effect.gen(function* () {
        // Background Bash leaves its output in the Sandbox where Claude Code can't find it (spike
        // #2), so it is refused here as well as in the mod.
        if (request.tool === "Bash" && request.input["run_in_background"] === true)
          return ToolBridgeReply.cases.ToolFailed.make({
            message:
              "Background commands are not available here. Run the command in the foreground.",
          })
        const session = yield* Deferred.await(current).pipe(Effect.timeoutOption(readyTimeout))
        if (session._tag === "None")
          return unavailable(
            `the Sandbox's tool server is not up${lastProblem === undefined ? "" : `: ${lastProblem}`}`,
          )
        return yield* session.value
          .request("tools/call", { name: request.tool, arguments: request.input })
          .pipe(
            Effect.map(replyFromMcp),
            Effect.catchTags({
              McpRpcError: (error) =>
                Effect.succeed(ToolBridgeReply.cases.ToolFailed.make({ message: error.message })),
              McpClosed: (error) => Effect.succeed(unavailable(error.message)),
            }),
          )
      })

    return { call }
  })

const json = (reply: ToolBridgeReply, status: number) =>
  Response.json(Schema.encodeSync(ToolBridgeReply)(reply), { status })

const decodeCall = Schema.decodeUnknownExit(ToolBridgeCall)
const decodeGitCall = Schema.decodeUnknownExit(GitToolCall)

/** Answers the mod's git tools on the host (WorkspaceGit.ts). Never fails. */
export type GitToolHandler = (call: GitToolCall) => Effect.Effect<ToolBridgeReply>

const noGit: GitToolHandler = (call) =>
  Effect.succeed(unavailable(`${call.tool} is not available on this Runner`))

/** Answers one HTTP request to the bridge. */
export const handleBridgeRequest = async (
  engine: ToolEngine,
  request: Request,
  git: GitToolHandler = noGit,
) => {
  const url = new URL(request.url)
  if (request.method !== "POST") return new Response("not found", { status: 404 })
  if (url.pathname === "/tools/call") {
    const body: unknown = await request.json().catch(() => undefined)
    const decoded = decodeCall(body)
    if (Exit.isFailure(decoded)) return json(unavailable("the tool call did not decode"), 400)
    const reply = await Effect.runPromise(engine.call(decoded.value))
    return json(reply, reply._tag === "BridgeUnavailable" ? 503 : 200)
  }
  if (url.pathname === "/git/call") {
    const body: unknown = await request.json().catch(() => undefined)
    const decoded = decodeGitCall(body)
    if (Exit.isFailure(decoded)) return json(unavailable("the git tool call did not decode"), 400)
    const reply = await Effect.runPromise(git(decoded.value))
    return json(reply, reply._tag === "BridgeUnavailable" ? 503 : 200)
  }
  return new Response("not found", { status: 404 })
}

/**
 * Serves the bridge on a Unix socket only the Runner's user may open, for as long as the scope
 * is open. A socket left behind by an earlier run is replaced.
 */
export const serveToolBridge = (
  socketPath: string,
  engine: ToolEngine,
  git?: GitToolHandler,
): Effect.Effect<void, ToolBridgeError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        await rm(socketPath, { force: true })
        const server = Bun.serve({
          unix: socketPath,
          fetch: (request, self) => {
            // A Bash call may run for up to 10 minutes; never drop the connection while it does.
            self.timeout(request, 0)
            return handleBridgeRequest(engine, request, git)
          },
        })
        try {
          await chmod(socketPath, 0o600)
        } catch (error) {
          await server.stop(true)
          throw error
        }
        return server
      },
      catch: (error) =>
        new ToolBridgeError({
          message: `could not serve the tool bridge on ${socketPath}: ${String(error)}`,
        }),
    }),
    (server) =>
      Effect.promise(async () => {
        await server.stop(true)
        await rm(socketPath, { force: true })
      }),
  ).pipe(Effect.asVoid)
