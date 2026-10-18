import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent"
import type { ProviderModel } from "@kndl/protocol"
import { resetBridge, setQuery } from "../../test/BridgeTesting.ts"
import { FakeClaudeCode, init, result, text } from "../../test/FakeClaudeCode.ts"
import { registerClaude } from "./Claude.ts"
import { ClaudeApi } from "./Names.ts"
import { clearSessionStates, sessionStateFor, setSessionStateFor } from "./SessionMirror.ts"

const root = mkdtempSync(join(tmpdir(), "kndl-claude-register-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))
afterEach(() => {
  setQuery(null)
  resetBridge()
  clearSessionStates()
})

const credentialed = {
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test",
  KNDL_CLAUDE_CODE: "/opt/kndl/claude-code/2.1.296-glibc/claude",
  CLAUDE_CONFIG_DIR: join(root, "claude"),
  IS_SANDBOX: "1",
}

const haiku: ProviderModel = {
  provider: "anthropic",
  id: "claude-haiku-5-5",
  label: "Claude Haiku 5.5",
  thinkingLevels: [],
}
const opus: ProviderModel = {
  provider: "anthropic",
  id: "claude-opus-4-6",
  label: "Claude Opus 4.6",
  thinkingLevels: [],
}
const gpt: ProviderModel = {
  provider: "openai",
  id: "gpt-5.6-luna",
  label: "GPT",
  thinkingLevels: [],
}

type Handler = (event: unknown, ctx: unknown) => unknown

/** A pi that records what the extension registers. */
const mockPi = () => {
  const providers: Array<{ name: string; config: ProviderConfig }> = []
  const handlers = new Map<string, Array<Handler>>()
  const pi = {
    on: (event: string, handler: Handler) =>
      handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerProvider: (name: string, config: ProviderConfig) => providers.push({ name, config }),
    registerTool: () => {},
  } as unknown as ExtensionAPI
  const emit = (event: string, payload: unknown, ctx: unknown) => {
    for (const handler of handlers.get(event) ?? []) handler(payload, ctx)
  }
  return { pi, providers, handlers, emit }
}

describe("registerClaude", () => {
  test("registers nothing for a Creator with no Claude credential", () => {
    const { pi, providers, handlers } = mockPi()
    const { CLAUDE_CODE_OAUTH_TOKEN: _token, ...env } = credentialed
    registerClaude(pi, [haiku], { env })
    expect(providers).toEqual([])
    expect(handlers.size).toBe(0)
  })

  test("registers nothing when the Runner gave pi no Claude Code", () => {
    const { pi, providers, handlers } = mockPi()
    const { KNDL_CLAUDE_CODE: _claude, ...env } = credentialed
    registerClaude(pi, [haiku], { env })
    expect(providers).toEqual([])
    expect(handlers.size).toBe(0)
  })

  test("registers nothing when the Hub lists no Claude Model pi knows", () => {
    const { pi, providers } = mockPi()
    const logged: Array<string> = []
    registerClaude(pi, [gpt], { env: credentialed })
    registerClaude(
      pi,
      [{ provider: "anthropic", id: "claude-nonesuch-9", label: "?", thinkingLevels: [] }],
      { env: credentialed, log: (line) => logged.push(line) },
    )
    expect(providers).toEqual([])
    expect(logged).toEqual(["kndl: pi doesn't know anthropic's claude-nonesuch-9"])
  })

  test("registers pi's `anthropic` provider for the Hub's Claude Models, in its order, at no price", () => {
    const { pi, providers } = mockPi()
    registerClaude(pi, [opus, gpt, haiku], { env: credentialed })
    expect(providers.map((provider) => provider.name)).toEqual(["anthropic"])
    const config = providers[0]?.config
    expect(config?.api).toBe(ClaudeApi)
    expect(typeof config?.streamSimple).toBe("function")
    expect(config?.models?.map((model) => model.id)).toEqual([
      "claude-opus-4-6",
      "claude-haiku-5-5",
    ])
    for (const model of config?.models ?? []) {
      expect(model.api).toBe(ClaudeApi)
      expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    }
    // Opus 4.6 serves 1M only on Max or with Extra Usage, which kndl can't tell: 200K.
    expect(
      config?.models?.map((model) => ("contextWindow" in model ? model.contextWindow : 0)),
    ).toEqual([200_000, 1_000_000])
  })
})

/** The context pi's events come with, for the session `sessionId`. */
const ctxOf = (sessionId: string) => ({
  ui: {},
  cwd: root,
  sessionManager: { getSessionId: () => sessionId },
})

describe("a pi session's end", () => {
  // A subagent's session is a pi session of its own in the same process: the Session's own
  // conversation ending, or another taking its place, leaves its mirror for its next turn.
  test("forgets its own mirror, not a subagent's", () => {
    const { pi, emit } = mockPi()
    registerClaude(pi, [haiku], { env: credentialed })
    const mirror = { sessionId: "cc", cursor: 2, cwd: root }
    setSessionStateFor("main", mirror)
    setSessionStateFor("subagent", mirror)
    emit("session_shutdown", { type: "session_shutdown", reason: "new" }, ctxOf("main"))
    emit("session_start", { type: "session_start", reason: "new" }, ctxOf("next"))
    expect(sessionStateFor("main")).toBeNull()
    expect(sessionStateFor("subagent")).toEqual(mirror)
  })
})

describe("a Claude turn", () => {
  test("runs the pinned Claude Code in the Workspace, as a model only, with none of the Anthropic variables or kndl's", async () => {
    const { pi, providers, emit } = mockPi()
    const workspace = mkdtempSync(join(root, "workspace-"))
    registerClaude(pi, [haiku], {
      env: {
        ...credentialed,
        ANTHROPIC_BASE_URL: "https://elsewhere.example",
        ANTHROPIC_API_KEY: "sk-ant-api-elsewhere",
        ANTHROPIC_AUTH_TOKEN: "elsewhere",
        KNDL_MOD_TOKEN: "mod-token",
        KNDL_URL: "http://hub",
        PATH: "/usr/bin",
      },
    })
    emit(
      "session_start",
      { type: "session_start", reason: "startup" },
      {
        ui: { notify: () => {} },
        cwd: workspace,
        sessionManager: { getSessionId: () => "pi-1" },
      },
    )
    const fake = new FakeClaudeCode()
    setQuery(fake.query)
    fake.scripts.push({ label: "hi", steps: [init("cc-1"), ...text("Hi."), result("Hi.")] })

    const config = providers[0]?.config
    const model = {
      ...config?.models?.[0],
      provider: "anthropic",
      baseUrl: "claude-code",
    } as Model<Api>
    const streamSimple = config?.streamSimple as unknown as
      | ((
          model: Model<Api>,
          context: Context,
          options?: SimpleStreamOptions,
        ) => { result: () => Promise<{ content: unknown; stopReason: string }> })
      | undefined
    if (streamSimple === undefined) throw new Error("no stream function registered")
    const stream = streamSimple(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
      { sessionId: "pi-1" },
    )
    const reply = await stream.result()
    expect(reply.stopReason).toBe("stop")
    expect(reply.content).toEqual([{ type: "text", text: "Hi." }])

    const options = fake.calls[0]?.options
    expect(fake.calls[0]?.prompt).toBe("hello")
    expect(options?.pathToClaudeCodeExecutable).toBe(credentialed.KNDL_CLAUDE_CODE)
    expect(options?.permissionMode).toBe("bypassPermissions")
    expect(options?.tools).toEqual([])
    expect(options?.cwd).toBe(workspace)
    expect(options?.strictMcpConfig).toBe(true)
    expect(options?.settingSources).toEqual([])
    expect(options?.extraArgs).toMatchObject({ model: "claude-haiku-5-5[1m]" })
    const env = options?.env ?? {}
    expect(env.CLAUDE_CONFIG_DIR).toBe(credentialed.CLAUDE_CONFIG_DIR)
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(credentialed.CLAUDE_CODE_OAUTH_TOKEN)
    expect(env.IS_SANDBOX).toBe("1")
    expect(env.PATH).toBe("/usr/bin")
    for (const name of [
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "KNDL_MOD_TOKEN",
      "KNDL_URL",
    ])
      expect(env[name]).toBeUndefined()
  })
})
