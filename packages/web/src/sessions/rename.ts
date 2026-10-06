// Renaming a Session in place, from its header or its sidebar row.

import { type SessionSummary, sessionTitle } from "@kndl/protocol"
import type { HubClient } from "../hub/client.ts"
import { toast } from "../ui/index.ts"

/**
 * What the Hub is asked to store for what was typed in place of a Session's name: the name, ""
 * to clear it, or null when nothing would change. The Hub trims it too, and has the last word.
 */
export function renameTo(session: SessionSummary, typed: string): string | null {
  const name = typed.trim()
  if (name === sessionTitle(session)) return null
  if (name === "" && session.name === undefined) return null
  return name
}

/** Renames a Session from what was typed, if that changes it, or says the Hub isn't connected. */
export function renameSession(hub: HubClient, session: SessionSummary, typed: string): void {
  const name = renameTo(session, typed)
  if (name === null) return
  if (!hub.renameSession(session.id, name)) {
    toast.show({ title: "Not connected to the Hub", intent: "warning" })
  }
}
