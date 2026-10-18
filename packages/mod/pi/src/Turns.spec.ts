import { describe, expect, test } from "bun:test"
import { ModEvent, providerModelName } from "@kndl/protocol"
import { Schema } from "effect"
import {
  modelName,
  toolResultSummary,
  turnEndReason,
  turnErrorMessageLength,
  Turns,
  turnUsage,
} from "./Turns.ts"
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

  test("a run an agent's result starts is a Turn from that agent, with the result as its prompt", () => {
    const { turns, events } = tracker()
    const result = { agentId: "a1", text: "<task-notification>done</task-notification>" }
    turns.beforeAgentStart(undefined, result)
    turns.agentStart()
    turns.assistantEnded(assistant())
    turns.settled(false)
    expect(events.map((event) => [event._tag, event.turnId])).toEqual([
      ["TurnStarted", "t1"],
      ["TurnEnded", "t1"],
    ])
    expect(events[0]).toEqual({
      _tag: "TurnStarted",
      turnId: "t1",
      text: "<task-notification>done</task-notification>",
      sender: { _tag: "FromAgent", agentId: "a1" },
    })
    expect(valid(events)).toBe(true)
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

  test("a Turn that ends in an error says why, as the Provider said", () => {
    const { turns, events } = tracker()
    turns.beforeAgentStart("go")
    turns.agentStart()
    turns.assistantEnded(
      assistant({
        stopReason: "error",
        errorMessage: "429 You exceeded your current quota.",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    )
    turns.settled(false)
    expect(events.at(-1)).toEqual({
      _tag: "TurnEnded",
      turnId: "t1",
      reason: "error",
      durationMs: 10,
      errorMessage: "429 You exceeded your current quota.",
    })
    expect(valid(events)).toBe(true)
  })

  test("only its last request's error counts, and only when the Turn ends in one", () => {
    const { turns, events } = tracker()
    turns.beforeAgentStart("go")
    turns.agentStart()
    // pi retried, and the retry answered.
    turns.assistantEnded(assistant({ stopReason: "error", errorMessage: "503 overloaded" }))
    turns.assistantEnded(assistant())
    turns.settled(false)
    expect(events.at(-1)).not.toHaveProperty("errorMessage")
    // Stopped while a request failed: it was stopped, not an error.
    turns.beforeAgentStart("again")
    turns.agentStart()
    turns.assistantEnded(assistant({ stopReason: "error", errorMessage: "socket closed" }))
    turns.settled(true)
    expect(events.at(-1)).toMatchObject({ reason: "aborted" })
    expect(events.at(-1)).not.toHaveProperty("errorMessage")
  })

  test("the error is clipped, and has no secrets in it", () => {
    const events: Array<Record<string, unknown>> = []
    const turns = new Turns({
      report: (event) => events.push(event),
      now: () => 0,
      newId: () => "t1",
      secrets: ["tok-session$1"],
    })
    turns.beforeAgentStart("go")
    turns.agentStart()
    turns.assistantEnded(
      assistant({
        stopReason: "error",
        errorMessage:
          "401 Incorrect API key provided: tok-session$1. Sent Authorization: Bearer abc.def-123, " +
          `key sk-proj-AbCdEf0123456789xyz and AIzaSyA0123456789abcdefghijklmnop. ${"x".repeat(2_000)}`,
      }),
    )
    turns.settled(false)
    const message = String(events.at(-1)?.errorMessage)
    expect(message).toStartWith(
      "401 Incorrect API key provided: [redacted]. Sent Authorization: Bearer [redacted], " +
        "key [redacted] and [redacted]. xxx",
    )
    expect(message).not.toContain("tok-session")
    expect(message.length).toBeLessThanOrEqual(turnErrorMessageLength)
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

  // As the Session's model is named (the protocol's providerModelName): the web compares them.
  test("usage names the model as <provider>/<id>, an id's own slashes kept", () => {
    expect(
      turnUsage([assistant({ provider: "openrouter", model: "anthropic/claude-sonnet-4" })])?.model,
    ).toBe("openrouter/anthropic/claude-sonnet-4")
    expect(modelName({ provider: "anthropic", id: "claude-haiku-5-5" })).toBe(
      providerModelName({ provider: "anthropic", id: "claude-haiku-5-5" }),
    )
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

describe("a subagent's runs (ADR 0014)", () => {
  test("carry its agentId, each a run of its own with no start, and end on their own", () => {
    const events: Array<Record<string, unknown>> = []
    let ids = 0
    const turns = new Turns({
      report: (event) => events.push(event),
      now: () => 1_000,
      newId: () => `r${++ids}`,
      agentId: "agent-1",
    })
    turns.agentStart()
    turns.textDelta("Looking.")
    turns.toolStarted("c1", "read", { path: "a.ts" })
    turns.toolEnded("c1", "read", { content: [{ type: "text", text: "x" }] }, false)
    turns.assistantEnded(assistant())
    turns.settled(false)
    turns.agentStart()
    turns.settled(true)
    expect(events).toEqual([
      { _tag: "TextDelta", turnId: "r1", agentId: "agent-1", text: "Looking." },
      {
        _tag: "ToolCallStarted",
        turnId: "r1",
        agentId: "agent-1",
        toolCallId: "c1",
        tool: "read",
        input: '{"path":"a.ts"}',
      },
      {
        _tag: "ToolCallEnded",
        turnId: "r1",
        agentId: "agent-1",
        toolCallId: "c1",
        tool: "read",
        outcome: "Succeeded",
        output: "x",
      },
      expect.objectContaining({ _tag: "TurnEnded", turnId: "r1", agentId: "agent-1" }),
      { _tag: "TurnEnded", turnId: "r2", agentId: "agent-1", reason: "aborted", durationMs: 0 },
    ])
    expect(valid(events)).toBe(true)
  })
})
