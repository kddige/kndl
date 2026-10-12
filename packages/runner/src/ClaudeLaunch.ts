import { posix } from "node:path"
import {
  type ClaudeSessionId,
  type EffortLevel,
  type GatewayServer,
  gatewayPath,
  type ModelName,
  type SessionId,
} from "@kndl/protocol"
import { gatewayPlugin, modPlugins } from "./sandbox/SessionLayout.ts"

/**
 * The environment variables the mod reads to reach the Hub. The Hub's URL and the mod token are
 * the credential proxy's (proxy/ClaudeEnvironment.ts); the launch sets the rest.
 *
 * The conversation is the one Claude Code was launched as. A `claude` run inside the Session
 * inherits all of them, but is another conversation, which the mod doesn't link (#321).
 */
export const ModEnvironment = {
  hubUrl: "KNDL_URL",
  sessionId: "KNDL_SESSION_ID",
  modToken: "KNDL_MOD_TOKEN",
  conversationId: "KNDL_CONVERSATION_ID",
} as const

export interface ClaudeLaunchOptions {
  /** Claude Code's executable in the Sandbox. */
  readonly claudePath: string
  readonly sessionId: SessionId
  /** The Session's copy of the mod in the Sandbox, a directory per plugin (SessionMod.ts). */
  readonly mod: string
  /** Start a new conversation with this id, or resume an existing one (waking an Asleep Session). */
  readonly conversation:
    | { readonly _tag: "New"; readonly id: string }
    | { readonly _tag: "Resume"; readonly id: ClaudeSessionId }
  /** The model, its `--model` (#128); Claude Code's default when absent. */
  readonly model?: ModelName
  /** The effort level, its `--effort` (#128); Claude Code's default when absent. */
  readonly effort?: EffortLevel
  /**
   * The MCP servers of the Installations it runs with (ADR 0020), in the mod's copy as the
   * {@link gatewayPlugin} plugin (SessionMod.ts); none when absent.
   */
  readonly mcpServers?: ReadonlyArray<GatewayServer>
}

export interface ClaudeLaunch {
  readonly argv: ReadonlyArray<string>
  /** Added to Claude Code's environment in the Sandbox. */
  readonly env: Readonly<Record<string, string>>
}

/**
 * The command line that runs a Session's Claude Code in its Sandbox (ADR 0013), in the Workspace,
 * with the mod's plugins loaded from the Session's read-only copy (SessionMod.ts). Claude Code runs
 * as it would on a developer's machine, with its usual tools and the Repo's settings, hooks,
 * skills and MCP servers, all in the Sandbox, but never asks for a permission (ADR 0004).
 *
 * A new conversation gets `--session-id`, chosen by the Runner, so its id is known up front; waking
 * uses `--resume`, which restores the conversation and keeps the id (spike #4).
 *
 * The Session's model and effort go as `--model` and `--effort` (#128), which, unlike `/model`
 * and `/effort`, last only for the process and are never written to its settings.json.
 *
 * Its Installations' MCP servers come in a plugin of their own (ADR 0020), so Claude Code names
 * each `plugin:kndl:<server>`, never the name of one in the Repo's `.mcp.json`.
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
      ...[...modPlugins, ...(options.mcpServers?.length ? [gatewayPlugin] : [])].flatMap(
        (plugin) => ["--plugin-dir", posix.join(options.mod, plugin)],
      ),
      "--dangerously-skip-permissions",
      ...(options.model === undefined ? [] : ["--model", options.model]),
      ...(options.effort === undefined ? [] : ["--effort", options.effort]),
    ],
    env: {
      // Auto memory stays off (#111): each Session would keep notes only for itself.
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      // One Claude Code per Session (#191). Agent view (its left arrow, `/background`, `--bg`)
      // runs the conversation as a background job: a second Claude Code, which inherits the mod
      // token and plugins, links as the Session too, and runs each prompt again.
      CLAUDE_CODE_DISABLE_AGENT_VIEW: "1",
      // The Runner installs Claude Code, from its own cache: /status has no ~/.local/bin, PATH or
      // install method to warn about (#157).
      DISABLE_INSTALLATION_CHECKS: "1",
      [ModEnvironment.sessionId]: options.sessionId,
      [ModEnvironment.conversationId]: options.conversation.id,
    },
  }
}

/**
 * The `.mcp.json` of the {@link gatewayPlugin} plugin: an MCP server for each Installation the
 * Session runs with, at the Gateway (ADR 0020), through the credential proxy as the mod's calls
 * go. Claude Code fills in the variables from its environment: the proxy's URL, and the Session
 * token, which the proxy relays with the Session's mod token in its place. Nothing in it is secret.
 */
export function gatewayMcpServers(servers: ReadonlyArray<GatewayServer>) {
  return {
    mcpServers: Object.fromEntries(
      servers.map(({ installationId, server }) => [
        server,
        {
          type: "http",
          url: `\${${ModEnvironment.hubUrl}}${gatewayPath(installationId)}`,
          headers: { Authorization: `Bearer \${${ModEnvironment.modToken}}` },
        },
      ]),
    ),
  }
}
