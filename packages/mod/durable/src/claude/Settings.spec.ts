// What every Claude Code the bridge runs is told, and kept from: it leaves the agent's state alone
// (compaction, claude.ai MCP servers), and gets none of what would sign it in another way, send it
// elsewhere, or link it to the Hub, whatever the agent's own environment holds; and the bridge's
// options, from the environment the Runner gives the durable agent.
//
// Ported in part from pi-claude-bridge 0.9.3's unit-child-env tests (MIT, Copyright (c) 2026 Eli
// Dickinson): see THIRD_PARTY_NOTICES.md.

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import { createModels } from "@earendil-works/pi-ai/models"
import type { ClaudeQuery } from "./Bridge.ts"
import { claudeBridgeOptionsFromEnv, createClaudeBridgeProvider } from "./index.ts"
import { ClaudeApi } from "./Names.ts"
import { ClaudeChildEnv, claudeCodeEnvironment, KeptOutOfClaudeCode } from "./Settings.ts"

/** What would sign Claude Code in another way, send it elsewhere, or link it to the Hub. */
const forbidden = {
  ANTHROPIC_BASE_URL: "https://elsewhere.example",
  ANTHROPIC_API_KEY: "sk-ant-api-not-the-creators",
  ANTHROPIC_AUTH_TOKEN: "not-the-creators",
  KNDL_MOD_TOKEN: "the-session-token",
  KNDL_URL: "http://hub.example",
}

describe("Claude Code's environment", () => {
  test("turns off auto-compaction, claude.ai MCP servers and non-essential traffic", () => {
    expect(ClaudeChildEnv).toEqual({
      ENABLE_CLAUDEAI_MCP_SERVERS: "0",
      DISABLE_AUTO_COMPACT: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    })
    expect(claudeCodeEnvironment({ PATH: "/bin" })).toEqual({ PATH: "/bin", ...ClaudeChildEnv })
  })

  test("is the agent's, less what would sign Claude Code in otherwise, send it elsewhere, or reach the Hub", () => {
    const env = claudeCodeEnvironment({
      PATH: "/bin",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-creator",
      CLAUDE_CONFIG_DIR: "/var/lib/kndl/claude",
      IS_SANDBOX: "1",
      ...forbidden,
    })
    for (const name of Object.keys(forbidden)) expect(env[name]).toBeUndefined()
    for (const name of KeptOutOfClaudeCode) expect(env[name]).toBeUndefined()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-creator")
    expect(env.CLAUDE_CONFIG_DIR).toBe("/var/lib/kndl/claude")
    expect(env.IS_SANDBOX).toBe("1")
  })
})

describe("the bridge's options from the environment", () => {
  const rest = { cwd: "/workspace", models: [{ id: "claude-haiku-5-5" }] }
  const complete = {
    CLAUDE_CODE_OAUTH_TOKEN: "t",
    KNDL_CLAUDE_CODE: "/opt/claude",
    CLAUDE_CONFIG_DIR: "/var/lib/kndl/claude",
  }

  test("need the Creator's setup token, the pinned Claude Code, and its state directory", () => {
    expect(claudeBridgeOptionsFromEnv({}, rest)).toBeUndefined()
    expect(claudeBridgeOptionsFromEnv({ ...complete, CLAUDE_CODE_OAUTH_TOKEN: "" }, rest)).toBe(
      undefined,
    )
    expect(claudeBridgeOptionsFromEnv({ ...complete, KNDL_CLAUDE_CODE: undefined }, rest)).toBe(
      undefined,
    )
    expect(claudeBridgeOptionsFromEnv({ ...complete, CLAUDE_CONFIG_DIR: undefined }, rest)).toBe(
      undefined,
    )
    expect(claudeBridgeOptionsFromEnv(complete, rest)).toMatchObject({
      claudeCodePath: "/opt/claude",
      configDir: "/var/lib/kndl/claude",
      oauthToken: "t",
      debug: false,
      cwd: "/workspace",
      env: complete,
    })
  })

  test("write the debug log when KNDL_CLAUDE_DEBUG=1", () => {
    expect(claudeBridgeOptionsFromEnv({ ...complete, KNDL_CLAUDE_DEBUG: "1" }, rest)?.debug).toBe(
      true,
    )
  })
})

/** A query that answers at once, recording the options it was made with. */
const capturing = (captured: Array<Options>) => (params: { readonly options: Options }) => {
  captured.push(params.options)
  const generator = (async function* () {
    yield { type: "system", subtype: "init", session_id: "cc-env" }
    yield { type: "result", subtype: "success", is_error: false, result: "ok" }
  })()
  return Object.assign(generator, { interrupt: async () => {}, close: () => {} }) as ClaudeQuery
}

describe("the bridge's provider", () => {
  test("lists the Hub's Claude Models on its own api, configured by the setup token", async () => {
    const provider = createClaudeBridgeProvider({
      claudeCodePath: "/opt/claude",
      configDir: "/nonexistent",
      oauthToken: "t",
      cwd: "/workspace",
      models: [
        { id: "claude-haiku-5-5" },
        { id: "claude-future-9" },
        { id: "gpt-5", provider: "openai" },
      ],
      report: () => {},
    })
    const models = createModels()
    models.setProvider(provider)

    expect(models.getModels("anthropic").map((model) => [model.id, model.api])).toEqual([
      ["claude-haiku-5-5", ClaudeApi],
    ])
    expect(provider.missing).toEqual(["claude-future-9"])
    expect((await models.getAuth("anthropic"))?.source).toBe("CLAUDE_CODE_OAUTH_TOKEN")
    await provider.close()
  })

  test("runs the pinned Claude Code, without its own tools, bypassing permissions, and with none of the forbidden variables", async () => {
    const claudeDir = mkdtempSync(join(tmpdir(), "kndl-claude-env-"))
    const captured: Array<Options> = []
    const provider = createClaudeBridgeProvider({
      claudeCodePath: "/opt/kndl/claude-code/test/claude",
      configDir: claudeDir,
      oauthToken: "sk-ant-oat-creator",
      cwd: "/workspace",
      models: [{ id: "claude-haiku-5-5" }],
      env: { PATH: "/bin", IS_SANDBOX: "1", ...forbidden },
      query: capturing(captured),
    })
    try {
      const models = createModels()
      models.setProvider(provider)
      const model = models.getModel("anthropic", "claude-haiku-5-5")
      if (model === undefined) throw new Error("not listed")
      const user = { role: "user" as const, content: "hi", timestamp: 0 }

      await models.completeSimple(model, { messages: [user] }, { sessionId: "s-env" })
      // A summary's Claude Code, too.
      await models.completeSimple(
        model,
        { messages: [user] },
        { sessionId: "s-env", cacheRetention: "none" },
      )

      expect(captured.length).toBe(2)
      for (const options of captured) {
        expect(options.pathToClaudeCodeExecutable).toBe("/opt/kndl/claude-code/test/claude")
        expect(options.tools).toEqual([])
        expect(options.cwd).toBe("/workspace")
        const env = options.env ?? {}
        for (const name of Object.keys(forbidden)) expect(env[name]).toBeUndefined()
        expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-creator")
        expect(env.CLAUDE_CONFIG_DIR).toBe(claudeDir)
        expect(env.IS_SANDBOX).toBe("1")
        expect(env.DISABLE_AUTO_COMPACT).toBe("1")
      }
      const [turn, summary] = captured
      expect(turn?.permissionMode).toBe("bypassPermissions")
      expect(turn?.strictMcpConfig).toBe(true)
      expect(turn?.settingSources).toEqual([])
      expect(summary?.persistSession).toBe(false)
    } finally {
      await provider.close()
      rmSync(claudeDir, { recursive: true, force: true })
    }
  })
})
