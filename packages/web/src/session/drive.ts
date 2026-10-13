// Who drives a Session (ADR 0026): only its Creator, whose Claude credential it runs on. Everyone
// else watches: the web UI hides what would drive it from them, and the Hub refuses it anyway.

import { driveRefusal, type SessionSummary } from "@kndl/protocol"
import { useHubState } from "../app/hub.tsx"

/**
 * Why the signed-in person can't drive the Session, as the Hub words it, or undefined when they
 * are its Creator. Until the Hub says who they are, nobody drives.
 */
export function useDriveRefusal(summary: Pick<SessionSummary, "creator">): string | undefined {
  const you = useHubState((state) => state.you)
  return driveRefusal(you ?? { id: "" }, summary.creator)?.refusal
}

/** Whether the signed-in person drives the Session: they are its Creator. */
export const useDrives = (summary: Pick<SessionSummary, "creator">): boolean =>
  useDriveRefusal(summary) === undefined
