// The Claude bridge's logs: a debug log, written only when the bridge is made with `debug` (as
// `KNDL_CLAUDE_DEBUG=1` asks), to its `logPath`, and what should never happen, always, to the
// bridge's `report` (the durable agent's own log). Each bridge has its own: nothing here is the
// process's.

import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

export interface BridgeLog {
  readonly debugEnabled: boolean
  /** Writes a line to the debug log, when there is one. */
  readonly debug: (...args: ReadonlyArray<unknown>) => void
  /** Something that should never happen: said in the bridge's report, and the debug log. */
  readonly diag: (label: string, data: Readonly<Record<string, unknown>>) => void
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

export function createLog(options: {
  readonly debug: boolean
  readonly path: string
  readonly report?: ((text: string) => void) | undefined
}): BridgeLog {
  const debug = (...args: ReadonlyArray<unknown>): void => {
    if (!options.debug) return
    try {
      mkdirSync(dirname(options.path), { recursive: true })
      appendFileSync(options.path, `[${new Date().toISOString()}] ${args.map(format).join(" ")}\n`)
    } catch {
      // Nowhere to say it.
    }
  }
  return {
    debugEnabled: options.debug,
    debug,
    diag: (label, data) => {
      const line = `kndl: claude bridge: ${label} ${format(data)}`
      options.report?.(line)
      debug(line)
    },
  }
}

/** A log that writes nothing: for a query context made outside a bridge, as tests make them. */
export const silentLog: BridgeLog = { debugEnabled: false, debug: () => {}, diag: () => {} }
