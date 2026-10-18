import { describe, expect, test } from "bun:test"
import { ModEvent } from "@kndl/protocol"
import { Schema } from "effect"
import { toolResultSummary, turnEndReason, Turns, turnUsage } from "./Turns.ts"
import type { AssistantEnd } from "./Turns.ts"

const ada = { id: "p1", login: "ada", name: "Ada Lovelace" }

const assistant = (overrides: Partial<AssistantEnd> = {}): AssistantEnd => ({
  provider: "openai",
  model: "gpt-test",
  stopReason: "stop",
  usage: {
    input: 100,
    output: 20,
    cacheRead: 50,
    cacheWrite: 0,
    cost: { total: 0.001 },
  },
  ...overrides,
})

/** A tracker over a clock that moves 10 ms a reading, with Turn ids t1, t2, ... */
const tracker = () => {
  const events: Array<Record<string, unknown>> = []
  let clock = 1_000
  let ids = 0
  const turns = new Turns({
    report: (event) => events.push(event),
    now: () => (clock += 10),
    newId: () => `t${++ids}`,
  })
  return { turns, events }
}

/** Every event decodes as the protocol has it. */
const valid = (events: ReadonlyArray<unknown>) =>
  events.every((event) =>
    Schema.is(Schema.toType(ModEvent))(Schema.decodeUnknownSync(ModEvent)(event)),
  )

describe("a pi run is a Turn: from the prompt to the run settling", () => {
  test("a prompt delivered from the Hub starts a Turn from its sender, with its promptId", () => {
    const { turns, events } = tracker()
    turns.deliver({ promptId: "q1", sender: ada, text: "[Ada Lovelace] hi" })
    turns.input("[Ada Lovelace] hi", "extension")
    expect(turns.beforeAgentStart("[Ada Lovelace] hi")?.promptId).toBe("q1")
    turns.agentStart()
    turns.textDelta("Hel")
    turns.textDelta("lo")
    turns.assistantEnded(assistant())
    turns.settled(false)
    expect(events).toEqual([
      {
        _tag: "TurnStarted",
        turnId: "t1",
        text: "[Ada Lovelace] hi",
        sender: { _tag: "FromParticipant", participant: ada },
        promptId: "q1",
      },
      { _tag: "TextDelta", turnId: "t1", text: "Hel" },
      { _tag: "TextDelta", turnId: "t1", text: "lo" },
      {
        _tag: "TurnEnded",
        turnId: "t1",
        reason: "stop",
        durationMs: 10,
        usage: {
          model: "openai/gpt-test",
          input: 100,
          output: 20,
          cacheRead: 50,
          cacheWrite: 0,
          cost: 0.001,
        },
      },
    ])
    expect(valid(events)).toBe(true)
  })

  test("a prompt typed at the terminal starts a Turn from the terminal", () => {
    const { turns, events } = tracker()
    turns.deliver({ promptId: "q1", sender: ada, text: "[Ada Lovelace] hi" })
    turns.input("what is this repo?", "interactive")
    expect(turns.beforeAgentStart("what is this repo?")).toBeUndefined()
    turns.agentStart()
    expect(events[0]).toEqual({
      _tag: "TurnStarted",
      turnId: "t1",
      text: "what is this repo?",
      sender: { _tag: "FromTerminal" },
    })
  })

  test("a run another extension starts with a message of its own starts a Turn with no prompt", () => {
    const { turns, events } = tracker()
    turns.beforeAgentStart(undefined)
    turns.agentStart()
    expect(events[0]).toEqual({
      _tag: "TurnStarted",
      turnId: "t1",
      text: "",
      sender: { _tag: "FromTerminal" },
    })
  })

  test("pi's retries and continuations within one run stay one Turn, its usage summed", () => {
    const { turns, events } = tracker()
    turns.beforeAgentStart("go")
    turns.agentStart()
    turns.assistantEnded(assistant({ stopReason: "toolUse" }))
    turns.assistantEnded(assistant({ stopReason: "error" }))
    // pi retries after agent_end, with a new agent_start, before it settles.
    turns.agentStart()
    turns.assistantEnded(
      assistant({
        provider: "xai",
        model: "grok-test",
        usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.5 } },
      }),
    )
    turns.settled(false)
    expect(events.filter((event) => event._tag === "TurnStarted")).toHaveLength(1)
    expect(events.at(-1)).toEqual({
      _tag: "TurnEnded",
      turnId: "t1",
      reason: "stop",
      durationMs: 10,
      usage: {
        model: "xai/grok-test",
        input: 201,
        output: 42,
        cacheRead: 103,
        cacheWrite: 4,
        cost: 0.502,
      },
    })
    expect(valid(events)).toBe(true)
  })

  test("a settle with no run started ends nothing", () => {
    const { turns, events } = tracker()
    turns.settled(false)
    expect(events).toEqual([])
  })

  test("the next run is a new Turn, and the delivered prompt is claimed once", () => {
    const { turns, events } = tracker()
    turns.deliver({ promptId: "q1", sender: ada, text: "[Ada Lovelace] hi" })
    turns.input("[Ada Lovelace] hi", "extension")
    turns.beforeAgentStart("[Ada Lovelace] hi")
    turns.agentStart()
    turns.settled(false)
    turns.input("[Ada Lovelace] hi", "extension")
    turns.beforeAgentStart("[Ada Lovelace] hi")
    turns.agentStart()
    const started = events.filter((event) => event._tag === "TurnStarted")
    expect(started.map((event) => [event.turnId, event.promptId])).toEqual([
      ["t1", "q1"],
      ["t2", undefined],
    ])
  })
})

describe("tool calls", () => {
  test("are reported with their input, and their result as the model reads it, clipped", () => {
    const { turns, events } = tracker()
    turns.beforeAgentStart("go")
    turns.agentStart()
    turns.toolStarted("c1", "bash", { command: "ls" })
    turns.toolEnded("c1", "bash", { content: [{ type: "text", text: "a\nb" }] }, false)
    turns.toolStarted("c2", "attachment", { id: "att-1" })
    turns.toolEnded(
      "c2",
      "attachment",
      {
        content: [
          { type: "text", text: "shot.png" },
          { type: "image", data: "aGk=", mimeType: "image/png" },
        ],
      },
      false,
    )
    turns.toolStarted("c3", "read", { path: "x".repeat(5_000) })
    turns.toolEnded("c3", "read", { content: [{ type: "text", text: "ENOENT" }] }, true)
    expect(events.slice(1)).toEqual([
      {
        _tag: "ToolCallStarted",
        turnId: "t1",
        toolCallId: "c1",
        tool: "bash",
        input: '{"command":"ls"}',
      },
      {
        _tag: "ToolCallEnded",
        turnId: "t1",
        toolCallId: "c1",
        tool: "bash",
        outcome: "Succeeded",
        output: "a\nb",
      },
      {
        _tag: "ToolCallStarted",
        turnId: "t1",
        toolCallId: "c2",
        tool: "attachment",
        input: '{"id":"att-1"}',
      },
      {
        _tag: "ToolCallEnded",
        turnId: "t1",
        toolCallId: "c2",
        tool: "attachment",
        outcome: "Succeeded",
        output: "shot.png\n[image/png]",
      },
      expect.objectContaining({ _tag: "ToolCallStarted", toolCallId: "c3" }),
      expect.objectContaining({ _tag: "ToolCallEnded", toolCallId: "c3", outcome: "Failed" }),
    ])
    expect(String(events[5]?.input).length).toBeLessThanOrEqual(4_000)
    expect(valid(events)).toBe(true)
  })

  test("outside a Turn, or made by another tool, are not reported", () => {
    const { turns, events } = tracker()
    turns.toolStarted("c1", "bash", { command: "ls" })
    turns.toolEnded("c1", "bash", { content: [] }, false)
    turns.beforeAgentStart("go")
    turns.agentStart()
    turns.toolStarted("c2/1", "read", {}, "c2")
    turns.toolEnded("c2/1", "read", { content: [] }, false, "c2")
    expect(events.map((event) => event._tag)).toEqual(["TurnStarted"])
  })
})

describe("steering (ADR 0018)", () => {
  test("a steered prompt joins the running Turn, and is read at the run's next request", () => {
    const { turns, events } = tracker()
    turns.beforeAgentStart("go")
    turns.agentStart()
    expect(turns.steered({ promptId: "q2", sender: ada, text: "and this" })).toBe(true)
    turns.steeredMessageStarted("q2")
    turns.steeredMessageStarted("q2")
    expect(events.slice(1)).toEqual([
      { _tag: "PromptSteered", turnId: "t1", promptId: "q2", text: "and this", sender: ada },
      { _tag: "SteeredPromptRead", turnId: "t1", promptId: "q2" },
    ])
    expect(valid(events)).toBe(true)
  })

  test("with no Turn running, it can't join one", () => {
    const { turns, events } = tracker()
    expect(turns.steered({ promptId: "q2", sender: ada, text: "and this" })).toBe(false)
    expect(events).toEqual([])
  })

  test("one the Turn ended before reading stays unread", () => {
    const { turns, events } = tracker()
    turns.beforeAgentStart("go")
    turns.agentStart()
    turns.steered({ promptId: "q2", sender: ada, text: "and this" })
    turns.settled(true)
    turns.beforeAgentStart("next")
    turns.agentStart()
    turns.steeredMessageStarted("q2")
    expect(events.map((event) => event._tag)).not.toContain("SteeredPromptRead")
  })
})

describe("how a Turn ends", () => {
  test("pi-ai's stop reason, as the protocol names it", () => {
    expect(turnEndReason(false, "stop")).toBe("stop")
    expect(turnEndReason(false, "length")).toBe("length")
    expect(turnEndReason(false, "error")).toBe("error")
    expect(turnEndReason(false, "aborted")).toBe("aborted")
    // A tool asked the run to stop after its call; or a deferred response ended it.
    expect(turnEndReason(false, "toolUse")).toBe("stop")
    expect(turnEndReason(false, "deferred")).toBe("stop")
    // Stopped, whatever the last request said.
    expect(turnEndReason(true, "stop")).toBe("aborted")
    // A run with no request is an error, unless it was stopped.
    expect(turnEndReason(false, undefined)).toBe("error")
    expect(turnEndReason(true, undefined)).toBe("aborted")
  })

  test("a stopped Turn says so, and has no usage when no request counted", () => {
    const { turns, events } = tracker()
    turns.beforeAgentStart("go")
    turns.agentStart()
    turns.assistantEnded(
      assistant({
        stopReason: "aborted",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
      }),
    )
    turns.settled(true)
    expect(events.at(-1)).toEqual({
      _tag: "TurnEnded",
      turnId: "t1",
      reason: "aborted",
      durationMs: 10,
    })
  })

  test("usage leaves the cost out when pi reports none", () => {
    expect(
      turnUsage([
        assistant({
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
        }),
      ]),
    ).toEqual({ model: "openai/gpt-test", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })
    expect(turnUsage([])).toBeUndefined()
  })
})

test("a tool's result as the web shows it: its text, and a note of each image, never its bytes", () => {
  expect(
    toolResultSummary({
      content: [
        { type: "text", text: "one" },
        { type: "image", data: "AAAA", mimeType: "image/jpeg" },
      ],
    }),
  ).toBe("one\n[image/jpeg]")
  expect(toolResultSummary({ content: [] })).toBe("")
  expect(toolResultSummary(undefined)).toBe("")
  expect(toolResultSummary("plain")).toBe("plain")
})
