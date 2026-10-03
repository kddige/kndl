// The fake Hub's terminals: a believable Claude Code screen per Session, for the terminal mirror
// to show. It answers keystrokes the way Claude Code does, roughly: a permission dialog picked
// with the arrows and Enter or dismissed with Esc, a prompt box to type into, a spinner that Esc
// interrupts, and Ctrl-C clearing what's typed. All made up.
//
// It keeps the screen as lines and redraws all of it on every change, the way Claude Code's own
// renderer rewrites its region: a Snapshot clears the screen first, Output only overwrites.

export interface TerminalSizeWire {
  readonly cols: number
  readonly rows: number
}

/** A run of text in one style; `sgr` is the SGR parameters, such as "1;32". */
type Span = readonly [text: string, sgr?: string]
type Line = ReadonlyArray<Span>

interface Dialog {
  readonly title: string
  readonly command: string
  readonly description: string
  readonly options: ReadonlyArray<string>
  selected: number
  /** Called with the picked option's index, or -1 when dismissed with Esc. */
  readonly pick: (index: number) => void
}

export interface FakeTerminalHooks {
  /** Runs `fn` after `steps` of the fake Hub's script. */
  readonly after: (steps: number, fn: () => void) => void
  /** The screen changed: send Output to everyone watching. */
  readonly changed: () => void
}

const claude = "38;5;173"
const muted = "90"
const green = "32"
const red = "31"
const spinnerFrames = ["·", "✢", "✳", "✶", "✻", "✽"]
const thinkingWords = ["Thinking", "Pondering", "Noodling", "Percolating"]

export class FakeTerminal {
  size: TerminalSizeWire = { cols: 120, rows: 40 }
  readonly #hooks: FakeTerminalHooks
  readonly #history: Array<Line> = []
  #input = ""
  #hint: Line | null = null
  #dialog: Dialog | null = null
  /** The running reply's spinner, with how many steps it has run; null when idle. */
  #busy: { word: string; steps: number; cancel: () => void } | null = null
  readonly #sent: Array<string> = []
  #recall = -1

  constructor(hooks: FakeTerminalHooks, options: { cwd: string; demo?: boolean }) {
    this.#hooks = hooks
    this.#history.push(...banner(options.cwd), [])
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
    const dialog = this.#dialog
    if (dialog) {
      if (key === "up") dialog.selected = Math.max(0, dialog.selected - 1)
      else if (key === "down")
        dialog.selected = Math.min(dialog.options.length - 1, dialog.selected + 1)
      else if (key === "enter") this.#pick(dialog, dialog.selected)
      else if (key === "esc") this.#pick(dialog, -1)
      else if (/^[1-9]$/.test(key) && Number(key) <= dialog.options.length) {
        this.#pick(dialog, Number(key) - 1)
      }
      return
    }
    this.#hint = null
    switch (key) {
      case "enter":
        if (this.#input.trim() !== "" && !this.#busy) this.#submit(this.#input.trim())
        return
      case "esc":
        if (this.#busy) this.#interrupt()
        return
      case "ctrl-c":
        if (this.#input !== "") this.#input = ""
        else this.#hint = [["Press Ctrl-C again to exit", muted]]
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

  #pick(dialog: Dialog, index: number): void {
    this.#dialog = null
    dialog.pick(index)
  }

  #submit(text: string): void {
    this.#sent.push(text)
    this.#recall = -1
    this.#input = ""
    this.#history.push(
      [
        ["> ", muted],
        [text, muted],
      ],
      [],
    )
    this.#work(4, () => {
      this.#say(`Fake Claude here: this terminal is the fake Hub's, so "${text}" goes nowhere.`)
      this.#say("Use the chat for prompts; the terminal is for what the chat can't do.", true)
    })
  }

  /** Shows a spinner for `steps`, then runs `done`, unless Esc interrupts first. */
  #work(steps: number, done: () => void): void {
    let cancelled = false
    const word = thinkingWords[this.#sent.length % thinkingWords.length] ?? "Thinking"
    this.#busy = { word, steps: 0, cancel: () => (cancelled = true) }
    for (let step = 1; step <= steps; step++) {
      this.#hooks.after(step, () => {
        if (cancelled || !this.#busy) return
        this.#busy.steps = step
        if (step === steps) {
          this.#busy = null
          done()
        }
        this.#hooks.changed()
      })
    }
  }

  #interrupt(): void {
    this.#busy?.cancel()
    this.#busy = null
    this.#history.push(
      [
        ["  ⎿  ", muted],
        ["Interrupted by user", red],
      ],
      [],
    )
  }

  #say(text: string, last = false): void {
    const width = Math.max(20, this.size.cols - 4)
    wrap(text, width).forEach((line, index) => {
      this.#history.push([[index === 0 ? "⏺ " : "  "], [line]])
    })
    if (last) this.#history.push([])
  }

  /** The demo Session's terminal starts at a permission dialog: the escape hatch's case. */
  #demo(): void {
    this.#history.push(
      [
        ["> ", muted],
        ["[Bob Lee] Run the web tests before we push", muted],
      ],
      [],
      [["⏺ "], ["I'll run the web package's tests."]],
      [],
    )
    this.#dialog = {
      title: "Bash command",
      command: "bun test packages/web",
      description: "Run the web package's tests",
      options: [
        "Yes",
        "Yes, and don't ask again for bun test commands in this project",
        "No, and tell Claude what to do differently (esc)",
      ],
      selected: 0,
      pick: (index) => {
        if (index === 0 || index === 1) {
          this.#history.push([["⏺ ", green], ["Bash", "1"], ["(bun test packages/web)"]])
          this.#work(6, () => {
            this.#history.push(
              [["  ⎿  ", muted], ["bun test v1.4.0"]],
              [["     "], ["168 pass", green]],
              [["     "], ["0 fail"]],
              [["     "], ["Ran 168 tests across 11 files. [1.92s]", muted]],
              [],
            )
            this.#say("All 168 web tests pass. Ready to push when you are.", true)
          })
        } else {
          this.#history.push(
            [
              ["  ⎿  ", muted],
              ["User rejected the command", red],
            ],
            [],
          )
        }
      },
    }
  }

  // ── Drawing ──────────────────────────────────────────────────────────────

  #draw(): string {
    const { cols, rows } = this.size
    const footer = this.#footer()
    const room = Math.max(0, rows - footer.lines.length)
    const shown = this.#history.slice(-room)
    const screen = [...shown, ...footer.lines]
    const body = Array.from(
      { length: rows },
      (_, row) => `${render(screen[row] ?? [], cols)}\x1b[K`,
    )
    const cursor = footer.cursor
      ? `\x1b[${shown.length + footer.cursor.row + 1};${footer.cursor.col + 1}H\x1b[?25h`
      : "\x1b[?25l"
    return `${body.join("\r\n")}\x1b[0m${cursor}`
  }

  #footer(): { lines: Array<Line>; cursor: { row: number; col: number } | null } {
    const width = Math.max(10, this.size.cols - 1)
    const dialog = this.#dialog
    if (dialog) {
      const inner = width - 4
      const boxed = (line: Line): Line => {
        const text = line.map(([t]) => t).join("")
        return [
          ["│ ", claude],
          ...line,
          [" ".repeat(Math.max(0, inner - text.length))],
          [" │", claude],
        ]
      }
      return {
        lines: [
          [["╭" + "─".repeat(width - 2) + "╮", claude]],
          boxed([[dialog.title, "1"]]),
          boxed([]),
          boxed([["  " + dialog.command]]),
          boxed([["  " + dialog.description, muted]]),
          boxed([]),
          boxed([["Do you want to proceed?"]]),
          ...dialog.options.map((option, index) =>
            boxed(
              index === dialog.selected
                ? [[`❯ ${index + 1}. ${option}`, claude]]
                : [[`  ${index + 1}. ${option}`]],
            ),
          ),
          [["╰" + "─".repeat(width - 2) + "╯", claude]],
        ],
        cursor: null,
      }
    }
    const lines: Array<Line> = []
    if (this.#busy) {
      const frame = spinnerFrames[this.#busy.steps % spinnerFrames.length] ?? "·"
      lines.push(
        [
          [`${frame} `, claude],
          [`${this.#busy.word}… `, claude],
          [`(${this.#busy.steps}s · `, muted],
          ["esc", "1;90"],
          [" to interrupt)", muted],
        ],
        [],
      )
    }
    const prompt = `> ${this.#input}`
    const inner = width - 4
    lines.push(
      [["╭" + "─".repeat(width - 2) + "╮", muted]],
      [
        ["│ ", muted],
        [prompt.slice(-inner)],
        [" ".repeat(Math.max(0, inner - prompt.length))],
        [" │", muted],
      ],
      [["╰" + "─".repeat(width - 2) + "╯", muted]],
      this.#hint ?? [["  ? for shortcuts", muted]],
    )
    const row = lines.length - 3
    return { lines, cursor: { row, col: 2 + Math.min(prompt.length, inner) } }
  }
}

function banner(cwd: string): Array<Line> {
  const width = 50
  const row = (line: Line): Line => {
    const text = line.map(([t]) => t).join("")
    return [
      ["│ ", claude],
      ...line,
      [" ".repeat(Math.max(0, width - 4 - text.length))],
      [" │", claude],
    ]
  }
  return [
    [["╭" + "─".repeat(width - 2) + "╮", claude]],
    row([["✻ ", claude], ["Welcome to "], ["Claude Code", "1"], ["!"]]),
    row([]),
    row([["  /help for help, /status for your current setup", muted]]),
    row([]),
    row([[`  cwd: ${cwd}`, muted]]),
    [["╰" + "─".repeat(width - 2) + "╯", claude]],
  ]
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

function wrap(text: string, width: number): Array<string> {
  const lines: Array<string> = []
  let line = ""
  for (const word of text.split(" ")) {
    if (line !== "" && line.length + 1 + word.length > width) {
      lines.push(line)
      line = word
    } else line = line === "" ? word : `${line} ${word}`
  }
  if (line !== "") lines.push(line)
  return lines
}

/** Splits what a terminal sent into keys: named ones for what Claude Code reacts to. */
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
