import type { TerminalSize } from "@kndl/protocol"

// tmux control mode (`tmux -C attach`): the client reads one line per notification on stdout
// and writes one command per line on stdin. Each command gets one reply, a %begin/%end (or
// %error) block, in the order the commands were sent, interleaved in order with the pane's
// %output. See tmux(1), CONTROL MODE.

/** One thing a control-mode client reported. */
export type ControlEvent =
  /** The pane printed `bytes`, raw (they may end mid UTF-8 character). */
  | { readonly _tag: "Output"; readonly paneId: string; readonly bytes: Uint8Array }
  /** The reply to one command this client sent, in the order sent. */
  | { readonly _tag: "Reply"; readonly lines: ReadonlyArray<string>; readonly isError: boolean }
  /** The window's layout changed, which carries its size. */
  | { readonly _tag: "LayoutChange"; readonly size: TerminalSize }
  /** A format subscribed to with `refresh-client -B` changed value. */
  | { readonly _tag: "SubscriptionChanged"; readonly name: string; readonly value: string }
  /** The client's attachment has completed, or it has switched to another session. */
  | { readonly _tag: "SessionChanged" }
  /** The client is detaching: its session was killed, or stdin closed. */
  | { readonly _tag: "Exit"; readonly reason: string | undefined }

const newline = 0x0a
const backslash = 0x5c
const decoder = new TextDecoder()

/** Turns the client's stdout, chunk by chunk, into {@link ControlEvent}s. */
export class ControlModeParser {
  private partial: Array<Uint8Array> = []
  private block: { readonly id: string; readonly isOwn: boolean; lines: Array<string> } | undefined

  push(chunk: Uint8Array): Array<ControlEvent> {
    const events: Array<ControlEvent> = []
    let start = 0
    for (let index = chunk.indexOf(newline); index !== -1; index = chunk.indexOf(newline, start)) {
      this.partial.push(chunk.subarray(start, index))
      const event = this.line(concat(this.partial))
      if (event !== undefined) events.push(event)
      this.partial = []
      start = index + 1
    }
    if (start < chunk.length) this.partial.push(chunk.slice(start))
    return events
  }

  private line(bytes: Uint8Array): ControlEvent | undefined {
    if (this.block !== undefined) {
      const text = decoder.decode(bytes)
      const end = /^%(end|error) (.*)$/.exec(text)
      if (end === null || end[2] !== this.block.id) {
        this.block.lines.push(text)
        return undefined
      }
      const { isOwn, lines } = this.block
      this.block = undefined
      // A reply to a command this client did not send itself, such as the `attach` it started with.
      if (!isOwn) return undefined
      return { _tag: "Reply", lines, isError: end[1] === "error" }
    }

    if (startsWith(bytes, "%output ")) {
      const paneEnd = bytes.indexOf(0x20, 8)
      if (paneEnd === -1) return undefined
      return {
        _tag: "Output",
        paneId: decoder.decode(bytes.subarray(8, paneEnd)),
        bytes: unescapeOutput(bytes.subarray(paneEnd + 1)),
      }
    }

    const text = decoder.decode(bytes)
    const [name, ...args] = text.split(" ")
    switch (name) {
      case "%begin": {
        // `%begin <time> <command number> <flags>`; flag 1 marks a command from this client.
        const id = args.join(" ")
        this.block = { id, isOwn: (Number(args[2]) & 1) === 1, lines: [] }
        return undefined
      }
      case "%layout-change": {
        // `%layout-change @<window> <layout> <visible layout> <flags>`; a layout starts with
        // `<checksum>,<cols>x<rows>,`.
        const size = /^[0-9a-f]{4},(\d+)x(\d+),/.exec(args[1] ?? "")
        if (size === null) return undefined
        return { _tag: "LayoutChange", size: { cols: Number(size[1]), rows: Number(size[2]) } }
      }
      case "%subscription-changed": {
        // `%subscription-changed <name> $<session> @<window> <index> %<pane> ... : <value>`
        const separator = text.indexOf(" : ")
        if (separator === -1 || args[0] === undefined) return undefined
        return { _tag: "SubscriptionChanged", name: args[0], value: text.slice(separator + 3) }
      }
      case "%session-changed":
        return { _tag: "SessionChanged" }
      case "%exit":
        return { _tag: "Exit", reason: args.length > 0 ? args.join(" ") : undefined }
      default:
        return undefined
    }
  }
}

/** Undoes %output's escaping: bytes below 32, and backslash, arrive as `\ooo` in octal. */
export function unescapeOutput(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length)
  let length = 0
  let index = 0
  while (index < bytes.length) {
    const byte = bytes[index] ?? 0
    const escaped = byte === backslash ? octal(bytes, index + 1) : undefined
    if (escaped === undefined) {
      out[length++] = byte
      index += 1
    } else {
      out[length++] = escaped
      index += 4
    }
  }
  return out.slice(0, length)
}

/** Where the cursor is, read with `display-message -p` before a `capture-pane`. */
export interface CursorState {
  readonly x: number
  readonly y: number
  readonly isVisible: boolean
  readonly size: TerminalSize
}

/** The `display-message -p` format that {@link parseCursorState} reads. */
export const cursorStateFormat =
  "#{cursor_x} #{cursor_y} #{cursor_flag} #{pane_width} #{pane_height}"

export function parseCursorState(line: string | undefined): CursorState | undefined {
  const fields = (line ?? "").trim().split(" ").map(Number)
  if (fields.length !== 5 || fields.some((field) => !Number.isInteger(field))) return undefined
  const [x, y, flag, cols, rows] = fields as [number, number, number, number, number]
  if (cols < 1 || rows < 1) return undefined
  return { x, y, isVisible: flag === 1, size: { cols, rows } }
}

/**
 * Turns a `capture-pane -p -e` of the visible screen and the cursor into terminal output that
 * redraws that screen on a reset terminal of the same size. tmux carries attributes from one line
 * into the next, sending only changes, so nothing resets them between lines: a background set on
 * one line can colour the next.
 */
export function renderSnapshot(lines: ReadonlyArray<string>, cursor: CursorState): string {
  const screen = lines.slice(0, cursor.size.rows).join("\r\n")
  const show = cursor.isVisible ? "\x1b[?25h" : "\x1b[?25l"
  return `\x1b[0m\x1b[H\x1b[2J${screen}\x1b[0m\x1b[${cursor.y + 1};${cursor.x + 1}H${show}`
}

/** Reads the three octal digits at `from`, or `undefined` when they aren't there. */
function octal(bytes: Uint8Array, from: number): number | undefined {
  let value = 0
  for (let index = from; index < from + 3; index++) {
    const byte = bytes[index]
    if (byte === undefined || byte < 48 || byte > 55) return undefined
    value = value * 8 + byte - 48
  }
  return value
}

function startsWith(bytes: Uint8Array, prefix: string): boolean {
  if (bytes.length < prefix.length) return false
  for (let index = 0; index < prefix.length; index++) {
    if (bytes[index] !== prefix.charCodeAt(index)) return false
  }
  return true
}

function concat(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  const [only] = chunks
  if (only !== undefined && chunks.length === 1) return only
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}
