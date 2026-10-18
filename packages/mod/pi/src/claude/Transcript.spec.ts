// pi's transcript read back as a prompt and tools, with sections in pi's builder's order, so the
// replayed prompt is byte for byte the key its capture was recorded under. Ported from
// pi-claude-bridge 0.9.3's tests (unit-transcript-replay-order).

import { describe, expect, test } from "bun:test"
import type { Context, Message, SystemMessage, Tool } from "@earendil-works/pi-ai"
import { toBridgeContext } from "./Transcript.ts"

const system = (overrides: Partial<SystemMessage>): SystemMessage => ({
  role: "system",
  content: "",
  timestamp: 0,
  ...overrides,
})

const user = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: 0,
})

const tool = (name: string) => ({ name, description: "", parameters: {} }) as unknown as Tool

const replayedSystemPrompt = (messages: Array<Message>) =>
  toBridgeContext({ messages }).systemPrompt

describe("toBridgeContext's section order", () => {
  test("renders sections in pi's order after a section is removed and added again", () => {
    // Skills goes when read and bash are disabled for a turn, and comes back at the map's end.
    const messages = [
      system({ toolsAdded: [tool("read")] }),
      system({ sections: { preamble: "P", tools: "T", rules: "R", docs: "D", cwd: "/w" } }),
      system({ sections: { skills: null } }),
      system({ sections: { skills: "S", cwd: "/w" } }),
      user("go"),
    ]
    expect(replayedSystemPrompt(messages)).toBe(["P", "T", "R", "D", "S", "/w"].join("\n\n"))
  })

  test("puts a section pi doesn't rank after cwd", () => {
    const messages = [
      system({ toolsAdded: [tool("read")] }),
      system({
        sections: { preamble: "P", tools: "T", rules: "R", docs: "D", environment: "E", cwd: "/w" },
      }),
      user("go"),
    ]
    expect(replayedSystemPrompt(messages)).toBe(["P", "T", "R", "D", "/w", "E"].join("\n\n"))
  })

  test("puts a custom section added late after cwd, as pi's builder does", () => {
    const messages = [
      system({ toolsAdded: [tool("read")] }),
      system({
        sections: {
          preamble: "P",
          tools: "T",
          rules: "R",
          docs: "D",
          project_context: "C",
          skills: "S",
          cwd: "/w",
        },
      }),
      system({ sections: { addendum: "A", mcp_servers: "M" } }),
      user("go"),
    ]
    expect(replayedSystemPrompt(messages)).toBe(
      ["P", "T", "R", "D", "A", "C", "S", "/w", "M"].join("\n\n"),
    )
  })

  test("keeps a custom section after the built-ins", () => {
    const messages = [
      system({ toolsAdded: [tool("read")] }),
      system({ sections: { preamble: "P", tools: "T", cwd: "/w", kndl_shared_session: "X" } }),
      user("go"),
    ]
    expect(replayedSystemPrompt(messages)).toBe(["P", "T", "/w", "X"].join("\n\n"))
  })

  test("renders a session's first system message as it is", () => {
    const messages = [
      system({
        sections: { preamble: "P", tools: "T", rules: "R", docs: "D", skills: "S", cwd: "/w" },
      }),
      user("go"),
    ]
    expect(replayedSystemPrompt(messages)).toBe(["P", "T", "R", "D", "S", "/w"].join("\n\n"))
  })

  test("joins content given as text blocks as it does a string", () => {
    const messages = [
      system({
        content: [
          { type: "text", text: "A" },
          { type: "text", text: "B" },
        ],
      }),
      system({ sections: { cwd: "/w" } }),
      user("go"),
    ]
    expect(replayedSystemPrompt(messages)).toBe(["A\nB", "/w"].join("\n\n"))
  })

  test("works out the tools through removals and additions", () => {
    const grep = tool("grep")
    const read = tool("read")
    const context = toBridgeContext({
      messages: [
        system({ toolsAdded: [read, grep] }),
        system({ toolsRemoved: [{ name: "read" }] }),
        system({ toolsAdded: [read] }),
        user("go"),
      ],
    })
    expect(context.tools).toEqual([grep, read])
    expect(context.messages.map((message) => message.role)).toEqual(["user"])
  })

  test("returns a context with no system messages as it is", () => {
    const context: Context = { messages: [user("go")], systemPrompt: "P", tools: [] }
    expect(toBridgeContext(context)).toBe(context)
  })
})
