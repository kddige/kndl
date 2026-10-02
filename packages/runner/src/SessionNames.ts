import { join } from "node:path"
import { SessionId } from "@claude-hub/protocol"
import { Schema } from "effect"

// A Session's id names its directory and its tmux session, so only ids that are safe in both are
// accepted. The Hub mints the ids; anything else is refused when the Session starts.

const SafeId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export function isSafeSessionId(id: string): boolean {
  return SafeId.test(id)
}

const TmuxPrefix = "hub-"

export function tmuxSessionName(id: SessionId): string {
  return `${TmuxPrefix}${id}`
}

/** The Session a tmux session belongs to, or `undefined` for a tmux session that isn't one. */
export function sessionIdOfTmuxName(name: string): SessionId | undefined {
  if (!name.startsWith(TmuxPrefix)) return undefined
  const id = name.slice(TmuxPrefix.length)
  return isSafeSessionId(id) ? Schema.decodeSync(SessionId)(id) : undefined
}

/** Where a Session's files live under the sessions root. */
export interface SessionDirectories {
  /** `<root>/<session id>`, which holds the other two. */
  readonly session: string
  /** The empty directory Claude Code runs in (ADR 0001). */
  readonly claude: string
  /** The Workspace: the Repo's checkout on the Work branch, mounted into the Sandbox. */
  readonly workspace: string
}

export function sessionDirectories(sessionsRoot: string, id: SessionId): SessionDirectories {
  const session = join(sessionsRoot, id)
  return { session, claude: join(session, "claude"), workspace: join(session, "workspace") }
}
