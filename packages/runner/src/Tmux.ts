import { MaxLastOutputLength, type SessionId, type TerminalSize } from "@claude-hub/protocol"
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
  /** Resizes the terminal, then sends a `Snapshot` at the new size. A no-op at the same size. */
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
  /**
   * Added to the tmux server's environment for this process. `PWD` (the cwd) and the Runner's
   * own `PATH` are always added too: see {@link paneEnvironment}.
   */
  readonly env: Readonly<Record<string, string>>
  readonly size: TerminalSize
}

/** The variables of a tmux server's global environment that matter to a launch (#105). */
export interface ServerEnvironment {
  readonly PWD?: string
  readonly OLDPWD?: string
  readonly PATH?: string
}

/** What {@link Tmux}'s `claimServer` found on the Runner's tmux socket, and did about it. */
export type ServerClaim =
  /** No server runs on the socket: the first launch starts one with the Runner's environment. */
  | { readonly _tag: "NoServer" }
  /**
   * A server with no sessions, perhaps left by another Runner (as one run from a checkout since
   * deleted): it was killed, so the first launch starts a fresh one. `changed` says how its
   * environment differed from the Runner's, as for `Refreshed`.
   */
  | { readonly _tag: "Replaced"; readonly changed: ReadonlyArray<string> }
  /**
   * A server with sessions, which is never killed: its global `PATH` was set to the Runner's, and
   * `PWD` and `OLDPWD` unset. `changed` says what was different, empty when nothing was.
   */
  | {
      readonly _tag: "Refreshed"
      readonly sessions: number
      readonly changed: ReadonlyArray<string>
    }

/**
 * The terminals Sessions run in: one tmux session per Session, on the Runner's own tmux server,
 * so they outlive the Runner and are re-adopted when it restarts.
 */
export class Tmux extends Context.Service<
  Tmux,
  {
    /**
     * Makes the server on the Runner's socket one with the Runner's environment, at startup: one
     * with no sessions is killed, one with sessions has its environment refreshed (#105).
     */
    readonly claimServer: Effect.Effect<ServerClaim, TmuxError>
    /** The Sessions whose tmux session exists, whether or not its process still runs. */
    readonly list: Effect.Effect<ReadonlyArray<SessionId>, TmuxError>
    /** Starts `argv` in a new detached tmux session for the Session. */
    readonly launch: (spec: LaunchSpec) => Effect.Effect<void, TmuxError>
    readonly attach: (sessionId: SessionId) => Effect.Effect<Pane, TmuxError, Scope.Scope>
    /**
     * The last lines the Session's terminal shows, as plain text: see {@link lastOutputOf}. Read
     * from a dead pane, before {@link kill}, it is what Claude Code printed before it exited.
     * Empty when there is nothing, or no such tmux session.
     */
    readonly lastOutput: (sessionId: SessionId) => Effect.Effect<string>
    /** Ends the Session's tmux session and anything still running in it. */
    readonly kill: (sessionId: SessionId) => Effect.Effect<void>
  }
>()("@claude-hub/runner/Tmux") {}

/**
 * The environment a Session's process gets on top of the tmux server's: `env`, with `PWD` set to
 * the directory it starts in and `PATH` to the Runner's own. Never what the server had: a server
 * started by another process (a Runner run from a checkout since deleted, say) keeps that
 * process's `PWD` and `PATH` in its global environment, and Claude Code trusts `PWD`, exiting
 * with "The current working directory was deleted" when it is gone (#105).
 */
export function paneEnvironment(
  spec: Pick<LaunchSpec, "cwd" | "env">,
  runnerPath: string | undefined,
): Record<string, string> {
  return {
    ...(runnerPath === undefined ? {} : { PATH: runnerPath }),
    ...spec.env,
    PWD: spec.cwd,
  }
}

/** `show-environment -g`'s answer, as the variables set: a `-NAME` line is one unset. */
export function parseServerEnvironment(stdout: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of stdout.split("\n")) {
    const at = line.indexOf("=")
    if (line.startsWith("-") || at <= 0) continue
    out[line.slice(0, at)] = line.slice(at + 1)
  }
  return out
}

/** What refreshing a server's environment to the Runner's changes, said for the Runner's log. */
export function environmentChanges(
  before: ServerEnvironment,
  runnerPath: string | undefined,
): ReadonlyArray<string> {
  const changes: Array<string> = []
  if (runnerPath !== undefined && before.PATH !== runnerPath) {
    changes.push(`PATH was ${before.PATH ?? "unset"}`)
  }
  if (before.PWD !== undefined) changes.push(`PWD was ${before.PWD}`)
  if (before.OLDPWD !== undefined) changes.push(`OLDPWD was ${before.OLDPWD}`)
  return changes
}

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

    const runnerPath = hostEnvironment().PATH

    // The server stays up with no sessions, keeps a dead pane so its exit status can be read,
    // sizes windows only when told to, and has no status line taking a row from the terminal.
    // It outlives the Runner, so it does not keep the Runner's working directory as `PWD`: that
    // directory may be deleted by the time the server next starts a Session (#105).
    const configureServer = tmux(
      sequence([
        ["start-server"],
        ["set-option", "-g", "exit-empty", "off"],
        ["set-option", "-g", "remain-on-exit", "on"],
        ["set-option", "-g", "window-size", "manual"],
        ["set-option", "-g", "status", "off"],
        ["set-environment", "-gu", "PWD"],
        ["set-environment", "-gu", "OLDPWD"],
      ]),
    )

    const sessionNames = tmux(["list-sessions", "-F", "#{session_name}"]).pipe(
      Effect.map(({ stdout }) =>
        stdout
          .split("\n")
          .map((name) => name.trim())
          .filter((name) => name !== ""),
      ),
      // No server yet means no sessions; some tmux versions say so for a server without any.
      Effect.catchIf(
        (error) => noServer(error) || /no sessions/.test(error.message),
        () => Effect.succeed([]),
      ),
    )

    const list = sessionNames.pipe(
      Effect.map((names) =>
        names.flatMap((name) => {
          const id = sessionIdOfTmuxName(name)
          return id === undefined ? [] : [id]
        }),
      ),
    )

    const claimServer: Effect.Effect<ServerClaim, TmuxError> = Effect.gen(function* () {
      const shown = yield* tmux(["show-environment", "-g"]).pipe(
        Effect.map(({ stdout }) => parseServerEnvironment(stdout)),
        Effect.catchIf(noServer, () => Effect.succeed(undefined)),
      )
      if (shown === undefined) return { _tag: "NoServer" } as const
      const environment: ServerEnvironment = {
        ...(shown.PWD === undefined ? {} : { PWD: shown.PWD }),
        ...(shown.OLDPWD === undefined ? {} : { OLDPWD: shown.OLDPWD }),
        ...(shown.PATH === undefined ? {} : { PATH: shown.PATH }),
      }
      const changed = environmentChanges(environment, runnerPath)
      const sessions = (yield* sessionNames).length
      if (sessions === 0) {
        yield* tmux(["kill-server"]).pipe(Effect.catchIf(noServer, () => Effect.void))
        return { _tag: "Replaced", changed } as const
      }
      yield* tmux(
        sequence([
          ...(runnerPath === undefined ? [] : [["set-environment", "-g", "PATH", runnerPath]]),
          ["set-environment", "-gu", "PWD"],
          ["set-environment", "-gu", "OLDPWD"],
        ]),
      )
      return { _tag: "Refreshed", sessions, changed } as const
    })

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
            ...Object.entries(paneEnvironment(spec, runnerPath)).flatMap(([key, value]) => [
              "-e",
              `${key}=${value}`,
            ]),
            "--",
            ...spec.argv,
          ].map(literalArgument),
        )
      })

    // `-J` joins the lines tmux wrapped; without `-e` the text comes without colours.
    const lastOutput = (sessionId: SessionId) =>
      tmux([
        "capture-pane",
        "-p",
        "-J",
        "-S",
        String(-LastOutputScrollback),
        "-t",
        `=${tmuxSessionName(sessionId)}:`,
      ]).pipe(
        Effect.map(({ stdout }) => lastOutputOf(stdout)),
        Effect.orElseSucceed(() => ""),
      )

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

    return Tmux.of({ claimServer, list, launch, attach, lastOutput, kill })
  }),
)

/** No tmux server runs on the socket. */
const noServer = (error: TmuxError) => /no server running|error connecting to/.test(error.message)

/** tmux commands run as one, separated by `;`. */
function sequence(commands: ReadonlyArray<ReadonlyArray<string>>): Array<string> {
  return commands.flatMap((command, index) => [
    ...(index === 0 ? [] : [";"]),
    ...command.map(literalArgument),
  ])
}

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

  /** The size last asked for, which tmux may not have applied yet. */
  private target: TerminalSize

  constructor(
    private readonly commands: Queue.Queue<string>,
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
