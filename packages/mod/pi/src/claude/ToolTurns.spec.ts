// Claude's tool calls after a tool call, in one pi run: the continuation of a held query calls
// another tool, after a first turn, after another Provider's turn (the mirror rebuilds), after a
// steer, and after a compaction discarded the held query; and one message calls two tools. A real
// pi session, with only Claude Code's query replaced, playing Claude Code's messages in the order
// the real one yields them. Every message pi holds stays as pi got it.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAssistantMessageEventStream, Type } from "@earendil-works/pi-ai"
import type { AssistantMessage, Model } from "@earendil-works/pi-ai"
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent"

type AgentMessage = AgentSession["messages"][number]
import { FakeClaudeCode, init, result, streamedToolCalls, text } from "../../test/FakeClaudeCode.ts"
import { markRebuildForSession, resetBridge, setQuery } from "./Bridge.ts"
import { registerClaude } from "./Claude.ts"
import { ClaudeApi } from "./Names.ts"
import { newAssistantOutput } from "./QueryState.ts"
import { clearSessionStates } from "./SessionMirror.ts"

let root: string
let fake: FakeClaudeCode

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "kndl-claude-tool-turns-"))
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

const claude: Model<string> = {
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

/** Another Provider's Model, which answers every turn with text. */
const other: Model<string> = { ...claude, id: "other-model", api: "other-api", provider: "other" }

interface Started {
  readonly session: AgentSession
  /** The tools pi ran, in order. */
  readonly ran: Array<string>
  /** Every message pi ended, as it was at its end. */
  readonly ended: Array<{ readonly message: AgentMessage; readonly snapshot: AgentMessage }>
}

/**
 * A real pi session on the bridge, with two tools, `look` and `count`. `duringLook` runs while
 * `look` does, the first time.
 */
async function startSession(
  duringLook?: (session: AgentSession) => Promise<void>,
): Promise<Started> {
  const ran: Array<string> = []
  const current: { session?: AgentSession } = {}
  let looked = false
  const extension = (pi: ExtensionAPI) => {
    registerClaude(pi, [haiku], {
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test",
        KNDL_CLAUDE_CODE: "/opt/kndl/claude-code/test/claude",
        CLAUDE_CONFIG_DIR: join(root, "claude"),
      },
    })
    pi.registerProvider("other", {
      baseUrl: "other",
      apiKey: "other",
      api: "other-api",
      models: [{ ...other, reasoning: false }],
      streamSimple: (model) => {
        const stream = createAssistantMessageEventStream()
        const message = newAssistantOutput(model, "Noted.", "stop")
        queueMicrotask(() => {
          stream.push({ type: "done", reason: "stop", message })
          stream.end()
        })
        return stream
      },
    })
    for (const name of ["look", "count"])
      pi.registerTool({
        name,
        label: name,
        description: `${name}s.`,
        parameters: Type.Object({}),
        execute: async () => {
          ran.push(name)
          if (name === "look" && !looked && current.session !== undefined) {
            looked = true
            await duringLook?.(current.session)
          }
          return { content: [{ type: "text", text: `${name} done` }], details: undefined }
        },
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
  const created = await createAgentSession({
    cwd: root,
    agentDir: join(root, "agent"),
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(root),
    settingsManager: settings,
    noTools: "builtin",
    model: claude,
  })
  const session = created.session
  current.session = session
  const ended: Started["ended"] = []
  session.subscribe((event) => {
    if (event.type === "message_end")
      ended.push({ message: event.message, snapshot: structuredClone(event.message) })
  })
  return { session, ran, ended }
}

/** A prompt's run, failing rather than hanging when a turn never ends. */
async function run(session: AgentSession, prompt: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the run of "${prompt}" never ended`)), 3_000)
  })
  try {
    await Promise.race([session.prompt(prompt), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** The run's messages from its prompt on, by role and what they carry. */
const shape = (messages: ReadonlyArray<AgentMessage>) =>
  messages.flatMap((message) => {
    if (message.role === "toolResult") return [`toolResult:${message.toolCallId}`]
    if (message.role === "system") return []
    if (message.role !== "assistant") return [message.role]
    const calls = message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []))
    return [`assistant:${message.stopReason}${calls.length ? `:${calls.join(",")}` : ""}`]
  })

const assistants = (session: AgentSession) =>
  session.messages.filter((message): message is AssistantMessage => message.role === "assistant")

/** Every message pi ended is the one it holds, unchanged since. */
function expectUnchanged(started: Started): void {
  for (const { message, snapshot } of started.ended) {
    expect(started.session.messages).toContain(message)
    expect(message).toEqual(snapshot)
  }
}

const lookThenCount = [
  ...streamedToolCalls("msg_look", [{ id: "toolu_look", tool: "look" }], {
    thinking: "I should look first.",
  }),
  ...streamedToolCalls("msg_count", [{ id: "toolu_count", tool: "count" }], {
    thinking: "Now count.",
  }),
  ...text("Seven lines.", "msg_answer"),
  result("Seven lines."),
]

describe("a Claude turn's second tool call", () => {
  test("reaches pi after the first's result, and the turn ends with the answer", async () => {
    fake = new FakeClaudeCode()
    setQuery(fake.query)
    fake.scripts.push({ label: "look, then count", steps: [init("cc-1"), ...lookThenCount] })
    const started = await startSession()
    try {
      await run(started.session, "look, then count")
      expect(started.ran).toEqual(["look", "count"])
      expect(shape(started.session.messages)).toEqual([
        "user",
        "assistant:toolUse:toolu_look",
        "toolResult:toolu_look",
        "assistant:toolUse:toolu_count",
        "toolResult:toolu_count",
        "assistant:stop",
      ])
      const [look, count, answer] = assistants(started.session)
      expect(look?.content.map((block) => block.type)).toEqual(["thinking", "toolCall"])
      expect(count?.content.map((block) => block.type)).toEqual(["thinking", "toolCall"])
      expect(answer?.content).toEqual([{ type: "text", text: "Seven lines." }])
      // One query held across the run.
      expect(fake.calls.length).toBe(1)
      expectUnchanged(started)
    } finally {
      started.session.dispose()
    }
  }, 10_000)

  test("reaches pi when the run follows another Provider's turn, on a rebuilt mirror", async () => {
    fake = new FakeClaudeCode()
    setQuery(fake.query)
    fake.scripts.push(
      { label: "hello", steps: [init("cc-1"), ...text("Hello."), result("Hello.")] },
      { label: "look, then count", steps: [init("cc-1"), ...lookThenCount] },
    )
    const started = await startSession()
    try {
      await run(started.session, "hello")
      await started.session.setModel(other)
      await run(started.session, "anything?")
      await started.session.setModel(claude)
      const from = started.session.messages.length
      await run(started.session, "look, then count")
      expect(assistants(started.session).map((message) => message.provider)).toEqual([
        "anthropic",
        "other",
        "anthropic",
        "anthropic",
        "anthropic",
      ])
      expect(fake.calls[1]?.options.resume).toBe("cc-1")
      expect(started.ran).toEqual(["look", "count"])
      expect(shape(started.session.messages.slice(from))).toEqual([
        "user",
        "assistant:toolUse:toolu_look",
        "toolResult:toolu_look",
        "assistant:toolUse:toolu_count",
        "toolResult:toolu_count",
        "assistant:stop",
      ])
      expectUnchanged(started)
    } finally {
      started.session.dispose()
    }
  }, 10_000)

  test("reaches pi after a steer sent while the first ran", async () => {
    fake = new FakeClaudeCode()
    setQuery(fake.query)
    fake.scripts.push({ label: "look, then count", steps: [init("cc-1"), ...lookThenCount] })
    const started = await startSession(async (session) => {
      await session.steer("and count, please")
    })
    try {
      await run(started.session, "look")
      expect(started.ran).toEqual(["look", "count"])
      expect(shape(started.session.messages)).toEqual([
        "user",
        "assistant:toolUse:toolu_look",
        "toolResult:toolu_look",
        "user",
        "assistant:toolUse:toolu_count",
        "toolResult:toolu_count",
        "assistant:stop",
      ])
      // The steer went to the held query, ahead of the result.
      expect(fake.calls.length).toBe(1)
      expect(fake.calls[0]?.steers).toEqual(["and count, please"])
      expectUnchanged(started)
    } finally {
      started.session.dispose()
    }
  }, 10_000)

  test("reaches pi from the query that replaced one a compaction discarded", async () => {
    fake = new FakeClaudeCode()
    setQuery(fake.query)
    fake.scripts.push(
      {
        label: "look",
        steps: [
          init("cc-1"),
          ...streamedToolCalls("msg_look", [{ id: "toolu_look", tool: "look" }], {
            thinking: "I should look first.",
          }),
        ],
      },
      {
        label: "count, after the compaction",
        steps: [
          init("cc-2"),
          ...streamedToolCalls("msg_count", [{ id: "toolu_count", tool: "count" }], {
            thinking: "Now count.",
          }),
          ...text("Seven lines.", "msg_answer"),
          result("Seven lines."),
        ],
      },
    )
    // What pi's session_compact does, while the query is held at the tool call.
    const started = await startSession(async (session) =>
      markRebuildForSession(session.sessionManager.getSessionId(), "session_compact:test"),
    )
    try {
      await run(started.session, "look, then count")
      expect(fake.calls[0]?.closed).toBe(true)
      expect(fake.calls[1]?.prompt).toContain("Your context was compacted")
      expect(started.ran).toEqual(["look", "count"])
      expect(shape(started.session.messages)).toEqual([
        "user",
        "assistant:toolUse:toolu_look",
        "toolResult:toolu_look",
        "assistant:toolUse:toolu_count",
        "toolResult:toolu_count",
        "assistant:stop",
      ])
      expectUnchanged(started)
    } finally {
      started.session.dispose()
    }
  }, 10_000)
})

describe("a Claude message with two tool calls", () => {
  test("reaches pi whole, and both results go back to the one query", async () => {
    fake = new FakeClaudeCode()
    setQuery(fake.query)
    fake.scripts.push({
      label: "look and count",
      steps: [
        init("cc-1"),
        ...streamedToolCalls(
          "msg_both",
          [
            { id: "toolu_look", tool: "look" },
            { id: "toolu_count", tool: "count" },
          ],
          { thinking: "Both at once." },
        ),
        ...streamedToolCalls("msg_again", [{ id: "toolu_count_2", tool: "count" }]),
        ...text("Seven lines.", "msg_answer"),
        result("Seven lines."),
      ],
    })
    const started = await startSession()
    try {
      await run(started.session, "look and count")
      expect(started.ran).toEqual(["look", "count", "count"])
      expect(shape(started.session.messages)).toEqual([
        "user",
        "assistant:toolUse:toolu_look,toolu_count",
        "toolResult:toolu_look",
        "toolResult:toolu_count",
        "assistant:toolUse:toolu_count_2",
        "toolResult:toolu_count_2",
        "assistant:stop",
      ])
      expect(fake.calls.length).toBe(1)
      expectUnchanged(started)
    } finally {
      started.session.dispose()
    }
  }, 10_000)
})
