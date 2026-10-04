// Whether the installed Runner is connected to its Hub, read from the last thing its log says
// about the connection. The Hub has no unauthenticated way to ask, and the log is the Runner's own
// account of it.

export type RunnerConnection =
  | { readonly _tag: "Connected"; readonly runnerId: string }
  | { readonly _tag: "Disconnected"; readonly detail: string }
  | { readonly _tag: "Unknown" }

/** The connection, from the Runner's log (HubConnection.ts writes these lines). */
export function runnerConnection(log: string): RunnerConnection {
  const lines = log.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ""
    const connected = /Connected to the Hub as Runner ([^\s"]+)/.exec(line)
    if (connected?.[1]) return { _tag: "Connected", runnerId: connected[1] }
    const lost = /Hub connection: (.+?)"?(?:\s+fiber=.*)?$/.exec(line)
    if (lost?.[1]) return { _tag: "Disconnected", detail: lost[1] }
  }
  return { _tag: "Unknown" }
}

export function describeConnection(connection: RunnerConnection): string {
  switch (connection._tag) {
    case "Connected":
      return `connected, as Runner ${connection.runnerId}`
    case "Disconnected":
      return `not connected: ${connection.detail}`
    case "Unknown":
      return "unknown: its log doesn't say yet"
  }
}
