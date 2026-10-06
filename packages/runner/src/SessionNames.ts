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
  /** The empty directory Claude Code runs in (ADR 0001). */
  readonly claude: string
  /** The Workspace: the Repo's checkout on the Work branch, mounted into the Sandbox. */
  readonly workspace: string
  /**
   * The Unix socket the Session's tool bridge listens on, which the mod finds through
   * `CLAUDE_HUB_TOOLS_SOCKET`. A socket path must stay under 104 bytes on macOS.
   */
  readonly toolsSocket: string
  /**
   * The Runner's own git directory for the Workspace, never mounted into the Sandbox. Host git
   * runs with it as `GIT_DIR`, so it reads the Runner's config and hooks, not the Workspace's
   * `.git/config` and `.git/hooks`, which the Sandbox can write (HostGit.ts).
   */
  readonly hostGit: string
  /**
   * The Repo's skills and CLAUDE.md, as the Runner copied them out of the Sandbox when the Session
   * last started (RepoFiles.ts). Rewritten at each start; never the Workspace's own files.
   */
  readonly repoFiles: string
}

export function sessionDirectories(sessionsRoot: string, id: SessionId): SessionDirectories {
  const session = join(sessionsRoot, id)
  return {
    session,
    claude: join(session, "claude"),
    workspace: join(session, "workspace"),
    toolsSocket: join(session, "tools.sock"),
    hostGit: join(session, "host-git"),
    repoFiles: join(session, "repo"),
  }
}
