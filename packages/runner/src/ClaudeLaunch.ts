import type {
  BranchName,
  ClaudeSessionId,
  EffortLevel,
  ModelName,
  RepoName,
  SessionId,
  SessionRef,
} from "@claude-hub/protocol"
import { ToolsSocketVariable } from "@claude-hub/protocol"
import { repoPluginDirectory } from "./RepoFiles.ts"
import { workspaceGuestPath } from "./sandbox/SessionLayout.ts"

/**
 * The tools Claude Code keeps (ADR 0001): the file and command tools, which the mod answers from
 * the Sandbox through the tool bridge (#11), and WebSearch, which the mod leaves to Claude Code:
 * the search runs at Anthropic, not on the host (#126). Claude Code 2.1.287 has no Glob or Grep
 * tool (its search runs through Bash), so those two only matter to builds that still have them.
 * Leaving ToolSearch out also turns tool search off, so the mod's own tools are listed directly
 * (spike #4). Never pass an empty list: that breaks `$.tool.register`.
 */
export const ClaudeTools = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "WebSearch",
]

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
   * A Child Session's Parent Session id (ADR 0012), set only for a child. The mod leaves out the
   * Child Session tools when it is set: Sessions nest one level deep.
   */
  parentSessionId: "CLAUDE_HUB_PARENT_SESSION_ID",
  /**
   * Where the Workspace is in the Sandbox, the Repo and the Work branch: the model is told these,
   * not the host's directory and platform, which Claude Code would tell it (#127).
   */
  workspace: "CLAUDE_HUB_WORKSPACE",
  repo: "CLAUDE_HUB_REPO",
  workBranch: "CLAUDE_HUB_WORK_BRANCH",
  /**
   * The Session's Repo files directory, which the Runner fills from the Sandbox (#125): the mod
   * adds its CLAUDE.md files to the context, and shows its skills' directory as the Workspace's.
   */
  repoFiles: "CLAUDE_HUB_REPO_FILES",
} as const

/**
 * What a Child Session's model is told of its place (ADR 0012), appended to Claude Code's system
 * prompt with `--append-system-prompt`, for children only.
 */
export const childSystemPrompt = (parent: SessionRef) =>
  `You are a Child Session in claude-hub: the Parent Session "${parent.title}" (${parent.id}) created you to do part of its work, and its messages reach you as prompts marked as from it. People may prompt you too. The final message of each of your Turns, whoever prompted it, goes to your Parent Session as a Report, so end every Turn with a message that stands on its own: what you did, what you found, and what you need from it, if anything. You can't create Child Sessions of your own.`

export interface ClaudeLaunchOptions {
  readonly claudeBin: string
  readonly modDir: string
  readonly hubUrl: URL
  readonly sessionId: SessionId
  readonly modToken: string
  /** The Session's tool bridge socket. */
  readonly toolsSocket: string
  /** The Session's Repo files directory, with the Repo's skills and CLAUDE.md (RepoFiles.ts). */
  readonly repoFiles: string
  readonly repo: RepoName
  readonly workBranch: BranchName
  /** Start a new conversation with this id, or resume an existing one (waking an Asleep Session). */
  readonly conversation:
    | { readonly _tag: "New"; readonly id: string }
    | { readonly _tag: "Resume"; readonly id: ClaudeSessionId }
  /** The Parent Session, when this Session is a Child Session (ADR 0012). */
  readonly parent?: SessionRef
  /** The model, its `--model` (#128); Claude Code's default when absent. */
  readonly model?: ModelName
  /** The effort level, its `--effort` (#128); Claude Code's default when absent. */
  readonly effort?: EffortLevel
}

export interface ClaudeLaunch {
  readonly argv: ReadonlyArray<string>
  /** Added to the environment Claude Code inherits from the Runner's tmux server. */
  readonly env: Readonly<Record<string, string>>
}

/**
 * The command line that runs a Session's Claude Code on the host, with the hardened flags of
 * ADR 0001, the mod loaded, and the Repo's skills as a plugin. It is started from an empty
 * per-Session directory.
 *
 * A new conversation gets `--session-id`, chosen by the Runner, so its id is known up front; waking
 * uses `--resume`, which restores the conversation and keeps the id (spike #4). A Child Session
 * gets its paragraph on every launch, waking included, since the flag lasts only for the process.
 *
 * The Session's model and effort go as `--model` and `--effort` (#128), which, unlike `/model`
 * and `/effort`, last only for the process and are never written to the host's settings.json.
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
      // The Repo's skills, as the Runner copied them out of the Sandbox (#125). Project settings
      // stay off: the source that loads a project's skills loads its settings.json too.
      "--plugin-dir",
      repoPluginDirectory(options.repoFiles),
      "--tools",
      ClaudeTools.join(","),
      "--strict-mcp-config",
      "--setting-sources",
      "",
      "--settings",
      JSON.stringify(ClaudeFlagSettings),
      ...(options.parent === undefined
        ? []
        : ["--append-system-prompt", childSystemPrompt(options.parent)]),
      ...(options.model === undefined ? [] : ["--model", options.model]),
      ...(options.effort === undefined ? [] : ["--effort", options.effort]),
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
      ...(options.parent === undefined
        ? {}
        : { [ModEnvironment.parentSessionId]: options.parent.id }),
      [ModEnvironment.workspace]: workspaceGuestPath,
      [ModEnvironment.repo]: options.repo,
      [ModEnvironment.workBranch]: options.workBranch,
      [ModEnvironment.repoFiles]: options.repoFiles,
    },
  }
}
