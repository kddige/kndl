// The terminals Sessions run in: one tmux session per Session, on a tmux server inside the
// Session's Sandbox (ADR 0013). tmux runs through the backend's exec, never the `msb` command
// line, which returns output only once a command exits. The server dies with the VM, so a
// Session's terminal lasts as long as its Sandbox runs.

import { MaxLastOutputLength, type SessionId, type TerminalSize } from "@kndl/protocol"
import { Context, Data, Effect, Layer, Queue, type Scope, Stream } from "effect"
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
export type PaneEvent =
  /** The terminal printed `data`, to write after what came before. */
  | { readonly _tag: "Output"; readonly data: string; readonly size: TerminalSize }
  /** The whole screen, answering {@link Pane.snapshot}: reset a terminal of `size` and draw it. */
  | { readonly _tag: "Snapshot"; readonly data: string; readonly size: TerminalSize }
  /** The process in the terminal ended. Always the last event. */
  | { readonly _tag: "Exited"; readonly exitCode: number | undefined }

/** A Session's terminal, attached for as long as the scope it was attached in. */
export interface Pane {
  /**
   * Everything the terminal does from now on. Ends after `Exited`, or without it when the tmux
   * session or its Sandbox is gone. Consume it once.
   */
  readonly events: Stream.Stream<PaneEvent>
  /** Types `data` into the terminal, byte for byte. */
  readonly input: (data: string) => Effect.Effect<void>
  /** Resizes the terminal, then sends a `Snapshot` at the new size. A no-op at the same size. */
  readonly resize: (size: TerminalSize) => Effect.Effect<void>
  /** Asks for a `Snapshot` event, which arrives in order with the output. */
  readonly snapshot: Effect.Effect<void>
  /** Sends SIGTERM to the process, which lets Claude Code end its session cleanly (spike #4). */
  readonly terminate: Effect.Effect<void>
}

export interface LaunchSpec {
  readonly sessionId: SessionId
  /** The directory it starts in, in the Sandbox. */
  readonly cwd: string
  readonly argv: ReadonlyArray<string>
  /**
   * Its environment, over the tmux server's. Given to this process alone (`new-session -e`),
   * never to the server or the Sandbox, so it may hold the Session token (ADR 0013).
   */
  readonly env: Readonly<Record<string, string>>
  readonly size: TerminalSize
}

/** The terminals Sessions run in: one tmux session per Session, in the Session's Sandbox. */
export class Tmux extends Context.Service<
  Tmux,
  {
    /** Starts `argv` in a new detached tmux session in the Session's running Sandbox. */
    readonly launch: (spec: LaunchSpec) => Effect.Effect<void, TmuxError>
    readonly attach: (sessionId: SessionId) => Effect.Effect<Pane, TmuxError, Scope.Scope>
    /**
     * The last lines the Session's terminal shows, as plain text: see {@link lastOutputOf}. Read
     * from a dead pane, before {@link kill}, it is what Claude Code printed before it exited.
     * Empty when there is nothing, or no such tmux session or running Sandbox.
     */
    readonly lastOutput: (sessionId: SessionId) => Effect.Effect<string>
    /**
     * The variable `name` of the environment the Session's process was launched with, while it
     * runs, as read back after a Runner restart (#157). Undefined once the process has exited, or
     * with no such variable, tmux session or running Sandbox.
     */
    readonly variable: (sessionId: SessionId, name: string) => Effect.Effect<string | undefined>
    /** Ends the Session's tmux session and anything still running in it. */
    readonly kill: (sessionId: SessionId) => Effect.Effect<void>
    /**
     * Stops the Runner's tmux server on the host, where Sessions ran Claude Code before it moved
     * into their Sandboxes (ADR 0013), if one is left from before the upgrade. Run once, at startup.
     */
    readonly retireHostServer: Effect.Effect<void>
  }
>()("@kndl/runner/Tmux") {}

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

/** What the Tmux service needs of a Sandbox backend: running commands. */
export type TmuxBackend = Pick<SandboxBackendShape, "exec" | "spawn">

const sandboxMessage = (error: SandboxError) =>
  error._tag === "InvalidSandboxSpec" || error._tag === "SandboxBackendError"
    ? error.message
    : `${error._tag} (${error.sessionId})`

/**
 * tmux in Sessions' Sandboxes through `backend`: its command line for each command, and one
 * control-mode client (`tmux -C`) per attached Session, which streams the pane's output and takes
 * commands whose replies arrive in order with it.
 */
export const makeTmux = (backend: TmuxBackend) => {
  // A failure's message is tmux's own, never its arguments: a launch's carry the Session token.
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

  // The server stays up with no sessions, keeps a dead pane so its exit status can be read, sizes
  // windows only when told to, and has no status line taking a row from the terminal. Focus events
  // pass through, or Claude Code prints a hint to turn them on in a tmux.conf. Window size is the
  // window's own, never the server's: tmux 3.3 (Debian 12's) crashes when the global option is
  // manual and there is no session, which is what a relaunch starts from.
  //
  // tmux gives a new session's process the PATH of the client that made it, over `-e PATH=`
  // (tmux's spawn.c), so the client runs with the launch's PATH: Claude Code and its tools get
  // the login PATH, not the Sandbox's default one.
  const launch = (spec: LaunchSpec) =>
    tmux(
      spec.sessionId,
      sequence([
        ["start-server"],
        ["set-option", "-g", "exit-empty", "off"],
        ["set-option", "-g", "remain-on-exit", "on"],
        ["set-option", "-g", "status", "off"],
        ["set-option", "-g", "focus-events", "on"],
        [
          "new-session",
          "-d",
          "-s",
          tmuxSessionName(spec.sessionId),
          "-x",
          String(spec.size.cols),
          "-y",
          String(spec.size.rows),
          "-c",
          spec.cwd,
          ...Object.entries(spec.env).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
          "--",
          ...spec.argv,
        ],
        ["set-option", "-w", "-t", `=${tmuxSessionName(spec.sessionId)}:`, "window-size", "manual"],
      ]),
      spec.env.PATH === undefined ? undefined : { PATH: spec.env.PATH },
    ).pipe(Effect.asVoid)

  // `-J` joins the lines tmux wrapped; without `-e` the text comes without colours.
  const lastOutput = (sessionId: SessionId) =>
    tmux(sessionId, [
      "capture-pane",
      "-p",
      "-J",
      "-S",
      String(-LastOutputScrollback),
      "-t",
      `=${tmuxSessionName(sessionId)}:`,
    ]).pipe(
      Effect.map(lastOutputOf),
      Effect.orElseSucceed(() => ""),
    )

  // The tmux session's environment is the one `new-session -e` launched the process with. The
  // value is read last, so a failure's output never holds it.
  const variable = (sessionId: SessionId, name: string) => {
    const target = `=${tmuxSessionName(sessionId)}`
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

  const kill = (sessionId: SessionId) =>
    tmux(sessionId, ["kill-session", "-t", `=${tmuxSessionName(sessionId)}`]).pipe(Effect.ignore)

  const attach = (sessionId: SessionId) =>
    Effect.gen(function* () {
      const target = `=${tmuxSessionName(sessionId)}`
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
      yield* Stream.fromQueue(commands).pipe(
        Stream.runForEach((command) => client.write(command)),
        Effect.ignore,
        Effect.forkScoped,
      )
      const pane = new ControlPane(commands, `${target}:`, {
        cols: Math.max(cols, 1),
        rows: Math.max(rows, 1),
      })
      yield* pane.issue(`refresh-client -B '${ExitSubscription}::#{pane_dead} #{pane_dead_status}'`)
      return pane.toPane(
        client.events.pipe(
          Stream.filter((event) => event._tag === "Stdout"),
          Stream.map((event) => event.data),
        ),
      )
    })

  return { launch, attach, lastOutput, variable, kill }
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

/** tmux commands run as one, separated by `;`. */
function sequence(commands: ReadonlyArray<ReadonlyArray<string>>): Array<string> {
  return commands.flatMap((command, index) => [
    ...(index === 0 ? [] : [";"]),
    ...command.map(literalArgument),
  ])
}

const ExitSubscription = "kndl-exit"

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

  /** The size last asked for, which tmux may not have applied yet. */
  private target: TerminalSize

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
    return Effect.sync(() => {
      this.pending.push(handler)
      Queue.offerUnsafe(this.commands, `${command}\n`)
    })
  }

  toPane(stdout: Stream.Stream<Uint8Array, unknown>): Pane {
    const events = stdout.pipe(
      Stream.map((chunk) => this.parser.push(chunk).flatMap((event) => this.toEvents(event))),
      Stream.flattenIterable,
      Stream.takeUntil((event) => event._tag === "Exited"),
      Stream.catchCause(() => Stream.empty),
    )

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

    // The process runs in the Sandbox, so the signal is sent there, by tmux's own shell.
    const terminate = this.issue(
      `run-shell -t ${this.pane} '[ #{pane_dead} = 1 ] || kill -TERM #{pane_pid}'`,
    )

    return { events, input, resize, snapshot, terminate }
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
        const [dead, status] = event.value.trim().split(" ")
        if (dead !== "1") return []
        const exitCode = status === undefined || status === "" ? undefined : Number(status)
        return [{ _tag: "Exited", exitCode: Number.isInteger(exitCode) ? exitCode : undefined }]
      }
      case "Exit":
        return []
    }
  }
}
