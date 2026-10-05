import type { BranchName, ClaudeSessionId, RepoName, SessionId } from "@claude-hub/protocol"
import { ToolsSocketVariable } from "@claude-hub/protocol"
import { workspaceGuestPath } from "./sandbox/SessionLayout.ts"

/**
 * The tools Claude Code keeps (ADR 0001): the file and command tools, which the mod answers from
 * the Sandbox through the tool bridge (#11). Claude Code 2.1.287 has no Glob or Grep tool (its
 * search runs through Bash), so those two only matter to builds that still have them. Leaving
 * ToolSearch out also turns tool search off, so the mod's own tools are listed directly
 * (spike #4). Never pass an empty list: that breaks `$.tool.register`.
 */
export const ClaudeTools = ["Bash", "Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep"]

/**
 * Settings passed with `--settings`, which `--setting-sources ""` still honours (spike #4).
 *
 * Auto memory is off (#111): Claude Code would save its notes with Write, which runs in the
 * Sandbox, so they would be lost with it, and each Session has its own memory directory anyway.
 */
export const ClaudeFlagSettings = { disableSkillShellExecution: true, autoMemoryEnabled: false }

/** The environment variables the mod reads to reach the Hub, and to tell the model about the Sandbox. */
export const ModEnvironment = {
  hubUrl: "CLAUDE_HUB_URL",
  sessionId: "CLAUDE_HUB_SESSION_ID",
  modToken: "CLAUDE_HUB_MOD_TOKEN",
  /** The Unix socket of the Session's tool bridge, which answers the routed tools. */
  toolsSocket: ToolsSocketVariable,
  /**
   * Where the Workspace is in the Sandbox, the Repo and the Work branch: the model is told these,
   * not the host's directory and platform, which Claude Code would tell it (#127).
   */
  workspace: "CLAUDE_HUB_WORKSPACE",
  repo: "CLAUDE_HUB_REPO",
  workBranch: "CLAUDE_HUB_WORK_BRANCH",
} as const

export interface ClaudeLaunchOptions {
  readonly claudeBin: string
  readonly modDir: string
  readonly hubUrl: URL
  readonly sessionId: SessionId
  readonly modToken: string
  /** The Session's tool bridge socket. */
  readonly toolsSocket: string
  readonly repo: RepoName
  readonly workBranch: BranchName
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
      // Background Bash would leave its output in the Sandbox, where Claude Code can't read it
      // back (spike #2). This drops `run_in_background` and Ctrl+B; the mod refuses it as well.
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      // Also turns auto memory off, ahead of any setting, a managed one included (#111).
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      [ModEnvironment.hubUrl]: options.hubUrl.href,
      [ModEnvironment.sessionId]: options.sessionId,
      [ModEnvironment.modToken]: options.modToken,
      [ModEnvironment.toolsSocket]: options.toolsSocket,
      [ModEnvironment.workspace]: workspaceGuestPath,
      [ModEnvironment.repo]: options.repo,
      [ModEnvironment.workBranch]: options.workBranch,
    },
  }
}
