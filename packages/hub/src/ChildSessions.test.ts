// What a Parent Session's model reads of its Child Sessions: Reports found in a Turn, and a
// child's conversation as text.

import { describe, expect, test } from "bun:test"
import { AgentId, type SessionEvent, type SessionLogEntry, TurnId } from "@claude-hub/protocol"
import { conversationText, finalMessage, MaxConversationLength } from "./ChildSessions.ts"

const turnId = TurnId.make("t-1")
const subagent = AgentId.make("agent-1")

const entries = (...events: ReadonlyArray<SessionEvent>): Array<SessionLogEntry> =>
  events.map((event, index) => ({ seq: index + 1, at: index, event }) as SessionLogEntry)

describe("a Turn's final message", () => {
  test("is the main loop's text after its last tool call, with who prompted it", () => {
    const turn = entries(
      { _tag: "TurnStarted", turnId, text: "go", sender: { _tag: "FromTerminal" } },
      { _tag: "TextDelta", turnId, text: "Looking first." },
      { _tag: "ToolCallStarted", turnId, toolCallId: "c", tool: "Bash", input: "ls" } as never,
      { _tag: "TextDelta", turnId, text: "Done: " },
      { _tag: "TextDelta", turnId, agentId: subagent, text: "a subagent's words" },
      { _tag: "TextDelta", turnId, text: "all green. " },
      { _tag: "TurnEnded", turnId, reason: "Answered", durationMs: 1 },
    )
    expect(finalMessage(turn)).toEqual({
      text: "Done: all green.",
      sender: { _tag: "FromTerminal" },
    })
  })

  test("says why when there is none", () => {
    const turn = entries(
      { _tag: "TurnStarted", turnId, text: "go", sender: { _tag: "FromTerminal" } },
      { _tag: "TurnEnded", turnId, reason: "Failed", durationMs: 1 },
    )
    expect(finalMessage(turn).text).toBe(
      "(An API error ended the Child Session's Turn before it wrote a final message.)",
    )
  })
})

describe("a Child Session's conversation", () => {
  test("is empty until something happens", () => {
    expect(conversationText([])).toBe("(Nothing has happened in it yet.)")
  })

  test("keeps its latest part when it is long", () => {
    const long = "x".repeat(MaxConversationLength)
    const text = conversationText(
      entries(
        { _tag: "TurnStarted", turnId, text: "first", sender: { _tag: "FromTerminal" } },
        { _tag: "TextDelta", turnId, text: long },
        { _tag: "TurnEnded", turnId, reason: "Answered", durationMs: 1 },
      ),
    )
    expect(text).toStartWith("(Earlier conversation left out.)\n\n")
    expect(text).toEndWith("[Turn ended: Answered]")
    expect(text).not.toContain("first")
  })
})
