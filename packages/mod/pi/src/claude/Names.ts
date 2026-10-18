// The names the Claude bridge goes by, to pi and to Claude Code.
//
// Ported from pi-claude-bridge 0.9.3 (MIT, Copyright (c) 2026 Eli Dickinson): see
// THIRD_PARTY_NOTICES.md.

/** pi's provider for Claude's Models: the Hub names them `anthropic/<id>`. */
export const ClaudeProvider = "anthropic"

/**
 * The api the bridge's Models go by. pi routes a model of the provider registered with a
 * `streamSimple` to it only when the model's api is the registration's, so this is what sends
 * Claude's turns through Claude Code and not to pi-ai's own Anthropic API code.
 */
export const ClaudeApi = "kndl-claude-code"

/** The in-process MCP server pi's tools are served to Claude Code from. */
export const McpServerName = "custom-tools"

/** How Claude Code names a tool of {@link McpServerName}: `mcp__custom-tools__read`. */
export const McpToolPrefix = `mcp__${McpServerName}__`
