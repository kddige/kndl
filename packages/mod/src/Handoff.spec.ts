import { describe, expect, test } from "bun:test"
import {
  handoffNote,
  historyAnswer,
  historyPath,
  historyRequest,
  historyText,
  historyToolName,
  historyToolSpec,
} from "./Handoff.ts"

const tool = "session_history"

describe("the handoff note", () => {
  test("frames the Hub's text as context for the next prompt, from the Harness before, and says where the left-out Turns are", () => {
    const note = handoffNote(
      {
        from: "Pi",
        text: "Turn #12, prompted by Ada Lovelace\nPrompt: add a health check",
        earlierBefore: 12,
      },
      tool,
    )
    expect(note).toStartWith("<context-handoff>\n")
    expect(note).toEndWith("\n</context-handoff>")
    expect(note).toContain("ran on another agent harness, pi,")
    expect(note).toContain("not a request of its own")
    expect(note).toContain("Turns before #12 were left out")
    expect(note).toContain("call session_history with before=12")
    expect(note).toContain("\n\nTurn #12, prompted by Ada Lovelace\nPrompt: add a health check\n")
  })

  test("names Claude Code, and the tool for any earlier Turn when none were left out", () => {
    const note = handoffNote({ from: "ClaudeCode", text: "Turn #1 …" }, historyToolName)
    expect(note).toContain("ran on another agent harness, Claude Code,")
    expect(note).not.toContain("left out")
    expect(note).toContain(`call ${historyToolName}`)
  })

  test("is nothing when there's nothing to hand over", () => {
    expect(handoffNote({ from: "Pi", text: " \n" }, tool)).toBeUndefined()
    expect(handoffNote({ from: "Pi", text: "", earlierBefore: 4 }, tool)).toContain("before=4")
  })
})

describe("the history tool", () => {
  test("is in the tool list from the first request, and says what a handoff is and when to read more", () => {
    expect(historyToolSpec).toMatchObject({ name: "session_history", isDeferred: false })
    expect(historyToolName).toBe("mcp__hub-link-commands__session_history")
    expect(historyToolSpec.description).toContain("handoff")
    expect(historyToolSpec.description).toContain("before")
    expect(Object.keys(historyToolSpec.inputSchema.properties)).toEqual(["before", "limit"])
    expect(historyToolSpec.inputSchema).not.toHaveProperty("required")
  })

  test("reads its arguments leniently, and refuses ones that aren't numbers", () => {
    expect(historyRequest({})).toEqual({ limit: 10 })
    expect(historyRequest({ before: 12, limit: 5 })).toEqual({ before: 12, limit: 5 })
    expect(historyRequest({ before: "12", limit: "500" })).toEqual({ before: 12, limit: 50 })
    expect(historyRequest({ limit: 0 })).toEqual({ limit: 1 })
    expect(historyRequest({ before: null })).toEqual({ limit: 10 })
    expect(historyRequest({ before: -1 })).toEqual({
      error: "`before` must be a Turn number, a whole number from 0 up.",
    })
    expect(historyRequest({ limit: "lots" })).toEqual({
      error: "`limit` must be a whole number of Turns.",
    })
  })

  test("asks the Hub for the Turns before one, or the latest", () => {
    expect(historyPath({ before: 12, limit: 5 })).toBe("/mod/history?before=12&limit=5")
    expect(historyPath({ limit: 10 })).toBe("/mod/history?limit=10")
  })
})

describe("the Session's history as the agent reads it", () => {
  const turns = [
    {
      seq: 3,
      by: "Ada Lovelace",
      prompt: "Add a health check.",
      tools: ["bash: curl localhost:8080/health", "edit: src/server.ts"],
      answer: "Added GET /health.",
      model: "openai/gpt-6-sol",
    },
    { seq: 4, by: "terminal", prompt: "thanks", tools: [], answer: "You're welcome." },
  ]

  test("each Turn with its number, who prompted it, its tools and its answer, oldest first; and where the earlier ones are", () => {
    expect(historyText({ turns, earlierBefore: 3 }, { limit: 2 }, tool)).toBe(
      [
        "Turn #3, prompted by Ada Lovelace, on openai/gpt-6-sol",
        "Prompt: Add a health check.",
        "Tools called:",
        "- bash: curl localhost:8080/health",
        "- edit: src/server.ts",
        "Answer: Added GET /health.",
        "",
        "Turn #4, prompted by terminal",
        "Prompt: thanks",
        "Answer: You're welcome.",
        "",
        "There are earlier Turns: call session_history with before=3 to read them.",
      ].join("\n"),
    )
  })

  test("says when it reached the Session's start, or found nothing", () => {
    expect(historyText({ turns }, { limit: 10 }, tool)).toEndWith(
      "\n\nThis is the start of the session: there are no earlier Turns.",
    )
    expect(historyText({ turns: [] }, { before: 1, limit: 10 }, tool)).toBe(
      "There are no Turns before #1.",
    )
    expect(historyText({ turns: [] }, { limit: 10 }, tool)).toBe("This session has no Turns yet.")
  })

  test("reads the Hub's answer, or says why there's none", () => {
    expect(historyAnswer(200, JSON.stringify({ turns: [turns[1]] }), { limit: 10 }, tool)).toEqual({
      text: expect.stringContaining("Turn #4"),
    })
    expect(
      historyAnswer(404, JSON.stringify({ error: "No such Session." }), { limit: 1 }, tool),
    ).toEqual({ error: "Could not read the session's history: No such Session." })
    expect(historyAnswer(502, "Bad Gateway", { limit: 1 }, tool)).toEqual({
      error: "Could not read the session's history: the Hub answered 502.",
    })
    expect(historyAnswer(200, "{}", { limit: 1 }, tool)).toEqual({
      error: "Could not read the session's history: the Hub's answer was not one.",
    })
  })
})
