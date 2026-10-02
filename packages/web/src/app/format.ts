// Small formatters for times, durations and counts.

import type { SessionState } from "@claude-hub/protocol"
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
