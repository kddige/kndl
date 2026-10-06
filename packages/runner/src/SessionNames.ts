import { join } from "node:path"
import type { SessionId } from "@claude-hub/protocol"

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

/** Where a Session's files live under the sessions root. */
export interface SessionDirectories {
  /** `<root>/<session id>`, which holds the others. */
  readonly session: string
  /**
   * The empty directory Claude Code ran in on the host, before it moved into the Sandbox (ADR
   * 0013). Never made now: its name finds the transcripts a Session has from then, to copy in
   * when it wakes, and purging a Session forgets them.
   */
  readonly claude: string
  /** The Workspace: the Repo's checkout on the Work branch, mounted into the Sandbox. */
  readonly workspace: string
  /**
   * The Runner's own git directory for the Workspace, never mounted into the Sandbox. Host git
   * runs with it as `GIT_DIR`, so it reads the Runner's config and hooks, not the Workspace's
   * `.git/config` and `.git/hooks`, which the Sandbox can write (HostGit.ts).
   */
  readonly hostGit: string
}

export function sessionDirectories(sessionsRoot: string, id: SessionId): SessionDirectories {
  const session = join(sessionsRoot, id)
  return {
    session,
    claude: join(session, "claude"),
    workspace: join(session, "workspace"),
    hostGit: join(session, "host-git"),
  }
}
