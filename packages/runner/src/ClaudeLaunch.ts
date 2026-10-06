import type {
  ClaudeSessionId,
  EffortLevel,
  ModelName,
  SessionId,
  SessionRef,
} from "@claude-hub/protocol"
import { modGuestPath } from "./sandbox/SessionLayout.ts"

/**
 * The environment variables the mod reads to reach the Hub. The Hub's URL and the mod token are
 * the credential proxy's (proxy/ClaudeEnvironment.ts); the launch sets the rest.
 */
export const ModEnvironment = {
  hubUrl: "CLAUDE_HUB_URL",
  sessionId: "CLAUDE_HUB_SESSION_ID",
  modToken: "CLAUDE_HUB_MOD_TOKEN",
  /**
   * A Child Session's Parent Session id (ADR 0012), set only for a child. The mod leaves out the
   * Child Session tools when it is set: Sessions nest one level deep.
   */
  parentSessionId: "CLAUDE_HUB_PARENT_SESSION_ID",
} as const

/**
 * What a Child Session's model is told of its place (ADR 0012), appended to Claude Code's system
 * prompt with `--append-system-prompt`, for children only.
 */
export const childSystemPrompt = (parent: SessionRef) =>
  `You are a Child Session in claude-hub: the Parent Session "${parent.title}" (${parent.id}) created you to do part of its work, and its messages reach you as prompts marked as from it. People may prompt you too. The final message of each of your Turns, whoever prompted it, goes to your Parent Session as a Report, so end every Turn with a message that stands on its own: what you did, what you found, and what you need from it, if anything. You can't create Child Sessions of your own.`

export interface ClaudeLaunchOptions {
  /** Claude Code's executable in the Sandbox. */
  readonly claudePath: string
  readonly sessionId: SessionId
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
  /** Added to Claude Code's environment in the Sandbox. */
  readonly env: Readonly<Record<string, string>>
}

/**
 * The command line that runs a Session's Claude Code in its Sandbox (ADR 0013), in the Workspace,
 * with the mod loaded from its read-only mount. Claude Code runs as it would on a developer's
 * machine, with its usual tools and the Repo's settings, but never asks for a permission
 * (ADR 0004), and loads no MCP server but those of `--mcp-config`, of which it gets none.
 *
 * A new conversation gets `--session-id`, chosen by the Runner, so its id is known up front; waking
 * uses `--resume`, which restores the conversation and keeps the id (spike #4). A Child Session
 * gets its paragraph on every launch, waking included, since the flag lasts only for the process.
 *
 * The Session's model and effort go as `--model` and `--effort` (#128), which, unlike `/model`
 * and `/effort`, last only for the process and are never written to its settings.json.
 */
export function claudeLaunch(options: ClaudeLaunchOptions): ClaudeLaunch {
  const conversation =
    options.conversation._tag === "New"
      ? ["--session-id", options.conversation.id]
      : ["--resume", options.conversation.id]
  return {
    argv: [
      options.claudePath,
      ...conversation,
      "--plugin-dir",
      modGuestPath,
      "--strict-mcp-config",
      "--dangerously-skip-permissions",
      ...(options.parent === undefined
        ? []
        : ["--append-system-prompt", childSystemPrompt(options.parent)]),
      ...(options.model === undefined ? [] : ["--model", options.model]),
      ...(options.effort === undefined ? [] : ["--effort", options.effort]),
    ],
    env: {
      // Auto memory stays off (#111): each Session would keep notes only for itself.
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      [ModEnvironment.sessionId]: options.sessionId,
      ...(options.parent === undefined
        ? {}
        : { [ModEnvironment.parentSessionId]: options.parent.id }),
    },
  }
}
