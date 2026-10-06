// The terminal of `kndl forward` (#180): the keys it reads in raw mode, the Session picker,
// the live list of what's forwarded, and the screen they are drawn on, redrawn in place. The keys,
// the picker and the drawing are pure, so they are tested without a terminal.
import { isDockerPort, type SessionSummary } from "@kndl/protocol"
import { localUrl, sessionLine, sessionTitle, shortId } from "./ForwardArgs.ts"
import type { ForwardedPort } from "./ForwardPorts.ts"

/** What a key press means here. */
export type Key = "up" | "down" | "enter" | "escape" | "interrupt" | "quit"

/**
 * The keys in what raw-mode stdin gave at once. An escape sequence (an arrow, say) comes whole in
 * one read, so a lone ESC is the Esc key.
 */
export function keysOf(chunk: string): ReadonlyArray<Key> {
  const keys: Array<Key> = []
  let i = 0
  while (i < chunk.length) {
    const rest = chunk.slice(i)
    // oxlint-disable-next-line eslint/no-control-regex -- a key's escape sequence starts with ESC
    const sequence = /^\x1b(?:\[[0-9;?]*[@-~]|O[@-~])/.exec(rest)?.[0]
    if (sequence !== undefined) {
      const final = sequence.at(-1)
      if (final === "A") keys.push("up")
      else if (final === "B") keys.push("down")
      i += sequence.length
      continue
    }
    const char = chunk.charAt(i)
    i++
    switch (char) {
      case "\x1b":
        keys.push("escape")
        break
      case "\x03":
        keys.push("interrupt")
        break
      case "\x04":
      case "q":
        keys.push("quit")
        break
      case "\r":
      case "\n":
        keys.push("enter")
        break
      case "k":
        keys.push("up")
        break
      case "j":
        keys.push("down")
        break
    }
  }
  return keys
}

export interface Picker {
  readonly sessions: ReadonlyArray<SessionSummary>
  readonly selected: number
}

export type PickerStep =
  | { readonly _tag: "Move"; readonly picker: Picker }
  | { readonly _tag: "Pick"; readonly session: SessionSummary }
  /** Esc, q or Ctrl-C: forward nothing. */
  | { readonly _tag: "Cancel" }

/** What a key does to the picker. */
export function pickerKey(picker: Picker, key: Key): PickerStep {
  const count = picker.sessions.length
  switch (key) {
    case "up":
      return {
        _tag: "Move",
        picker: { ...picker, selected: (picker.selected - 1 + count) % count },
      }
    case "down":
      return { _tag: "Move", picker: { ...picker, selected: (picker.selected + 1) % count } }
    case "enter": {
      const session = picker.sessions[picker.selected]
      return session === undefined ? { _tag: "Cancel" } : { _tag: "Pick", session }
    }
    case "escape":
    case "interrupt":
    case "quit":
      return { _tag: "Cancel" }
  }
}

const bold = (text: string) => `\x1b[1m${text}\x1b[22m`
const dim = (text: string) => `\x1b[2m${text}\x1b[22m`
const inverse = (text: string) => `\x1b[7m${text}\x1b[27m`

/** A terminal's control sequence, as colours and cursor moves are: ESC [, then its parameters. */
// oxlint-disable-next-line eslint/no-control-regex -- it starts with ESC
export const controlSequence = /\x1b\[[0-9;?]*[@-~]/

/** Text without its colours, for a transcript or a test. */
export const plain = (text: string) => text.replace(new RegExp(controlSequence, "g"), "")

/** The picker, a line a Session. */
export function pickerLines(picker: Picker): ReadonlyArray<string> {
  return [
    bold("Forward which Session?"),
    ...picker.sessions.map((session, index) =>
      index === picker.selected
        ? inverse(`> ${sessionLine(session)}`)
        : `  ${sessionLine(session)}`,
    ),
    dim("Up and down to choose, Enter to forward, Esc to quit"),
  ]
}

/** How the live list is: the Session, its ports here, and anything to say. */
export interface LiveView {
  readonly session: SessionSummary
  readonly ports: ReadonlyArray<ForwardedPort>
  /** The addresses listened on. */
  readonly addresses: ReadonlyArray<string>
  /** Whether a forward to the Hub is up now. */
  readonly connected: boolean
  /** A line about the forward itself: waking the Session, reconnecting to the Hub. */
  readonly status: string | undefined
  /** Whether Esc goes back to the picker: only with a terminal to pick on. */
  readonly canPick: boolean
}

/** The Session's state, as the list says it. */
export function stateText(session: SessionSummary): string {
  if (session.state === "Active" && session.starting !== undefined) return "starting"
  if (session.state === "Frozen") return "Frozen: its Runner is offline"
  return session.state
}

/** One port's line: where it is here and what it is, or why it isn't forwarded. */
export function portLine(
  port: ForwardedPort,
  view: Pick<LiveView, "addresses" | "session">,
): string {
  const remap = port.local === port.remote ? "" : ` (port ${port.remote} in the Session)`
  switch (port.state._tag) {
    case "Forwarding": {
      const what = [
        port.open?.process,
        port.open !== undefined && isDockerPort(port.open) ? "Docker" : undefined,
        port.connections === 1
          ? "1 connection"
          : port.connections > 1
            ? `${port.connections} connections`
            : undefined,
      ].filter((part) => part !== undefined)
      return `${localUrl(view.addresses, port.local).padEnd(24)} ${what.join(" · ")}${remap}`
    }
    case "Taken": {
      const holder = port.state.holder === undefined ? "" : ` by ${port.state.holder}`
      return `${String(port.local).padEnd(24)} taken here${holder}: trying again until it's free. Or forward it to another port: kndl forward ${shortId(view.session)} ${port.remote}:${port.local + 100}`
    }
    case "Refused":
      return `${String(port.local).padEnd(24)} ${port.state.message}`
    case "NotOpen":
      // Open in the Session, and listening here is under way.
      if (port.open !== undefined) return `${String(port.local).padEnd(24)} opening here...`
      return `${String(port.local).padEnd(24)} nothing listens on port ${port.remote} in the Session yet`
  }
}

/** The live list. */
export function liveLines(view: LiveView): ReadonlyArray<string> {
  const { session } = view
  const heading = [
    `Forwarding ${bold(shortId(session))} ${sessionTitle(session)}`,
    session.repo,
    stateText(session),
  ].join(" · ")
  const ports =
    view.ports.length === 0
      ? [dim("  Nothing listens in the Session yet: a port appears here once something does.")]
      : view.ports.map((port) => `  ${portLine(port, view)}`)
  return [
    heading,
    ...ports,
    ...(view.status === undefined ? [] : [dim(view.status)]),
    dim(view.canPick ? "Esc: forward another Session · Ctrl-C: stop" : "Ctrl-C: stop"),
  ]
}

/** What the CLI reads keys from: stdin. */
export interface KeyInput {
  readonly isTTY?: boolean
  setRawMode?(raw: boolean): unknown
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown
  resume(): unknown
  pause(): unknown
}

/** What the CLI draws on: stdout. */
export interface ScreenOutput {
  readonly isTTY?: boolean
  readonly columns?: number
  write(text: string): unknown
}

/** Keeps a line within the terminal's width, so a redraw knows how many lines it takes. */
function fit(line: string, columns: number): string {
  if (plain(line).length <= columns) return line
  let visible = 0
  let out = ""
  for (const part of line.split(new RegExp(`(${controlSequence.source})`))) {
    if (part.startsWith("\x1b")) {
      out += part
      continue
    }
    const room = columns - 1 - visible
    if (room <= 0) continue
    out += part.slice(0, room)
    visible += Math.min(part.length, room)
  }
  return `${out}\x1b[0m…`
}

/**
 * A frame redrawn in place, with lines printed above it. On a terminal only; elsewhere a frame
 * isn't drawn and lines are just printed.
 */
export class Screen {
  private height = 0
  private frame: ReadonlyArray<string> = []
  private cursorHidden = false
  private readonly showCursor = () => this.release()

  constructor(private readonly output: ScreenOutput) {}

  get live(): boolean {
    return this.output.isTTY === true
  }

  /** Draws `lines` over the frame drawn before. */
  draw(lines: ReadonlyArray<string>): void {
    if (!this.live) return
    const columns = Math.max(this.output.columns ?? 80, 20)
    this.frame = lines.map((line) => fit(line, columns))
    let text = this.erase()
    if (!this.cursorHidden) {
      text += "\x1b[?25l"
      this.cursorHidden = true
      // However the CLI ends, the cursor shows again.
      process.once("exit", this.showCursor)
    }
    this.output.write(`${text}${this.frame.join("\n")}\n`)
    this.height = this.frame.length
  }

  /** Prints a line above the frame, which stays. */
  print(line: string): void {
    if (!this.live) {
      this.output.write(`${plain(line)}\n`)
      return
    }
    const frame = this.frame
    this.output.write(`${this.erase()}${line}\n`)
    this.height = 0
    if (frame.length > 0) this.draw(frame)
  }

  /** Takes the frame off the screen. */
  clear(): void {
    if (!this.live) return
    this.output.write(this.erase())
    this.height = 0
    this.frame = []
  }

  /** Leaves the frame as it is, and the cursor below it, showing. */
  release(): void {
    if (!this.live) return
    if (this.cursorHidden) {
      this.output.write("\x1b[?25h")
      process.off("exit", this.showCursor)
    }
    this.cursorHidden = false
    this.height = 0
    this.frame = []
  }

  private erase(): string {
    return this.height === 0 ? "\r\x1b[J" : `\x1b[${this.height}F\x1b[J`
  }
}

/**
 * Raw-mode key presses from stdin, while `start`ed: on a terminal only. `stop` puts the terminal
 * back as it was; it runs on exit too, in case the CLI ends without it.
 */
export class Keys {
  private listener: ((chunk: Buffer | string) => void) | undefined
  private readonly restore = () => this.stop()

  constructor(private readonly input: KeyInput) {}

  get available(): boolean {
    return this.input.isTTY === true && this.input.setRawMode !== undefined
  }

  start(onKey: (key: Key) => void): void {
    if (!this.available || this.listener !== undefined) return
    this.listener = (chunk) => {
      for (const key of keysOf(String(chunk))) onKey(key)
    }
    this.input.setRawMode?.(true)
    this.input.on("data", this.listener)
    this.input.resume()
    process.once("exit", this.restore)
  }

  stop(): void {
    if (this.listener === undefined) return
    this.input.off("data", this.listener)
    this.listener = undefined
    this.input.setRawMode?.(false)
    this.input.pause()
    process.off("exit", this.restore)
  }
}
