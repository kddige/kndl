// A stopped turn and the prompt cache: a real pi session runs Claude's turns through the bridge,
// with Claude Code's query replaced by one that keeps a session file as Claude Code does, with
// the attachments Claude Code puts on each prompt (FakeTranscript). The turn after a stopped one
// must resume the same session, its request starting as the stopped turn's did: rebuilding the
// session from pi's history loses those attachments, and the prompt cache with them.

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
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
import { getProjectDir, normalizeProjectPath } from "cc-session-io"
import { callTool, FakeClaudeCode, init, result, text, toolUse } from "../../test/FakeClaudeCode.ts"
import type { FakeClaudeCodeOptions, Step } from "../../test/FakeClaudeCode.ts"
import { resetBridge, setQuery } from "./Bridge.ts"
import { registerClaude } from "./Claude.ts"
import { ClaudeApi } from "./Names.ts"
import { clearSessionStates } from "./SessionMirror.ts"

let root: string
let fake: FakeClaudeCode

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kndl-claude-stop-"))
})
afterEach(() => {
  setQuery(null)
  resetBridge()
  clearSessionStates()
  rmSync(root, { recursive: true, force: true })
})
afterAll(() => setQuery(null))

const claudeDir = () => join(root, "claude")

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
async function startSession(options: FakeClaudeCodeOptions = {}): Promise<AgentSession> {
  fake = new FakeClaudeCode({ claudeDir: claudeDir(), ...options })
  setQuery(fake.query)
  const extension = (pi: ExtensionAPI) => {
    registerClaude(pi, [haiku], {
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test",
        KNDL_CLAUDE_CODE: "/opt/kndl/claude-code/test/claude",
        CLAUDE_CONFIG_DIR: claudeDir(),
      },
    })
    pi.registerTool({
      name: "wait",
      label: "Wait",
      description: "Waits.",
      parameters: Type.Object({}),
      execute: (_id, _params, signal) =>
        new Promise<AgentToolResult<undefined>>((resolve) => {
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
  return session
}

/** A step that says when it's reached, then holds the query until it's killed. */
function hold(): { readonly reached: Promise<void>; readonly step: Step } {
  let reached: (() => void) | undefined
  return {
    reached: new Promise<void>((resolve) => {
      reached = resolve
    }),
    step: async ({ killed }) => {
      reached?.()
      await killed
    },
  }
}

/** A reply that streams `partial`, then holds until it's stopped. */
const stoppedReply = (partial: string, reached: Step): Array<Step> => [
  { type: "stream_event", event: { type: "message_start", message: { id: "msg_stopped" } } },
  {
    type: "stream_event",
    event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  },
  {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: partial },
    },
  },
  reached,
]

/** Runs a prompt the fake holds, and stops it once it's held. */
async function stop(session: AgentSession, prompt: string, held: Promise<void>): Promise<void> {
  const run = session.prompt(prompt)
  await held
  await session.abort()
  await run
}

/** Claude Code's project directory for the directory the queries ran in. */
const projectDir = () =>
  getProjectDir(normalizeProjectPath(fake.calls[0]?.options.cwd ?? root), claudeDir())

/** The session files in the project directory. */
const sessionFiles = () => readdirSync(projectDir()).filter((file) => file.endsWith(".jsonl"))

const lastAssistant = (session: AgentSession) =>
  session.messages
    .filter((message): message is AssistantMessage => message.role === "assistant")
    .at(-1)

describe("the turn after a stopped one", () => {
  test("resumes the same session, its request starting as the stopped turn's did", async () => {
    const session = await startSession()
    try {
      const held = hold()
      fake.scripts.push(
        { label: "first", steps: [init("cc"), ...text("Hello."), result("Hello.")] },
        { label: "stopped", steps: [init("cc"), ...stoppedReply("Once upon", held.step)] },
        { label: "after", steps: [init("cc"), ...text("Sure.", "msg_after"), result("Sure.")] },
      )
      await session.prompt("one")
      await stop(session, "tell me a story", held.reached)
      expect(lastAssistant(session)?.stopReason).toBe("aborted")
      await session.prompt("three")

      const [first, stopped, after] = fake.calls
      expect(stopped?.options.resume).toBe(first?.sessionId)
      expect(after?.options.resume).toBe(first?.sessionId)
      expect(sessionFiles()).toEqual([`${first?.sessionId}.jsonl`])
      // Everything the stopped request held, Claude Code's attachments too, in its place.
      expect(stopped?.request).toEqual([
        "user:one",
        "attachment:total_tokens_reminder",
        "assistant:Hello.",
        "user:tell me a story",
        "attachment:total_tokens_reminder",
      ])
      expect(after?.request).toEqual([
        ...(stopped?.request ?? []),
        // The reply as pi holds it, cut off.
        "assistant:Once upon",
        "user:three",
        "attachment:total_tokens_reminder",
      ])
      expect(lastAssistant(session)?.content).toEqual([{ type: "text", text: "Sure." }])
    } finally {
      session.dispose()
    }
  }, 15_000)

  test("stopped before any output, goes on from its prompt", async () => {
    const session = await startSession()
    try {
      const held = hold()
      fake.scripts.push(
        { label: "first", steps: [init("cc"), ...text("Hello."), result("Hello.")] },
        { label: "stopped", steps: [init("cc"), held.step] },
        { label: "after", steps: [init("cc"), ...text("Sure.", "msg_after"), result("Sure.")] },
      )
      await session.prompt("one")
      await stop(session, "two", held.reached)
      expect(lastAssistant(session)).toMatchObject({ stopReason: "aborted", content: [] })
      await session.prompt("three")

      const [first, stopped, after] = fake.calls
      expect(after?.options.resume).toBe(first?.sessionId)
      expect(after?.request).toEqual([
        ...(stopped?.request ?? []),
        "user:three",
        "attachment:total_tokens_reminder",
      ])
    } finally {
      session.dispose()
    }
  }, 15_000)

  test("stopped while a tool ran, goes on with the call and its result as pi holds them", async () => {
    const session = await startSession()
    try {
      const held = hold()
      fake.scripts.push(
        { label: "first", steps: [init("cc"), ...text("Hello."), result("Hello.")] },
        {
          label: "stopped",
          steps: [
            init("cc"),
            ...toolUse("toolu_wait", "wait"),
            held.step,
            callTool("wait", "toolu_wait"),
          ],
        },
        { label: "after", steps: [init("cc"), ...text("Sure.", "msg_after"), result("Sure.")] },
      )
      await session.prompt("one")
      await stop(session, "wait, please", held.reached)
      await session.prompt("three")

      const [first, stopped, after] = fake.calls
      expect(after?.options.resume).toBe(first?.sessionId)
      expect(after?.request).toEqual([
        ...(stopped?.request ?? []),
        "assistant:tool_use:toolu_wait",
        "user:tool_result:toolu_wait",
        "user:three",
        "attachment:total_tokens_reminder",
      ])
      expect(lastAssistant(session)?.content).toEqual([{ type: "text", text: "Sure." }])
    } finally {
      session.dispose()
    }
  }, 15_000)

  test("after stops in a row, still resumes the same session", async () => {
    const session = await startSession()
    try {
      const second = hold()
      const third = hold()
      fake.scripts.push(
        { label: "first", steps: [init("cc"), ...text("Hello."), result("Hello.")] },
        { label: "stopped", steps: [init("cc"), ...stoppedReply("Once", second.step)] },
        { label: "stopped again", steps: [init("cc"), ...stoppedReply("Twice", third.step)] },
        { label: "after", steps: [init("cc"), ...text("Sure.", "msg_after"), result("Sure.")] },
      )
      await session.prompt("one")
      await stop(session, "two", second.reached)
      await stop(session, "three", third.reached)
      await session.prompt("four")

      const [first, , stoppedAgain, after] = fake.calls
      for (const call of fake.calls.slice(1)) expect(call.options.resume).toBe(first?.sessionId)
      expect(sessionFiles()).toHaveLength(1)
      expect(after?.request).toEqual([
        ...(stoppedAgain?.request ?? []),
        "assistant:Twice",
        "user:four",
        "attachment:total_tokens_reminder",
      ])
      expect(stoppedAgain?.request).toContain("assistant:Once")
    } finally {
      session.dispose()
    }
  }, 15_000)

  // Claude Code goes on writing for a moment after it's told to stop. Cutting the session back
  // before it exits would leave what it writes last after pi's messages.
  test("waits for the stopped Claude Code to exit before cutting its session back", async () => {
    const session = await startSession({ process: { lateMs: 300 } })
    try {
      const held = hold()
      fake.scripts.push(
        { label: "first", steps: [init("cc"), ...text("Hello."), result("Hello.")] },
        { label: "stopped", steps: [init("cc"), ...stoppedReply("Once upon", held.step)] },
        { label: "after", steps: [init("cc"), ...text("Sure.", "msg_after"), result("Sure.")] },
      )
      await session.prompt("one")
      await stop(session, "tell me a story", held.reached)
      await session.prompt("three")
      // Past when the stopped one wrote its last, had nothing waited for it.
      await new Promise((resolve) => setTimeout(resolve, 400))

      const [first, stopped, after] = fake.calls
      expect(after?.options.resume).toBe(first?.sessionId)
      expect(after?.request).toEqual([
        ...(stopped?.request ?? []),
        "assistant:Once upon",
        "user:three",
        "attachment:total_tokens_reminder",
      ])
      const file = join(projectDir(), `${first?.sessionId}.jsonl`)
      expect(readFileSync(file, "utf8")).not.toContain("[Request interrupted by user]")
    } finally {
      session.dispose()
    }
  }, 15_000)
})
