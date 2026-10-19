// The names the Claude bridge goes by, to pi-ai and to Claude Code.
//
// Ported from pi-claude-bridge 0.9.3 (MIT, Copyright (c) 2026 Eli Dickinson): see
// THIRD_PARTY_NOTICES.md.

/** pi-ai's provider for Claude's Models: the Hub names them `anthropic/<id>`. */
export const ClaudeProvider = "anthropic"

/**
 * The api the bridge's Models go by: not pi-ai's `anthropic-messages`, so nothing mistakes them for
 * Models pi-ai's own Anthropic API code can call, and a message written by them is known for one
 * Claude Code wrote (its thinking signatures are Claude Code's to hand back).
 */
export const ClaudeApi = "kndl-claude-code"

/** A Model's address, which pi-ai wants; never used, Claude Code being the transport. */
export const ClaudeBaseUrl = "claude-code"

/** The in-process MCP server the agent's tools are served to Claude Code from. */
export const McpServerName = "custom-tools"

/** How Claude Code names a tool of {@link McpServerName}: `mcp__custom-tools__read`. */
export const McpToolPrefix = `mcp__${McpServerName}__`
