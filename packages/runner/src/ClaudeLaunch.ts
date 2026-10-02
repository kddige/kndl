import type { ClaudeSessionId, SessionId } from "@claude-hub/protocol"

/**
 * The tools Claude Code keeps (ADR 0001): the file and command tools, which the mod will answer
 * from the Sandbox (#11). Leaving ToolSearch out also turns tool search off, so the mod's own
 * tools are listed directly (spike #4). Never pass an empty list: that breaks `$.tool.register`.
 */
export const ClaudeTools = ["Bash", "Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep"]

/** Settings passed with `--settings`, which `--setting-sources ""` still honours (spike #4). */
export const ClaudeFlagSettings = { disableSkillShellExecution: true }

/** The environment variables the mod reads to reach the Hub. */
export const ModEnvironment = {
  hubUrl: "CLAUDE_HUB_URL",
  sessionId: "CLAUDE_HUB_SESSION_ID",
  modToken: "CLAUDE_HUB_MOD_TOKEN",
} as const

export interface ClaudeLaunchOptions {
  readonly claudeBin: string
  readonly modDir: string
  readonly hubUrl: URL
  readonly sessionId: SessionId
  readonly modToken: string
  /** Start a new conversation with this id, or resume an existing one (waking an Asleep Session). */
  readonly conversation:
    | { readonly _tag: "New"; readonly id: string }
    | { readonly _tag: "Resume"; readonly id: ClaudeSessionId }
}

export interface ClaudeLaunch {
  readonly argv: ReadonlyArray<string>
  /** Added to the environment Claude Code inherits from the Runner's tmux server. */
  readonly env: Readonly<Record<string, string>>
}

/**
 * The command line that runs a Session's Claude Code on the host, with the hardened flags of
 * ADR 0001 and the mod loaded. It is started from an empty per-Session directory.
 *
 * A new conversation gets `--session-id`, chosen by the Runner, so its id is known up front; waking
 * uses `--resume`, which restores the conversation and keeps the id (spike #4).
 */
export function claudeLaunch(options: ClaudeLaunchOptions): ClaudeLaunch {
  const conversation =
    options.conversation._tag === "New"
      ? ["--session-id", options.conversation.id]
      : ["--resume", options.conversation.id]
  return {
    argv: [
      options.claudeBin,
      ...conversation,
      "--plugin-dir",
      options.modDir,
      "--tools",
      ClaudeTools.join(","),
      "--strict-mcp-config",
      "--setting-sources",
      "",
      "--settings",
      JSON.stringify(ClaudeFlagSettings),
    ],
    env: {
      CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
      [ModEnvironment.hubUrl]: options.hubUrl.href,
      [ModEnvironment.sessionId]: options.sessionId,
      [ModEnvironment.modToken]: options.modToken,
    },
  }
}
