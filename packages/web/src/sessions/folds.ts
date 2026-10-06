// Which Sessions' rows in the sidebar are folded, hiding their subagents (ADR 0014). Per viewer,
// in localStorage, so a reload keeps them; every sidebar on the page shares them, and
// another tab's change shows here too. A row is open unless folded.

import { useSyncExternalStore } from "react"

const storageKey = "claude-hub:sidebar-folded"

/** What couldn't be stored, as when storage is full or off: it lasts until the page closes. */
let unstored: string | undefined
let cached: { readonly raw: string; readonly ids: ReadonlySet<string> } | undefined
const listeners = new Set<() => void>()

function stored(): string {
  if (unstored !== undefined) return unstored
  try {
    return localStorage.getItem(storageKey) ?? "[]"
  } catch {
    return "[]"
  }
}

/** The folded ids as stored; none when storage holds anything but a list of them. */
function parse(raw: string): ReadonlySet<string> {
  try {
    const value: unknown = JSON.parse(raw)
    return new Set(Array.isArray(value) ? value.filter((id) => typeof id === "string") : [])
  } catch {
    return new Set()
  }
}

function snapshot(): ReadonlySet<string> {
  const raw = stored()
  if (cached?.raw !== raw) cached = { raw, ids: parse(raw) }
  return cached.ids
}

function subscribe(listener: () => void): () => void {
  const fromOtherTab = (event: StorageEvent) => {
    if (event.key === storageKey || event.key === null) listener()
  }
  listeners.add(listener)
  window.addEventListener("storage", fromOtherTab)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", fromOtherTab)
  }
}

/**
 * Folds or opens a Session's row. `known` is every Session the web knows of: ids no longer among
 * them are dropped as it's stored, so the list doesn't grow with purged Sessions.
 */
export function setFolded(sessionId: string, fold: boolean, known?: ReadonlySet<string>): void {
  if (known === undefined && snapshot().has(sessionId) === fold) return
  const ids = new Set(snapshot())
  if (fold) ids.add(sessionId)
  else ids.delete(sessionId)
  if (known) for (const id of ids) if (!known.has(id)) ids.delete(id)
  const raw = JSON.stringify([...ids])
  try {
    localStorage.setItem(storageKey, raw)
    unstored = undefined
  } catch {
    unstored = raw
  }
  for (const listener of listeners) listener()
}

/** The Sessions whose rows are folded, by id. */
export function useFolded(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
