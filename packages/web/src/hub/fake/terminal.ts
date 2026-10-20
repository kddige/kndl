// The fake Hub's terminals: a believable shell per Session, for the terminal mirror to show. The
// real one is a plain `bash -l` in /workspace that the Runner restarts when it exits, with the
// agent running elsewhere, so this is a prompt to type commands at, and nothing more: a few it
// answers, and "command not found" for the rest. All made up.
//
// It keeps the screen as lines and redraws all of it on every change: a Snapshot clears the screen
// first, Output only overwrites.

export interface TerminalSizeWire {
  readonly cols: number
  readonly rows: number
}

/** A run of text in one style; `sgr` is the SGR parameters, such as "1;32". */
type Span = readonly [text: string, sgr?: string]
type Line = ReadonlyArray<Span>

export interface FakeTerminalHooks {
  /** The screen changed: send Output to everyone watching. */
  readonly changed: () => void
}

const muted = "90"
const green = "32"
const blue = "1;34"

export class FakeTerminal {
  size: TerminalSizeWire = { cols: 120, rows: 40 }
  readonly #hooks: FakeTerminalHooks
  readonly #cwd: string
  readonly #history: Array<Line> = []
  #input = ""
  readonly #sent: Array<string> = []
  #recall = -1

  constructor(hooks: FakeTerminalHooks, options: { cwd: string; demo?: boolean }) {
    this.#hooks = hooks
    this.#cwd = options.cwd
    if (options.demo) this.#demo()
  }

  /** The whole screen, for a Snapshot. */
  snapshot(): string {
    return `\x1b[0m\x1b[H\x1b[2J${this.#draw()}`
  }

  /** The whole screen again, for Output: overwrites each line, so nothing is left behind. */
  redraw(): string {
    return `\x1b[0m\x1b[H${this.#draw()}`
  }

  resize(size: TerminalSizeWire): boolean {
    if (size.cols === this.size.cols && size.rows === this.size.rows) return false
    this.size = size
    return true
  }

  /** Keystrokes, as a terminal sends them. */
  type(data: string): void {
    for (const key of keys(data)) this.#key(key)
    this.#hooks.changed()
  }

  // ── Keys ─────────────────────────────────────────────────────────────────

  #key(key: string): void {
    switch (key) {
      case "enter":
        this.#run(this.#input)
        return
      case "ctrl-c":
        // Bash shows the interrupt after what was typed, and gives a fresh prompt.
        this.#history.push(this.#promptLine(`${this.#input}^C`))
        this.#input = ""
        this.#recall = -1
        return
      case "backspace":
        this.#input = this.#input.slice(0, -1)
        return
      case "up":
      case "down": {
        if (this.#sent.length === 0) return
        const step = key === "up" ? -1 : 1
        const from = this.#recall === -1 ? this.#sent.length : this.#recall
        this.#recall = Math.max(0, Math.min(this.#sent.length, from + step))
        this.#input = this.#sent[this.#recall] ?? ""
        if (this.#recall === this.#sent.length) this.#recall = -1
        return
      }
      default:
        if (key.length === 1 && key >= " ") this.#input += key
    }
  }

  /** Runs what was typed, as far as the fake knows how: the command and what it printed. */
  #run(typed: string): void {
    const command = typed.trim()
    this.#history.push(this.#promptLine(typed))
    this.#input = ""
    this.#recall = -1
    if (command === "") return
    this.#sent.push(command)
    const [name = "", ...args] = command.split(/\s+/)
    switch (name) {
      case "pwd":
        this.#history.push([[this.#cwd]])
        return
      case "echo":
        this.#history.push([[args.join(" ")]])
        return
      case "ls":
        this.#history.push([["kndl", blue], ["  notes.md"]])
        return
      case "clear":
        this.#history.length = 0
        return
      default:
        this.#history.push([[`bash: ${name}: command not found`]])
    }
  }

  /** The demo Session's terminal has had a command run in it. */
  #demo(): void {
    this.#history.push(
      this.#promptLine("bun test packages/web"),
      [["bun test v1.4.0", muted]],
      [["168 pass", green]],
      [["0 fail"]],
      [["Ran 168 tests across 11 files. [1.92s]", muted]],
    )
  }

  // ── Drawing ──────────────────────────────────────────────────────────────

  #promptLine(typed: string): Line {
    return [[`runner@sandbox:${this.#cwd}`, green], ["$ "], [typed]]
  }

  #draw(): string {
    const { cols, rows } = this.size
    const prompt = this.#promptLine(this.#input)
    // What fits above the prompt, which is always the last line on the screen.
    const shown = this.#history.slice(-Math.max(0, rows - 1))
    const screen = [...shown, prompt]
    const body = Array.from(
      { length: rows },
      (_, row) => `${render(screen[row] ?? [], cols)}\x1b[K`,
    )
    const width = prompt.reduce((sum, [text]) => sum + [...text].length, 0)
    return `${body.join("\r\n")}\x1b[0m\x1b[${shown.length + 1};${Math.min(cols, width + 1)}H\x1b[?25h`
  }
}

/** A line as ANSI text, cut to `cols` columns. */
function render(line: Line, cols: number): string {
  let out = ""
  let left = cols
  for (const [text, sgr] of line) {
    if (left <= 0) break
    const piece = [...text].slice(0, left).join("")
    left -= [...piece].length
    out += sgr ? `\x1b[${sgr}m${piece}\x1b[0m` : piece
  }
  return out
}

/** Splits what a terminal sent into keys: named ones for what the shell reacts to. */
export function keys(data: string): Array<string> {
  const out: Array<string> = []
  for (let index = 0; index < data.length;) {
    const char = data[index] ?? ""
    if (char === "\x1b") {
      // What follows the ESC.
      const rest = data.slice(index + 1)
      const arrow = /^[[O]([ABCD])/.exec(rest)
      if (arrow) {
        out.push({ A: "up", B: "down", C: "right", D: "left" }[arrow[1] as "A"])
        index += 1 + arrow[0].length
        continue
      }
      // Any other sequence is skipped; a lone ESC is the key.
      const sequence = /^\[[0-?]*[ -/]*[@-~]/.exec(rest)
      if (sequence) {
        index += 1 + sequence[0].length
        continue
      }
      out.push("esc")
      index++
      continue
    }
    index++
    if (char === "\r" || char === "\n") out.push("enter")
    else if (char === "\x7f" || char === "\b") out.push("backspace")
    else if (char === "\x03") out.push("ctrl-c")
    else out.push(char)
  }
  return out
}
