// Helpers for the Runner's tests. Not used by the Runner itself.
import { SessionId, type StartSession, type TerminalSize } from "@claude-hub/protocol"
import { type Cause, Effect, Layer, Queue, Schema, Stream } from "effect"
import { Sandboxes } from "./Sandbox.ts"
import type { FakeProcessIO } from "./sandbox/FakeSandboxBackend.ts"
import { sessionDirectories } from "./SessionNames.ts"
import { type LaunchSpec, type PaneEvent, Tmux, TmuxError } from "./Tmux.ts"
import { WorkspaceError, Workspaces } from "./Workspace.ts"

export const sessionId = (id: string) => Schema.decodeSync(SessionId)(id)

/** Re-runs `check` every 20 ms until it returns true, failing after `timeoutMs`. */
export const waitFor = <E, R>(check: Effect.Effect<boolean, E, R>, timeoutMs = 5_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs
    while (!(yield* check)) {
      if (Date.now() > deadline) return yield* Effect.die(new Error("timed out waiting"))
      yield* Effect.sleep("20 millis")
    }
  })

/** {@link waitFor} for plain promises, polling a synchronous check. */
export async function eventually(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting")
    await Bun.sleep(10)
  }
}

/** One fake tmux session: records what was typed into it, and emits what a test tells it to. */
export class FakePane {
  readonly inputs: Array<string> = []
  readonly resizes: Array<TerminalSize> = []
  snapshots = 0
  terminated = false
  attached = false
  private queue: Queue.Queue<PaneEvent, Cause.Done> | undefined

  constructor(
    readonly spec: LaunchSpec,
    private size: TerminalSize = spec.size,
  ) {}

  /** Makes the terminal print `data`, or its process exit. */
  emit(event: PaneEvent): void {
    if (this.queue === undefined) throw new Error("not attached")
    Queue.offerUnsafe(this.queue, event)
    if (event._tag === "Exited") Queue.endUnsafe(this.queue)
  }

  output(data: string): void {
    this.emit({ _tag: "Output", data, size: this.size })
  }

  attach(queue: Queue.Queue<PaneEvent, Cause.Done>) {
    this.queue = queue
    this.attached = true
    return {
      events: Stream.fromQueue(queue),
      input: (data: string) => Effect.sync(() => void this.inputs.push(data)),
      resize: (size: TerminalSize) =>
        Effect.sync(() => {
          this.size = size
          this.resizes.push(size)
        }),
      snapshot: Effect.sync(() => {
        this.snapshots += 1
        this.emit({ _tag: "Snapshot", data: `screen of ${this.spec.sessionId}`, size: this.size })
      }),
      // Claude Code exits on SIGTERM with 143.
      terminate: Effect.sync(() => {
        this.terminated = true
        this.emit({ _tag: "Exited", exitCode: 143 })
      }),
    }
  }

  /** The tmux session is gone: the attached client's stream ends. */
  detach(): void {
    if (this.queue !== undefined) Queue.endUnsafe(this.queue)
  }
}

/** tmux, in memory. */
export class FakeTmux {
  readonly panes = new Map<SessionId, FakePane>()
  readonly launched: Array<LaunchSpec> = []
  readonly killed: Array<SessionId> = []

  /** Pretends a Session was left running in tmux by an earlier Runner. */
  leaveRunning(id: SessionId): FakePane {
    const pane = new FakePane({
      sessionId: id,
      cwd: "/",
      argv: [],
      env: {},
      size: { cols: 80, rows: 24 },
    })
    this.panes.set(id, pane)
    return pane
  }

  pane(id: string): FakePane {
    const pane = this.panes.get(sessionId(id))
    if (pane === undefined) throw new Error(`no tmux session for ${id}`)
    return pane
  }

  readonly layer = Layer.sync(Tmux, () =>
    Tmux.of({
      list: Effect.sync(() => Array.from(this.panes.keys())),
      launch: (spec) =>
        Effect.suspend(() => {
          if (this.panes.has(spec.sessionId)) {
            return Effect.fail(new TmuxError({ message: "duplicate session" }))
          }
          this.launched.push(spec)
          this.panes.set(spec.sessionId, new FakePane(spec))
          return Effect.void
        }),
      attach: (id) => {
        const pane = this.panes.get(id)
        return pane === undefined
          ? Effect.fail(new TmuxError({ message: "no such session" }))
          : Queue.unbounded<PaneEvent, Cause.Done>().pipe(Effect.map((queue) => pane.attach(queue)))
      },
      kill: (id) =>
        Effect.sync(() => {
          this.killed.push(id)
          this.panes.get(id)?.detach()
          this.panes.delete(id)
        }),
    }),
  )
}

/** Workspaces that only record what they were asked to prepare, failing for repo `broken/repo`. */
export class FakeWorkspaces {
  readonly prepared: Array<StartSession> = []

  constructor(private readonly root: string) {}

  readonly layer = Layer.sync(Workspaces, () =>
    Workspaces.of({
      prepare: (start) =>
        Effect.suspend(() => {
          this.prepared.push(start)
          return start.repo === "broken/repo"
            ? Effect.fail(new WorkspaceError({ message: "could not clone broken/repo" }))
            : Effect.succeed(sessionDirectories(this.root, start.sessionId))
        }),
    }),
  )
}

/** Sandboxes that only record calls. */
export class FakeSandboxes {
  readonly calls: Array<string> = []
  /** The running Sessions each `reconcile` was given. */
  readonly reconciled: Array<Array<SessionId>> = []

  readonly layer = Layer.sync(Sandboxes, () =>
    Sandboxes.of({
      start: (id) => Effect.sync(() => void this.calls.push(`start ${id}`)),
      stop: (id, reason) => Effect.sync(() => void this.calls.push(`stop ${id} ${reason}`)),
      reconcile: (running) => Effect.sync(() => void this.reconciled.push([...running])),
    }),
  )
}

interface Rpc {
  readonly id?: number
  readonly method: string
  readonly params?: { readonly name?: string; readonly arguments?: Record<string, unknown> }
}

export type ToolHandler = (name: string, args: Record<string, unknown>) => Effect.Effect<unknown>

/** Plays `claude mcp serve`: answers the handshake, and each tools/call with `onTool`. */
export const fakeMcpServer =
  (onTool: ToolHandler) =>
  (io: FakeProcessIO): Effect.Effect<number> =>
    io.stdin.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.mapEffect(
        (line) => {
          const rpc = JSON.parse(line) as Rpc
          if (rpc.id === undefined) return Effect.void
          const answer = (result: unknown) =>
            io.stdout(`${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })}\n`)
          if (rpc.method === "initialize")
            return answer({ serverInfo: { name: "claude/tengu", version: "2.1.287" } })
          return onTool(rpc.params?.name ?? "", rpc.params?.arguments ?? {}).pipe(
            Effect.flatMap(answer),
          )
        },
        { concurrency: "unbounded" },
      ),
      Stream.runDrain,
      Effect.as(0),
    )

export const mcpRecord = (value: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
})

export const echoTools: ToolHandler = (name, args) =>
  Effect.succeed(
    name === "Bash" && args["command"] === "exit 2"
      ? { content: [{ type: "text", text: "Exit code 2" }], isError: true }
      : mcpRecord({ tool: name, args }),
  )
