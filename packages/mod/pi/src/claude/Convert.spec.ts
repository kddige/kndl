// pi's messages as Anthropic messages for Claude Code's session (Convert.ts), and the write path
// they go through: convertPiMessages → repairToolPairing → Session.importMessages. Ported from
// pi-claude-bridge 0.9.3's unit-import.mjs, unit-convert-determinism.mjs and
// unit-session-integrity.mjs (MIT, Copyright (c) 2026 Eli Dickinson).

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createSession, repairToolPairing } from "cc-session-io"
import type { ContentBlock, Message as SessionMessage } from "cc-session-io"
import { convertPiMessages } from "./Convert.ts"
import { ClaudeApi } from "./Names.ts"

/** Converts loosely-written pi messages, as tests write them. */
const convertWith = (messages: ReadonlyArray<unknown>, map = new Map<string, string>()) =>
  convertPiMessages(messages as never, map)

const convert = (messages: ReadonlyArray<unknown>, map?: Map<string, string>) =>
  convertWith(messages, map).anthropicMessages

const blocksOf = (messages: ReadonlyArray<SessionMessage>): Array<ContentBlock> =>
  messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))

const toolResults = (messages: ReadonlyArray<SessionMessage>) =>
  blocksOf(messages).flatMap((b) => (b.type === "tool_result" ? [b] : []))

describe("tool ID sanitization", () => {
  test("Kimi-style IDs with dots and colons", () => {
    const result = convert([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "functions.bash:0", name: "bash", arguments: {} }],
      },
      { role: "toolResult", toolCallId: "functions.bash:0", content: "file.txt" },
    ])
    expect(result[0]).toMatchObject({ content: [{ id: "functions_bash_0" }] })
    expect(result[1]).toMatchObject({ content: [{ tool_use_id: "functions_bash_0" }] })
  })

  test("IDs with spaces and special chars", () => {
    const result = convert([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "tool call#1@foo", name: "bash", arguments: {} }],
      },
      { role: "toolResult", toolCallId: "tool call#1@foo", content: "ok" },
    ])
    expect(result[0]).toMatchObject({ content: [{ id: "tool_call_1_foo" }] })
    expect(result[1]).toMatchObject({ content: [{ tool_use_id: "tool_call_1_foo" }] })
  })

  test("already-valid Anthropic IDs pass through unchanged", () => {
    const result = convert([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "toolu_abc123-XYZ", name: "read", arguments: {} }],
      },
      { role: "toolResult", toolCallId: "toolu_abc123-XYZ", content: "data" },
    ])
    expect(result[0]).toMatchObject({ content: [{ id: "toolu_abc123-XYZ" }] })
    expect(result[1]).toMatchObject({ content: [{ tool_use_id: "toolu_abc123-XYZ" }] })
  })

  test("tool_use and tool_result IDs stay paired after sanitization", () => {
    const ids = ["fn.read:0", "fn.write:1", "fn.bash:2"]
    const result = convert(
      ids.flatMap((id) => [
        { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: {} }] },
        { role: "toolResult", toolCallId: id, content: "ok" },
      ]),
    )
    const uses = blocksOf(result).flatMap((b) => (b.type === "tool_use" ? [b.id] : []))
    expect(uses).toHaveLength(3)
    expect(toolResults(result).map((b) => b.tool_use_id)).toEqual(uses)
  })
})

describe("empty text block filtering", () => {
  test("assistant with empty text + toolCall → only toolCall", () => {
    const result = convert([
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "toolCall", id: "abc", name: "read", arguments: {} },
        ],
      },
    ])
    expect(result).toHaveLength(1)
    expect(result[0]?.content).toEqual([
      { type: "tool_use", id: "abc", name: "mcp__custom-tools__read", input: {} },
    ])
  })

  test("assistant with only empty text → placeholder", () => {
    const result = convert([{ role: "assistant", content: [{ type: "text", text: "" }] }])
    expect(result).toEqual([
      { role: "assistant", content: [{ type: "text", text: "[incompatible content omitted]" }] },
    ])
  })

  test("assistant with non-empty text → preserved", () => {
    const result = convert([
      { role: "assistant", content: [{ type: "text", text: "Hello world" }] },
    ])
    expect(result).toEqual([
      { role: "assistant", content: [{ type: "text", text: "Hello world" }] },
    ])
  })

  test("assistant with multiple text blocks, some empty", () => {
    const result = convert([
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "real content" },
          { type: "text", text: "" },
        ],
      },
    ])
    expect(result).toEqual([
      { role: "assistant", content: [{ type: "text", text: "real content" }] },
    ])
  })
})

describe("thinking block filtering", () => {
  test("another provider's thinking blocks are dropped", () => {
    const result = convert([
      {
        role: "assistant",
        provider: "openrouter",
        api: "openai-completions",
        content: [
          { type: "thinking", thinking: "let me think..." },
          { type: "text", text: "answer" },
        ],
      },
    ])
    expect(result[0]?.content).toEqual([{ type: "text", text: "answer" }])
  })

  test("Claude Code's own thinking with a signature is kept", () => {
    const result = convert([
      {
        role: "assistant",
        provider: "anthropic",
        api: ClaudeApi,
        content: [
          { type: "thinking", thinking: "reasoning...", thinkingSignature: "sig123" },
          { type: "text", text: "answer" },
        ],
      },
    ])
    expect(result[0]?.content).toEqual([
      { type: "thinking", thinking: "reasoning...", signature: "sig123" },
      { type: "text", text: "answer" },
    ])
  })

  // A signature minted by another provider isn't ours to replay into Claude Code's session, even
  // under the same provider name.
  test("thinking from pi's own Anthropic API is dropped", () => {
    const result = convert([
      {
        role: "assistant",
        provider: "anthropic",
        api: "anthropic-messages",
        content: [
          { type: "thinking", thinking: "hmm", thinkingSignature: "sig456" },
          { type: "text", text: "done" },
        ],
      },
    ])
    expect(result[0]?.content).toEqual([{ type: "text", text: "done" }])
  })

  test("Claude Code's thinking WITHOUT a signature is dropped", () => {
    const result = convert([
      {
        role: "assistant",
        provider: "anthropic",
        api: ClaudeApi,
        content: [
          { type: "thinking", thinking: "no sig" },
          { type: "text", text: "answer" },
        ],
      },
    ])
    expect(result[0]?.content).toEqual([{ type: "text", text: "answer" }])
  })

  test("assistant with only another provider's thinking → placeholder", () => {
    const result = convert([
      {
        role: "assistant",
        provider: "deepseek",
        content: [{ type: "thinking", thinking: "deep thoughts" }],
      },
    ])
    expect(result).toEqual([
      { role: "assistant", content: [{ type: "text", text: "[incompatible content omitted]" }] },
    ])
  })
})

describe("message structure", () => {
  test("toolResult → user with tool_result content", () => {
    const result = convert([
      { role: "toolResult", toolCallId: "id1", content: "result text", isError: false },
    ])
    expect(result).toEqual([
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "id1", content: "result text", is_error: false },
        ],
      },
    ])
  })

  test("toolResult with isError=true", () => {
    const result = convert([
      { role: "toolResult", toolCallId: "id1", content: "oh no", isError: true },
    ])
    expect(result[0]).toMatchObject({ content: [{ is_error: true }] })
  })

  // Claude Code puts every result of one assistant turn in a single user message.
  test("merges the results of a parallel tool call into one user message", () => {
    const result = convert([
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "t1", name: "read", arguments: { path: "a.txt" } },
          { type: "toolCall", id: "t2", name: "read", arguments: { path: "b.txt" } },
        ],
      },
      { role: "toolResult", toolCallId: "t1", content: "content a" },
      { role: "toolResult", toolCallId: "t2", content: "content b" },
    ])
    expect(result).toHaveLength(2)
    expect(result[0]?.content).toHaveLength(2)
    expect(result[1]?.role).toBe("user")
    expect(toolResults(result).map((b) => [b.tool_use_id, b.content])).toEqual([
      ["t1", "content a"],
      ["t2", "content b"],
    ])
  })

  test("does not merge results across an intervening user message", () => {
    const result = convert([
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }] },
      { role: "toolResult", toolCallId: "t1", content: "a" },
      { role: "user", content: "keep going" },
      { role: "assistant", content: [{ type: "toolCall", id: "t2", name: "read", arguments: {} }] },
      { role: "toolResult", toolCallId: "t2", content: "b" },
    ])
    expect(result.map((m) => m.role)).toEqual(["assistant", "user", "user", "assistant", "user"])
  })

  test("mixed conversation: user → assistant(tool) → toolResult → assistant(text)", () => {
    const result = convert([
      { role: "user", content: "read file.txt" },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call1", name: "read", arguments: { path: "file.txt" } }],
      },
      { role: "toolResult", toolCallId: "call1", content: "hello world" },
      { role: "assistant", content: [{ type: "text", text: "The file says hello world." }] },
    ])
    expect(result).toEqual([
      { role: "user", content: "read file.txt" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call1",
            name: "mcp__custom-tools__read",
            input: { path: "file.txt" },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call1", content: "hello world" }],
      },
      { role: "assistant", content: [{ type: "text", text: "The file says hello world." }] },
    ])
  })

  test("user string content", () => {
    expect(convert([{ role: "user", content: "hello" }])[0]?.content).toBe("hello")
  })

  test("user empty string → [empty]", () => {
    expect(convert([{ role: "user", content: "" }])[0]?.content).toBe("[empty]")
  })

  test("user with array content containing text blocks", () => {
    const result = convert([{ role: "user", content: [{ type: "text", text: "hi" }] }])
    expect(result[0]?.content).toEqual([{ type: "text", text: "hi" }])
  })

  test("user with empty text blocks in array → [image] fallback", () => {
    expect(convert([{ role: "user", content: [{ type: "text", text: "" }] }])[0]?.content).toBe(
      "[image]",
    )
  })

  // The query runs `tools: []`, so no name in the transcript may look like a Claude Code builtin:
  // a tool missing from the map is one pi ran and no longer serves, not a builtin.
  test("tool name mapping: unserved pi tools keep the MCP namespace", () => {
    const served = new Map([["read", "mcp__custom-tools__Read"]])
    const result = convert(
      [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "a", name: "read", arguments: {} },
            { type: "toolCall", id: "b", name: "bash", arguments: {} },
            { type: "toolCall", id: "c", name: "AskClaude", arguments: {} },
          ],
        },
      ],
      served,
    )
    expect(blocksOf(result).map((b) => (b.type === "tool_use" ? b.name : b.type))).toEqual([
      "mcp__custom-tools__Read",
      "mcp__custom-tools__bash",
      "mcp__custom-tools__AskClaude",
    ])
  })

  test("tool name mapping: an SDK name in pi history is a double mapping, not a tool", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "a", name: "mcp__custom-tools__bash", arguments: {} }],
      },
    ]
    expect(() => convert(messages)).toThrow(/already an SDK tool name/)
  })

  test("toolResult with array content extracts text", () => {
    const result = convert([
      {
        role: "toolResult",
        toolCallId: "x",
        content: [
          { type: "text", text: "line 1" },
          { type: "text", text: "line 2" },
        ],
      },
    ])
    expect(toolResults(result)[0]?.content).toBe("line 1\nline 2")
  })

  // Claude Code keeps screenshots as image blocks in tool_result.content; flattening to text would
  // drop them from a rebuilt session.
  test("toolResult keeps image blocks instead of flattening to text", () => {
    const result = convert([
      {
        role: "toolResult",
        toolCallId: "x",
        content: [
          { type: "text", text: "captured" },
          { type: "image", data: "BASE64DATA", mimeType: "image/png" },
        ],
      },
    ])
    expect(toolResults(result)[0]?.content).toEqual([
      { type: "text", text: "captured" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "BASE64DATA" } },
    ])
  })

  // The string is what Claude Code writes for text-only results; blocks would change the cache key.
  test("toolResult without an image stays a flat string", () => {
    const result = convert([
      { role: "toolResult", toolCallId: "x", content: [{ type: "text", text: "just text" }] },
    ])
    expect(toolResults(result)[0]?.content).toBe("just text")
  })

  test("toolResult keeps markers for blocks that are neither text nor image", () => {
    const result = convert([
      {
        role: "toolResult",
        toolCallId: "x",
        content: [
          { type: "document" },
          { type: "image", data: "BASE64DATA", mimeType: "image/png" },
        ],
      },
    ])
    expect(toolResults(result)[0]?.content).toEqual([
      { type: "text", text: "[document]" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "BASE64DATA" } },
    ])
  })

  test("toolResult with only an image keeps the image", () => {
    const result = convert([
      {
        role: "toolResult",
        toolCallId: "x",
        content: [{ type: "image", data: "BASE64DATA", mimeType: "image/png" }],
      },
    ])
    expect(toolResults(result)[0]?.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "BASE64DATA" } },
    ])
  })
})

const parallelCall = (n: number) => {
  const ids = Array.from({ length: n }, (_, i) => `t${i}`)
  return [
    { role: "user", content: "read them all" },
    {
      role: "assistant",
      content: ids.map((id) => ({
        type: "toolCall",
        id,
        name: "read",
        arguments: { path: `${id}.txt` },
      })),
    },
    ...ids.map((id) => ({ role: "toolResult", toolCallId: id, content: `body of ${id}` })),
  ]
}

// repairToolPairing pairs only results in the user message straight after their assistant
// message: anything later is dropped for a synthetic "[no tool result recorded]" error.
describe("conversion survives repairToolPairing", () => {
  test("keeps every result of a parallel tool call", () => {
    const converted = convert(parallelCall(3))
    const repaired = repairToolPairing(converted)
    expect(repaired).toEqual(converted)
    expect(toolResults(repaired).map((b) => b.content)).toEqual([
      "body of t0",
      "body of t1",
      "body of t2",
    ])
  })

  // A steer mid-turn puts a user message between the results; Claude Code writes the same turn as
  // results, then the steer.
  test("collects results that a steer interleaved, keeping the steer after them", () => {
    const repaired = repairToolPairing(
      convert([
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "t0", name: "read", arguments: {} },
            { type: "toolCall", id: "t1", name: "read", arguments: {} },
          ],
        },
        { role: "toolResult", toolCallId: "t0", content: "first" },
        { role: "user", content: "actually, also check X" },
        { role: "toolResult", toolCallId: "t1", content: "second" },
      ]),
    )
    expect(repaired.map((m) => m.role)).toEqual(["assistant", "user", "user"])
    expect(toolResults(repaired.slice(1, 2)).map((b) => b.content)).toEqual(["first", "second"])
    expect(repaired[2]?.content).toBe("actually, also check X")
  })

  // A steer sent while the first tool still runs comes before any result in pi's history.
  test("collects results that a steer preceded", () => {
    const repaired = repairToolPairing(
      convert([
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "t0", name: "read", arguments: {} },
            { type: "toolCall", id: "t1", name: "read", arguments: {} },
          ],
        },
        { role: "user", content: "actually stop and check X" },
        { role: "toolResult", toolCallId: "t0", content: "first" },
        { role: "toolResult", toolCallId: "t1", content: "second" },
      ]),
    )
    expect(repaired.map((m) => m.role)).toEqual(["assistant", "user", "user"])
    expect(toolResults(repaired.slice(1, 2)).map((b) => b.content)).toEqual(["first", "second"])
    expect(repaired[2]?.content).toBe("actually stop and check X")
  })

  test("leaves no synthetic result stubs behind", () => {
    const repaired = repairToolPairing(convert(parallelCall(5)))
    const stubs = toolResults(repaired).filter(
      (b) => typeof b.content === "string" && b.content.includes("no tool result recorded"),
    )
    expect(stubs).toEqual([])
  })
})

describe("aborted assistant turns", () => {
  test("a turn aborted before anything streamed is dropped, not fabricated", () => {
    const result = convert([
      { role: "user", content: [{ type: "text", text: "first ask" }] },
      { role: "assistant", content: [] },
      { role: "user", content: [{ type: "text", text: "second ask" }] },
    ])
    expect(result.map((m) => m.role)).toEqual(["user", "user"])
  })

  test("a turn whose blocks were all filtered still says so", () => {
    const result = convert([
      {
        role: "assistant",
        provider: "deepseek",
        content: [{ type: "thinking", thinking: "deep thoughts" }],
      },
    ])
    expect(result).toEqual([
      { role: "assistant", content: [{ type: "text", text: "[incompatible content omitted]" }] },
    ])
  })

  // The prompt cache is keyed on exact prefix bytes: a placeholder for an aborted turn on rebuild
  // would diverge there and cost every cached token after it.
  test("rebuilding across an aborted turn preserves the cached prefix", () => {
    const live = convert([
      { role: "user", content: [{ type: "text", text: "first ask" }] },
      { role: "user", content: [{ type: "text", text: "second ask" }] },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ])
    const rebuilt = convert([
      { role: "user", content: [{ type: "text", text: "first ask" }] },
      { role: "assistant", content: [] },
      { role: "user", content: [{ type: "text", text: "second ask" }] },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ])
    expect(rebuilt).toEqual(live)
  })

  test("a result stranded after an aborted turn still lands on the real assistant", () => {
    const result = convert([
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }] },
      { role: "assistant", content: [] },
      { role: "toolResult", toolCallId: "t1", content: "ok" },
    ])
    expect(result.map((m) => m.role)).toEqual(["assistant", "user"])
    expect(toolResults(result)[0]?.tool_use_id).toBe("t1")
  })
})

describe("dropped-content accounting", () => {
  test("counts stripped thinking by provider and aborted turns", () => {
    const { dropped } = convertWith([
      {
        role: "assistant",
        provider: "openrouter",
        content: [
          { type: "thinking", thinking: "reasoning" },
          { type: "text", text: "the answer" },
        ],
      },
      { role: "assistant", content: [] },
      {
        role: "assistant",
        provider: "anthropic",
        api: ClaudeApi,
        content: [{ type: "thinking", thinking: "mine", thinkingSignature: "sig" }],
      },
    ])
    expect(dropped.thinking).toBe(1)
    expect([...dropped.providers]).toEqual(["openrouter"])
    expect(dropped.abortedTurns).toBe(1)
  })

  test("reports nothing when everything converts", () => {
    const { dropped } = convertWith([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ])
    expect(dropped.thinking).toBe(0)
    expect(dropped.abortedTurns).toBe(0)
    expect(dropped.other.size).toBe(0)
  })
})

// --- The write path: determinism and prefix stability ---

/** Record fields that differ between two builds of the same history: identity and clock. */
const Volatile = new Set(["uuid", "parentUuid", "sessionId", "timestamp", "slug", "requestId"])

/** The write path, reduced to the record content the prompt cache is keyed on. */
function transcript(piMessages: ReadonlyArray<unknown>): Array<string> {
  const repaired = repairToolPairing(convert(piMessages))
  const session = createSession({ projectPath: process.cwd() })
  if (repaired.length) session.importMessages(repaired)
  return session.records.map((record) => {
    const fields = record as Record<string, unknown>
    const message = fields.message as Record<string, unknown> | undefined
    return JSON.stringify({
      ...Object.fromEntries(Object.entries(fields).filter(([key]) => !Volatile.has(key))),
      message: { ...message, id: undefined },
    })
  })
}

interface LooseHistoryMessage {
  readonly role: string
  readonly content?: unknown
  readonly toolCallId?: string
}

/** The prefix lengths at which every tool call so far has its result. */
function settledPrefixes(messages: ReadonlyArray<LooseHistoryMessage>): Array<number> {
  const lengths: Array<number> = []
  const pending = new Set<string>()
  messages.forEach((msg, i) => {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const block of msg.content as Array<{ type: string; id?: string }>)
        if (block.type === "toolCall" && block.id) pending.add(block.id)
    }
    if (msg.role === "toolResult" && msg.toolCallId) pending.delete(msg.toolCallId)
    if (pending.size === 0) lengths.push(i + 1)
  })
  return lengths
}

function expectPrefix(
  shorter: ReadonlyArray<string>,
  longer: ReadonlyArray<string>,
  label: string,
) {
  for (let i = 0; i < shorter.length; i++) {
    if (longer[i] !== shorter[i])
      throw new Error(`${label}: record ${i} of ${shorter.length} diverged`)
  }
}

// A real 310-message pi session, its content scrubbed to placeholders: the structure (roles,
// block types, tool ids, parallel calls, thinking signatures) is verbatim.
const corpus = readFileSync(
  join(import.meta.dir, "../../test/fixtures/claude/pi-history-310.jsonl"),
  "utf-8",
)
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as LooseHistoryMessage)

const exotic: ReadonlyArray<LooseHistoryMessage> = [
  { role: "user", content: "start" },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "planning", thinkingSignature: "sigA" },
      { type: "text", text: "reading two files" },
      { type: "toolCall", id: "functions.read:0", name: "read", arguments: { path: "a" } },
      { type: "toolCall", id: "functions.read:1", name: "read", arguments: { path: "b" } },
    ],
  },
  { role: "toolResult", toolCallId: "functions.read:0", content: "body a" },
  { role: "user", content: "actually also check c" },
  {
    role: "toolResult",
    toolCallId: "functions.read:1",
    content: [
      { type: "text", text: "shot" },
      { type: "image", data: "BASE64", mimeType: "image/png" },
    ],
  },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "foreign", thinkingSignature: "sigB" },
      { type: "toolCall", id: "tool call#2@x", name: "my_custom_tool", arguments: {} },
    ],
  },
  { role: "toolResult", toolCallId: "tool call#2@x", content: "" },
  { role: "assistant", content: [{ type: "thinking", thinking: "unsigned" }] },
  { role: "user", content: "" },
  { role: "user", content: [{ type: "image", data: "IMG", mimeType: "image/jpeg" }] },
  {
    role: "assistant",
    content: [{ type: "toolCall", id: "t9", name: "bash", arguments: { cmd: "ls" } }],
  },
  { role: "toolResult", toolCallId: "t9", content: [{ type: "document" }] },
  { role: "assistant", content: [{ type: "text", text: "done" }] },
].map((message) =>
  message.role === "assistant" ? { ...message, provider: "anthropic", api: ClaudeApi } : message,
)

describe("conversion is deterministic", () => {
  test("a real 310-message session converts identically twice", () => {
    expect(transcript(corpus)).toEqual(transcript(corpus))
  })

  test("parallel calls, images, errors and thinking blocks convert identically twice", () => {
    expect(transcript(exotic)).toEqual(transcript(exotic))
  })
})

describe("rebuilds extend the transcript instead of rewriting it", () => {
  test("every settled prefix of a real session is a prefix of the full rebuild", () => {
    const full = transcript(corpus)
    const lengths = settledPrefixes(corpus)
    expect(lengths.length).toBeGreaterThan(100)
    for (const n of lengths) expectPrefix(transcript(corpus.slice(0, n)), full, `history[0..${n}]`)
  })

  test("a settled prefix survives every longer history, mid-turn truncation included", () => {
    for (const n of settledPrefixes(exotic)) {
      const shorter = transcript(exotic.slice(0, n))
      for (let m = n + 1; m <= exotic.length; m++)
        expectPrefix(shorter, transcript(exotic.slice(0, m)), `exotic[0..${n}] vs [0..${m}]`)
    }
  })
})

describe("repairToolPairing", () => {
  // The bridge repairs, then importMessages repairs again: a second pass has to change nothing.
  test("is idempotent", () => {
    const once = repairToolPairing(convert(corpus))
    expect(repairToolPairing(once)).toEqual(once)
  })

  // Prefix stability holds for a conversion that loses content consistently: so the content too.
  test("a real session round-trips with every tool result intact", () => {
    const blocks = toolResults(repairToolPairing(convert(corpus)))
    const expected = corpus.filter((m) => m.role === "toolResult")
    expect(blocks.map((b) => b.tool_use_id)).toEqual(expected.map((m) => m.toolCallId ?? ""))
    expect(blocks.filter((b) => String(b.content).includes("no tool result recorded"))).toEqual([])
  })

  test("passes through a paired tool_use/tool_result", () => {
    const messages: Array<SessionMessage> = [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "X", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ]
    expect(repairToolPairing(messages)).toHaveLength(2)
  })

  test("synthesizes a tool_result for an orphan tool_use", () => {
    const repaired = repairToolPairing([
      { role: "assistant", content: [{ type: "tool_use", id: "orphan", name: "X", input: {} }] },
      { role: "user", content: "next turn" },
    ])
    expect(repaired).toHaveLength(2)
    expect(repaired[1]?.role).toBe("user")
    expect(blocksOf(repaired.slice(1))[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "orphan",
      is_error: true,
    })
  })

  test("empty input returns empty", () => {
    expect(repairToolPairing([])).toEqual([])
  })
})
