import { describe, expect, test } from "bun:test"
import {
  buildTranscript,
  displayPrompt,
  prettyInput,
  runningTurn,
  type TranscriptItem,
  toolSummary,
  type TurnView,
} from "../src/hub/transcript.ts"
import { alice, bob, entries, fromAlice, fromBob } from "./fixtures.ts"

const usage = {
  model: "claude-opus-5-5",
  inputTokens: 10,
  outputTokens: 5,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
}

function turns(items: ReadonlyArray<TranscriptItem>): ReadonlyArray<TurnView> {
  return items.flatMap((item) => (item.kind === "turn" ? [item.turn] : []))
}

describe("buildTranscript", () => {
  test("a Turn shows its sender, its prompt and the streamed text merged", () => {
    const items = buildTranscript(
      entries([
        {
          _tag: "TurnStarted",
          turnId: "t-1",
          text: "[Alice] add a test",
          sender: fromAlice,
          promptId: "p-1",
        },
        { _tag: "TextDelta", turnId: "t-1", text: "Sure, " },
        { _tag: "TextDelta", turnId: "t-1", text: "adding it." },
        { _tag: "TurnEnded", turnId: "t-1", reason: "Answered", durationMs: 900, usage },
      ]),
    )
    expect(items).toHaveLength(1)
    const [turn] = turns(items)
    expect(turn?.sender).toEqual(fromAlice as never)
    expect(turn?.prompt).toBe("add a test")
    expect(turn?.promptId).toBe("p-1" as never)
    expect(turn?.blocks).toEqual([{ kind: "text", key: "text-1", text: "Sure, adding it." }])
    expect(turn?.end?.reason).toBe("Answered")
    expect(turn?.end?.usage?.outputTokens).toBe(5)
  })

  test("a tool call's start and end are one block; text either side stays separate", () => {
    const [turn] = turns(
      buildTranscript(
        entries([
          { _tag: "TurnStarted", turnId: "t-1", text: "go", sender: { _tag: "FromTerminal" } },
          { _tag: "TextDelta", turnId: "t-1", text: "Looking." },
          {
            _tag: "ToolCallStarted",
            turnId: "t-1",
            toolCallId: "c-1",
            tool: "Bash",
            input: '{"command":"ls"}',
          },
          {
            _tag: "ToolCallStarted",
            turnId: "t-1",
            toolCallId: "c-2",
            tool: "Read",
            input: '{"file_path":"a.ts"}',
          },
          {
            _tag: "ToolCallEnded",
            turnId: "t-1",
            toolCallId: "c-1",
            tool: "Bash",
            outcome: "Succeeded",
            output: "a.ts",
          },
          { _tag: "TextDelta", turnId: "t-1", text: "Done." },
        ]),
      ),
    )
    expect(turn?.blocks.map((block) => block.kind)).toEqual(["text", "tool", "tool", "text"])
    const [, bash, read] = turn?.blocks ?? []
    expect(bash).toMatchObject({
      kind: "tool",
      call: { tool: "Bash", input: '{"command":"ls"}', outcome: "Succeeded", output: "a.ts" },
    })
    // Still running: no outcome yet.
    expect(read?.kind === "tool" && read.call.outcome).toBeUndefined()
    expect(turn?.end).toBeNull()
  })

  test("a subagent's events are grouped under its agentId, where it first spoke", () => {
    const [turn] = turns(
      buildTranscript(
        entries([
          { _tag: "TurnStarted", turnId: "t-1", text: "research", sender: fromAlice },
          { _tag: "TextDelta", turnId: "t-1", text: "Asking a subagent." },
          { _tag: "TextDelta", turnId: "t-1", agentId: "a-1", text: "Searching" },
          { _tag: "TextDelta", turnId: "t-1", text: "Meanwhile…" },
          {
            _tag: "ToolCallStarted",
            turnId: "t-1",
            agentId: "a-1",
            toolCallId: "c-1",
            tool: "Grep",
            input: '{"pattern":"foo"}',
          },
          {
            _tag: "ToolCallEnded",
            turnId: "t-1",
            agentId: "a-1",
            toolCallId: "c-1",
            tool: "Grep",
            outcome: "Failed",
            output: "boom",
          },
          { _tag: "TextDelta", turnId: "t-1", agentId: "a-2", text: "Other agent" },
          { _tag: "TurnEnded", turnId: "t-1", agentId: "a-1", reason: "Answered", durationMs: 300 },
          { _tag: "TextDelta", turnId: "t-1", agentId: "a-1", text: " done" },
        ]),
      ),
    )
    expect(turn?.blocks.map((block) => block.key)).toEqual([
      "text-1",
      "agent-a-1",
      "text-3",
      "agent-a-2",
    ])
    const agent = turn?.blocks[1]
    if (agent?.kind !== "agent") throw new Error("expected a subagent group")
    expect(agent.agent.agentId).toBe("a-1" as never)
    expect(agent.agent.blocks.map((block) => block.kind)).toEqual(["text", "tool", "text"])
    expect(agent.agent.blocks[1]).toMatchObject({ call: { outcome: "Failed", output: "boom" } })
    // A subagent's end ends only the subagent.
    expect(agent.agent.end?.reason).toBe("Answered")
    expect(turn?.end).toBeNull()
  })

  test("stop requests attach to the running Turn", () => {
    const [first, second] = turns(
      buildTranscript(
        entries([
          { _tag: "TurnStarted", turnId: "t-1", text: "one", sender: fromAlice },
          { _tag: "TurnEnded", turnId: "t-1", reason: "Answered", durationMs: 1 },
          { _tag: "TurnStopRequested", by: alice },
          { _tag: "TurnStarted", turnId: "t-2", text: "two", sender: fromBob },
          { _tag: "TurnStopRequested", by: bob },
          { _tag: "TurnEnded", turnId: "t-2", reason: "Stopped", durationMs: 2 },
        ]),
      ),
    )
    expect(first?.stopRequests).toEqual([])
    expect(second?.stopRequests.map((person) => person.login)).toEqual(["bob"])
    expect(second?.end?.reason).toBe("Stopped")
  })

  test("state changes become notices between Turns", () => {
    const items = buildTranscript(
      entries([
        { _tag: "TurnStarted", turnId: "t-1", text: "one", sender: fromAlice },
        { _tag: "TurnEnded", turnId: "t-1", reason: "Answered", durationMs: 1 },
        { _tag: "SessionStateChanged", state: "Frozen", message: "Runner studio is offline" },
        { _tag: "SessionStateChanged", state: "Active" },
      ]),
    )
    expect(items.map((item) => item.kind)).toEqual(["turn", "notice", "notice"])
    expect(items[1]).toMatchObject({
      kind: "notice",
      key: "notice-2",
      event: { state: "Frozen", message: "Runner studio is offline" },
    })
  })

  test("events for a Turn whose start is missing get an unattributed Turn", () => {
    const [turn] = turns(
      buildTranscript(
        entries([
          {
            _tag: "ToolCallEnded",
            turnId: "t-9",
            toolCallId: "c-1",
            tool: "Bash",
            outcome: "Denied",
            output: "not allowed",
          },
        ]),
      ),
    )
    expect(turn?.sender).toEqual({ _tag: "FromTerminal" })
    expect(turn?.prompt).toBe("")
    expect(turn?.blocks).toEqual([
      {
        kind: "tool",
        key: "tool-c-1",
        call: {
          toolCallId: "c-1" as never,
          tool: "Bash",
          input: "",
          outcome: "Denied",
          output: "not allowed",
        },
      },
    ])
  })

  test("an earlier transcript is not changed by building from a longer log", () => {
    const log = entries([
      { _tag: "TurnStarted", turnId: "t-1", text: "one", sender: fromAlice },
      { _tag: "TextDelta", turnId: "t-1", text: "a" },
      { _tag: "TextDelta", turnId: "t-1", agentId: "a-1", text: "x" },
      { _tag: "TextDelta", turnId: "t-1", agentId: "a-1", text: "y" },
      { _tag: "TurnEnded", turnId: "t-1", reason: "Answered", durationMs: 1 },
    ])
    const before = buildTranscript(log.slice(0, 3))
    const snapshot = JSON.stringify(before)
    buildTranscript(log)
    expect(JSON.stringify(before)).toBe(snapshot)
    expect(turns(before)[0]?.end).toBeNull()
  })

  test("an empty log is an empty transcript", () => {
    expect(buildTranscript([])).toEqual([])
  })
})

describe("runningTurn", () => {
  test("is the last Turn while it has no end", () => {
    const log = entries([
      { _tag: "TurnStarted", turnId: "t-1", text: "one", sender: fromAlice },
      { _tag: "TurnEnded", turnId: "t-1", reason: "Answered", durationMs: 1 },
      { _tag: "TurnStarted", turnId: "t-2", text: "two", sender: fromAlice },
      { _tag: "SessionStateChanged", state: "Active" },
    ])
    expect(runningTurn(buildTranscript(log))?.turnId).toBe("t-2" as never)
    expect(runningTurn(buildTranscript(log.slice(0, 2)))).toBeUndefined()
    expect(runningTurn([])).toBeUndefined()
  })
})

describe("displayPrompt", () => {
  test("drops the [Name] or [login] prefix of the prompt's own sender only", () => {
    expect(displayPrompt("[Alice] hi", fromAlice as never)).toBe("hi")
    expect(displayPrompt("[alice] hi", fromAlice as never)).toBe("hi")
    expect(displayPrompt("[Bob] hi", fromAlice as never)).toBe("[Bob] hi")
    expect(displayPrompt("[Alice] hi", { _tag: "FromTerminal" })).toBe("[Alice] hi")
  })
})

describe("tool call summaries", () => {
  test("toolSummary picks the telling field, or shows the input as it is", () => {
    expect(toolSummary('{"command":"bun test","timeout":5}')).toBe("bun test")
    expect(toolSummary('{"file_path":"src/a.ts"}')).toBe("src/a.ts")
    expect(toolSummary('{"pattern":"TODO"}')).toBe("TODO")
    expect(toolSummary('{"other":1}')).toBe('{"other":1}')
    expect(toolSummary('{"command":"cut off')).toBe('{"command":"cut off')
  })

  test("prettyInput indents whole JSON and leaves clipped input alone", () => {
    expect(prettyInput('{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(prettyInput('{"a":')).toBe('{"a":')
  })
})
