// The spike's bug, at the unit level (docs/research/claude-bridge-spike.md): a real pi session
// runs Claude's turns through the bridge, with only Claude Code's query replaced. Claude calls a
// tool, the person aborts while it runs, and a new Claude turn follows. The message pi holds for
// the tool call must be just as it was: pi-ai drops an `aborted` assistant message when it replays
// history to another Provider, which would orphan the tool's result (OpenAI then refuses it).

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Type } from "@earendil-works/pi-ai"
import type { AssistantMessage, Model } from "@earendil-works/pi-ai"
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"
import type { AgentSession, AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { callTool, FakeClaudeCode, init, result, text, toolUse } from "../../test/FakeClaudeCode.ts"
import { resetBridge, setQuery } from "./Bridge.ts"
import { registerClaude } from "./Claude.ts"
import { ClaudeApi } from "./Names.ts"
import { clearSessionStates } from "./SessionMirror.ts"

let root: string
let fake: FakeClaudeCode

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "kndl-claude-abort-"))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))
afterEach(() => {
  setQuery(null)
  resetBridge()
  clearSessionStates()
})

const haiku = {
  provider: "anthropic" as const,
  id: "claude-haiku-5-5",
  label: "Claude Haiku 5.5",
  thinkingLevels: [],
}

const model: Model<string> = {
  id: "claude-haiku-5-5",
  name: "Claude Haiku 5.5",
  api: ClaudeApi,
  provider: "anthropic",
  baseUrl: "claude-code",
  reasoning: false,
  input: ["text"],
  contextWindow: 200_000,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

/** A real pi session on the bridge, with one tool, `wait`, that runs until it's aborted. */
async function startSession(): Promise<{
  session: AgentSession
  toolStarted: Promise<void>
}> {
  let started: (() => void) | undefined
  const toolStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  const extension = (pi: ExtensionAPI) => {
    registerClaude(pi, [haiku], {
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test",
        KNDL_CLAUDE_CODE: "/opt/kndl/claude-code/test/claude",
        CLAUDE_CONFIG_DIR: join(root, "claude"),
      },
    })
    pi.registerTool({
      name: "wait",
      label: "Wait",
      description: "Waits.",
      parameters: Type.Object({}),
      execute: (_id, _params, signal) =>
        new Promise<AgentToolResult<undefined>>((resolve) => {
          started?.()
          signal?.addEventListener("abort", () =>
            resolve({ content: [{ type: "text", text: "stopped" }], details: undefined }),
          )
        }),
    })
  }
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  })
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [extension],
  })
  await loader.reload()
  expect(loader.getExtensions().errors).toEqual([])
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: join(root, "agent"),
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(root),
    settingsManager: settings,
    noTools: "builtin",
    model,
  })
  return { session, toolStarted }
}

const assistants = (session: AgentSession) =>
  session.messages.filter((message): message is AssistantMessage => message.role === "assistant")

describe("an abort while Claude's tool call runs", () => {
  test("leaves the tool call's message pi holds as it was, through the next Claude turn", async () => {
    fake = new FakeClaudeCode()
    setQuery(fake.query)
    fake.scripts.push(
      {
        label: "calls wait",
        steps: [init("cc-1"), ...toolUse("toolu_wait", "wait"), callTool("wait", "toolu_wait")],
      },
      {
        label: "after the abort",
        steps: [init("cc-2"), ...text("Hello again."), result("Hello again.")],
      },
    )
    const { session, toolStarted } = await startSession()
    try {
      const run = session.prompt("wait, please")
      await toolStarted
      const held = assistants(session).find((message) => message.stopReason === "toolUse")
      if (held === undefined) throw new Error("pi holds no tool call")
      const before = structuredClone(held)

      await session.abort()
      await run
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(fake.calls[0]?.closed).toBe(true)

      await session.prompt("hello?")
      expect(fake.calls[1]?.prompt).toBe("hello?")
      expect(assistants(session).at(-1)?.content).toEqual([{ type: "text", text: "Hello again." }])

      // The same object, unchanged: still a tool call pi-ai replays to any Provider.
      const after = assistants(session).find((message) => message === held)
      expect(after).toBe(held)
      expect(held).toEqual(before)
      expect(held.stopReason).toBe("toolUse")
      expect(held.errorMessage).toBeUndefined()
    } finally {
      session.dispose()
    }
  }, 15_000)
})
