// What `kndl forward [session] [ports...]` (#180) is given, read: which Session, which of its
// ports to which local ones, and where to listen. Pure, so it is tested on its own.
import { isIP } from "node:net"
import { type SessionSummary, sessionTitle } from "@kndl/protocol"

/** A Session's short id, as the web shows it in the forward command: its first 6 characters. */
export const shortId = (session: Pick<SessionSummary, "id">) => session.id.slice(0, 6)

/** A Session as a person knows it (the protocol's title: its name, or else its branch). */
export { sessionTitle }

/** One remote port, and the local one it is forwarded to. */
export interface PortMapping {
  readonly remote: number
  readonly local: number
}

const portOf = (text: string): number | undefined => {
  if (!/^\d{1,5}$/.test(text)) return undefined
  const port = Number(text)
  return port >= 1 && port <= 65535 ? port : undefined
}

/**
 * `3000`, or `3000:3100` for the Session's port 3000 on local port 3100. Fails with what's wrong.
 */
export function parsePort(text: string): PortMapping | string {
  const [remoteText = "", localText, extra] = text.split(":")
  const remote = portOf(remoteText)
  const local = localText === undefined ? remote : portOf(localText)
  if (extra !== undefined || remote === undefined || local === undefined) {
    return `${text} isn't a port: give one as 3000, or as 3000:3100 to forward the Session's port 3000 to port 3100 here.`
  }
  return { remote, local }
}

/** The ports given, read; or what's wrong with them. */
export function parsePorts(texts: ReadonlyArray<string>): ReadonlyArray<PortMapping> | string {
  const mappings: Array<PortMapping> = []
  for (const text of texts) {
    const mapping = parsePort(text)
    if (typeof mapping === "string") return mapping
    if (mappings.some((m) => m.remote === mapping.remote)) {
      return `Port ${mapping.remote} is named twice.`
    }
    if (mappings.some((m) => m.local === mapping.local)) {
      return `Two ports would be forwarded to port ${mapping.local} here.`
    }
    mappings.push(mapping)
  }
  return mappings
}

/** Where to listen: 127.0.0.1 and ::1 by default, so `localhost` reaches it either way. */
export function bindAddresses(bind: string | undefined): ReadonlyArray<string> | string {
  if (bind === undefined) return ["127.0.0.1", "::1"]
  const address = bind.replace(/^\[(.*)\]$/, "$1")
  if (address === "localhost") return ["127.0.0.1", "::1"]
  if (isIP(address) === 0)
    return `--bind takes an IP address, such as 127.0.0.1 or ::1; not ${bind}.`
  return [address]
}

/** The URL a forwarded port is at here. */
export function localUrl(addresses: ReadonlyArray<string>, port: number): string {
  const [first] = addresses
  if (addresses.length !== 1 || first === undefined) return `http://localhost:${port}`
  const host = first === "0.0.0.0" || first === "::" ? "localhost" : first
  return `http://${isIP(host) === 6 ? `[${host}]` : host}:${port}`
}

/** What a Session argument names: an id, or the start of one, or a Session's URL. */
export type SessionTarget =
  | { readonly _tag: "Id"; readonly id: string }
  /** A Session URL: its id, and the Hub it is on. */
  | { readonly _tag: "Url"; readonly id: string; readonly origin: string }

export function parseTarget(text: string): SessionTarget | string {
  const trimmed = text.trim()
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL
    try {
      url = new URL(trimmed)
    } catch {
      return `${text} isn't a Session's URL.`
    }
    const id = /\/sessions\/([^/?#]+)/.exec(url.pathname)?.[1]
    if (id === undefined) return `${text} isn't a Session's URL: one ends in /sessions/<id>.`
    return { _tag: "Url", id: decodeURIComponent(id), origin: url.origin }
  }
  if (trimmed === "" || /[\s/]/.test(trimmed)) {
    return `${text} isn't a Session: give its id, the start of it, or its URL.`
  }
  return { _tag: "Id", id: trimmed }
}

/** Which Session a target picks, of those the CLI can forward. */
export type Resolved =
  | { readonly _tag: "Found"; readonly session: SessionSummary }
  | { readonly _tag: "Ambiguous"; readonly matches: ReadonlyArray<SessionSummary> }
  | { readonly _tag: "None" }

/** A whole id, or the start of only one Session's. */
export function resolveTarget(id: string, sessions: ReadonlyArray<SessionSummary>): Resolved {
  const exact = sessions.find((session) => session.id === id)
  if (exact !== undefined) return { _tag: "Found", session: exact }
  const matches = sessions.filter((session) => session.id.startsWith(id))
  const [only] = matches
  if (matches.length === 1 && only !== undefined) return { _tag: "Found", session: only }
  return matches.length === 0 ? { _tag: "None" } : { _tag: "Ambiguous", matches }
}

/** One line for a Session in a list: short id, name, Repo, state unless Active, and ports. */
export function sessionLine(session: SessionSummary): string {
  const ports = (session.openPorts ?? []).map((port) => port.port)
  return [
    shortId(session),
    sessionTitle(session),
    session.repo,
    ...(session.state === "Active" ? [] : [session.state]),
    ports.length === 0 ? "no open ports" : ports.join(", "),
  ].join("  ")
}
