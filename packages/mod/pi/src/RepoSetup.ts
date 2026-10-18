// What a pi Session loads beside pi's own `.pi/`, as a Claude Code Session does (ADR 0029, "A
// Repo's setup still loads"): the MCP servers of the Session's Installations, at the Hub's Gateway
// (ADR 0020), and the Repo's Claude Code skills, in `.claude/skills`. pi finds AGENTS.md and
// CLAUDE.md itself.

import { existsSync } from "node:fs"
import { join } from "node:path"
import type { McpServerConfig } from "@earendil-works/pi-coding-agent"
import { GatewayServer, gatewayPath } from "@kndl/protocol"
import { Exit, Schema } from "effect"

/**
 * The variable the Runner gives pi the Session's MCP servers in (the Runner's PiLaunch.ts): a JSON
 * list of `GatewayServer`s, an Installation and its server's name each. Nothing in it is secret.
 */
export const McpServersVariable = "KNDL_MCP_SERVERS"

/** An MCP server for `pi.registerMcpServer`. */
export interface McpRegistration {
  readonly name: string
  readonly config: McpServerConfig
}

const decodeServers = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Array(GatewayServer)))

/**
 * The MCP servers of the Session's Installations, from {@link McpServersVariable}: each at the
 * Gateway through the Runner's relay at `hubUrl`, as the mod's own calls go, with the Session
 * token, which the relay swaps for the mod token.
 *
 * pi reads the token from its environment (`${KNDL_MOD_TOKEN}`) as it connects, so it isn't in the
 * server's configuration, which `/mcp` shows. Each is named `kndl-<server>`, so it can't take the
 * name of one in the Repo's `.pi/mcp.json`, which would win over it: its tools are
 * `mcp__kndl_<server>__<tool>`.
 */
export const installationServers = (
  value: string | undefined,
  hubUrl: string,
  log?: (text: string) => void,
): Array<McpRegistration> => {
  if (value === undefined || value === "") return []
  const servers = decodeServers(value)
  if (Exit.isFailure(servers)) {
    log?.(`kndl: ${McpServersVariable} isn't a list of MCP servers, so pi has none of them`)
    return []
  }
  const base = hubUrl.replace(/\/+$/, "")
  return servers.value.map(({ installationId, server }) => ({
    name: `kndl-${server}`,
    config: {
      url: `${base}${gatewayPath(installationId)}`,
      headers: { Authorization: "Bearer ${KNDL_MOD_TOKEN}" },
    },
  }))
}

/**
 * The Repo's Claude Code skills, `.claude/skills` in the Workspace (`cwd`), when it has them. pi
 * finds `.pi/skills` and `.agents/skills` itself.
 */
export const claudeSkills = (cwd: string): string | undefined => {
  const dir = join(cwd, ".claude", "skills")
  return existsSync(dir) ? dir : undefined
}
