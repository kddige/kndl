// What every Claude Code the bridge runs is told, and kept from: it leaves pi's state alone
// (compaction, claude.ai MCP servers), and gets none of what would sign it in another way, send it
// elsewhere, or link it to the Hub, whatever pi's own environment holds.
//
// Ported in part from pi-claude-bridge 0.9.3's unit-child-env tests (MIT, Copyright (c) 2026 Eli
// Dickinson): see THIRD_PARTY_NOTICES.md.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import type { Api, AssistantMessageEventStream, Context, Model } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent"
import { resetBridge, setQuery } from "./Bridge.ts"
import type { ClaudeQuery } from "./Bridge.ts"
import { registerClaude } from "./Claude.ts"
import { clearSessionStates, setClaudeDir } from "./SessionMirror.ts"
import {
  ClaudeChildEnv,
  claudeCodeEnvironment,
  claudeSettings,
  KeptOutOfClaudeCode,
} from "./Settings.ts"

afterEach(() => {
  setQuery(null)
  resetBridge()
  clearSessionStates()
  setClaudeDir(undefined)
})

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

  test("is pi's, less what would sign Claude Code in otherwise, send it elsewhere, or reach the Hub", () => {
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

describe("the bridge's settings", () => {
  test("need the Creator's setup token and the pinned Claude Code", () => {
    expect(claudeSettings({})).toBeUndefined()
    expect(claudeSettings({ CLAUDE_CODE_OAUTH_TOKEN: "t" })).toBeUndefined()
    expect(claudeSettings({ KNDL_CLAUDE_CODE: "/opt/claude" })).toBeUndefined()
    expect(claudeSettings({ CLAUDE_CODE_OAUTH_TOKEN: "", KNDL_CLAUDE_CODE: "/opt/claude" })).toBe(
      undefined,
    )
    expect(
      claudeSettings({
        CLAUDE_CODE_OAUTH_TOKEN: "t",
        KNDL_CLAUDE_CODE: "/opt/claude",
        CLAUDE_CONFIG_DIR: "/var/lib/kndl/claude",
      }),
    ).toEqual({ executable: "/opt/claude", configDir: "/var/lib/kndl/claude", debug: false })
  })
})

/** Registers the bridge on a stub pi, and returns its provider's stream function. */
function register(env: NodeJS.ProcessEnv) {
  let config: ProviderConfig | undefined
  const pi = {
    on: () => {},
    registerProvider: (_name: string, provider: ProviderConfig) => {
      config = provider
    },
    registerTool: () => {},
  } as unknown as ExtensionAPI
  registerClaude(
    pi,
    [
      {
        provider: "anthropic",
        id: "claude-haiku-5-5",
        label: "Claude Haiku 5.5",
        thinkingLevels: [],
      },
    ],
    { env },
  )
  const model = config?.models?.[0]
  if (config?.streamSimple === undefined || model === undefined) throw new Error("not registered")
  const stream = config.streamSimple as unknown as (
    model: Model<Api>,
    context: Context,
    options?: Record<string, unknown>,
  ) => AssistantMessageEventStream
  return {
    model: { ...model, provider: "anthropic", baseUrl: "claude-code" } as unknown as Model<Api>,
    stream,
  }
}

/** A query that answers at once, recording the options it was made with. */
const capturing = (captured: Array<Options>) => (params: { readonly options: Options }) => {
  captured.push(params.options)
  const generator = (async function* () {
    yield { type: "system", subtype: "init", session_id: "cc-env" }
    yield { type: "result", subtype: "success", is_error: false, result: "ok" }
  })()
  return Object.assign(generator, { interrupt: async () => {}, close: () => {} }) as ClaudeQuery
}

describe("the Claude Code the bridge runs", () => {
  test("runs the pinned Claude Code, without its own tools, bypassing permissions, and with none of pi's forbidden variables", async () => {
    const claudeDir = mkdtempSync(join(tmpdir(), "kndl-claude-env-"))
    try {
      const { model, stream } = register({
        PATH: "/bin",
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-creator",
        KNDL_CLAUDE_CODE: "/opt/kndl/claude-code/test/claude",
        CLAUDE_CONFIG_DIR: claudeDir,
        IS_SANDBOX: "1",
        ...forbidden,
      })
      const captured: Array<Options> = []
      setQuery(capturing(captured))
      const user = { role: "user" as const, content: "hi", timestamp: 0 }

      await stream(model, { messages: [user] }, { sessionId: "s-env" }).result()
      // A summary's Claude Code, too.
      await stream(model, { messages: [user] }, { cacheRetention: "none" }).result()

      expect(captured.length).toBe(2)
      for (const options of captured) {
        expect(options.pathToClaudeCodeExecutable).toBe("/opt/kndl/claude-code/test/claude")
        expect(options.tools).toEqual([])
        const env = options.env ?? {}
        for (const name of Object.keys(forbidden)) expect(env[name]).toBeUndefined()
        expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat-creator")
        expect(env.CLAUDE_CONFIG_DIR).toBe(claudeDir)
        expect(env.IS_SANDBOX).toBe("1")
        expect(env.DISABLE_AUTO_COMPACT).toBe("1")
      }
      const [turn] = captured
      expect(turn?.permissionMode).toBe("bypassPermissions")
      expect(turn?.strictMcpConfig).toBe(true)
      expect(turn?.settingSources).toEqual([])
    } finally {
      rmSync(claudeDir, { recursive: true, force: true })
    }
  })
})
