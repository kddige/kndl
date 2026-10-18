import { describe, expect, test } from "bun:test"
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent"
import { handoffMessage, historyToolDefinition, registerHistory, renderHandoff } from "./History.ts"

const turns = {
  turns: [{ seq: 4, by: "Ada Lovelace", prompt: "Add a server.", tools: [], answer: "Added it." }],
  earlierBefore: 4,
}

const run = (tool: ReturnType<typeof historyToolDefinition>, params: Record<string, unknown>) =>
  tool.execute("call-1", params as never, undefined, undefined, undefined as never)

describe("the history tool (ADR 0030)", () => {
  test("reads the Turns before one from the Hub, as text", async () => {
    const asked: Array<string> = []
    const tool = historyToolDefinition({
      fetchHistory: async (path) => {
        asked.push(path)
        return { status: 200, text: JSON.stringify(turns) }
      },
    })
    expect(tool.name).toBe("session_history")
    expect(tool.description).toContain("<context-handoff>")

    const result = await run(tool, { before: 9, limit: 3 })

    expect(asked).toEqual(["/mod/history?before=9&limit=3"])
    expect(result.content).toEqual([
      {
        type: "text",
        text: [
          "Turn #4, prompted by Ada Lovelace",
          "Prompt: Add a server.",
          "Answer: Added it.",
          "",
          "There are earlier Turns: call session_history with before=4 to read them.",
        ].join("\n"),
      },
    ])
  })

  test("fails the call, saying why, when the Hub can't answer", async () => {
    const tool = historyToolDefinition({
      fetchHistory: async () => ({ status: 403, text: JSON.stringify({ error: "Forbidden." }) }),
    })
    await expect(run(tool, {})).rejects.toThrow("Could not read the session's history: Forbidden.")
    const offline = historyToolDefinition({
      fetchHistory: async () => {
        throw new Error("connection refused")
      },
    })
    await expect(run(offline, {})).rejects.toThrow(
      "Could not read the session's history: Error: connection refused",
    )
  })
})

/** A pi that keeps what the extension gives it. */
const fakePi = () => {
  const sent: Array<{ message: unknown; options: unknown }> = []
  const renderers = new Map<string, unknown>()
  const tools: Array<string> = []
  const pi = {
    sendMessage: (message: unknown, options: unknown) => sent.push({ message, options }),
    registerMessageRenderer: (type: string, renderer: unknown) => renderers.set(type, renderer),
    registerTool: (tool: { name: string }) => tools.push(tool.name),
  } as unknown as ExtensionAPI
  return { pi, sent, renderers, tools }
}

describe("a context handoff (ADR 0030)", () => {
  test("is a custom message pi puts in the conversation now, for the next request, and starts no run", () => {
    const { pi, sent, renderers, tools } = fakePi()
    const history = registerHistory(pi, { fetchHistory: async () => ({ status: 404, text: "" }) })
    expect(tools).toEqual(["session_history"])
    expect(renderers.get(handoffMessage)).toBe(renderHandoff)

    history.deliver({
      _tag: "DeliverHandoff",
      sessionId: "s1" as never,
      from: "ClaudeCode",
      text: "Turn #7, prompted by Ada Lovelace\nPrompt: hi\nAnswer: Hello.",
      earlierBefore: 7,
    })
    history.deliver({ _tag: "DeliverHandoff", sessionId: "s1" as never, from: "Pi", text: "" })

    expect(sent).toEqual([
      {
        message: {
          customType: handoffMessage,
          content: expect.stringContaining("\n\nTurn #7, prompted by Ada Lovelace\n"),
          display: true,
          details: { from: "ClaudeCode", earlierBefore: 7 },
        },
        // No options: while pi is idle it is added at once, with no run; during one, at its end.
        options: undefined,
      },
    ])
    expect((sent[0]?.message as { content: string } | undefined)?.content).toContain(
      "call session_history with before=7",
    )
  })

  test("is drawn as one line in pi's terminal, and in full when expanded", () => {
    const theme = { fg: (_: string, text: string) => text } as unknown as Theme
    const message = {
      role: "custom" as const,
      customType: handoffMessage,
      content:
        "<context-handoff>\nUntil now this session ran on another agent harness …\n\nTurn #7",
      display: true,
      details: { from: "ClaudeCode" as const, earlierBefore: 7 },
      timestamp: 0,
    }

    const collapsed = renderHandoff(message, { expanded: false, outputPad: 1 }, theme)
    const expanded = renderHandoff(message, { expanded: true, outputPad: 1 }, theme)

    expect(collapsed?.render(60)).toEqual([
      " kndl: context handoff from Claude Code, for the next promp…",
    ])
    expect(collapsed?.render(200)).toEqual([
      " kndl: context handoff from Claude Code, for the next prompt (Turns before #7 left out)",
    ])
    expect(expanded?.render(60)).toEqual([
      " kndl: context handoff from Claude Code, for the next promp…",
      " <context-handoff>",
      " Until now this session ran on another agent harness …",
      "",
      " Turn #7",
    ])
  })
})
