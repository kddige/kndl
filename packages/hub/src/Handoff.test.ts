// The context handoff (ADR 0030) and the agent's history (`GET /mod/history`), built from a
// Session's log as plain data.

import { describe, expect, test } from "bun:test"
import {
  EventSeq,
  ParticipantId,
  type SessionEvent,
  type SessionLogEntry,
  TurnId,
} from "@kndl/protocol"
import { buildHandoff, HandoffBudget, historyPage, historyTurns } from "./Handoff.ts"

const ada = { id: ParticipantId.make("dev:ada"), login: "ada", name: "Ada" }

/** The log, numbered from `first`, a minute apart from 2026-10-18 09:00 UTC. */
const logOf = (events: ReadonlyArray<SessionEvent>, first = 0): Array<SessionLogEntry> =>
  events.map((event, i) => ({
    seq: EventSeq.make(first + i),
    at: Date.UTC(2026, 9, 18, 9, first + i),
    event,
  }))

/** A Turn's events: Ada's prompt, a tool call, the answer in two pieces, and its end. */
const turn = (id: string, prompt: string, answer: string): Array<SessionEvent> => [
  {
    _tag: "TurnStarted",
    turnId: TurnId.make(id),
    text: prompt,
    sender: { _tag: "FromParticipant", participant: ada },
  },
  {
    _tag: "ToolCallStarted",
    turnId: TurnId.make(id),
    toolCallId: `${id}-tool` as never,
    tool: "Bash",
    input: '{"command":"bun test"}',
  },
  {
    _tag: "ToolCallEnded",
    turnId: TurnId.make(id),
    toolCallId: `${id}-tool` as never,
    tool: "Bash",
    outcome: "Succeeded",
    output: "ok",
  },
  { _tag: "TextDelta", turnId: TurnId.make(id), text: answer.slice(0, 3) },
  { _tag: "TextDelta", turnId: TurnId.make(id), text: answer.slice(3) },
  {
    _tag: "TurnEnded",
    turnId: TurnId.make(id),
    reason: "stop",
    durationMs: 10,
    usage: {
      model: "claude-opus-5-5",
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
    },
  },
]

describe("a Session's Turns, as its agent reads them", () => {
  test("say who prompted and what, the tools called, the answer and the model, oldest first", () => {
    const log = logOf([
      ...turn("t-1", "Add a health check", "Added /health."),
      { _tag: "SessionStateChanged", state: "Asleep" },
      {
        _tag: "TurnStarted",
        turnId: TurnId.make("t-2"),
        text: "ls",
        sender: { _tag: "FromTerminal" },
      },
      // A subagent's work isn't the main loop's.
      { _tag: "TextDelta", turnId: TurnId.make("a-1"), agentId: "a-1" as never, text: "agent" },
      { _tag: "TextDelta", turnId: TurnId.make("t-2"), text: "README.md" },
      {
        _tag: "TurnEnded",
        turnId: TurnId.make("t-2"),
        reason: "error",
        durationMs: 1,
        errorMessage: "overloaded",
      },
    ])
    expect(historyTurns(log)).toEqual([
      {
        seq: 0,
        by: "Ada",
        prompt: "Add a health check",
        tools: ['Bash: {"command":"bun test"}'],
        answer: "Added /health.",
        model: "claude-opus-5-5",
      },
      { seq: 7, by: "the terminal", prompt: "ls", tools: [], answer: "README.md" },
    ])
  })

  test("keep a gap between what the agent said before a tool call and after it", () => {
    const id = TurnId.make("t-1")
    const log = logOf([
      {
        _tag: "TurnStarted",
        turnId: id,
        text: "Add a health check",
        sender: { _tag: "FromParticipant", participant: ada },
      },
      { _tag: "TextDelta", turnId: id, text: "Let me look " },
      { _tag: "TextDelta", turnId: id, text: "first." },
      {
        _tag: "ToolCallStarted",
        turnId: id,
        toolCallId: "t-1-tool" as never,
        tool: "Read",
        input: '{"path":"src/main.ts"}',
      },
      { _tag: "TextDelta", turnId: id, text: "Added /health." },
      { _tag: "TurnEnded", turnId: id, reason: "stop", durationMs: 1 },
    ])
    expect(historyTurns(log)[0]?.answer).toBe("Let me look first.\n\nAdded /health.")
    expect(buildHandoff({ entries: log })?.text).toContain(
      "Answer:\nLet me look first.\n\nAdded /health.",
    )
  })

  test("are clipped: a long prompt, answer or tool input says how much more there was", () => {
    const long = "x".repeat(10_000)
    const [only] = historyTurns(logOf(turn("t-1", long, long)))
    expect(only?.prompt.length).toBeLessThan(4_100)
    expect(only?.prompt).toEndWith("… (6000 more characters)")
    expect(only?.answer).toEndWith("… (6000 more characters)")
  })

  test("a page is the latest Turns before `before`, oldest first, and where the earlier ones start", () => {
    const log = logOf([
      ...turn("t-1", "one", "1"),
      ...turn("t-2", "two", "2"),
      ...turn("t-3", "three", "3"),
    ])
    expect(historyPage(log, { limit: 2 })).toEqual({
      turns: [
        expect.objectContaining({ seq: 6, prompt: "two" }),
        expect.objectContaining({ seq: 12, prompt: "three" }),
      ],
      earlierBefore: 6,
    })
    expect(historyPage(log, { before: EventSeq.make(6), limit: 2 })).toEqual({
      turns: [expect.objectContaining({ seq: 0, prompt: "one" })],
    })
    expect(historyPage(log, { before: EventSeq.make(0), limit: 2 })).toEqual({ turns: [] })
  })
})

describe("the context handoff", () => {
  test("tells each Turn and each model switch among them, oldest first, for the mod to frame", () => {
    const log = logOf(
      [
        ...turn("t-1", "Add a health check", "Added /health."),
        {
          _tag: "ModelSwitched",
          by: ada,
          model: "openai/gpt-6-sol",
          modelLabel: "GPT-6-Sol",
          harness: "Pi",
        },
      ],
      3,
    )
    expect(buildHandoff({ entries: log })).toEqual({
      text: [
        "## Turn 3, 2026-10-18 09:03 UTC: Ada prompted",
        "Add a health check",
        "",
        "Tools called:",
        '- Bash: {"command":"bun test"}',
        "",
        "Answer (claude-opus-5-5):",
        "Added /health.",
        "",
        "## 2026-10-18 09:09 UTC: Ada switched the model to GPT-6-Sol, on pi.",
      ].join("\n"),
    })
  })

  test("says how a Turn ended other than with an answer", () => {
    const log = logOf([
      {
        _tag: "TurnStarted",
        turnId: TurnId.make("t-1"),
        text: "go",
        sender: { _tag: "FromTerminal" },
      },
      { _tag: "TurnEnded", turnId: TurnId.make("t-1"), reason: "aborted", durationMs: 1 },
      {
        _tag: "TurnStarted",
        turnId: TurnId.make("t-2"),
        text: "again",
        sender: { _tag: "FromTerminal" },
      },
      {
        _tag: "TurnEnded",
        turnId: TurnId.make("t-2"),
        reason: "error",
        durationMs: 1,
        errorMessage: "overloaded",
      },
      {
        _tag: "TurnStarted",
        turnId: TurnId.make("t-3"),
        text: "once more",
        sender: { _tag: "FromTerminal" },
      },
    ])
    expect(buildHandoff({ entries: log })?.text).toBe(
      [
        "## Turn 0, 2026-10-18 09:00 UTC: someone at the terminal prompted",
        "go",
        "",
        "It was stopped before it answered.",
        "",
        "## Turn 2, 2026-10-18 09:02 UTC: someone at the terminal prompted",
        "again",
        "",
        "It ended in an error: overloaded",
        "",
        "## Turn 4, 2026-10-18 09:04 UTC: someone at the terminal prompted",
        "once more",
        "",
        "It hadn't ended.",
      ].join("\n"),
    )
  })

  test("is nothing without a Turn to hand over", () => {
    const log = logOf([
      { _tag: "ModelSwitched", by: ada, model: "opus", harness: "ClaudeCode" },
      { _tag: "SessionStateChanged", state: "Active" },
    ])
    expect(buildHandoff({ entries: log })).toBeUndefined()
    expect(buildHandoff({ entries: [] })).toBeUndefined()
  })

  test("keeps the newest Turns that fit its budget, and says where the earlier ones start", () => {
    const answer = "y".repeat(3_000)
    const log = logOf(
      Array.from({ length: 40 }, (_, i) => turn(`t-${i}`, `prompt ${i}`, answer)).flat(),
    )
    const handoff = buildHandoff({ entries: log })
    expect(handoff?.text.length).toBeLessThanOrEqual(HandoffBudget)
    expect(handoff?.text.length).toBeGreaterThan(HandoffBudget - 4_000)
    const kept = [...(handoff?.text ?? "").matchAll(/## Turn (\d+),/g)].map((m) => Number(m[1]))
    // The newest, oldest first, up to the last.
    expect(kept.at(-1)).toBe(39 * 6)
    expect(kept).toEqual(kept.toSorted((a, b) => a - b))
    // What `GET /mod/history?before=` takes to read the Turns left out.
    expect(handoff?.earlierBefore as number | undefined).toBe(kept[0])
    expect(historyPage(log, { before: handoff?.earlierBefore, limit: 50 }).turns.at(-1)?.seq).toBe(
      defined(kept[0]) - 6,
    )
  })
})

function defined<T>(value: T | undefined): T {
  expect(value).toBeDefined()
  return value as T
}
