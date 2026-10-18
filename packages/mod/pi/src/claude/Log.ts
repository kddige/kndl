// The Claude bridge's logs: a debug log, written only when `KNDL_CLAUDE_DEBUG=1` asks for it, to
// `claude-bridge.log` in pi's agent directory, and what should never happen, always, to the
// extension's own log (kndl.log).

import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"

interface LogState {
  debug: boolean
  report: (text: string) => void
}

const state: LogState = { debug: false, report: () => {} }

/** Sets where the bridge's logs go: called at registration. */
export function configureLog(options: {
  readonly debug: boolean
  readonly report?: ((text: string) => void) | undefined
}): void {
  state.debug = options.debug
  state.report = options.report ?? (() => {})
}

export const debugEnabled = () => state.debug

/** The debug log's path. */
export function debugLogPath(): string {
  try {
    return join(getAgentDir(), "claude-bridge.log")
  } catch {
    return "claude-bridge.log"
  }
}

const format = (value: unknown): string => {
  if (typeof value === "string") return value
  if (value instanceof Error)
    return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ""}`
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function debug(...args: ReadonlyArray<unknown>): void {
  if (!state.debug) return
  const path = debugLogPath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `[${new Date().toISOString()}] ${args.map(format).join(" ")}\n`)
  } catch {
    // Nowhere to say it.
  }
}

/** Something that should never happen: said in the extension's log, and the debug log. */
export function diag(label: string, data: Readonly<Record<string, unknown>>): void {
  const line = `kndl: claude bridge: ${label} ${format(data)}`
  state.report(line)
  debug(line)
}
