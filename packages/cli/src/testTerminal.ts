// A terminal for tests of `claude-hub forward` (#180): its stdout, played as a terminal plays it,
// and its stdin in raw mode, typed into. Not part of the CLI.

import { controlSequence, type KeyInput, plain, type ScreenOutput } from "./ForwardTui.ts"

/** A terminal's output: what was written, and the screen it makes. */
export interface Terminal {
  readonly output: ScreenOutput
  readonly writes: Array<string>
  /** The lines on the screen, from playing the writes: redraws and erases as a terminal does. */
  readonly screen: () => ReadonlyArray<string>
}

export function terminal(columns = 80, isTTY = true): Terminal {
  const writes: Array<string> = []
  return {
    output: { isTTY, columns, write: (text: string) => void writes.push(text) },
    writes,
    screen: () => {
      const lines: Array<string> = [""]
      let row = 0
      for (const text of writes) {
        for (const token of text.split(new RegExp(`(${controlSequence.source}|\n|\r)`))) {
          const control = controlSequence.test(token)
          if (control && token.endsWith("F")) {
            // Up that many lines.
            row = Math.max(0, row - Number(token.slice(2, -1)))
          } else if (token === "\x1b[J") {
            // Erases from the cursor down.
            lines.length = row + 1
            lines[row] = ""
          } else if (token === "\n") {
            row++
            lines[row] ??= ""
          } else if (token !== "" && token !== "\r" && !control) {
            lines[row] = (lines[row] ?? "") + token
          }
        }
      }
      return lines.slice(0, row).map(plain)
    },
  }
}

/** A terminal's input: the modes it was put in, and keys typed into it. */
export interface Keyboard extends KeyInput {
  readonly raw: Array<boolean>
  readonly type: (text: string) => void
}

export function keyboard(isTTY = true): Keyboard {
  const listeners = new Set<(chunk: Buffer | string) => void>()
  const raw: Array<boolean> = []
  return {
    isTTY,
    raw,
    setRawMode: (on) => void raw.push(on),
    on: (_, listener) => void listeners.add(listener),
    off: (_, listener) => void listeners.delete(listener),
    resume: () => undefined,
    pause: () => undefined,
    type: (text) => {
      for (const listener of listeners) listener(Buffer.from(text))
    },
  }
}
