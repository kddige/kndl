import { describe, expect, test } from "bun:test"
import type { SessionLogEntry } from "@claude-hub/protocol"
import {
  agentsOf,
  buildTranscript,
  recentAgents,
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

/** The transcript's items. */
const build = (log: ReadonlyArray<SessionLogEntry>) => buildTranscript(log).items

function turns(items: ReadonlyArray<TranscriptItem>): ReadonlyArray<TurnView> {
  return items.flatMap((item) => (item.kind === "turn" ? [item.turn] : []))
}

describe("buildTranscript", () => {
  test("a Turn shows its sender, its prompt and the streamed text merged", () => {
    const items = build(
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
      build(
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

  test("a subagent is a card in place of the Agent call that started it, with its own events", () => {
    const transcript = buildTranscript(
      entries([
        { _tag: "TurnStarted", turnId: "t-1", text: "research", sender: fromAlice },
        { _tag: "TextDelta", turnId: "t-1", text: "Asking a subagent." },
        { _tag: "ToolCallStarted", turnId: "t-1", toolCallId: "c-1", tool: "Agent", input: "{}" },
        // Its run's events can come before the Hub hears it started.
        { _tag: "TextDelta", turnId: "t-a", agentId: "a-1", text: "Searching" },
        agentStarted("a-1", "c-1"),
        {
          _tag: "ToolCallStarted",
          turnId: "t-a",
          agentId: "a-1",
          toolCallId: "c-2",
          tool: "Grep",
          input: '{"pattern":"foo"}',
        },
        { _tag: "TextDelta", turnId: "t-1", text: "Meanwhile…" },
        {
          _tag: "ToolCallEnded",
          turnId: "t-a",
          agentId: "a-1",
          toolCallId: "c-2",
          tool: "Grep",
          outcome: "Failed",
          output: "boom",
        },
        // Claude Code's own agents, which no Agent call started, aren't shown.
        { _tag: "TextDelta", turnId: "t-x", agentId: "a-own", text: "Summarizing" },
        { _tag: "TurnEnded", turnId: "t-a", agentId: "a-1", reason: "Answered", durationMs: 300 },
        { _tag: "AgentStatusChanged", agentId: "a-1", status: "Done" },
        {
          _tag: "ToolCallEnded",
          turnId: "t-1",
          toolCallId: "c-1",
          tool: "Agent",
          outcome: "Succeeded",
          output: "Found it.",
        },
      ]),
    )
    const [turn] = turns(transcript.items)
    expect(turn?.blocks.map((block) => block.key)).toEqual(["text-1", "agent-a-1", "text-6"])
    const card = turn?.blocks[1]
    if (card?.kind !== "agent") throw new Error("expected a subagent's card")
    expect(card.agent).toMatchObject({
      agentId: "a-1",
      agentType: "Explore",
      description: "Search the code",
      background: false,
      status: "Done",
    })
    expect(card.agent.blocks.map((block) => block.kind)).toEqual(["text", "tool"])
    expect(card.agent.blocks[1]).toMatchObject({ call: { outcome: "Failed", output: "boom" } })
    // Its run ending ends only the subagent.
    expect(turn?.end).toBeNull()
    expect([...transcript.agents.keys()]).toEqual(["a-1" as never])
    expect(transcript.agents.get("a-1" as never)).toBe(card.agent)
  })

  test("a background agent fills its card after its Turn ends, and the Turn it starts is from it", () => {
    const transcript = buildTranscript(
      entries([
        { _tag: "TurnStarted", turnId: "t-1", text: "research", sender: fromAlice },
        { _tag: "ToolCallStarted", turnId: "t-1", toolCallId: "c-1", tool: "Agent", input: "{}" },
        agentStarted("a-1", "c-1", true),
        {
          _tag: "AgentStatusChanged",
          agentId: "a-1",
          status: "Running",
          worktree: { path: "/w/.claude/worktrees/a", branch: "worktree-a" },
        },
        {
          _tag: "ToolCallEnded",
          turnId: "t-1",
          toolCallId: "c-1",
          tool: "Agent",
          outcome: "Succeeded",
          output: "Async agent launched successfully.",
        },
        { _tag: "TurnEnded", turnId: "t-1", reason: "Answered", durationMs: 10 },
        { _tag: "TextDelta", turnId: "t-a", agentId: "a-1", text: "Found it." },
        { _tag: "AgentMessaged", agentId: "a-1", sender: bob, text: "Look in docs/ too" },
        { _tag: "AgentStatusChanged", agentId: "a-1", status: "Done" },
        {
          _tag: "TurnStarted",
          turnId: "t-2",
          // As Claude Code 2.1.289 writes it.
          text: [
            "<task-notification>",
            "<task-id>a-1</task-id>",
            "<tool-use-id>toolu_1</tool-use-id>",
            "<output-file>/tmp/claude-0/-workspace/s-1/tasks/a-1.output</output-file>",
            "<status>completed</status>",
            '<summary>Agent "Search the code" finished</summary>',
            "<note>A task-notification fires each time this agent stops with no live background children of its own.</note>",
            "<result>Found it.</result>",
            "<usage><subagent_tokens>12388</subagent_tokens><tool_uses>3</tool_uses><duration_ms>17036</duration_ms></usage>",
            "</task-notification>",
          ].join("\n"),
          sender: { _tag: "FromAgent", agentId: "a-1" },
        },
      ]),
    )
    const [first, second] = turns(transcript.items)
    expect(first?.end?.reason).toBe("Answered")
    const card = first?.blocks[0]
    if (card?.kind !== "agent") throw new Error("expected a subagent's card")
    expect(card.agent.background).toBe(true)
    expect(card.agent.status).toBe("Done")
    expect(card.agent.worktree?.branch).toBe("worktree-a")
    expect(card.agent.blocks).toMatchObject([
      { kind: "text", text: "Found it." },
      { kind: "message", sender: { login: "bob" }, text: "Look in docs/ too" },
    ])
    expect(second?.sender).toEqual({ _tag: "FromAgent", agentId: "a-1" } as never)
    expect(second?.agentDescription).toBe("Search the code")
    expect(second?.prompt).toBe('Agent "Search the code" finished\n\nFound it.')
  })

  test("a Turn Claude Code starts at a background command's end is from no agent", () => {
    const [turn] = turns(
      build(
        entries([
          {
            _tag: "TurnStarted",
            turnId: "t-1",
            // As Claude Code 2.1.289 writes it.
            text: [
              "<task-notification>",
              "<task-id>b0id3avkx</task-id>",
              "<status>completed</status>",
              '<summary>Background command "Wait 120 seconds" completed (exit code 0)</summary>',
              "</task-notification>",
            ].join("\n"),
            sender: { _tag: "FromAgent", agentId: "b0id3avkx" },
          },
        ]),
      ),
    )
    expect(turn?.agentDescription).toBeUndefined()
    expect(turn?.prompt).toBe('Background command "Wait 120 seconds" completed (exit code 0)')
  })

  test("a subagent whose Agent call wasn't seen goes at the end of the Turn that started it", () => {
    const [turn] = turns(
      build(
        entries([
          { _tag: "TurnStarted", turnId: "t-1", text: "go", sender: fromAlice },
          { _tag: "TextDelta", turnId: "t-1", text: "Starting one." },
          agentStarted("a-1", "c-9"),
        ]),
      ),
    )
    expect(turn?.blocks.map((block) => block.kind)).toEqual(["text", "agent"])
  })

  test("stop requests attach to the running Turn", () => {
    const [first, second] = turns(
      build(
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
    const items = build(
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

  test("a WIP ref that could not be pushed becomes a notice", () => {
    const items = build(entries([{ _tag: "WipNotPushed", message: "remote rejected" }]))
    expect(items).toMatchObject([
      { kind: "notice", event: { _tag: "WipNotPushed", message: "remote rejected" } },
    ])
  })

  test("events for a Turn whose start is missing get an unattributed Turn", () => {
    const [turn] = turns(
      build(
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
    const before = build(log.slice(0, 3))
    const snapshot = JSON.stringify(before)
    build(log)
    expect(JSON.stringify(before)).toBe(snapshot)
    expect(turns(before)[0]?.end).toBeNull()
  })

  test("an empty log is an empty transcript", () => {
    expect(buildTranscript([])).toEqual({ items: [], agents: new Map() })
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
    expect(runningTurn(build(log))?.turnId).toBe("t-2" as never)
    expect(runningTurn(build(log.slice(0, 2)))).toBeUndefined()
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

  test("a Turn from an agent shows what its task notification says", () => {
    const fromAgent = { _tag: "FromAgent", agentId: "a-1" } as never
    expect(
      displayPrompt(
        "<task-notification>\n<task-id>a-1</task-id>\n<summary>Agent done</summary>\n<result>All green.</result>\n</task-notification>",
        fromAgent,
      ),
    ).toBe("Agent done\n\nAll green.")
    expect(displayPrompt("Not a notification.", fromAgent)).toBe("Not a notification.")
  })
})

describe("agentsOf", () => {
  test("lists the subagents the Session started, in order, with their status", () => {
    const log = entries([
      { _tag: "TurnStarted", turnId: "t-1", text: "go", sender: fromAlice },
      agentStarted("a-1", "c-1"),
      agentStarted("a-2", "c-2", true),
      { _tag: "AgentStatusChanged", agentId: "a-1", status: "Stopped" },
      // Claude Code's own agent, never started by an Agent call.
      { _tag: "AgentStatusChanged", agentId: "a-own", status: "Done" },
    ])
    expect(agentsOf(log)).toEqual([
      { id: "a-1", description: "Search the code", status: "Stopped" },
      { id: "a-2", description: "Search the code", status: "Running" },
    ] as never)
  })
})

/** An agent's summary in the sidebar, described by its id. */
const agent = (id: string, status: string) => ({ id, description: id, status }) as never
const ids = (list: ReadonlyArray<{ id: string }>) => list.map((each) => each.id)

describe("recentAgents", () => {
  const agents = [
    agent("a-1", "Done"),
    agent("a-2", "Interrupted"),
    agent("a-3", "Stopped"),
    agent("a-4", "Done"),
    agent("a-5", "Running"),
    agent("a-6", "Done"),
    agent("a-7", "Done"),
  ]

  test("keeps the unfinished agents and the latest three finished, in order", () => {
    expect(ids(recentAgents(agents, undefined))).toEqual(["a-2", "a-4", "a-5", "a-6", "a-7"])
  })

  test("keeps an older finished agent whose view is open", () => {
    expect(ids(recentAgents(agents, "a-1"))).toEqual(["a-1", "a-2", "a-4", "a-5", "a-6", "a-7"])
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

/** The mod's report that an Agent call started a subagent. */
function agentStarted(agentId: string, toolCallId: string, background = false) {
  return {
    _tag: "AgentStarted",
    turnId: "t-1",
    agentId,
    toolCallId,
    agentType: "Explore",
    description: "Search the code",
    model: "claude-haiku-4-5",
    background,
  } as const
}
