import { describe, expect, test } from "bun:test"
import type { GatewayServer, SessionId } from "@kndl/protocol"
import { AgentVariables, durableLaunch } from "./DurableLaunch.ts"
import { ModEnvironment } from "./HarnessEnvironment.ts"

const options = {
  nodePath: "/opt/kndl/pi/node-v24.22.0-musl/bin/node",
  sessionId: "s-1" as SessionId,
  mod: "/opt/kndl/mod/m1",
  conversationId: "3c1f6f0e-8a2b-4c7d-9e1f-2a3b4c5d6e7f",
} as const

describe("durableLaunch", () => {
  test("runs the Session's copy of the durable agent on the bundle's Node.js, as pi to the Hub", () => {
    const { argv, env } = durableLaunch(options)
    expect(argv).toEqual([options.nodePath, "/opt/kndl/mod/m1/durable/agent.js"])
    expect(env).toEqual({
      // On the Session's claude volume, so its storage survives sleep.
      KNDL_STATE_DIR: "/var/lib/kndl/claude",
      KNDL_SESSION_ID: "s-1",
      KNDL_CONVERSATION_ID: "3c1f6f0e-8a2b-4c7d-9e1f-2a3b4c5d6e7f",
      KNDL_HARNESS: "Pi",
    })
    // The Hub's URL and the mod token are the mod relay's to give.
    expect(env).not.toHaveProperty(ModEnvironment.hubUrl)
    expect(env).not.toHaveProperty(ModEnvironment.modToken)
  })

  test("starts on the Session's model and thinking level, which the agent reads as it starts", () => {
    const { argv, env } = durableLaunch({
      ...options,
      model: "openai/gpt-6-sol",
      thinkingLevel: "xhigh",
    } as never)
    expect(env).toMatchObject({ KNDL_MODEL: "openai/gpt-6-sol", KNDL_THINKING: "xhigh" })
    // The command line is the same whatever the setting.
    expect(argv).toEqual(durableLaunch(options).argv)
    expect(durableLaunch({ ...options, thinkingLevel: "off" }).env).toMatchObject({
      KNDL_THINKING: "off",
    })
    expect(durableLaunch(options).env).not.toHaveProperty(AgentVariables.model)
    expect(durableLaunch(options).env).not.toHaveProperty(AgentVariables.thinkingLevel)
  })

  test("with a Claude credential, gives the Claude bridge the pinned Claude Code and its state", () => {
    const { env } = durableLaunch({
      ...options,
      claudePath: "/opt/kndl/claude-code/2.1.296/claude",
    })
    expect(env).toMatchObject({
      KNDL_CLAUDE_CODE: "/opt/kndl/claude-code/2.1.296/claude",
      CLAUDE_CONFIG_DIR: "/var/lib/kndl/claude",
      IS_SANDBOX: "1",
    })
    expect(durableLaunch(options).env).not.toHaveProperty("KNDL_CLAUDE_CODE")
    expect(durableLaunch(options).env).not.toHaveProperty("CLAUDE_CONFIG_DIR")
  })

  test("gives the agent the MCP servers of the Session's Installations, with no secret in them (ADR 0020)", () => {
    const mcpServers = [
      { installationId: "inst-1", server: "linear" },
      { installationId: "inst-2", server: "linear-2" },
    ] as unknown as ReadonlyArray<GatewayServer>
    const { env } = durableLaunch({ ...options, mcpServers })
    expect(JSON.parse(env[AgentVariables.mcpServers] ?? "")).toEqual(mcpServers)
    // None, no variable.
    expect(durableLaunch(options).env).not.toHaveProperty(AgentVariables.mcpServers)
    expect(durableLaunch({ ...options, mcpServers: [] }).env).not.toHaveProperty(
      AgentVariables.mcpServers,
    )
  })
})
