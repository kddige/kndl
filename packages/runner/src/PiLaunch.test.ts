import { describe, expect, test } from "bun:test"
import type { GatewayServer, SessionId } from "@kndl/protocol"
import { HarnessVariable, ModEnvironment } from "./HarnessEnvironment.ts"
import { McpServersVariable, piLaunch, PiSessionIdPattern } from "./PiLaunch.ts"

const options = {
  nodePath: "/opt/kndl/pi/node-v24.22.0-musl/bin/node",
  cliPath:
    "/opt/kndl/pi/pi-1.3.0-abc/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
  sessionId: "s-1" as SessionId,
  mod: "/opt/kndl/mod/m1",
  conversationId: "3c1f6f0e-8a2b-4c7d-9e1f-2a3b4c5d6e7f",
} as const

describe("piLaunch", () => {
  test("runs pi's TUI on the bundle's Node.js, with the mod's extension and the Repo's .pi/", () => {
    const { argv, env } = piLaunch(options)
    expect(argv).toEqual([
      options.nodePath,
      options.cliPath,
      "--approve",
      "-e",
      "/opt/kndl/mod/m1/pi/kndl.js",
      "--session-id",
      "3c1f6f0e-8a2b-4c7d-9e1f-2a3b4c5d6e7f",
    ])
    expect(env).toEqual({
      // On the Session's claude volume, so it survives sleep.
      PI_CODING_AGENT_DIR: "/var/lib/kndl/claude/pi",
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      KNDL_SESSION_ID: "s-1",
      KNDL_CONVERSATION_ID: "3c1f6f0e-8a2b-4c7d-9e1f-2a3b4c5d6e7f",
      KNDL_HARNESS: "Pi",
    })
    // The Hub's URL and the mod token are the mod relay's to give.
    expect(env).not.toHaveProperty(ModEnvironment.hubUrl)
    expect(env).not.toHaveProperty(ModEnvironment.modToken)
  })

  test("starts on the Session's model and thinking level", () => {
    const { argv } = piLaunch({
      ...options,
      model: "openai/gpt-6-sol",
      thinkingLevel: "xhigh",
    } as never)
    expect(argv.slice(-4)).toEqual(["--model", "openai/gpt-6-sol", "--thinking", "xhigh"])
    // Every thinking level is pi's own, `off` and `minimal` too.
    expect(piLaunch({ ...options, thinkingLevel: "off" }).argv.slice(-2)).toEqual([
      "--thinking",
      "off",
    ])
  })

  test("waking resumes with the same --session-id, which pi creates or resumes", () => {
    const resumed = { ...options, conversationId: "9c528fab-0d1e-4f2a-8b3c-4d5e6f7a8b9c" }
    const { argv, env } = piLaunch(resumed)
    expect(argv.slice(5, 7)).toEqual(["--session-id", "9c528fab-0d1e-4f2a-8b3c-4d5e6f7a8b9c"])
    expect(env[ModEnvironment.conversationId]).toBe("9c528fab-0d1e-4f2a-8b3c-4d5e6f7a8b9c")
  })

  test("with a Claude credential, gives the Claude bridge the pinned Claude Code and its state", () => {
    const { env } = piLaunch({ ...options, claudePath: "/opt/kndl/claude-code/2.1.296/claude" })
    expect(env).toMatchObject({
      KNDL_CLAUDE_CODE: "/opt/kndl/claude-code/2.1.296/claude",
      CLAUDE_CONFIG_DIR: "/var/lib/kndl/claude",
      IS_SANDBOX: "1",
    })
    expect(piLaunch(options).env).not.toHaveProperty("KNDL_CLAUDE_CODE")
    expect(piLaunch(options).env).not.toHaveProperty("CLAUDE_CONFIG_DIR")
  })

  test("gives the extension the MCP servers of the Session's Installations, with no secret in them (ADR 0020)", () => {
    const mcpServers = [
      { installationId: "inst-1", server: "linear" },
      { installationId: "inst-2", server: "linear-2" },
    ] as unknown as ReadonlyArray<GatewayServer>
    const { argv, env } = piLaunch({ ...options, mcpServers })
    expect(JSON.parse(env[McpServersVariable] ?? "")).toEqual(mcpServers)
    expect(argv).toEqual(piLaunch(options).argv)
    // None, no variable.
    expect(piLaunch(options).env).not.toHaveProperty(McpServersVariable)
    expect(piLaunch({ ...options, mcpServers: [] }).env).not.toHaveProperty(McpServersVariable)
  })

  test("a UUID is a session id pi takes, and an id it would refuse isn't", () => {
    expect(PiSessionIdPattern.test(options.conversationId)).toBe(true)
    expect(PiSessionIdPattern.test("-rm")).toBe(false)
    expect(PiSessionIdPattern.test("a b")).toBe(false)
    expect(HarnessVariable).toBe("KNDL_HARNESS")
  })
})
