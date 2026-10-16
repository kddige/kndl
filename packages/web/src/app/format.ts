// Small formatters for times, durations and counts.

import type { SessionState, SessionSummary } from "@kndl/protocol"
import type { SessionState as StatusState } from "../ui/index.ts"

/** "just now", "5m ago", "3h ago", "2d ago", then the date. */
export function timeAgo(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 45) return "just now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

/** The time of day, for a message: "14:05". */
export function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
}

/** "0.8s", "42s", "3m 05s". */
export function duration(ms: number): string {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
}

/** "950", "12.4k", "1.2M". */
export function count(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** A size in binary units, with a decimal under ten: "512 B", "9.5 GiB", "186 GiB". */
export function bytes(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"]
  let value = n
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${unit > 0 && value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/** How long a host has been up: "under a minute", "5m", "3h 20m", "3d 4h". */
export function uptime(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  if (minutes < 1) return "under a minute"
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return `${minutes}m`
}

/** "A", "A and B", "A, B and C". */
export function andList(items: ReadonlyArray<string>): string {
  if (items.length <= 1) return items[0] ?? ""
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`
}

/** The protocol's Session state as the kit's SessionStatus takes it. */
export function statusOf(state: SessionState): StatusState {
  switch (state) {
    case "Active":
      return "active"
    case "Asleep":
      return "asleep"
    case "Frozen":
      return "frozen"
    case "Archived":
      return "archived"
  }
}

/** A day, for when something happens: "Nov 2". */
export function day(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

/** How long until an Archived Session is purged: "in 27 days", "in 1 day", "today". */
export function purgedIn(purgeAt: number, now = Date.now()): string {
  const days = Math.ceil((purgeAt - now) / 86_400_000)
  if (days <= 0) return "today"
  return days === 1 ? "in 1 day" : `in ${days} days`
}

/** A Repo's route params, from its `owner/name`. */
export function repoParams(repo: string): { owner: string; repo: string } {
  const slash = repo.indexOf("/")
  return { owner: repo.slice(0, slash), repo: repo.slice(slash + 1) }
}

/**
 * Whether an Active Session runs on an older version of its Repo's Environment than the latest
 * (ADR 0009): it picks the latest up on a restart. Other states pick it up as they next wake.
 * A Session being started counts the version it is being started on, not the one it ran before
 * (#70); one being restarted is getting the latest already.
 */
export function environmentChanged(session: SessionSummary): boolean {
  const { environment, starting } = session
  if (session.state !== "Active" || environment === undefined) return false
  if (session.restarting !== undefined) return false
  const version = starting ? (starting.environmentVersion ?? null) : environment.version
  return version !== environment.latestVersion
}

/**
 * Whether an Active Session runs with other Installations than its Repo's (ADR 0020): one was
 * created, changed or deleted since it started, and a restart applies the change. Other states
 * pick it up as they next wake; one being started or restarted is getting it already.
 */
export function mcpServersChanged(session: SessionSummary): boolean {
  if (session.state !== "Active" || session.mcpServersChanged !== true) return false
  return session.starting === undefined && session.restarting === undefined
}

/**
 * Terminal output as plain text, for a log view: colours and cursor moves dropped, and a line a
 * progress bar redrew (with a carriage return) shown as it was last drawn.
 */
export function terminalText(output: string): string {
  return (
    output
      .replace(terminalEscapes, "")
      .replace(/\r\n/g, "\n")
      .split("\n")
      // A carriage return that ends the output so far is a redraw still to come.
      .map((line) => line.split("\r").findLast((drawn) => drawn !== "") ?? "")
      .join("\n")
      .replace(controlCharacters, "")
  )
}

/**
 * ESC and what follows it: OSC sequences (window titles, links) up to BEL or ST, CSI sequences
 * (colours, cursor moves, erasing), and other two-character escapes.
 */
const terminalEscapes =
  // oxlint-disable-next-line eslint/no-control-regex -- matching terminal escapes is the point
  /\u001b(?:\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\[[0-?]*[ -/]*[@-~]?|[@-Z\\-_]?)/g

/** Control characters other than tab and newline, which a log view can't show. */
// oxlint-disable-next-line eslint/no-control-regex -- removing them is the point
const controlCharacters = /[\u0000-\u0008\u000b-\u001f\u007f]/g
