// What the Claude bridge runs Claude Code with. The durable agent reads it from the environment the
// Runner gives it (docs/design/durable-harness.md, "The process"): the Creator's setup token, the
// pinned Claude Code's path, and its state directory on the Session's volume. The reference's
// config file has no place in a Session: these are all there is.

/** The variable the Runner puts the pinned Claude Code's path in. */
export const ClaudeCodeVariable = "KNDL_CLAUDE_CODE"

/** The Creator's setup token, as Claude Code reads it. */
export const ClaudeTokenVariable = "CLAUDE_CODE_OAUTH_TOKEN"

/** Claude Code's state directory, where its sessions live. */
export const ClaudeConfigVariable = "CLAUDE_CONFIG_DIR"

/** Writes the bridge's debug log when `1`. */
export const ClaudeDebugVariable = "KNDL_CLAUDE_DEBUG"

/**
 * Set on every Claude Code the bridge runs.
 *
 * - `ENABLE_CLAUDEAI_MCP_SERVERS=0`: none of the account's claude.ai MCP servers, which
 *   `--strict-mcp-config` doesn't reach; the durable agent serves the tools.
 * - `DISABLE_AUTO_COMPACT=1`: the durable agent owns compaction. Claude Code compacting its copy
 *   would diverge from the conversation, which every rebuild comes from.
 * - `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`: no update checks or telemetry, as the Runner
 *   runs Claude Code itself.
 */
export const ClaudeChildEnv = {
  ENABLE_CLAUDEAI_MCP_SERVERS: "0",
  DISABLE_AUTO_COMPACT: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
} as const

/**
 * Kept out of Claude Code's environment, whatever the agent's holds: what would sign it in some
 * other way than the setup token or send its requests elsewhere (the reference's issue #107: an
 * exported `ANTHROPIC_BASE_URL` fails every turn), as the Runner keeps them out of Claude Code's
 * own; and kndl's link to the Hub, which is the agent's and none of Claude Code's.
 */
export const KeptOutOfClaudeCode: ReadonlyArray<string> = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "KNDL_URL",
  "KNDL_MOD_TOKEN",
  "KNDL_SESSION_ID",
  "KNDL_CONVERSATION_ID",
]

/** The environment the bridge runs Claude Code with: `env`, less {@link KeptOutOfClaudeCode}. */
export function claudeCodeEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const child: Record<string, string> = {}
  for (const [name, value] of Object.entries(env))
    if (value !== undefined && !KeptOutOfClaudeCode.includes(name)) child[name] = value
  return { ...child, ...ClaudeChildEnv }
}
