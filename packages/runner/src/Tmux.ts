import type { SessionId, TerminalSize } from "@claude-hub/protocol"
import { Context, Data, Effect, Layer, Queue, type Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import {
  type ControlEvent,
  ControlModeParser,
  type CursorState,
  cursorStateFormat,
  parseCursorState,
  renderSnapshot,
} from "./ControlMode.ts"
import { hostEnvironment, runCommand } from "./Process.ts"
import { RunnerConfig } from "./RunnerConfig.ts"
import { sessionIdOfTmuxName, tmuxSessionName } from "./SessionNames.ts"

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
   * session is gone. Consume it once.
   */
  readonly events: Stream.Stream<PaneEvent>
  /** Types `data` into the terminal, byte for byte. */
  readonly input: (data: string) => Effect.Effect<void>
  readonly resize: (size: TerminalSize) => Effect.Effect<void>
  /** Asks for a `Snapshot` event, which arrives in order with the output. */
  readonly snapshot: Effect.Effect<void>
  /** Sends SIGTERM to the process, which lets Claude Code end its session cleanly (spike #4). */
  readonly terminate: Effect.Effect<void>
}

export interface LaunchSpec {
  readonly sessionId: SessionId
  readonly cwd: string
  readonly argv: ReadonlyArray<string>
  /** Added to the tmux server's environment for this process. */
  readonly env: Readonly<Record<string, string>>
  readonly size: TerminalSize
}

/**
 * The terminals Sessions run in: one tmux session per Session, on the Runner's own tmux server,
 * so they outlive the Runner and are re-adopted when it restarts.
 */
export class Tmux extends Context.Service<
  Tmux,
  {
    /** The Sessions whose tmux session exists, whether or not its process still runs. */
    readonly list: Effect.Effect<ReadonlyArray<SessionId>, TmuxError>
    /** Starts `argv` in a new detached tmux session for the Session. */
    readonly launch: (spec: LaunchSpec) => Effect.Effect<void, TmuxError>
    readonly attach: (sessionId: SessionId) => Effect.Effect<Pane, TmuxError, Scope.Scope>
    /** Ends the Session's tmux session and anything still running in it. */
    readonly kill: (sessionId: SessionId) => Effect.Effect<void>
  }
>()("@claude-hub/runner/Tmux") {}

/**
 * tmux through its command line, and one control-mode client (`tmux -C`) per attached Session,
 * which streams the pane's output and takes commands whose replies arrive in order with it.
 */
export const TmuxLive = Layer.effect(
  Tmux,
  Effect.gen(function* () {
    const config = yield* RunnerConfig
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    // `-f /dev/null`: the user's tmux.conf must not change how Sessions behave.
    const server = ["-L", config.tmuxSocket, "-f", "/dev/null"]

    const tmux = (args: ReadonlyArray<string>) =>
      runCommand("tmux", [...server, ...args]).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError((error) => new TmuxError({ message: error.message })),
      )

    // The server stays up with no sessions, keeps a dead pane so its exit status can be read,
    // sizes windows only when told to, and has no status line taking a row from the terminal.
    const configureServer = tmux(
      [
        ["start-server"],
        ["set-option", "-g", "exit-empty", "off"],
        ["set-option", "-g", "remain-on-exit", "on"],
        ["set-option", "-g", "window-size", "manual"],
        ["set-option", "-g", "status", "off"],
      ].flatMap((command, index) => (index === 0 ? command : [";", ...command])),
    )

    const list = tmux(["list-sessions", "-F", "#{session_name}"]).pipe(
      Effect.map(({ stdout }) =>
        stdout.split("\n").flatMap((name) => {
          const id = sessionIdOfTmuxName(name.trim())
          return id === undefined ? [] : [id]
        }),
      ),
      // No server yet means no Sessions.
      Effect.catchIf(
        (error) => /no server running|error connecting to/.test(error.message),
        () => Effect.succeed([]),
      ),
    )

    const launch = (spec: LaunchSpec) =>
      Effect.gen(function* () {
        yield* configureServer
        yield* tmux(
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
          ].map(literalArgument),
        )
      })

    const kill = (sessionId: SessionId) =>
      tmux(["kill-session", "-t", `=${tmuxSessionName(sessionId)}`]).pipe(Effect.ignore)

    const attach = (sessionId: SessionId) =>
      Effect.gen(function* () {
        const target = `=${tmuxSessionName(sessionId)}`
        const { stdout } = yield* tmux([
          "display-message",
          "-p",
          "-t",
          `${target}:`,
          "#{window_width} #{window_height}",
        ])
        const [cols = 0, rows = 0] = stdout.trim().split(" ").map(Number)
        const commands = yield* Queue.unbounded<string>()
        const client = yield* spawner
          .spawn(
            ChildProcess.make("tmux", [...server, "-u", "-C", "attach-session", "-t", target], {
              env: hostEnvironment(),
              extendEnv: false,
              stdin: Stream.fromQueue(commands).pipe(Stream.encodeText),
              stderr: "ignore",
            }),
          )
          .pipe(Effect.mapError((error) => new TmuxError({ message: error.message })))
        const pane = new ControlPane(commands, { cols: Math.max(cols, 1), rows: Math.max(rows, 1) })
        yield* pane.issue(
          `refresh-client -B '${ExitSubscription}::#{pane_dead} #{pane_dead_status}'`,
        )
        return pane.toPane(client.stdout)
      })

    return Tmux.of({ list, launch, attach, kill })
  }),
)

const ExitSubscription = "claude-hub-exit"

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

  constructor(
    private readonly commands: Queue.Queue<string>,
    private size: TerminalSize,
  ) {}

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

    const resize = (size: TerminalSize) =>
      this.issue(`resize-window -x ${size.cols} -y ${size.rows}`)

    const snapshot = Effect.suspend(() => {
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

    const terminate = this.issue("display-message -p '#{pane_pid} #{pane_dead}'", (reply) => {
      const [pid = 0, dead = 1] = (reply.lines[0] ?? "").split(" ").map(Number)
      if (!reply.isError && pid > 0 && dead === 0) {
        try {
          process.kill(pid, "SIGTERM")
        } catch {
          // It already exited.
        }
      }
      return undefined
    })

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
