// What Sessions run in: two tmux sessions per Session, on a tmux server inside the Session's
// Sandbox (ADR 0013, docs/design/durable-harness.md). One is the Session's terminal, which its
// people watch and type into: a login shell in the Workspace, started again whenever it exits.
// The other, `<name>-agent`, runs the durable agent, which nobody watches: the Runner reads only
// when it exits, and what it printed last. Each control-mode client attaches to one of them, so
// it sees that session's panes alone: the terminal never shows the agent's output. tmux runs
// through the backend's exec, never the `msb` command line, which returns output only once a
// command exits. The server dies with the VM, so both last as long as their Sandbox runs.

import { MaxLastOutputLength, type SessionId, type TerminalSize } from "@kndl/protocol"
import { Context, Data, Deferred, Effect, Layer, Queue, type Scope, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import {
  type ControlEvent,
  ControlModeParser,
  type CursorState,
  cursorStateFormat,
  parseCursorState,
  renderSnapshot,
} from "./ControlMode.ts"
import { runCommand } from "./Process.ts"
import { RunnerConfig } from "./RunnerConfig.ts"
import { SandboxBackend } from "./sandbox/SandboxBackend.ts"
import type { SandboxBackendShape, SandboxError } from "./sandbox/SandboxBackend.ts"
import { tmuxSessionName } from "./SessionNames.ts"

export class TmuxError extends Data.TaggedError("TmuxError")<{
  readonly message: string
}> {}

/** What a Session's terminal did, in the order it happened. */
export type TerminalEvent =
  /** The terminal printed `data`, to write after what came before. */
  | { readonly _tag: "Output"; readonly data: string; readonly size: TerminalSize }
  /** The whole screen, answering {@link Terminal.snapshot}: reset a terminal of `size` and draw it. */
  | { readonly _tag: "Snapshot"; readonly data: string; readonly size: TerminalSize }

/** What a pane did: what its terminal did, then, last, that its process ended. */
type PaneEvent = TerminalEvent | { readonly _tag: "Exited"; readonly exitCode: number | undefined }

/** A Session's terminal, attached for as long as the scope it was attached in. */
export interface Terminal {
  /**
   * Everything the terminal does from now on. Its shell is started again whenever it exits, so
   * this ends only when the tmux session or its Sandbox is gone. Consume it once.
   */
  readonly events: Stream.Stream<TerminalEvent>
  /** Types `data` into the terminal, byte for byte. */
  readonly input: (data: string) => Effect.Effect<void>
  /** Resizes the terminal, then sends a `Snapshot` at the new size. A no-op at the same size. */
  readonly resize: (size: TerminalSize) => Effect.Effect<void>
  /** Asks for a `Snapshot` event, which arrives in order with the output. */
  readonly snapshot: Effect.Effect<void>
}

/** A Session's durable agent, watched for as long as the scope it was attached in. */
export interface Agent {
  /**
   * Completes once the agent has exited, with its exit status when tmux knows it, or once its
   * tmux session or Sandbox is gone. Await it once.
   */
  readonly exited: Effect.Effect<number | undefined>
  /** Sends SIGTERM to the agent, which lets it close its storage cleanly. */
  readonly terminate: Effect.Effect<void>
}

/** The Session's terminal: a login shell, in `cwd`, which comes back whenever it exits. */
export interface TerminalSpec {
  readonly sessionId: SessionId
  /** The directory it starts in, in the Sandbox. */
  readonly cwd: string
  /** Its environment, over the tmux server's: never the agent's secrets. */
  readonly env: Readonly<Record<string, string>>
  readonly size: TerminalSize
}

/** The Session's durable agent. */
export interface AgentSpec {
  readonly sessionId: SessionId
  /** The directory it starts in, in the Sandbox. */
  readonly cwd: string
  readonly argv: ReadonlyArray<string>
  /**
   * Its environment, over the tmux server's. Given to this process alone (`new-session -e`),
   * never to the server, the terminal or the Sandbox, so it may hold the Session token and the
   * Creator's setup token (ADR 0026).
   */
  readonly env: Readonly<Record<string, string>>
  /**
   * Variables kept out of its environment even where the tmux server has them, as from the
   * Sandbox's image: unset in the server's global environment, which each new process starts from.
   */
  readonly unset?: ReadonlyArray<string>
}

/** What Sessions run in: their terminal and their agent, each in a tmux session in its Sandbox. */
export class Tmux extends Context.Service<
  Tmux,
  {
    /** Starts the Session's terminal in a new detached tmux session in its running Sandbox. */
    readonly launchTerminal: (spec: TerminalSpec) => Effect.Effect<void, TmuxError>
    /** Starts the Session's agent in a new detached tmux session in its running Sandbox. */
    readonly launchAgent: (spec: AgentSpec) => Effect.Effect<void, TmuxError>
    readonly attachTerminal: (
      sessionId: SessionId,
    ) => Effect.Effect<Terminal, TmuxError, Scope.Scope>
    readonly attachAgent: (sessionId: SessionId) => Effect.Effect<Agent, TmuxError, Scope.Scope>
    /**
     * The last lines the Session's agent printed, as plain text: see {@link lastOutputOf}. Read
     * from its dead pane, before {@link kill}, it is what it printed before it exited. Empty when
     * there is nothing, or no such tmux session or running Sandbox.
     */
    readonly lastOutput: (sessionId: SessionId) => Effect.Effect<string>
    /**
     * The variable `name` of the environment the Session's agent was launched with, while it
     * runs, as read back after a Runner restart (#157). Undefined once the agent has exited, or
     * with no such variable, tmux session or running Sandbox.
     */
    readonly variable: (sessionId: SessionId, name: string) => Effect.Effect<string | undefined>
    /** Ends the Session's agent's tmux session, and the agent if it still runs. */
    readonly killAgent: (sessionId: SessionId) => Effect.Effect<void>
    /** Ends both of the Session's tmux sessions, and anything still running in them. */
    readonly kill: (sessionId: SessionId) => Effect.Effect<void>
    /**
     * Stops the Runner's tmux server on the host, where Sessions ran Claude Code before it moved
     * into their Sandboxes (ADR 0013), if one is left from before the upgrade. Run once, at startup.
     */
    readonly retireHostServer: Effect.Effect<void>
  }
>()("@kndl/runner/Tmux") {}

/** The tmux session the Session's agent runs in, beside its terminal's. */
export const agentSessionName = (sessionId: SessionId) => `${tmuxSessionName(sessionId)}-agent`

/**
 * The terminal's command: a login shell, bash where there is one, and again each time it exits,
 * so the terminal is never left dead. One that fails at once is started again only after a
 * second.
 */
export const TerminalShell = [
  "sh",
  "-c",
  "while :; do if command -v bash >/dev/null 2>&1; then bash -l; else sh -l; fi || sleep 1; done",
] as const

/** How many lines of a dead pane {@link lastOutputOf} keeps. */
export const LastOutputLines = 40

/** How far back into a pane's history {@link Tmux}'s `lastOutput` reads. */
const LastOutputScrollback = 200

// CSI and OSC sequences, other two-character ESC sequences, and every other control character
// but the line break and tab.
const controlSequences =
  // oxlint-disable-next-line no-control-regex
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-_]|[\u0000-\u0008\u000b-\u001f\u007f]/g

/**
 * The end of what a pane shows, as plain text: control sequences stripped, the blank lines around
 * it and tmux's own "Pane is dead" line dropped, its last `lines` lines kept, and at most
 * `maxLength` characters of them, the end kept.
 */
export function lastOutputOf(
  screen: string,
  lines: number = LastOutputLines,
  maxLength: number = MaxLastOutputLength,
): string {
  const kept = screen
    .replace(controlSequences, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => !line.startsWith("Pane is dead ("))
  while (kept.length > 0 && kept.at(-1) === "") kept.pop()
  const last = kept.slice(-lines)
  while (last.length > 0 && last[0] === "") last.shift()
  const text = last.join("\n")
  return text.length <= maxLength ? text : text.slice(text.length - maxLength)
}

/**
 * The tmux server in each Sandbox, `tmux -L kndl`: apart from any tmux the agent starts
 * there itself. `-f /dev/null`: an image's tmux.conf must not change how Sessions behave.
 */
const guestServer = ["-L", "kndl", "-f", "/dev/null"]

/**
 * The size of the agent's window, which nobody watches: wide enough that what it prints as it
 * exits reads back as it printed it.
 */
const AgentSize: TerminalSize = { cols: 160, rows: 50 }

/** What the Tmux service needs of a Sandbox backend: running commands. */
export type TmuxBackend = Pick<SandboxBackendShape, "exec" | "spawn">

const sandboxMessage = (error: SandboxError) =>
  error._tag === "InvalidSandboxSpec" || error._tag === "SandboxBackendError"
    ? error.message
    : `${error._tag} (${error.sessionId})`

/**
 * tmux in Sessions' Sandboxes through `backend`: its command line for each command, and a
 * control-mode client (`tmux -C`) for each attached terminal or agent, which streams its pane's
 * output and takes commands whose replies arrive in order with it.
 */
export const makeTmux = (backend: TmuxBackend) => {
  // A failure's message is tmux's own, never its arguments: a launch's carry the Session token and
  // the setup token.
  // `env` is the tmux client's, over the Sandbox's.
  const tmux = (
    sessionId: SessionId,
    args: ReadonlyArray<string>,
    env?: Readonly<Record<string, string>>,
  ) => {
    const command = { command: "tmux", args: [...guestServer, ...args] }
    return backend.exec(sessionId, env === undefined ? command : { ...command, env }).pipe(
      Effect.mapError((error) => new TmuxError({ message: sandboxMessage(error) })),
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed(result.stdout)
          : Effect.fail(
              new TmuxError({
                message: `tmux ${args[0] ?? ""} exited with ${result.exitCode}: ${
                  result.stderr.trim() || result.stdout.trim() || "no output"
                }`,
              }),
            ),
      ),
    )
  }

  // Should the shell's own loop be killed, its pane is started again all the same: it never stays
  // dead, so the terminal never shows tmux's "Pane is dead".
  const launchTerminal = (spec: TerminalSpec) => {
    const name = tmuxSessionName(spec.sessionId)
    return tmux(
      spec.sessionId,
      sequence([
        ...serverCommands(),
        ...newSessionCommands(name, spec, spec.size, TerminalShell),
        ["set-hook", "-t", `=${name}:`, "pane-died", "respawn-pane"],
      ]),
      clientEnv(spec.env),
    ).pipe(Effect.asVoid)
  }

  // The server is readied by a command line of its own, which holds no secret: the client that
  // starts the server forks it, and the server keeps that client's command line, which `ps` shows
  // anything in the Sandbox for as long as it runs. The agent's session, and its secrets, come
  // from a second client, gone once it is made.
  const launchAgent = (spec: AgentSpec) =>
    tmux(spec.sessionId, sequence(serverCommands(spec.unset)), clientEnv(spec.env)).pipe(
      Effect.andThen(
        tmux(
          spec.sessionId,
          sequence(
            newSessionCommands(agentSessionName(spec.sessionId), spec, AgentSize, spec.argv),
          ),
          clientEnv(spec.env),
        ),
      ),
      Effect.asVoid,
    )

  // `-J` joins the lines tmux wrapped; without `-e` the text comes without colours.
  const lastOutput = (sessionId: SessionId) =>
    tmux(sessionId, [
      "capture-pane",
      "-p",
      "-J",
      "-S",
      String(-LastOutputScrollback),
      "-t",
      `=${agentSessionName(sessionId)}:`,
    ]).pipe(
      Effect.map(lastOutputOf),
      Effect.orElseSucceed(() => ""),
    )

  // The tmux session's environment is the one `new-session -e` launched the agent with. The
  // value is read last, so a failure's output never holds it.
  const variable = (sessionId: SessionId, name: string) => {
    const target = `=${agentSessionName(sessionId)}`
    return tmux(
      sessionId,
      sequence([
        ["display-message", "-p", "-t", `${target}:`, "#{pane_dead}"],
        ["show-environment", "-t", target, name],
      ]),
    ).pipe(
      Effect.map((stdout) => {
        const [dead, line = ""] = stdout.split("\n")
        return dead === "0" && line.startsWith(`${name}=`) ? line.slice(name.length + 1) : undefined
      }),
      Effect.orElseSucceed(() => undefined),
    )
  }

  const killSession = (sessionId: SessionId, name: string) =>
    tmux(sessionId, ["kill-session", "-t", `=${name}`]).pipe(Effect.ignore)

  const killAgent = (sessionId: SessionId) => killSession(sessionId, agentSessionName(sessionId))

  const kill = (sessionId: SessionId) =>
    Effect.andThen(killAgent(sessionId), killSession(sessionId, tmuxSessionName(sessionId)))

  /** A control-mode client of the tmux session `name`, and its pane, as tmux targets it. */
  const control = (sessionId: SessionId, name: string) =>
    Effect.gen(function* () {
      const target = `=${name}`
      const stdout = yield* tmux(sessionId, [
        "display-message",
        "-p",
        "-t",
        `${target}:`,
        "#{window_width} #{window_height}",
      ])
      const [cols = 0, rows = 0] = stdout.trim().split(" ").map(Number)
      const client = yield* backend
        .spawn(sessionId, {
          command: "tmux",
          args: [...guestServer, "-u", "-C", "attach-session", "-t", target],
        })
        .pipe(Effect.mapError((error) => new TmuxError({ message: sandboxMessage(error) })))
      const commands = yield* Queue.unbounded<string>()
      const pane = new ControlPane(commands, `${target}:`, {
        cols: Math.max(cols, 1),
        rows: Math.max(rows, 1),
      })
      // Control mode accepts input before attach-session completes. Without waiting, commands
      // can target another client's session: refresh-client then subscribes the terminal to the
      // agent's exit (or the reverse), and the agent's watcher never sees it.
      yield* pane.ready.pipe(
        Effect.andThen(
          Stream.fromQueue(commands).pipe(Stream.runForEach((command) => client.write(command))),
        ),
        Effect.ignore,
        Effect.forkScoped,
      )
      const events = pane.events(
        client.events.pipe(
          Stream.filter((event) => event._tag === "Stdout"),
          Stream.map((event) => event.data),
        ),
      )
      return { pane, events }
    })

  // The shell comes back whenever it exits, so the terminal's exit is never watched for.
  const attachTerminal = (sessionId: SessionId) =>
    Effect.map(control(sessionId, tmuxSessionName(sessionId)), ({ pane, events }) =>
      pane.toTerminal(
        events.pipe(Stream.filter((event): event is TerminalEvent => event._tag !== "Exited")),
      ),
    )

  // What the agent prints is never streamed: only its exit is looked for.
  const attachAgent = (sessionId: SessionId) =>
    Effect.gen(function* () {
      const { pane, events } = yield* control(sessionId, agentSessionName(sessionId))
      yield* pane.issue(`refresh-client -B '${ExitSubscription}::${PaneExitFormat}'`)
      return {
        exited: events.pipe(
          Stream.runFold(
            (): number | undefined => undefined,
            (exitCode, event) => (event._tag === "Exited" ? event.exitCode : exitCode),
          ),
        ),
        terminate: pane.terminate,
      } satisfies Agent
    })

  return {
    launchTerminal,
    launchAgent,
    attachTerminal,
    attachAgent,
    lastOutput,
    variable,
    killAgent,
    kill,
  }
}

/** tmux in the Sandboxes of the Runner's backend. */
export const TmuxLive = Layer.effect(
  Tmux,
  Effect.gen(function* () {
    const backend = yield* SandboxBackend
    const config = yield* RunnerConfig
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

    // A server is left only when the Runner ran its Sessions on the host before this version:
    // their Claude Code would run on, with its tools pointed at a bridge that is gone.
    const retireHostServer = runCommand("tmux", ["-L", config.tmuxSocket, "kill-server"]).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.andThen(
        Effect.logWarning(
          `Stopped the tmux server ${config.tmuxSocket} on the host, where Sessions ran before ` +
            "Claude Code moved into their Sandboxes: each wakes in its Sandbox on its next prompt",
        ),
      ),
      Effect.ignore,
    )

    return Tmux.of({ ...makeTmux(backend), retireHostServer })
  }),
)

/**
 * Readies the tmux server, starting it if need be. It stays up with no sessions, keeps a dead pane
 * so its exit status can be read, sizes windows only when told to, and has no status line taking
 * a row from the terminal. Focus events pass through, or a TUI run in the terminal prints a hint
 * to turn them on in a tmux.conf. Window size is the window's own, never the server's: tmux 3.3
 * (Debian 12's) crashes when the global option is manual and there is no session, which is what a
 * relaunch starts from. `unset` is taken out of the server's environment, which each new process
 * starts from.
 */
function serverCommands(unset: ReadonlyArray<string> = []): Array<ReadonlyArray<string>> {
  return [
    ["start-server"],
    ["set-option", "-g", "exit-empty", "off"],
    ["set-option", "-g", "remain-on-exit", "on"],
    ["set-option", "-g", "status", "off"],
    ["set-option", "-g", "focus-events", "on"],
    ...unset.map((name) => ["set-environment", "-g", "-u", name]),
  ]
}

/** A new detached tmux session `name` running `argv`, its window sized as given. */
function newSessionCommands(
  name: string,
  spec: { readonly cwd: string; readonly env: Readonly<Record<string, string>> },
  size: TerminalSize,
  argv: ReadonlyArray<string>,
): Array<ReadonlyArray<string>> {
  return [
    [
      "new-session",
      "-d",
      "-s",
      name,
      "-x",
      String(size.cols),
      "-y",
      String(size.rows),
      "-c",
      spec.cwd,
      ...Object.entries(spec.env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      "--",
      ...argv,
    ],
    ["set-option", "-w", "-t", `=${name}:`, "window-size", "manual"],
  ]
}

/**
 * The environment of the tmux client that makes a session. tmux gives a new session's process the
 * PATH of the client that made it, over `-e PATH=` (tmux's spawn.c), so the client runs with the
 * launch's PATH: the shell and the agent get the login PATH, not the Sandbox's default one.
 */
function clientEnv(env: Readonly<Record<string, string>>) {
  return env.PATH === undefined ? undefined : { PATH: env.PATH }
}

/** tmux commands run as one, separated by `;`. */
function sequence(commands: ReadonlyArray<ReadonlyArray<string>>): Array<string> {
  return commands.flatMap((command, index) => [
    ...(index === 0 ? [] : [";"]),
    ...command.map(literalArgument),
  ])
}

const ExitSubscription = "kndl-exit"

/**
 * Whether the pane is dead, and how its process ended: its exit status, or the signal that killed
 * it. tmux marks a pane dead when its terminal closes, and knows how the process ended only once
 * it reaps it (#296). tmux 3.2 has no `pane_dead_signal`, so it never says a signal killed it.
 */
const PaneExitFormat = "#{pane_dead} #{pane_dead_status} #{pane_dead_signal}"

/**
 * While a dead pane's process isn't reaped, how long between two checks: doubling from the first
 * to the last (#296). On a tmux with no `pane_dead_signal`, after how long a process tmux still
 * has no status for is taken as killed by a signal.
 */
const ReapCheckFirstMs = 100
const ReapCheckLastMs = 5_000
const ReapGiveUpWithoutSignalsMs = 10_000

/** The most bytes typed with one `send-keys` command. */
const InputChunkBytes = 256

const encoder = new TextEncoder()

/** Keeps tmux from reading an argument that ends in `;` as the end of a command. */
function literalArgument(argument: string): string {
  return argument.endsWith(";") ? `${argument.slice(0, -1)}\\;` : argument
}

type ReplyHandler = (reply: Extract<ControlEvent, { _tag: "Reply" }>) => PaneEvent | undefined

/** The state of one control-mode client: its pending commands, the pane's size and decoder. */
class ControlPane {
  private readonly pending: Array<ReplyHandler> = []
  private readonly parser = new ControlModeParser()
  private readonly decoder = new TextDecoder()
  private readonly attached = Deferred.makeUnsafe<void>()
  /** Completes once tmux has attached this client to its session. */
  readonly ready = Deferred.await(this.attached)

  /** The size last asked for, which tmux may not have applied yet. */
  private target: TerminalSize

  /** Set once `Exited` is emitted, or the stream ends; then nothing more is checked. */
  private done = false
  /** While the pane is dead and its process not yet reaped: when it was seen dead, the next check. */
  private deadSince: number | undefined
  private reapCheck: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly commands: Queue.Queue<string>,
    /** The pane, as a tmux target. */
    private readonly pane: string,
    private size: TerminalSize,
  ) {
    this.target = size
  }

  /** Sends a command; `handler` gets its reply, in the order the commands were sent. */
  issue(command: string, handler: ReplyHandler = () => undefined): Effect.Effect<void> {
    return Effect.sync(() => this.issueUnsafe(command, handler))
  }

  private issueUnsafe(command: string, handler: ReplyHandler): void {
    this.pending.push(handler)
    Queue.offerUnsafe(this.commands, `${command}\n`)
  }

  /** What the pane does, from what the client prints. Ends after `Exited`. */
  events(stdout: Stream.Stream<Uint8Array, unknown>): Stream.Stream<PaneEvent> {
    return stdout.pipe(
      Stream.map((chunk) => this.parser.push(chunk).flatMap((event) => this.toEvents(event))),
      Stream.flattenIterable,
      Stream.takeUntil((event) => event._tag === "Exited"),
      Stream.catchCause(() => Stream.empty),
      Stream.ensuring(Effect.sync(() => this.stop())),
    )
  }

  toTerminal(events: Stream.Stream<TerminalEvent>): Terminal {
    const input = (data: string) =>
      Effect.suspend(() => {
        const bytes = encoder.encode(data)
        const commands: Array<string> = []
        for (let start = 0; start < bytes.length; start += InputChunkBytes) {
          const hex = Array.from(bytes.subarray(start, start + InputChunkBytes), (byte) =>
            byte.toString(16).padStart(2, "0"),
          )
          commands.push(`send-keys -H ${hex.join(" ")}`)
        }
        return Effect.forEach(commands, (command) => this.issue(command), { discard: true })
      })

    // After a resize every viewer redraws from a snapshot: tmux crops and wraps its screen its
    // own way, which a viewer's terminal resizing itself would not match.
    const resize = (size: TerminalSize) =>
      Effect.suspend(() => {
        if (size.cols === this.target.cols && size.rows === this.target.rows) return Effect.void
        this.target = size
        return Effect.andThen(this.issue(`resize-window -x ${size.cols} -y ${size.rows}`), snapshot)
      })

    const snapshot: Effect.Effect<void> = Effect.suspend(() => {
      let cursor: CursorState | undefined
      return Effect.andThen(
        this.issue(`display-message -p '${cursorStateFormat}'`, (reply) => {
          cursor = reply.isError ? undefined : parseCursorState(reply.lines[0])
          return undefined
        }),
        this.issue("capture-pane -p -e", (reply) => {
          if (reply.isError || cursor === undefined) return undefined
          this.size = cursor.size
          return { _tag: "Snapshot", data: renderSnapshot(reply.lines, cursor), size: cursor.size }
        }),
      )
    })

    return { events, input, resize, snapshot }
  }

  /** Sends SIGTERM to the pane's process. It runs in the Sandbox, so tmux's own shell sends it. */
  get terminate(): Effect.Effect<void> {
    return this.issue(`run-shell -t ${this.pane} '[ #{pane_dead} = 1 ] || kill -TERM #{pane_pid}'`)
  }

  /** `Exited`, the first time only. */
  private exit(exitCode: number | undefined): Array<PaneEvent> {
    if (this.done) return []
    this.stop()
    return [{ _tag: "Exited", exitCode }]
  }

  private stop(): void {
    this.done = true
    clearTimeout(this.reapCheck)
  }

  /**
   * The pane is dead, but tmux hasn't reaped its process, so doesn't know how it ended. tmux reaps
   * when a SIGCHLD reaches it, and a pane's can be missed: the status then waits for the next
   * child of the server to exit (#296). So each check starts a job, whose exit reaps every child
   * that has exited, and later reads what tmux knows. `-b` keeps a missed SIGCHLD for the job from
   * holding up the commands after it. The subscription says so too, once tmux knows.
   */
  private awaitReap(): void {
    if (this.done || this.deadSince !== undefined) return
    this.deadSince = Date.now()
    const check = (delay: number) => {
      this.reapCheck = setTimeout(() => {
        if (this.done) return
        this.issueUnsafe("run-shell -b true", () => undefined)
        this.issueUnsafe(
          `display-message -p -t ${this.pane} '${PaneExitFormat} #{version}'`,
          (reply) => {
            if (this.done || reply.isError) return undefined
            const line = reply.lines[0] ?? ""
            const exit = parsePaneExit(line)
            if (exit === undefined) return undefined
            if (exit.known) return this.exit(exit.exitCode)[0]
            // Without `pane_dead_signal`, a process a signal killed is never known: give it time.
            const waited = Date.now() - (this.deadSince ?? Date.now())
            if (
              !reportsSignals(line.split(" ").at(-1) ?? "") &&
              waited >= ReapGiveUpWithoutSignalsMs
            )
              return this.exit(undefined)[0]
            check(Math.min(delay * 2, ReapCheckLastMs))
            return undefined
          },
        )
      }, delay)
    }
    check(ReapCheckFirstMs)
  }

  private toEvents(event: ControlEvent): Array<PaneEvent> {
    switch (event._tag) {
      case "Output": {
        const data = this.decoder.decode(event.bytes, { stream: true })
        return data === "" ? [] : [{ _tag: "Output", data, size: this.size }]
      }
      case "Reply": {
        const out = this.pending.shift()?.(event)
        return out === undefined ? [] : [out]
      }
      case "LayoutChange":
        this.size = event.size
        this.target = event.size
        return []
      case "SubscriptionChanged": {
        if (event.name !== ExitSubscription) return []
        const exit = parsePaneExit(event.value)
        if (exit === undefined) return []
        if (exit.known) return this.exit(exit.exitCode)
        this.awaitReap()
        return []
      }
      case "SessionChanged":
        Deferred.doneUnsafe(this.attached, Effect.void)
        return []
      case "Exit":
        return []
    }
  }
}

/**
 * A pane's `PaneExitFormat`: undefined while it runs; once dead, its exit status, and whether
 * tmux knows how it ended yet (an exit status, or a signal, which has none).
 */
function parsePaneExit(
  value: string,
): { readonly known: boolean; readonly exitCode: number | undefined } | undefined {
  const [dead = "", status = "", signal = ""] = value.split(" ").map((part) => part.trim())
  if (dead !== "1") return undefined
  const exitCode = status === "" ? undefined : Number(status)
  return {
    known: status !== "" || signal !== "",
    exitCode: Number.isInteger(exitCode) ? exitCode : undefined,
  }
}

/** Whether a tmux of `version` (`#{version}`, like `3.3a`) has `pane_dead_signal`: 3.3 or later. */
function reportsSignals(version: string): boolean {
  const [major = Number.NaN, minor = Number.NaN] = version
    .split(".")
    .map((part) => Number.parseInt(part, 10))
  if (Number.isNaN(major) || Number.isNaN(minor)) return true
  return major > 3 || (major === 3 && minor >= 3)
}
