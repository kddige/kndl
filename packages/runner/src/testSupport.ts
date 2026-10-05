// Helpers for the Runner's tests. Not used by the Runner itself.
import {
  GitAnswer,
  type GitAsk,
  GitCredentials,
  type GitIdentity,
  SessionId,
  type StartSession,
  type TerminalSize,
  type TestBuildId,
  type VariablesFor,
  type VariableValue,
} from "@claude-hub/protocol"
import { type Cause, Effect, Layer, Queue, Redacted, Schema, Stream } from "effect"
import { HubGit } from "./HubGit.ts"
import { HubVariables, VariablesError } from "./HubVariables.ts"
import { Sandboxes } from "./Sandbox.ts"
import type { FakeProcessIO } from "./sandbox/FakeSandboxBackend.ts"
import { sessionDirectories } from "./SessionNames.ts"
import type { SessionSandboxesOptions } from "./SessionSandboxes.ts"
import { type LaunchSpec, type PaneEvent, Tmux, TmuxError } from "./Tmux.ts"
import { WorkspaceError, Workspaces } from "./Workspace.ts"
import { WorkspaceGit } from "./WorkspaceGit.ts"

export const sessionId = (id: string) => Schema.decodeSync(SessionId)(id)

/** A variable value, as the Hub sends it. */
export const variable = (name: string, value: string, availableAtBuild = false): VariableValue => ({
  name,
  value: Redacted.make(value),
  availableAtBuild,
})

/** The Hub's variables: answers every fetch from `values`, or refuses with `refusal`. */
export class FakeHubVariables {
  /** What each fetch asked for, in order. */
  readonly asked: Array<VariablesFor> = []
  values: ReadonlyArray<VariableValue>
  refusal: string | undefined

  constructor(values: ReadonlyArray<VariableValue> = [], refusal?: string) {
    this.values = values
    this.refusal = refusal
  }

  readonly layer = Layer.sync(HubVariables, () =>
    HubVariables.of({
      fetch: (target) =>
        Effect.suspend(() => {
          this.asked.push(target)
          return this.refusal === undefined
            ? Effect.succeed(this.values)
            : Effect.fail(new VariablesError({ message: this.refusal }))
        }),
      receive: () => Effect.void,
    }),
  )
}

/** The Environment settings of `makeSessionSandboxes` for tests: generous limits, no clone. */
export const sandboxesDefaults: Pick<
  SessionSandboxesOptions,
  "limits" | "keepBuilds" | "cloneDefaultBranch"
> = {
  limits: { cpus: 8, memoryMib: 16384 },
  keepBuilds: 3,
  cloneDefaultBranch: () => Effect.fail({ message: "tests clone nothing" }),
}

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
          if (size.cols === this.size.cols && size.rows === this.size.rows) return
          this.size = size
          this.resizes.push(size)
          this.snapshot()
        }),
      snapshot: Effect.sync(() => this.snapshot()),
      // Claude Code exits on SIGTERM with 143.
      terminate: Effect.sync(() => {
        this.terminated = true
        this.emit({ _tag: "Exited", exitCode: 143 })
      }),
    }
  }

  private snapshot(): void {
    this.snapshots += 1
    this.emit({ _tag: "Snapshot", data: `screen of ${this.spec.sessionId}`, size: this.size })
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

/**
 * Workspaces that only record what they were asked to prepare, failing for repo `broken/repo`,
 * and which Sessions they were asked to remove, failing while `removeFails`.
 */
export class FakeWorkspaces {
  readonly prepared: Array<StartSession> = []
  readonly removed: Array<SessionId> = []
  removeFails = false

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
      remove: (id) =>
        Effect.suspend(() => {
          if (this.removeFails) {
            return Effect.fail(new WorkspaceError({ message: `could not delete ${id}` }))
          }
          this.removed.push(id)
          return Effect.void
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
      start: (id, _directories, target) =>
        Effect.sync(() => {
          this.calls.push(`start ${id}`)
          return target?.environment === undefined
            ? {}
            : { environmentVersion: target.environment.version }
        }),
      stop: (id, reason) => Effect.sync(() => void this.calls.push(`stop ${id} ${reason}`)),
      purge: (id) => Effect.sync(() => void this.calls.push(`purge ${id}`)),
      reconcile: (running) => Effect.sync(() => void this.reconciled.push([...running])),
      testBuild: (request, log) =>
        Effect.andThen(
          Effect.sync(() => void this.calls.push(`testBuild ${request.testBuildId}`)),
          log("built\n"),
        ),
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

/**
 * The Hub's side of the git conversation, in memory: Repo access with the credentials a test
 * sets (a fake token, or the host's), Sandbox tokens while it has a token to give (`sandbox-1`,
 * `sandbox-2`, ...), and a record of what was asked and reported. `answer` overrides any answer.
 */
export class FakeHubGit {
  readonly asked: Array<{ readonly sessionId: SessionId; readonly ask: GitAsk }> = []
  readonly wipFailures: Array<{ readonly sessionId: SessionId; readonly message: string }> = []
  /** The Sandbox tokens handed out, oldest first. */
  readonly sandboxTokens: Array<string> = []
  credentials: GitCredentials = GitCredentials.cases.HostCredentials.make({})
  answer: ((sessionId: SessionId, ask: GitAsk) => GitAnswer | undefined) | undefined
  /** The Test builds asked how to clone, and what the Hub answers. */
  readonly clonesAsked: Array<TestBuildId> = []
  cloneAnswer: GitAnswer = GitAnswer.cases.CloneAccess.make({
    credentials: { _tag: "HostCredentials" },
  })

  constructor(readonly repo: string) {}

  /** Hands out `token` as the App's installation token, with `author` as its bot. */
  useToken(token: string, author: GitIdentity, expiresAt = Date.now() + 3_600_000) {
    this.credentials = Schema.decodeUnknownSync(GitCredentials)({
      _tag: "AppToken",
      token,
      expiresAt,
      author,
    })
  }

  private reply(session: SessionId, ask: GitAsk): GitAnswer {
    const given = this.answer?.(session, ask)
    if (given !== undefined) return given
    switch (ask._tag) {
      case "GitAccess":
        return Schema.decodeUnknownSync(GitAnswer)({
          _tag: "GitAccess",
          repo: this.repo,
          credentials: Schema.encodeSync(GitCredentials)(this.credentials),
        })
      case "SandboxToken": {
        if (this.credentials._tag === "HostCredentials")
          return GitAnswer.cases.GitFailed.make({ message: "No GitHub App is configured" })
        const token = `sandbox-${this.sandboxTokens.length + 1}`
        this.sandboxTokens.push(token)
        return GitAnswer.cases.SandboxToken.make({
          token: Redacted.make(token),
          expiresAt: Date.now() + 3_600_000,
        })
      }
    }
  }

  readonly layer = Layer.sync(HubGit, () =>
    HubGit.of({
      ask: (session, ask) =>
        Effect.sync(() => {
          this.asked.push({ sessionId: session, ask })
          return this.reply(session, ask)
        }),
      cloneAccess: (testBuildId) =>
        Effect.sync(() => {
          this.clonesAsked.push(testBuildId)
          return this.cloneAnswer
        }),
      receive: () => Effect.void,
      wipPushFailed: (session, message) =>
        Effect.sync(() => void this.wipFailures.push({ sessionId: session, message })),
    }),
  )
}

/**
 * Git that only records calls, `pushWip <id> <reason>`, into `calls`: pass another fake's record
 * to see the order they ran in.
 */
export class FakeWorkspaceGit {
  constructor(readonly calls: Array<string> = []) {}

  readonly layer = Layer.sync(WorkspaceGit, () =>
    WorkspaceGit.of({
      pushWip: (session, _directories, reason) =>
        Effect.sync(() => void this.calls.push(`pushWip ${session} ${reason}`)),
    }),
  )
}
