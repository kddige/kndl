// Each pi session's working directory, which its Claude Code runs in: the Workspace, in a Session.
//
// Ported from pi-claude-bridge 0.9.3's unit-session-cwd tests (MIT, Copyright (c) 2026 Eli
// Dickinson): see THIRD_PARTY_NOTICES.md.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import type { Api, AssistantMessageEventStream, Context, Model } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent"
import { resetBridge, setQuery } from "../../test/BridgeTesting.ts"
import type { ClaudeQuery } from "./Bridge.ts"
import { registerClaude } from "./Claude.ts"
import { forgetSessionCwd, rememberSessionCwd, sessionCwdFor } from "./SessionCwd.ts"
import { clearSessionStates, setClaudeDir } from "./SessionMirror.ts"

describe("a session's working directory", () => {
  test("is the one remembered for it, and only it", () => {
    rememberSessionCwd("s1", "/agents/Martin")
    expect(sessionCwdFor("s1")).toBe("/agents/Martin")
    expect(sessionCwdFor("other")).toBe(process.cwd())
    forgetSessionCwd("s1")
  })

  test("is the process's for no session", () => {
    expect(sessionCwdFor(null)).toBe(process.cwd())
    expect(sessionCwdFor(undefined)).toBe(process.cwd())
  })

  test("is forgotten", () => {
    rememberSessionCwd("s2", "/x")
    forgetSessionCwd("s2")
    expect(sessionCwdFor("s2")).toBe(process.cwd())
  })
})

describe("the provider", () => {
  const cleanup: Array<() => void> = []
  afterEach(() => {
    for (const step of cleanup.splice(0)) step()
    setQuery(null)
    resetBridge()
    clearSessionStates()
    setClaudeDir(undefined)
  })

  test("runs Claude Code in the directory pi's session started in", async () => {
    const sessionCwd = mkdtempSync(join(tmpdir(), "kndl-claude-session-cwd-"))
    const claudeDir = mkdtempSync(join(tmpdir(), "kndl-claude-session-cwd-cfg-"))
    cleanup.push(() => {
      rmSync(sessionCwd, { recursive: true, force: true })
      rmSync(claudeDir, { recursive: true, force: true })
      forgetSessionCwd("s-web")
    })
    const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>()
    let config: ProviderConfig | undefined
    const pi = {
      on: (name: string, handler: (event: unknown, ctx: unknown) => void) => {
        handlers.set(name, [...(handlers.get(name) ?? []), handler])
      },
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
      {
        env: {
          CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test",
          KNDL_CLAUDE_CODE: "/opt/kndl/claude-code/test/claude",
          CLAUDE_CONFIG_DIR: claudeDir,
        },
      },
    )
    for (const handler of handlers.get("session_start") ?? [])
      handler(
        { reason: "startup" },
        { cwd: sessionCwd, ui: undefined, sessionManager: { getSessionId: () => "s-web" } },
      )

    let queryCwd: string | undefined
    setQuery(({ options }: { options: Options }) => {
      queryCwd = options.cwd
      const generator = (async function* () {
        yield { type: "system", subtype: "init", session_id: "cc-web" }
        yield { type: "result", subtype: "success", is_error: false, result: "ok" }
      })()
      return Object.assign(generator, { interrupt: async () => {}, close: () => {} }) as ClaudeQuery
    })

    const stream = config?.streamSimple as unknown as (
      model: Model<Api>,
      context: Context,
      options?: Record<string, unknown>,
    ) => AssistantMessageEventStream
    const model = {
      ...config?.models?.[0],
      provider: "anthropic",
      baseUrl: "claude-code",
    } as unknown as Model<Api>
    await stream(
      model,
      { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
      { sessionId: "s-web" },
    ).result()
    expect(queryCwd).toBe(sessionCwd)
  })
})
