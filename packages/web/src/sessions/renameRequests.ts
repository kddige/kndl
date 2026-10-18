// Asking a Session's sidebar row to turn into its name field (#400): from F2, or a menu that isn't
// the row's own state.

import type { SessionId } from "@kndl/protocol"

const listeners = new Map<SessionId, Set<() => void>>()

/** Asks the row of `sessionId` to rename it in place. */
export function requestRename(sessionId: SessionId): void {
  for (const listener of listeners.get(sessionId) ?? []) listener()
}

/** Calls `rename` whenever the row of `sessionId` is asked to rename it; returns how to stop. */
export function onRenameRequest(sessionId: SessionId, rename: () => void): () => void {
  const set = listeners.get(sessionId) ?? new Set()
  set.add(rename)
  listeners.set(sessionId, set)
  return () => {
    set.delete(rename)
  }
}
