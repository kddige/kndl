// Helpers for the Runner's tests. Not used by the Runner itself.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  GitAnswer,
  type GitAsk,
  GitCredentials,
  type GitIdentity,
  type OpenPort,
  RunnerToHub,
  SessionId,
  type StartSession,
  type TerminalSize,
  type TestBuildId,
  type VariablesFor,
  type VariableValue,
} from "@kndl/protocol"
import { type Cause, Effect, Layer, Queue, Redacted, Schema, Stream } from "effect"
import { HubGit } from "./HubGit.ts"
import { HubLink } from "./HubLink.ts"
import { HubVariables, VariablesError } from "./HubVariables.ts"
import { OpenPorts } from "./OpenPorts.ts"
import { makeModRelay, ModRelay } from "./relay/ModRelay.ts"
import { makeSessionTokens, type SessionGrant } from "./relay/SessionTokens.ts"
import { SandboxError, Sandboxes, type SandboxTarget } from "./Sandbox.ts"
import { SandboxBackendError } from "./sandbox/SandboxBackend.ts"
import type { ExecEvent, ExecRequest, SpawnedCommand } from "./sandbox/SandboxBackend.ts"
import { modPlugins } from "./sandbox/SessionLayout.ts"
import { sessionDirectories } from "./SessionNames.ts"
import type { SessionSandboxesOptions } from "./SessionSandboxes.ts"
import {
  type LaunchSpec,
  lastOutputOf,
  type PaneEvent,
  Tmux,
  type TmuxBackend,
  TmuxError,
} from "./Tmux.ts"
import { WorkspaceError, Workspaces } from "./Workspace.ts"

export const sessionId = (id: string) => Schema.decodeSync(SessionId)(id)

/**
 * The mod relay without its server: real Session tokens, and a record of the Sessions admitted
 * and revoked, in order.
 */
export class FakeModRelay {
  readonly tokens = makeSessionTokens()
  readonly calls: Array<string> = []
  /** What each Session was admitted with, in order. */
  readonly grants: Array<SessionGrant> = []
  readonly layer: Layer.Layer<ModRelay>

  constructor() {
    const relay = makeModRelay({ port: 7778, tokens: this.tokens })
    this.layer = Layer.succeed(
      ModRelay,
      ModRelay.of({
        ...relay,
        admit: (grant) =>
          Effect.tap(relay.admit(grant), () =>
            Effect.sync(() => {
              this.calls.push(`admit ${grant.sessionId}`)
              this.grants.push(grant)
            }),
          ),
        revoke: (id) =>
          Effect.tap(relay.revoke(id), () => Effect.sync(() => this.calls.push(`revoke ${id}`))),
      }),
    )
  }
}

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
  /** Its process exited: tmux keeps the dead pane. */
  exited = false
  private queue: Queue.Queue<PaneEvent, Cause.Done> | undefined

  constructor(
    readonly spec: LaunchSpec,
    private size: TerminalSize = spec.size,
  ) {}

  /** Makes the terminal print `data`, or its process exit. */
  emit(event: PaneEvent): void {
    if (this.queue === undefined) throw new Error("not attached")
    Queue.offerUnsafe(this.queue, event)
    if (event._tag === "Exited") {
      this.exited = true
      Queue.endUnsafe(this.queue)
    }
  }

  /** Everything the terminal printed, as `capture-pane` would read it back. */
  printed = ""

  output(data: string): void {
    this.printed += data
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
  /** How often the host's tmux server was retired. */
  retired = 0

  pane(id: string): FakePane {
    const pane = this.panes.get(sessionId(id))
    if (pane === undefined) throw new Error(`no tmux session for ${id}`)
    return pane
  }

  readonly layer = Layer.sync(Tmux, () =>
    Tmux.of({
      retireHostServer: Effect.sync(() => {
        this.retired += 1
      }),
      lastOutput: (id) => Effect.sync(() => lastOutputOf(this.panes.get(id)?.printed ?? "")),
      variable: (id, name) =>
        Effect.sync(() => {
          const pane = this.panes.get(id)
          return pane === undefined || pane.exited ? undefined : pane.spec.env[name]
        }),
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
  /** The bytes each Session's directory takes, for `usage`; 0 for one not set. */
  readonly usages = new Map<SessionId, number>()

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
      usage: (id) => Effect.sync(() => this.usages.get(id) ?? 0),
    }),
  )
}

/** The environment a command in `hostTmuxBackend` gets: this process's, outside any tmux. */
const hostTmuxEnv = (request: ExecRequest) => {
  const inherited: Record<string, string | undefined> = { ...process.env }
  delete inherited.TMUX
  return { ...inherited, ...request.env }
}

/**
 * The host as a Sandbox for tmux (Tmux.ts): commands run here, with the guest's tmux server moved
 * to `socket`, never the one a Runner on this machine might use, and each argument that is a key
 * of `paths`, a path in the Sandbox such as the Workspace's, replaced by its value on the host.
 */
export function hostTmuxBackend(options: {
  readonly socket: string
  readonly paths?: Readonly<Record<string, string>>
}): TmuxBackend {
  const command = (request: ExecRequest): Array<string> => {
    const args = (request.args ?? []).map((arg) => options.paths?.[arg] ?? arg)
    const at = args.indexOf("-L")
    if (request.command === "tmux" && at >= 0) args[at + 1] = options.socket
    return [request.command, ...args]
  }
  return {
    exec: (_sessionId, request) =>
      Effect.promise(async () => {
        const child = Bun.spawn(command(request), {
          env: hostTmuxEnv(request),
          stdout: "pipe",
          stderr: "pipe",
        })
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        return { exitCode, stdout, stderr }
      }),
    spawn: (_sessionId, request) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          Bun.spawn(command(request), {
            env: hostTmuxEnv(request),
            stdin: "pipe",
            stdout: "pipe",
            stderr: "ignore",
          }),
        ),
        (child) => Effect.sync(() => child.kill()),
      ).pipe(
        Effect.map((child): SpawnedCommand => ({
          events: Stream.fromReadableStream({
            evaluate: () => child.stdout,
            onError: (cause) =>
              new SandboxBackendError({ operation: "spawn", message: String(cause) }),
          }).pipe(Stream.map((data): ExecEvent => ({ _tag: "Stdout", data }))),
          write: (data) =>
            Effect.sync(() => {
              child.stdin.write(data)
              child.stdin.flush()
            }),
          closeStdin: Effect.sync(() => void child.stdin.end()),
        })),
      ),
  }
}

/**
 * Builds a stand-in for the Runner's mod into `modDir`, as `bun run mod:build` would, each plugin
 * with a hook that says `build`, and the pi extension saying it too.
 */
export function writeFakeMod(modDir: string, build = "built") {
  for (const plugin of modPlugins) {
    mkdirSync(join(modDir, "plugins", plugin, "hooks"), { recursive: true })
    writeFileSync(join(modDir, "plugins", plugin, "hooks", "hook.js"), `// ${build}\n`)
  }
  mkdirSync(join(modDir, "pi", "dist"), { recursive: true })
  writeFileSync(join(modDir, "pi", "dist", "kndl.js"), `// pi ${build}\n`)
  return modDir
}

/** The Claude Code {@link FakeSandboxes} says each Sandbox runs. */
export const fakeSandboxClaudePath = "/opt/claude-code/claude"

/** The Node.js {@link FakeSandboxes} says each Sandbox runs pi on. */
export const fakeSandboxNodePath = "/opt/pi/node"

/** Sandboxes that only record calls. */
export class FakeSandboxes {
  readonly calls: Array<string> = []
  /** The running Sessions each `reconcile` was given. */
  readonly reconciled: Array<Array<SessionId>> = []
  /** What each `start` was given to start the Sandbox from. */
  readonly targets: Array<SandboxTarget> = []
  /** The conversations Claude Code has a transcript of, to resume. */
  readonly transcripts = new Set<string>()
  /** The Sessions whose Sandbox runs: started, and not stopped since. */
  readonly running = new Set<SessionId>()
  /** What each Sandbox says Claude Code runs with, as from its Variables. */
  claudeEnv: Readonly<Record<string, string>> = { CLAUDE_CONFIG_DIR: "/claude" }
  /** What each Sandbox says pi runs with: Claude Code's, but for its state. */
  piEnv: Readonly<Record<string, string>> = { LANG: "C.UTF-8" }
  /** The bytes each Session's volumes take, for `diskUsage`; 0 for one not set. */
  readonly diskUsages = new Map<SessionId, number>()
  /** The Sessions whose `diskUsage` fails. */
  readonly diskUsageFails = new Set<SessionId>()

  /** `claudePath`: the Claude Code each Sandbox runs. */
  constructor(readonly claudePath: string = fakeSandboxClaudePath) {}

  readonly layer = Layer.sync(Sandboxes, () =>
    Sandboxes.of({
      start: (id, _directories, target) =>
        Effect.sync(() => {
          this.calls.push(`start ${id}`)
          this.targets.push(target)
          this.running.add(id)
          return {
            ...(target.environment === undefined
              ? {}
              : { environmentVersion: target.environment.version }),
            claude: { path: this.claudePath, env: this.claudeEnv },
            pi: { node: fakeSandboxNodePath, env: this.piEnv },
          }
        }),
      running: Effect.sync(() => [...this.running]),
      keep: (id) =>
        Effect.sync(() => {
          this.calls.push(`keep ${id}`)
          return {
            claude: { path: this.claudePath, env: this.claudeEnv },
            pi: { node: fakeSandboxNodePath, env: this.piEnv },
          }
        }),
      hasTranscript: (_id, _directories, conversation) =>
        Effect.sync(() => this.transcripts.has(conversation)),
      stop: (id, reason) =>
        Effect.sync(() => {
          this.calls.push(`stop ${id} ${reason}`)
          this.running.delete(id)
        }),
      purge: (id) =>
        Effect.sync(() => {
          this.calls.push(`purge ${id}`)
          this.running.delete(id)
        }),
      diskUsage: (id) =>
        this.diskUsageFails.has(id)
          ? Effect.fail(new SandboxError({ message: "could not list the volumes" }))
          : Effect.succeed(this.diskUsages.get(id) ?? 0),
      reconcile: (running) =>
        Effect.sync(() => {
          const known = [...running]
          this.reconciled.push(known)
          for (const id of this.running) if (!known.includes(id)) this.running.delete(id)
        }),
      testBuild: (request, log) =>
        Effect.andThen(
          Effect.sync(() => void this.calls.push(`testBuild ${request.testBuildId}`)),
          log("built\n"),
        ),
    }),
  )
}

/**
 * Open ports without a Sandbox: a watched Session reports the ports a test gives it in `ports`,
 * if any, and an empty list when it is unwatched after reporting some. Records each call.
 */
export class FakeOpenPorts {
  readonly calls: Array<string> = []
  /** The Open ports each Session's Sandbox has, by Session. */
  readonly ports = new Map<SessionId, ReadonlyArray<OpenPort>>()
  readonly watched = new Set<SessionId>()

  private has(id: SessionId) {
    return (this.ports.get(id)?.length ?? 0) > 0
  }

  readonly layer = Layer.effect(
    OpenPorts,
    Effect.map(HubLink, (hub) => {
      const report = (id: SessionId, ports: ReadonlyArray<OpenPort>) =>
        hub.send(RunnerToHub.cases.SessionPorts.make({ sessionId: id, ports }))
      return OpenPorts.of({
        watch: (id) =>
          Effect.suspend(() => {
            this.calls.push(`watch ${id}`)
            if (this.watched.has(id)) return Effect.void
            this.watched.add(id)
            return this.has(id) ? report(id, this.ports.get(id) ?? []) : Effect.void
          }),
        unwatch: (id) =>
          Effect.suspend(() => {
            this.calls.push(`unwatch ${id}`)
            if (!this.watched.delete(id)) return Effect.void
            return this.has(id) ? report(id, []) : Effect.void
          }),
        resendAll: Effect.suspend(() =>
          Effect.forEach(
            [...this.watched].filter((id) => this.has(id)),
            (id) => report(id, this.ports.get(id) ?? []),
            { discard: true },
          ),
        ),
      })
    }),
  )
}

/**
 * The Hub's side of the git conversation, in memory: Repo access with the credentials a test
 * sets (a fake token, or the host's), Sandbox tokens while it has a token to give (`sandbox-1`,
 * `sandbox-2`, ...), and a record of what was asked. `answer` overrides any answer.
 */
export class FakeHubGit {
  readonly asked: Array<{ readonly sessionId: SessionId; readonly ask: GitAsk }> = []
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
    }),
  )
}
