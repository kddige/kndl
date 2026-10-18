// When the bridge records what pi assembled into a prompt (before_agent_start, agent_start,
// turn_start), the shapes that still fall outside it, and a prompt it refuses failing its turn.
// Ported from pi-claude-bridge 0.9.3's tests (unit-agent-start-capture,
// unit-agent-start-capture-gaps, unit-prompt-capture-turn-failure).

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Api, AssistantMessageEventStream, Context, Model } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent"
import { bridgeState, capturedPrompts, resetBridge, setQuery } from "./Bridge.ts"
import { registerClaude } from "./Claude.ts"
import {
  PiPreamble,
  projectPromptCapture,
  PromptCaptures,
  sharedPromptCaptures,
} from "./PromptCapture.ts"

type Handler = (event: unknown, ctx?: unknown) => unknown

const env = {
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test",
  KNDL_CLAUDE_CODE: "/opt/kndl/claude-code/test/claude",
}
const haiku = {
  provider: "anthropic" as const,
  id: "claude-haiku-5-5",
  label: "Claude Haiku 5.5",
  thinkingLevels: [],
}

/** The bridge registered on a stand-in pi: its event handlers, and the provider it registered. */
function activate(log?: (text: string) => void): {
  readonly handler: (name: string) => Handler
  readonly provider: () => ProviderConfig
} {
  const handlers = new Map<string, Handler>()
  let provider: ProviderConfig | undefined
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerProvider: (_name: string, config: ProviderConfig) => {
      provider = config
    },
    registerTool: () => {},
  } as unknown as ExtensionAPI
  registerClaude(pi, [haiku], { env, ...(log === undefined ? {} : { log }) })
  return {
    handler: (name) => {
      const found = handlers.get(name)
      if (found === undefined) throw new Error(`no ${name} handler`)
      return found
    },
    provider: () => {
      if (provider === undefined) throw new Error("no provider registered")
      return provider
    },
  }
}

const promptCtx = (prompt: string) => ({ getSystemPrompt: () => prompt })
const captures = capturedPrompts()

const PreWiden = "You are pi.\n# Tools\n- read: Read a file\n\npi packages (docs/packages.md)"
// The same, with the tools' descriptions that join once MCP servers connect.
const Widened =
  "You are pi.\n# Tools\n- read: Read a file\n- Agent: Launch a subagent with a very long description ... \n\npi packages (docs/packages.md)"

describe("agent_start records the widened prompt", () => {
  test("records ctx.getSystemPrompt(), so the widened prompt itself resolves", () => {
    const pi = activate()
    pi.handler("before_agent_start")({ systemPrompt: PreWiden, systemPromptOptions: {} })
    expect(() => captures.resolveOrDerive(Widened)).toThrow(/no capture/)

    pi.handler("agent_start")({}, promptCtx(Widened))
    expect(captures.resolveOrDerive(Widened)).toBeDefined()
  })

  test("lets a child embedding the widened parent resolve by inheritance", () => {
    const pi = activate()
    pi.handler("before_agent_start")({ systemPrompt: PreWiden, systemPromptOptions: {} })
    pi.handler("agent_start")({}, promptCtx(Widened))

    const child = `${Widened}\n\n<sub_agent_context>be concise</sub_agent_context>\n\n<active_agent name="worker"/>`
    expect(captures.resolveOrDerive(child)?.inherited.length).toBeGreaterThanOrEqual(1)
  })

  test("carries before_agent_start's portable parts onto the widened key", () => {
    const pi = activate()
    const contextFiles = [{ path: "/AGENTS.md", content: "project rules" }]
    pi.handler("before_agent_start")({
      systemPrompt: PreWiden,
      systemPromptOptions: { contextFiles, skills: [], selectedTools: ["read"] },
    })
    pi.handler("agent_start")({}, promptCtx(Widened))
    expect(captures.resolve(Widened)?.contextFiles).toEqual(contextFiles)
  })

  test("carries a section a later before_agent_start handler adds, as kndl's own", () => {
    const pi = activate()
    const options = { sections: {} as Record<string, string> }
    pi.handler("before_agent_start")({ systemPrompt: PreWiden, systemPromptOptions: options })
    // kndl's extension adds its section after the bridge's handler ran, on the same live options.
    options.sections.kndl_shared_session = "This session is shared."
    const rendered = `${Widened}\n\n<kndl_shared_session>\nThis session is shared.\n</kndl_shared_session>`
    pi.handler("agent_start")({}, promptCtx(rendered))

    const capture = captures.resolve(rendered)
    if (capture === undefined) throw new Error("not recorded")
    expect(projectPromptCapture(capture, { skillReadTool: "none" })).toBe(
      "<kndl_shared_session>\nThis session is shared.\n</kndl_shared_session>",
    )
  })
})

describe("turn_start records the prompt again", () => {
  test("keys a prompt rebuilt between turns, with the portable parts", () => {
    const pi = activate()
    const contextFiles = [{ path: "/AGENTS.md", content: "project rules" }]
    pi.handler("before_agent_start")({
      systemPrompt: PreWiden,
      systemPromptOptions: { contextFiles, skills: [], selectedTools: ["read"] },
    })
    pi.handler("agent_start")({}, promptCtx(Widened))
    const turnTwo = `${Widened}\n# Tools\n- git_status: Report repo state\n`
    pi.handler("turn_start")({}, promptCtx(turnTwo))
    expect(captures.resolve(turnTwo)?.contextFiles).toEqual(contextFiles)
  })

  test("doesn't grow the captures for the same prompt again", () => {
    const pi = activate()
    pi.handler("before_agent_start")({ systemPrompt: PreWiden, systemPromptOptions: {} })
    pi.handler("agent_start")({}, promptCtx(Widened))
    const before = captures.size
    pi.handler("turn_start")({}, promptCtx(Widened))
    pi.handler("turn_start")({}, promptCtx(Widened))
    expect(captures.resolve(Widened)).toBeDefined()
    expect(captures.size).toBe(before)
  })
})

const section = (name: string, content: string) => `<${name}>\n${content}\n</${name}>`
const parentSections = [
  `${PiPreamble}, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.`,
  section(
    "tools",
    "- read: Read a file\n- bash: Run commands\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.",
  ),
  section(
    "rules",
    "- Use bash for file operations like ls, rg, find\n- Be concise in your responses",
  ),
  section(
    "docs",
    "Pi documentation (read only when the user asks about pi itself):\n- Main documentation: /pi/README.md",
  ),
  section(
    "project_context",
    'Project-specific instructions and guidelines:\n\n<project_instructions path="/parent/AGENTS.md">\nParent rules.\n</project_instructions>',
  ),
  section(
    "skills",
    "The following skills provide specialized instructions for specific tasks.\n\n<available_skills>\n  <skill>\n    <name>deploy</name>\n    <description>Deploy the application.</description>\n  </skill>\n</available_skills>",
  ),
  section("cwd", "/parent"),
]
const ParentPrompt = parentSections.join("\n\n")
const StrippedParent = parentSections.slice(0, 5).join("\n\n")
const StrippedChild = `${StrippedParent}\n\n<active_agent name="Explore"/>\n\n# Environment\nWorking directory: /child\nGit repository: yes\nBranch: main\nPlatform: darwin`

describe("what the captures don't cover", () => {
  test("a capture recorded by the extension loaded again (a subagent's) is the stream's too", async () => {
    // The registry is process-wide: a fresh module's records land where the stream resolves.
    const freshModule = "./PromptCapture.ts?isolated-child"
    const fresh = (await import(freshModule)) as {
      readonly PromptCaptures: unknown
      readonly sharedPromptCaptures: typeof sharedPromptCaptures
    }
    expect(fresh.PromptCaptures).not.toBe(PromptCaptures)
    const isolatedPrompt = "You are an isolated smoke-test agent. Respond with ZZ_ISO_OK."
    fresh.sharedPromptCaptures().record(isolatedPrompt, { contextFiles: [], skills: [] })
    expect(fresh.sharedPromptCaptures()).toBe(sharedPromptCaptures())
    expect(captures.resolveOrDerive(isolatedPrompt)).toBeDefined()
  })

  test("a child embedding its parent's prompt less its tail matches nothing (reference #88)", () => {
    const pi = activate()
    pi.handler("before_agent_start")({ systemPrompt: ParentPrompt, systemPromptOptions: {} })
    pi.handler("agent_start")({}, promptCtx(ParentPrompt))
    expect(() => captures.resolveOrDerive(StrippedChild)).toThrow(/no capture/)
  })

  test("such a child, recorded, fails before pi's harness reaches Claude Code", () => {
    const pi = activate()
    pi.handler("before_agent_start")({ systemPrompt: ParentPrompt, systemPromptOptions: {} })
    pi.handler("agent_start")({}, promptCtx(ParentPrompt))
    pi.handler("before_agent_start")({
      systemPrompt: StrippedChild,
      systemPromptOptions: { customPrompt: StrippedChild },
    })
    pi.handler("agent_start")({}, promptCtx(StrippedChild))

    const capture = captures.resolve(StrippedChild)
    if (capture === undefined) throw new Error("not recorded")
    expect(capture.inherited.length).toBe(0)
    expect(() => projectPromptCapture(capture, { skillReadTool: "none" })).toThrow(
      /prompt-capture: refusing to send this prompt/,
    )
  })

  test("a prompt a handler forces whole resolves by its agent_start key", () => {
    const pi = activate()
    pi.handler("before_agent_start")({
      systemPrompt: "pi rendered prompt",
      systemPromptOptions: {},
    })
    pi.handler("agent_start")({}, promptCtx("forced replacement prompt owning the request head"))
    expect(captures.resolve("forced replacement prompt owning the request head")).toBeDefined()
  })

  test("a prompt made outside before_agent_start resolves to nothing", () => {
    const pi = activate()
    pi.handler("before_agent_start")({
      systemPrompt: "pi rendered prompt",
      systemPromptOptions: {},
    })
    pi.handler("agent_start")({}, promptCtx("pi rendered prompt"))
    expect(() => captures.resolveOrDerive("host-composed prompt owning the request head")).toThrow(
      /no capture/,
    )
  })

  test("a prompt replaced after turn_start resolves to nothing", () => {
    const pi = activate()
    pi.handler("before_agent_start")({ systemPrompt: "turn-1 prompt", systemPromptOptions: {} })
    pi.handler("agent_start")({}, promptCtx("turn-1 prompt"))
    pi.handler("turn_start")({}, promptCtx("turn-2 rendered prompt"))
    expect(captures.resolveOrDerive("turn-2 rendered prompt")).toBeDefined()
    expect(() =>
      captures.resolveOrDerive("replacement head installed by a context handler"),
    ).toThrow(/no capture/)
  })
})

describe("a prompt the bridge refuses", () => {
  let queries = 0
  const logged: Array<string> = []
  let turn: (systemPrompt: string) => AssistantMessageEventStream

  beforeEach(() => {
    queries = 0
    logged.length = 0
    resetBridge()
    setQuery(() => {
      queries++
      throw new Error("no query should start")
    })
    const config = activate((text) => logged.push(text)).provider()
    const model = {
      ...config.models?.[0],
      provider: "anthropic",
      baseUrl: "claude-code",
    } as unknown as Model<Api>
    const stream = config.streamSimple as unknown as (
      model: Model<Api>,
      context: Context,
      options?: { sessionId?: string },
    ) => AssistantMessageEventStream
    turn = (systemPrompt) =>
      stream(
        model,
        { systemPrompt, messages: [{ role: "user", content: "hi", timestamp: 0 }], tools: [] },
        { sessionId: "pi-session" },
      )
  })
  afterEach(() => setQuery(null))

  test("fails its turn on the stream when no capture accounts for the prompt", async () => {
    const result = await turn("a system prompt no capture boundary recorded").result()
    expect(result.stopReason).toBe("error")
    expect(result.errorMessage).toMatch(/prompt-capture: no capture/)
    expect(queries).toBe(0)
    expect(bridgeState.activeQueryContexts.size).toBe(0)
    expect(logged.some((line) => line.includes("prompt_capture_unresolved"))).toBe(true)
  })

  test("fails its turn on the stream when the guard refuses the capture", async () => {
    const prompt = `${PiPreamble}, recorded with pi's harness in its custom prompt.`
    captures.record(prompt, { custom: prompt, contextFiles: [], skills: [] })
    const result = await turn(prompt).result()
    expect(result.stopReason).toBe("error")
    expect(result.errorMessage).toMatch(/prompt-capture: refusing to send this prompt/)
    expect(queries).toBe(0)
    expect(bridgeState.activeQueryContexts.size).toBe(0)
  })
})
