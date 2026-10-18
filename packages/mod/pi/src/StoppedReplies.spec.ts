// A stopped reply in what the model reads (StoppedReplies.ts): the request's messages, as pi-ai
// then sends them to OpenAI's Responses API, and the context handler in a real pi session on faux
// models, a Gateway one and one that goes by the Claude bridge's api.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  fauxAssistantMessage,
  fauxProvider,
  InMemoryCredentialStore,
  normalizeContext,
} from "@earendil-works/pi-ai"
import type {
  AssistantMessage,
  Model,
  ToolCall,
  ToolResultMessage,
  TranscriptContext,
} from "@earendil-works/pi-ai"
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared"
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages"
import {
  convertToLlm,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"
import type { ContextEvent } from "@earendil-works/pi-coding-agent"
import { ClaudeApi } from "./claude/Names.ts"
import { keepStoppedReplies, StopMarker, withStoppedReplies } from "./StoppedReplies.ts"

type PiMessage = ContextEvent["messages"][number]

const usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

let clock = 1_000

const user = (text: string): PiMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: ++clock,
})

const reply = (
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  extra: Partial<AssistantMessage> = {},
): AssistantMessage => ({
  role: "assistant",
  content,
  api: "openai-responses",
  provider: "xai",
  model: "grok-4.3",
  usage,
  stopReason,
  timestamp: ++clock,
  ...extra,
})

/** pi's message for a reply someone stopped: what had streamed, as pi-ai's providers end one. */
const stopped = (content: AssistantMessage["content"]) =>
  reply(content, "aborted", { errorMessage: "Request was aborted" })

const call = (id: string, name: string, args: ToolCall["arguments"]): ToolCall => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
})

const result = (toolCallId: string, toolName: string, text: string): ToolResultMessage => ({
  role: "toolResult",
  toolCallId,
  toolName,
  content: [{ type: "text", text }],
  isError: false,
  timestamp: ++clock,
})

/** What says the reply was stopped, where it is in a request. */
const marker = (timestamp: number) => ({
  role: "custom",
  customType: "kndl-stopped",
  content: StopMarker,
  display: false,
  timestamp,
})

const grok: Model<"openai-responses"> = {
  id: "grok-4.3",
  name: "Grok 4.3",
  api: "openai-responses",
  provider: "xai",
  baseUrl: "https://kndl.test/gateway/models/xai/v1",
  reasoning: true,
  input: ["text"],
  contextWindow: 200_000,
  maxTokens: 8_192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

/** The OpenAI Responses input pi-ai builds from a request's messages, as Grok gets it. */
const responsesInput = (messages: ReadonlyArray<PiMessage>) =>
  convertResponsesMessages(
    grok,
    normalizeContext({ messages: convertToLlm([...messages]) }),
    new Set(["openai", "xai"]),
  ) as unknown as Array<Record<string, unknown>>

/** Every tool output in a Responses input follows the call it answers, and every call has one. */
const paired = (input: ReadonlyArray<Record<string, unknown>>) => {
  const calls = new Set<unknown>()
  const answered = new Set<unknown>()
  for (const item of input) {
    if (item.type === "function_call") calls.add(item.call_id)
    if (item.type === "function_call_output") {
      if (!calls.has(item.call_id)) return false
      answered.add(item.call_id)
    }
  }
  return [...calls].every((id) => answered.has(id))
}

/** `value`, and everything in it, frozen: changing any of it throws. */
const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    for (const each of Object.values(value)) deepFreeze(each)
    Object.freeze(value)
  }
  return value
}

describe("a reply the person stopped stays in what the model sees", () => {
  test("its text, then that it was stopped, before what was said next", () => {
    const asked = user("can you write a really long poem")
    const poem = stopped([{ type: "text", text: "Upon the hills of morning light," }])
    const thanks = user("Thanks")
    const request = withStoppedReplies([asked, poem, thanks])
    expect(request).toEqual([
      asked,
      {
        ...poem,
        content: [{ type: "text", text: "Upon the hills of morning light," }],
        stopReason: "stop",
        errorMessage: undefined,
      },
      marker(poem.timestamp),
      thanks,
    ] as never)
    // pi-ai replays it now, where it left it out before.
    const replayed = transformMessages(convertToLlm([...(request ?? [])]), grok)
    expect(replayed.map((message) => message.role)).toEqual(["user", "assistant", "user", "user"])
    expect(responsesInput(request ?? [])).toEqual([
      { role: "user", content: [{ type: "input_text", text: "can you write a really long poem" }] },
      expect.objectContaining({
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "Upon the hills of morning light,", annotations: [] },
        ],
      }),
      { role: "user", content: [{ type: "input_text", text: StopMarker }] },
      { role: "user", content: [{ type: "input_text", text: "Thanks" }] },
    ])
  })

  test("its complete tool calls, with their results, then that it was stopped", () => {
    const asked = user("look at a.ts")
    const look = call("call_1", "read", { path: "a.ts" })
    const held = stopped([{ type: "text", text: "Let me look." }, look])
    const read = result("call_1", "read", "export const a = 1")
    const next = user("never mind")
    const request = withStoppedReplies([asked, held, read, next])
    expect(request).toEqual([
      asked,
      {
        ...held,
        content: [{ type: "text", text: "Let me look." }, look],
        stopReason: "toolUse",
        errorMessage: undefined,
      },
      read,
      marker(held.timestamp),
      next,
    ] as never)
    const input = responsesInput(request ?? [])
    expect(paired(input)).toBe(true)
    expect(input.map((item) => item.type ?? item.role)).toEqual([
      "user",
      "message",
      "function_call",
      "function_call_output",
      "user",
      "user",
    ])
    expect(JSON.stringify(input)).not.toContain("No result provided")
  })

  test("a tool call cut off mid-arguments, or that never ran, is left out", () => {
    const asked = user("write the poem to a file")
    const ran = call("call_2", "read", { path: "poem.md" })
    const complete = call("call_3", "bash", { command: "ls" })
    const cut = {
      ...call("call_4", "write", { path: "poem.md" }),
      partialJson: '{"path":"poem.md","content":"Upon the hi',
    }
    const held = stopped([{ type: "text", text: "Writing it:" }, ran, complete, cut])
    const read = result("call_2", "read", "(empty)")
    const next = user("stop")
    const request = withStoppedReplies([asked, held, read, next])
    expect(request).toEqual([
      asked,
      {
        ...held,
        content: [{ type: "text", text: "Writing it:" }, ran],
        stopReason: "toolUse",
        errorMessage: undefined,
      },
      read,
      marker(held.timestamp),
      next,
    ] as never)
    const input = responsesInput(request ?? [])
    expect(paired(input)).toBe(true)
    expect(JSON.stringify(input)).not.toContain("call_3")
    expect(JSON.stringify(input)).not.toContain("call_4")
    expect(JSON.stringify(input)).not.toContain("No result provided")
  })

  test("its reasoning is left out, and its text goes without the ids that tie it to that reasoning", () => {
    const asked = user("a poem, please")
    const held = stopped([
      {
        type: "thinking",
        thinking: "A long poem about mornings",
        thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_1", summary: [] }),
      },
      { type: "thinking", thinking: "Rhyme on light, bri" },
      {
        type: "text",
        text: "Upon the hills",
        textSignature: JSON.stringify({ v: 1, id: "msg_1" }),
      },
    ])
    const next = user("Thanks")
    const request = withStoppedReplies([asked, held, next])
    expect(request?.[1]).toEqual({
      ...held,
      content: [{ type: "text", text: "Upon the hills" }],
      stopReason: "stop",
      errorMessage: undefined,
    } as never)
    const input = JSON.stringify(responsesInput(request ?? []))
    expect(input).not.toContain("rs_1")
    expect(input).not.toContain("msg_1")
    expect(input).not.toContain("A long poem about mornings")
  })

  test("a reply stopped before anything worth keeping streamed is only said to have been stopped", () => {
    const asked = user("a poem, please")
    const empty = stopped([])
    const thinking = stopped([
      { type: "thinking", thinking: "Hmm" },
      { type: "text", text: " " },
    ])
    const next = user("again?")
    const after = user("Thanks")
    expect(withStoppedReplies([asked, empty, next, thinking, after])).toEqual([
      asked,
      marker(empty.timestamp),
      next,
      marker(thinking.timestamp),
      after,
    ] as never)
  })

  test("a reply stopped while its tool ran: the call and its result, then that it was stopped", () => {
    const asked = user("run the tests")
    const run = call("call_5", "bash", { command: "bun test" })
    const calling = reply([run], "toolUse")
    const ran = { ...result("call_5", "bash", "Operation aborted"), isError: true }
    const ended = stopped([])
    const next = user("why did you stop?")
    expect(withStoppedReplies([asked, calling, ran, ended, next])).toEqual([
      asked,
      calling,
      ran,
      marker(ended.timestamp),
      next,
    ] as never)
  })

  test("its results go right after it, and the marker after them, with a steer that came between them after", () => {
    const asked = user("look at a.ts")
    const look = call("call_6", "read", { path: "a.ts" })
    const held = stopped([look])
    const steer = user("and b.ts")
    const read = result("call_6", "read", "export const a = 1")
    const request = withStoppedReplies([asked, held, steer, read])
    expect(request).toEqual([
      asked,
      { ...held, content: [look], stopReason: "toolUse", errorMessage: undefined },
      read,
      marker(held.timestamp),
      steer,
    ] as never)
    expect(paired(responsesInput(request ?? []))).toBe(true)
  })

  test("a reply that ended in an error is left to pi-ai, which leaves it out: nothing changes", () => {
    const asked = user("a poem, please")
    const failed = reply([{ type: "text", text: "Upon" }], "error", {
      errorMessage: "overloaded",
    })
    const next = user("again")
    expect(withStoppedReplies([asked, failed, next])).toBeUndefined()
    expect(withStoppedReplies([asked, reply([{ type: "text", text: "Hi." }], "stop")])).toBe(
      undefined,
    )
  })

  test("the messages it is given are left as they are", () => {
    const messages = deepFreeze([
      user("look at a.ts"),
      stopped([
        { type: "thinking", thinking: "Hmm" },
        { type: "text", text: "Let me look.", textSignature: "sig" },
        call("call_7", "read", { path: "a.ts" }),
        call("call_8", "read", { path: "b.ts" }),
      ]),
      result("call_7", "read", "export const a = 1"),
      user("never mind"),
    ])
    const before = structuredClone(messages)
    expect(() => withStoppedReplies(messages)).not.toThrow()
    expect(messages).toEqual(before)
  })
})

describe("in a pi session, through pi's context event", () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "kndl-stopped-replies-"))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const gateway = fauxProvider({ provider: "xai", models: [{ id: "grok-4.3" }] })
  // The Claude bridge's Models go by its api, as pi routes them to it.
  const bridge = fauxProvider({
    provider: "anthropic",
    api: ClaudeApi,
    models: [{ id: "claude-haiku-5-5" }],
  })

  const startSession = async () => {
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    })
    modelRuntime.registerNativeProvider(gateway.provider)
    modelRuntime.registerNativeProvider(bridge.provider)
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    })
    const resourceLoader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: join(dir, "agent"),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [keepStoppedReplies],
    })
    await resourceLoader.reload()
    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: join(dir, "agent"),
      modelRuntime,
      model: gateway.getModel(),
      resourceLoader,
      sessionManager: SessionManager.inMemory(dir),
      settingsManager,
      noTools: "builtin",
    })
    await session.bindExtensions({})
    return session
  }

  /**
   * The user and assistant text a request carried, in order, as a provider's own conversion sends
   * it, after pi-ai's cross-provider transform (the faux provider has none of its own).
   */
  const lines = (context: TranscriptContext) =>
    transformMessages(context.messages, gateway.getModel()).flatMap((message) => {
      if (message.role !== "user" && message.role !== "assistant") return []
      const content = typeof message.content === "string" ? [] : message.content
      return content.flatMap((block) =>
        block.type === "text" ? [`${message.role}: ${block.text}`] : [],
      )
    })

  test("a Gateway model's request carries the stopped reply and the marker; the Claude bridge's is left as pi holds it", async () => {
    const session = await startSession()
    try {
      let toGateway: TranscriptContext | undefined
      let toBridge: TranscriptContext | undefined
      gateway.setResponses([
        fauxAssistantMessage("Upon the hills of morning light,", { stopReason: "aborted" }),
        (context) => {
          toGateway = context
          return fauxAssistantMessage("You're welcome.")
        },
      ])
      bridge.setResponses([
        (context) => {
          toBridge = context
          return fauxAssistantMessage("Hello.")
        },
      ])
      await session.prompt("can you write a really long poem")
      await session.prompt("Thanks")
      expect(lines(toGateway as TranscriptContext)).toEqual([
        "user: can you write a really long poem",
        "assistant: Upon the hills of morning light,",
        `user: ${StopMarker}`,
        "user: Thanks",
      ])
      // pi's session holds the stopped reply as it was.
      const held = session.messages.find((message) => message.role === "assistant")
      expect(held).toMatchObject({ stopReason: "aborted" })

      await session.setModel(bridge.getModel())
      await session.prompt("hello?")
      const bridged = toBridge as TranscriptContext
      expect(lines(bridged)).not.toContain(`user: ${StopMarker}`)
      expect(bridged.messages.find((message) => message.role === "assistant")).toMatchObject({
        stopReason: "aborted",
      })
    } finally {
      session.dispose()
    }
  })
})
