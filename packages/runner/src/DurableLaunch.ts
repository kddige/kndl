// How a Session's durable agent runs in its Sandbox (docs/design/durable-harness.md): one headless
// Node.js process, on the pinned Node.js of the pi bundle (sandbox/SandboxPi.ts), running the
// Session's copy of the mod's agent (SessionMod.ts), which links it to the Hub as the pi extension
// did. Every Session runs it, whatever Harness the Hub names: it is pi to the Hub.
//
// The agent reaches every Provider through the Hub's Gateway, on the Session token alone, so it
// runs without its Creator's Claude credential. When it has one, it gets it too, with the pinned
// Claude Code, which its Claude bridge runs for Claude's Models: on its own process alone
// (`tmux -e`). It passes its environment on to Claude Code, so what is kept out of Claude Code's is
// kept out of its own (HarnessEnvironment.ts).

import { posix } from "node:path"
import type { GatewayServer, ModelName, SessionId, ThinkingLevel } from "@kndl/protocol"
import { HarnessVariable, ModEnvironment } from "./HarnessEnvironment.ts"
import { claudeStateEnv } from "./sandbox/ClaudeState.ts"
import { agentStateGuestPath, durableAgent } from "./sandbox/SessionLayout.ts"

/** The variable the agent's Claude bridge finds the pinned Claude Code by. */
export const ClaudeCodeVariable = "KNDL_CLAUDE_CODE"

/** The variables the agent reads its setting from, as it starts. */
export const AgentVariables = {
  /** The Model, `<provider>/<id>`; the agent's default when absent. */
  model: "KNDL_MODEL",
  /** The thinking level; the agent's default when absent. */
  thinkingLevel: "KNDL_THINKING",
  /** The Session's MCP servers: the {@link GatewayServer}s, as JSON. */
  mcpServers: "KNDL_MCP_SERVERS",
  /** Its state directory, on the Session's volume: its storage and its log are under `durable/`. */
  stateDir: "KNDL_STATE_DIR",
} as const

export interface DurableLaunchOptions {
  /** Node.js's executable in the Sandbox. */
  readonly nodePath: string
  readonly sessionId: SessionId
  /** The Session's copy of the mod in the Sandbox (SessionMod.ts), holding the {@link durableAgent}. */
  readonly mod: string
  /**
   * The conversation the Hub knows the Session's by. The agent's state is its storage, so it
   * resumes without it; it says it in its hello.
   */
  readonly conversationId: string
  /** The Model, `<provider>/<id>`; the agent's default when absent. */
  readonly model?: ModelName
  /** The thinking level; the agent's default when absent. */
  readonly thinkingLevel?: ThinkingLevel
  /**
   * The pinned Claude Code's executable in the Sandbox, given when the Session's Creator has a
   * Claude credential, for the agent's Claude bridge; absent when they don't.
   */
  readonly claudePath?: string
  /** The MCP servers of the Installations it runs with (ADR 0020); none when absent. */
  readonly mcpServers?: ReadonlyArray<GatewayServer>
}

export interface DurableLaunch {
  readonly argv: ReadonlyArray<string>
  /** Added to the agent's environment in the Sandbox. */
  readonly env: Readonly<Record<string, string>>
}

/**
 * The command line that runs a Session's durable agent in its Sandbox, in the Workspace. Starting
 * and waking are the same command: the agent resumes from its storage, in its state directory on
 * the Session's `claude` volume, whatever it was doing.
 *
 * With a Claude credential, the Claude bridge gets what Claude Code itself runs with: its state
 * directory, `IS_SANDBOX`, as it runs as root, and the pinned Claude Code.
 *
 * The Session's MCP servers go to the agent, which adds them at the Gateway (ADR 0020): their
 * Installations and names only, as it reaches them with the Session token it already has.
 */
export function durableLaunch(options: DurableLaunchOptions): DurableLaunch {
  return {
    argv: [options.nodePath, posix.join(options.mod, durableAgent)],
    env: {
      [AgentVariables.stateDir]: agentStateGuestPath,
      [ModEnvironment.sessionId]: options.sessionId,
      [ModEnvironment.conversationId]: options.conversationId,
      [HarnessVariable]: "Pi",
      ...(options.model === undefined ? {} : { [AgentVariables.model]: options.model }),
      ...(options.thinkingLevel === undefined
        ? {}
        : { [AgentVariables.thinkingLevel]: options.thinkingLevel }),
      ...(options.mcpServers?.length
        ? { [AgentVariables.mcpServers]: JSON.stringify(options.mcpServers) }
        : {}),
      ...(options.claudePath === undefined
        ? {}
        : { ...claudeStateEnv, [ClaudeCodeVariable]: options.claudePath }),
    },
  }
}
