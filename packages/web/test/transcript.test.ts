import { describe, expect, test } from "bun:test"
import type { SessionLogEntry } from "@kndl/protocol"
import { seedSessions } from "../src/hub/fake/script.ts"
import {
  buildTranscript,
  emptyTranscript,
  foldTranscript,
  type LiveTranscript,
  recentAgents,
  displayPrompt,
  prettyInput,
  runningTurn,
  type Transcript,
  type TranscriptItem,
  toolSummary,
  type TurnView,
} from "../src/hub/transcript.ts"
import { alice, bob, entries, fromAlice, fromBob } from "./fixtures.ts"

const usage = {
  model: "claude-opus-5-5",
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
}

/**
 * The transcript of a log, checked to be the same whether its entries are folded in all at once,
 * one at a time, or in batches of any size, as the store folds them.
 */
function transcriptOf(log: ReadonlyArray<SessionLogEntry>): Transcript {
  const whole = buildTranscript(log)
  expect(viewOf(foldInBatches(log, () => 1))).toEqual(whole)
  for (const seed of [1, 2, 3])
    expect(viewOf(foldInBatches(log, randomSplits(seed)))).toEqual(whole)
  return whole
}

/** The transcript's items. */
const build = (log: ReadonlyArray<SessionLogEntry>) => transcriptOf(log).items

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
        { _tag: "TurnEnded", turnId: "t-1", reason: "stop", durationMs: 900, usage },
      ]),
    )
    expect(items).toHaveLength(1)
    const [turn] = turns(items)
    expect(turn?.sender).toEqual(fromAlice as never)
    expect(turn?.prompt).toBe("add a test")
    expect(turn?.promptId).toBe("p-1" as never)
    expect(turn?.blocks).toEqual([{ kind: "text", key: "text-1", text: "Sure, adding it." }])
    expect(turn?.end?.reason).toBe("stop")
    expect(turn?.end?.usage?.output).toBe(5)
  })

  test("a Turn shows the files its prompt carried, and its prompt without their markers (#276)", () => {
    const shot = { id: "att-1", name: "shot.png", mediaType: "image/png", size: 12 } as const
    const [withText, alone] = turns(
      build(
        entries([
          {
            _tag: "TurnStarted",
            turnId: "t-1",
            text: "[Alice] what broke?\n[Image #1: shot.png (attachment att-1)]",
            sender: fromAlice,
            promptId: "p-1",
            attachments: [shot],
          },
          { _tag: "TurnEnded", turnId: "t-1", reason: "stop", durationMs: 900 },
          {
            _tag: "TurnStarted",
            turnId: "t-2",
            text: "[Alice] [Image #1: shot.png (attachment att-1)]",
            sender: fromAlice,
            promptId: "p-2",
            attachments: [shot],
          },
        ]),
      ),
    )
    expect(withText).toMatchObject({ prompt: "what broke?", attachments: [shot] })
    expect(alone).toMatchObject({ prompt: "", attachments: [shot] })
  })

  test("a steered prompt, a message to an agent and a reply show the files they carried (#278)", () => {
    const shot = { id: "att-1", name: "shot.png", mediaType: "image/png", size: 12 } as const
    const transcript = transcriptOf(
      entries([
        { _tag: "TurnStarted", turnId: "t-1", text: "research", sender: fromAlice },
        { _tag: "ToolCallStarted", turnId: "t-1", toolCallId: "c-1", tool: "Agent", input: "{}" },
        agentStarted("a-1", "c-1", true),
        {
          _tag: "AgentMessaged",
          agentId: "a-1",
          sender: bob,
          text: "",
          attachments: [shot],
        },
        {
          _tag: "PromptSteered",
          turnId: "t-1",
          promptId: "p-2",
          text: "",
          sender: bob,
          attachments: [shot],
        },
        { _tag: "SteeredPromptRead", turnId: "t-1", promptId: "p-2" },
        {
          _tag: "QuestionAsked",
          turnId: "t-1",
          toolCallId: "q-1",
          questions: [{ question: "Which?", header: "", options: [], multiSelect: false }],
        },
        {
          _tag: "QuestionClosed",
          turnId: "t-1",
          toolCallId: "q-1",
          outcome: { _tag: "Replied", text: "like this", attachments: [shot] },
          by: bob,
        },
      ]),
    )
    const [turn] = turns(transcript.items)
    const agent = turn?.blocks.find((block) => block.kind === "agent")
    expect(agent?.kind === "agent" && agent.agent.blocks).toEqual([
      { kind: "message", key: "message-3", sender: bob, text: "", attachments: [shot] },
    ] as never)
    expect(turn?.blocks.find((block) => block.kind === "steered")).toMatchObject({
      text: "",
      attachments: [shot],
    })
    const question = turn?.blocks.find((block) => block.kind === "question")
    expect(question?.kind === "question" && question.question.closed?.outcome).toEqual({
      _tag: "Replied",
      text: "like this",
      attachments: [shot],
    } as never)
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
    const transcript = transcriptOf(
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
        { _tag: "TurnEnded", turnId: "t-a", agentId: "a-1", reason: "stop", durationMs: 300 },
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
    const transcript = transcriptOf(
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
        { _tag: "TurnEnded", turnId: "t-1", reason: "stop", durationMs: 10 },
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
    expect(first?.end?.reason).toBe("stop")
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
          { _tag: "TurnEnded", turnId: "t-1", reason: "stop", durationMs: 1 },
          { _tag: "TurnStopRequested", by: alice },
          { _tag: "TurnStarted", turnId: "t-2", text: "two", sender: fromBob },
          { _tag: "TurnStopRequested", by: bob },
          { _tag: "TurnEnded", turnId: "t-2", reason: "aborted", durationMs: 2 },
        ]),
      ),
    )
    expect(first?.stopRequests).toEqual([])
    expect(second?.stopRequests.map((person) => person.login)).toEqual(["bob"])
    expect(second?.end?.reason).toBe("aborted")
  })

  test("a steered prompt shows where Claude read it, and until then after the Turn (#195)", () => {
    const log = entries([
      { _tag: "TurnStarted", turnId: "t-1", text: "[Alice] one", sender: fromAlice },
      { _tag: "TextDelta", turnId: "t-1", text: "Working on it." },
      { _tag: "PromptSteered", turnId: "t-1", promptId: "p-2", text: "and two", sender: bob },
      { _tag: "TextDelta", turnId: "t-1", text: " Still." },
      { _tag: "SteeredPromptRead", turnId: "t-1", promptId: "p-2" },
      { _tag: "TextDelta", turnId: "t-1", text: "Two as well." },
      { _tag: "TurnEnded", turnId: "t-1", reason: "stop", durationMs: 1 },
    ])
    const steered = { key: "steered-2", promptId: "p-2", sender: bob, text: "and two" }

    // Joined, it waits for the next step; the Turn is still Alice's.
    const [joined] = turns(build(log.slice(0, 4)))
    expect(joined?.sender).toEqual(fromAlice as never)
    expect(joined?.unread).toEqual([steered] as never)
    expect(joined?.blocks.map((block) => block.kind)).toEqual(["text"])

    const [read] = turns(build(log))
    expect(read?.unread).toEqual([])
    expect(read?.blocks).toEqual([
      { kind: "text", key: "text-1", text: "Working on it. Still." },
      { kind: "steered", ...steered },
      { kind: "text", key: "text-5", text: "Two as well." },
    ] as never)
  })

  test("a steered prompt the Turn ended without reading stays unread (#195)", () => {
    const [turn] = turns(
      build(
        entries([
          { _tag: "TurnStarted", turnId: "t-1", text: "one", sender: fromAlice },
          { _tag: "PromptSteered", turnId: "t-1", promptId: "p-2", text: "two", sender: alice },
          { _tag: "TurnStopRequested", by: alice },
          { _tag: "TurnEnded", turnId: "t-1", reason: "aborted", durationMs: 1 },
        ]),
      ),
    )
    expect(turn?.unread.map((prompt) => prompt.text)).toEqual(["two"])
    expect(turn?.end?.reason).toBe("aborted")
  })

  test("state changes become notices between Turns", () => {
    const items = build(
      entries([
        { _tag: "TurnStarted", turnId: "t-1", text: "one", sender: fromAlice },
        { _tag: "TurnEnded", turnId: "t-1", reason: "stop", durationMs: 1 },
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

  test("a note about the Sandbox becomes a notice", () => {
    const message = "Memory capped at 8192 MiB by the Runner"
    const items = build(entries([{ _tag: "SandboxNoted", message }]))
    expect(items).toMatchObject([{ kind: "notice", event: { _tag: "SandboxNoted", message } }])
  })

  test("a prompt the Hub cancelled shows as cancelled, in its place between Turns (ADR 0026)", () => {
    const message = "Only the Session's Creator prompts it now"
    const items = build(
      entries([
        { _tag: "TurnStarted", turnId: "t-1", text: "one", sender: fromAlice },
        { _tag: "TurnEnded", turnId: "t-1", reason: "stop", durationMs: 1 },
        { _tag: "PromptCancelled", promptId: "p-2", sender: bob, text: "two", message },
        { _tag: "TurnStarted", turnId: "t-3", text: "three", sender: fromAlice },
      ]),
    )
    expect(items.map((item) => item.kind)).toEqual(["turn", "cancelled", "turn"])
    expect(items[1]).toMatchObject({
      kind: "cancelled",
      key: "cancelled-2",
      event: { promptId: "p-2", sender: { name: "Bob" }, text: "two", message },
    })
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
      { _tag: "TurnEnded", turnId: "t-1", reason: "stop", durationMs: 1 },
    ])
    const before = build(log.slice(0, 3))
    const snapshot = JSON.stringify(before)
    build(log)
    expect(JSON.stringify(before)).toBe(snapshot)
    expect(turns(before)[0]?.end).toBeNull()
  })
})

describe("questions (#193)", () => {
  const questions = [
    {
      question: "Which library?",
      header: "Library",
      multiSelect: false,
      options: [{ label: "date-fns", description: "Small." }, { label: "Luxon" }],
    },
  ]
  const started = { _tag: "TurnStarted", turnId: "t-1", text: "hi", sender: fromAlice } as const
  const call = {
    _tag: "ToolCallStarted",
    turnId: "t-1",
    toolCallId: "q-1",
    tool: "AskUserQuestion",
    input: "{}",
  } as const
  const asked = { _tag: "QuestionAsked", turnId: "t-1", toolCallId: "q-1", questions } as const
  const answered = {
    _tag: "QuestionClosed",
    turnId: "t-1",
    toolCallId: "q-1",
    outcome: { _tag: "Answered", answers: { "Which library?": "Luxon" } },
    by: bob,
  } as const
  const ended = {
    _tag: "ToolCallEnded",
    turnId: "t-1",
    toolCallId: "q-1",
    tool: "AskUserQuestion",
    outcome: "Succeeded",
    output: "answered",
  } as const

  test("a question stands in place of its AskUserQuestion call, and says how it closed", () => {
    const transcript = transcriptOf(
      entries([started, { _tag: "TextDelta", turnId: "t-1", text: "One thing:" }, call, asked]),
    )
    const [turn] = turns(transcript.items)
    expect(turn?.blocks.map((block) => block.kind)).toEqual(["text", "question"])
    expect(transcript.questions.get("q-1" as never)?.closed).toBeUndefined()

    const later = transcriptOf(
      entries([started, call, asked, answered, ended, { ...call, toolCallId: "other" }]),
    )
    const blocks = turns(later.items)[0]?.blocks ?? []
    expect(blocks.map((block) => block.kind)).toEqual(["question", "tool"])
    const [block] = blocks
    expect(block?.kind === "question" && block.question.closed?.by?.name).toBe("Bob")
    expect(later.questions.get("q-1" as never)?.closed?.outcome).toEqual(answered.outcome)
  })

  test("a question reported before its tool call hides the call", () => {
    const [turn] = turns(build(entries([started, asked, call, answered, ended])))
    expect(turn?.blocks).toHaveLength(1)
    expect(turn?.blocks[0]?.kind).toBe("question")
    expect(turn?.blocks[0]?.key).toBe("question-q-1")
  })

  test("a close for a question not in the log changes nothing", () => {
    const [turn] = turns(build(entries([started, answered])))
    expect(turn?.blocks).toEqual([])
  })
})

describe("foldTranscript", () => {
  test("the fake Hub's Sessions fold the same entry by entry, or in any batches, as all at once", () => {
    for (const seed of seedSessions(1_790_000_000_000)) transcriptOf(entries(seed.events))
  })

  test("any log folds the same in any batches as all at once", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const log = randomLog(seed)
      const whole = buildTranscript(log)
      expect(viewOf(foldInBatches(log, () => 1))).toEqual(whole)
      expect(viewOf(foldInBatches(log, randomSplits(seed)))).toEqual(whole)
    }
  })

  test("text streaming into the last Turn leaves every earlier Turn as it was", () => {
    const before = foldTranscript(
      emptyTranscript,
      entries([
        { _tag: "TurnStarted", turnId: "t-1", text: "one", sender: fromAlice },
        { _tag: "TextDelta", turnId: "t-1", text: "Done." },
        { _tag: "TurnEnded", turnId: "t-1", reason: "stop", durationMs: 1 },
        { _tag: "SessionStateChanged", state: "Active" },
        { _tag: "TurnStarted", turnId: "t-2", text: "two", sender: fromBob },
        { _tag: "TextDelta", turnId: "t-2", text: "Work" },
      ]),
    )
    const after = foldTranscript(
      before,
      entries([{ _tag: "TextDelta", turnId: "t-2", text: "ing" }], 6),
    )
    expect(after.items).toHaveLength(3)
    expect(after.items[0]).toBe(before.items[0] as never)
    expect(after.items[1]).toBe(before.items[1] as never)
    expect(turns(after.items)[1]?.blocks).toEqual([
      { kind: "text", key: "text-5", text: "Working" },
    ])
    expect(after.agents).toBe(before.agents)
    expect(after.questions).toBe(before.questions)
    expect(after.agentList).toBe(before.agentList)
    // What was folded before is as it was.
    expect(turns(before.items)[1]?.blocks).toEqual([{ kind: "text", key: "text-5", text: "Work" }])
  })

  test("a subagent's text changes only the Turn its card is in", () => {
    const log = entries([
      { _tag: "TurnStarted", turnId: "t-1", text: "research", sender: fromAlice },
      { _tag: "ToolCallStarted", turnId: "t-1", toolCallId: "c-1", tool: "Agent", input: "{}" },
      agentStarted("a-1", "c-1", true),
      { _tag: "TurnEnded", turnId: "t-1", reason: "stop", durationMs: 1 },
      { _tag: "TurnStarted", turnId: "t-2", text: "meanwhile", sender: fromBob },
    ])
    const before = foldTranscript(emptyTranscript, log)
    const after = foldTranscript(
      before,
      entries([{ _tag: "TextDelta", turnId: "t-a", agentId: "a-1", text: "Found it" }], 5),
    )
    expect(after.items[1]).toBe(before.items[1] as never)
    const card = turns(after.items)[0]?.blocks[0]
    expect(card?.kind === "agent" && card.agent.blocks).toEqual([
      { kind: "text", key: "text-5", text: "Found it" },
    ])
    expect(card?.kind === "agent" && card.agent).toBe(after.agents.get("a-1" as never) as never)
  })

  test("says which Turn is running and the latest state change", () => {
    const transcript = transcriptOf(
      entries([
        { _tag: "SessionStateChanged", state: "Asleep" },
        { _tag: "TurnStarted", turnId: "t-1", text: "one", sender: fromAlice },
        { _tag: "SessionStateChanged", state: "Active", message: "Woke up" },
        { _tag: "SandboxNoted", message: "Docker is off" },
      ]),
    )
    expect(transcript.running?.turnId).toBe("t-1" as never)
    expect(transcript.stateChange).toEqual({
      _tag: "SessionStateChanged",
      state: "Active",
      message: "Woke up",
    })
  })
})

/** The transcript without what folding more into it needs. */
function viewOf(live: LiveTranscript): Transcript {
  const { fold: _, ...view } = live
  return view
}

/** Folds a log in batches, each as long as `size` says, at least one entry. */
function foldInBatches(log: ReadonlyArray<SessionLogEntry>, size: () => number): LiveTranscript {
  let live = emptyTranscript
  for (let start = 0; start < log.length;) {
    const end = start + Math.max(1, size())
    live = foldTranscript(live, log.slice(start, end))
    start = end
  }
  return live
}

/** A seeded pseudo-random number in [0, 1), so a failing case repeats (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** Batch sizes from 1 to 8, from a seed. */
function randomSplits(seed: number): () => number {
  const next = random(seed * 7919)
  return () => 1 + Math.floor(next() * 8)
}

type EventEncoded = Parameters<typeof entries>[0][number]

/**
 * A log of every kind of event, in any order, over a few ids each, so events meet Turns, calls
 * and agents they don't belong to, or that aren't in the log yet.
 */
function randomLog(seed: number): ReadonlyArray<SessionLogEntry> {
  const next = random(seed)
  const pick = <A>(options: ReadonlyArray<A>): A =>
    options[Math.floor(next() * options.length)] as A
  const turnId = () => pick(["t-0", "t-1", "t-2"])
  const agentId = () => pick(["a-0", "a-1"])
  const toolCallId = () => pick(["c-0", "c-1", "c-2", "c-a-0", "c-a-1"])
  const promptId = () => pick(["p-0", "p-1"])
  const person = () => pick([alice, bob])
  const inAgent = (): { agentId?: string } => (next() < 0.3 ? { agentId: agentId() } : {})
  const threadId = () => pick(["thr-0", "thr-1"])
  // Most events are the main loop's; some are a thread's (docs/design/durable-harness.md).
  const inThread = (): { threadId?: string } => (next() < 0.35 ? { threadId: threadId() } : {})
  const inLoop = (): { threadId?: string; agentId?: string } => {
    const roll = next()
    return roll < 0.25 ? { agentId: agentId() } : roll < 0.5 ? { threadId: threadId() } : {}
  }
  const plan = () => ({
    steps: [
      { text: "Read", status: pick(["done", "in_progress"] as const) },
      { text: "Write", status: pick(["pending", "in_progress", "done"] as const) },
    ],
  })
  const makers: ReadonlyArray<() => EventEncoded> = [
    () => ({
      _tag: "TurnStarted",
      turnId: turnId(),
      ...inThread(),
      text: "[Alice] go",
      sender: pick([
        fromAlice,
        fromBob,
        { _tag: "FromTerminal" },
        { _tag: "FromAgent", agentId: agentId() },
        { _tag: "Resumed" },
      ]),
      ...(next() < 0.5 && { promptId: promptId() }),
    }),
    () => ({ _tag: "TextDelta", turnId: turnId(), ...inAgent(), text: pick(["a", "b "]) }),
    () => ({ _tag: "TextDelta", turnId: turnId(), threadId: threadId(), text: "t" }),
    () => ({ _tag: "TextDelta", turnId: turnId(), text: "c" }),
    () => {
      // Each subagent's calls have ids of their own, so no subagent's card is in its own blocks.
      const loop = inAgent()
      return {
        _tag: "ToolCallStarted",
        turnId: turnId(),
        ...loop,
        ...(loop.agentId === undefined && inThread()),
        toolCallId: loop.agentId === undefined ? pick(["c-0", "c-1", "c-2"]) : `c-${loop.agentId}`,
        tool: pick(["Bash", "Agent", "AskUserQuestion", "update_plan"]),
        input: "{}",
      }
    },
    () => ({
      _tag: "ToolCallEnded",
      turnId: turnId(),
      ...inAgent(),
      toolCallId: toolCallId(),
      tool: "Bash",
      outcome: pick(["Succeeded", "Failed"] as const),
      output: "out",
    }),
    () => ({
      _tag: "TurnEnded",
      turnId: turnId(),
      ...inLoop(),
      reason: pick(["stop", "aborted", "length", "error"] as const),
      durationMs: 1,
    }),
    () => {
      // a-0's card may be in a-1's blocks, but not a-1's in a-0's.
      const started = agentId()
      return {
        _tag: "AgentStarted",
        turnId: turnId(),
        ...inThread(),
        agentId: started,
        toolCallId: pick(started === "a-0" ? ["c-0", "c-1", "c-a-1"] : ["c-0", "c-1", "c-2"]),
        agentType: "Explore",
        description: pick(["Search", "Read"]),
        model: "haiku",
        background: next() < 0.5,
      }
    },
    () => ({
      _tag: "AgentStatusChanged",
      agentId: agentId(),
      status: pick(["Running", "Done", "Stopped"] as const),
      ...(next() < 0.3 && { worktree: { path: "/w", branch: "worktree-a" } }),
    }),
    () => ({ _tag: "AgentMessaged", agentId: agentId(), sender: person(), text: "hey" }),
    () => ({
      _tag: "QuestionAsked",
      turnId: turnId(),
      toolCallId: toolCallId(),
      questions: [
        { question: "Which?", header: "Pick", multiSelect: false, options: [{ label: "A" }] },
      ],
    }),
    () => ({
      _tag: "QuestionClosed",
      turnId: turnId(),
      toolCallId: toolCallId(),
      outcome: { _tag: "Dismissed" },
      ...(next() < 0.5 && { by: person() }),
    }),
    () => ({ _tag: "TurnStopRequested", by: person(), ...inThread() }),
    () => ({
      _tag: "PromptSteered",
      turnId: turnId(),
      ...inThread(),
      promptId: promptId(),
      text: "also this",
      sender: person(),
    }),
    () => ({ _tag: "SteeredPromptRead", turnId: turnId(), ...inThread(), promptId: promptId() }),
    () => ({
      _tag: "ThreadStarted",
      threadId: threadId(),
      anchorTurnId: turnId(),
      title: pick(["Why?", "And Windows?"]),
      startedBy: person(),
      ...(next() < 0.5 && { model: "openai/gpt-6-sol" }),
    }),
    () => ({
      _tag: "ThreadPromptSent",
      threadId: threadId(),
      promptId: promptId(),
      sender: person(),
      text: "in the thread",
    }),
    () => ({ _tag: "ThreadModelChanged", threadId: threadId(), by: person(), model: "x/y" }),
    () => ({
      _tag: "CompactionStarted",
      ...inLoop(),
      reason: pick(["threshold", "overflow", "manual"] as const),
      ...(next() < 0.5 && { by: person() }),
    }),
    () => ({
      _tag: "CompactionEnded",
      ...inLoop(),
      outcome: pick(["compacted", "skipped", "failed"] as const),
      ...(next() < 0.5 && { summary: "summed up" }),
    }),
    () => ({ _tag: "PlanChanged", ...inLoop(), plan: plan() }),
    () => ({
      _tag: "UsageChanged",
      ...inLoop(),
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: next() },
    }),
    () => ({ _tag: "SessionStateChanged", state: pick(["Active", "Asleep"] as const) }),
    () => ({ _tag: "SandboxNoted", message: "noted" }),
    () => ({ _tag: "ModelSwitched", by: person(), model: "sonnet" }),
  ]
  const length = 1 + Math.floor(next() * 60)
  return entries(Array.from({ length }, () => pick(makers)()))
}

describe("threads, the Plan, compaction and Resumed Turns (docs/design/durable-harness.md)", () => {
  /** A finished main-loop Turn, t-1, which threads fork off. */
  const answered: ReadonlyArray<EventEncoded> = [
    { _tag: "TurnStarted", turnId: "t-1", text: "[Alice] add /health", sender: fromAlice },
    { _tag: "TextDelta", turnId: "t-1", text: "Added it." },
    { _tag: "TurnEnded", turnId: "t-1", reason: "stop", durationMs: 900, usage },
  ]
  const started: EventEncoded = {
    _tag: "ThreadStarted",
    threadId: "thr-1",
    anchorTurnId: "t-1",
    title: "What about Windows?",
    startedBy: bob,
    model: "openai/gpt-6-sol",
  }
  const posted = (promptId: string, sender: typeof alice, text: string): EventEncoded => ({
    _tag: "ThreadPromptSent",
    threadId: "thr-1",
    promptId,
    sender,
    text,
  })

  test("a thread's events fold into its own Turns, and leave the main loop as it was", () => {
    const transcript = transcriptOf(
      entries([
        ...answered,
        started,
        posted("p-1", bob, "What about Windows?"),
        {
          _tag: "TurnStarted",
          turnId: "t-2",
          threadId: "thr-1",
          text: "[Bob] What about Windows?",
          sender: fromBob,
          promptId: "p-1",
        },
        { _tag: "TextDelta", turnId: "t-2", threadId: "thr-1", text: "Windows needs " },
        {
          _tag: "ToolCallStarted",
          turnId: "t-2",
          threadId: "thr-1",
          toolCallId: "c-1",
          tool: "bash",
          input: '{"command":"ls"}',
        },
      ]),
    )
    // The main loop has its one Turn, finished: a thread running doesn't make it busy.
    expect(turns(transcript.items).map((turn) => turn.turnId)).toEqual(["t-1"] as never)
    expect(transcript.running).toBeUndefined()

    const thread = transcript.threads.get("thr-1" as never)
    expect(thread?.title).toBe("What about Windows?")
    expect(thread?.startedBy.name).toBe("Bob")
    expect(thread?.model).toBe("openai/gpt-6-sol" as never)
    const [turn] = turns(thread?.items ?? [])
    expect(turn?.prompt).toBe("What about Windows?")
    expect(turn?.blocks.map((block) => block.kind)).toEqual(["text", "tool"])
    expect(thread?.running?.turnId).toBe("t-2" as never)
    // It hangs off the Turn it forked from.
    expect(transcript.anchored.get("t-1" as never)?.map((each) => each.threadId)).toEqual([
      "thr-1",
    ] as never)
  })

  test("a prompt posted shows as sent until a Turn starts from it or it steers the running one", () => {
    const log = entries([
      ...answered,
      started,
      posted("p-1", bob, "What about Windows?"),
      posted("p-2", alice, "and macOS"),
    ])
    const before = transcriptOf(log).threads.get("thr-1" as never)
    expect(before?.sent.map((prompt) => prompt.text)).toEqual(["What about Windows?", "and macOS"])
    expect(before?.items).toEqual([])
    expect(before?.people.map((person) => person.name)).toEqual(["Bob", "Alice"])
    expect(before?.replies).toBe(2)

    const after = transcriptOf(
      entries(
        [
          {
            _tag: "TurnStarted",
            turnId: "t-2",
            threadId: "thr-1",
            text: "[Bob] What about Windows?",
            sender: fromBob,
            promptId: "p-1",
          },
          {
            _tag: "PromptSteered",
            turnId: "t-2",
            threadId: "thr-1",
            promptId: "p-2",
            text: "and macOS",
            sender: alice,
          },
        ],
        log.length,
      ).reduce((all, entry) => [...all, entry], [...log]),
    ).threads.get("thr-1" as never)
    // Each is shown once: as the Turn, and as a prompt steered into it.
    expect(after?.sent).toEqual([])
    const [turn] = turns(after?.items ?? [])
    expect(turn?.promptId).toBe("p-1" as never)
    expect(turn?.unread.map((prompt) => prompt.promptId)).toEqual(["p-2"] as never)
    // The prompts and the answer to the first.
    expect(after?.replies).toBe(3)
  })

  test("a stop asked for in a thread stops its Turn, not the main loop's", () => {
    const transcript = transcriptOf(
      entries([
        { _tag: "TurnStarted", turnId: "t-1", text: "go", sender: fromAlice },
        started,
        { _tag: "TurnStarted", turnId: "t-2", threadId: "thr-1", text: "go", sender: fromBob },
        { _tag: "TurnStopRequested", by: bob, threadId: "thr-1" },
      ]),
    )
    expect(transcript.running?.stopRequests).toEqual([])
    expect(transcript.threads.get("thr-1" as never)?.running?.stopRequests).toEqual([bob] as never)
  })

  test("a subagent a thread's Turn started has its card in that Turn", () => {
    const transcript = transcriptOf(
      entries([
        ...answered,
        started,
        { _tag: "TurnStarted", turnId: "t-2", threadId: "thr-1", text: "go", sender: fromBob },
        {
          _tag: "ToolCallStarted",
          turnId: "t-2",
          threadId: "thr-1",
          toolCallId: "c-1",
          tool: "agent",
          input: "{}",
        },
        {
          _tag: "AgentStarted",
          turnId: "t-2",
          threadId: "thr-1",
          agentId: "a-1",
          toolCallId: "c-1",
          agentType: "general",
          description: "Check Windows",
          model: "openai/gpt-6-sol",
          background: true,
        },
        { _tag: "TextDelta", turnId: "t-9", agentId: "a-1", text: "Looking" },
      ]),
    )
    const [turn] = turns(transcript.threads.get("thr-1" as never)?.items ?? [])
    const card = turn?.blocks[0]
    expect(card?.kind).toBe("agent")
    expect(card?.kind === "agent" && card.agent.blocks).toEqual([
      { kind: "text", key: "text-7", text: "Looking" },
    ])
    expect(transcript.agents.get("a-1" as never)?.threadId).toBe("thr-1" as never)
  })

  test("a thread streaming leaves every main-loop Turn as it was", () => {
    const log = entries([
      ...answered,
      started,
      { _tag: "TurnStarted", turnId: "t-2", threadId: "thr-1", text: "go", sender: fromBob },
    ])
    const before = foldTranscript(emptyTranscript, log)
    const after = foldTranscript(
      before,
      entries([{ _tag: "TextDelta", turnId: "t-2", threadId: "thr-1", text: "more" }], log.length),
    )
    expect(after.items).toBe(before.items)
    expect(after.threads.get("thr-1" as never)).not.toBe(before.threads.get("thr-1" as never))
  })

  test("a Turn resumed after a restart goes on from the one the restart ended", () => {
    const items = build(
      entries([
        { _tag: "TurnStarted", turnId: "t-1", text: "[Alice] go", sender: fromAlice },
        { _tag: "TextDelta", turnId: "t-1", text: "Working on it" },
        { _tag: "TurnEnded", turnId: "t-1", reason: "aborted", durationMs: 9 },
        { _tag: "SessionStateChanged", state: "Active" },
        { _tag: "TurnStarted", turnId: "t-2", text: "", sender: { _tag: "Resumed" } },
        { _tag: "TextDelta", turnId: "t-2", text: "and done." },
      ]),
    )
    const [interrupted, resumed] = turns(items)
    expect(interrupted?.continued).toBe(true)
    expect(resumed?.sender._tag).toBe("Resumed")
    expect(resumed?.continued).toBeUndefined()
  })

  test("a compaction shows in the Turn it ran in, or between Turns, with how it ended", () => {
    const transcript = transcriptOf(
      entries([
        { _tag: "CompactionStarted", reason: "manual", by: alice },
        { _tag: "CompactionEnded", outcome: "skipped" },
        { _tag: "TurnStarted", turnId: "t-1", text: "go", sender: fromAlice },
        { _tag: "CompactionStarted", reason: "threshold" },
        { _tag: "TextDelta", turnId: "t-1", text: "still working" },
        { _tag: "CompactionEnded", outcome: "compacted", summary: "We added a route." },
        started,
        { _tag: "CompactionStarted", threadId: "thr-1", reason: "overflow" },
        { _tag: "CompactionEnded", threadId: "thr-1", outcome: "failed", error: "429" },
      ]),
    )
    const [between, turn] = transcript.items
    expect(between).toEqual({
      kind: "compaction",
      key: "compaction-0",
      compaction: {
        at: 1_790_000_000_000,
        reason: "manual",
        by: alice,
        end: { outcome: "skipped" },
      } as never,
    })
    const inTurn = turn?.kind === "turn" ? turn.turn.blocks : []
    expect(inTurn.map((block) => block.kind)).toEqual(["compaction", "text"])
    expect(inTurn[0]?.kind === "compaction" && inTurn[0].compaction.end).toEqual({
      outcome: "compacted",
      summary: "We added a route.",
    })
    const [threadItem] = transcript.threads.get("thr-1" as never)?.items ?? []
    expect(threadItem?.kind === "compaction" && threadItem.compaction.end).toEqual({
      outcome: "failed",
      error: "429",
    })
  })

  test("a compaction running shows as running", () => {
    const [item] = build(entries([{ _tag: "CompactionStarted", reason: "threshold" }]))
    expect(item?.kind === "compaction" && item.compaction.end).toBeUndefined()
  })

  test("the Plan is each conversation's latest, marked where it changed, in place of its call", () => {
    const step = (text: string, status: "pending" | "in_progress" | "done") => ({ text, status })
    const first = { steps: [step("Add the route", "in_progress"), step("Test it", "pending")] }
    const second = { steps: [step("Add the route", "done"), step("Test it", "in_progress")] }
    const transcript = transcriptOf(
      entries([
        { _tag: "TurnStarted", turnId: "t-1", text: "go", sender: fromAlice },
        {
          _tag: "ToolCallStarted",
          turnId: "t-1",
          toolCallId: "c-1",
          tool: "update_plan",
          input: "{}",
        },
        { _tag: "PlanChanged", plan: first },
        {
          _tag: "ToolCallEnded",
          turnId: "t-1",
          toolCallId: "c-1",
          tool: "update_plan",
          outcome: "Succeeded",
          output: "ok",
        },
        { _tag: "PlanChanged", plan: second },
        started,
        { _tag: "PlanChanged", threadId: "thr-1", plan: first },
        { _tag: "PlanChanged", agentId: "a-1", plan: second },
      ]),
    )
    expect(transcript.plan).toEqual(second as never)
    const [turn] = turns(transcript.items)
    expect(turn?.blocks).toEqual([
      { kind: "plan", key: "tool-c-1", plan: first },
      { kind: "plan", key: "plan-4", plan: second, previous: first },
    ] as never)
    expect(transcript.threads.get("thr-1" as never)?.plan).toEqual(first as never)
    // Between Turns, the thread's Plan shows; nothing is marked.
    expect(transcript.threads.get("thr-1" as never)?.items).toEqual([])
  })

  test("what each conversation spent is the latest it said", () => {
    const spent = (cost: number) => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost })
    const transcript = transcriptOf(
      entries([
        started,
        { _tag: "UsageChanged", usage: spent(0.1) },
        { _tag: "UsageChanged", threadId: "thr-1", usage: spent(0.02) },
        { _tag: "UsageChanged", usage: spent(0.3) },
      ]),
    )
    expect(transcript.usage?.cost).toBe(0.3)
    expect(transcript.threads.get("thr-1" as never)?.usage?.cost).toBe(0.02)
  })

  test("a change of a thread's model shows in it, and becomes its model", () => {
    const thread = transcriptOf(
      entries([
        started,
        { _tag: "ThreadModelChanged", threadId: "thr-1", by: alice, model: "anthropic/opus" },
      ]),
    ).threads.get("thr-1" as never)
    expect(thread?.model).toBe("anthropic/opus" as never)
    expect(thread?.items.map((item) => item.kind)).toEqual(["notice"])
  })
})

describe("runningTurn", () => {
  test("is the last Turn while it has no end", () => {
    const log = entries([
      { _tag: "TurnStarted", turnId: "t-1", text: "one", sender: fromAlice },
      { _tag: "TurnEnded", turnId: "t-1", reason: "stop", durationMs: 1 },
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

describe("the list of subagents", () => {
  test("lists the subagents the Session started, in order, with their status", () => {
    const log = entries([
      { _tag: "TurnStarted", turnId: "t-1", text: "go", sender: fromAlice },
      agentStarted("a-1", "c-1"),
      agentStarted("a-2", "c-2", true),
      { _tag: "AgentStatusChanged", agentId: "a-1", status: "Stopped" },
      // Claude Code's own agent, never started by an Agent call.
      { _tag: "AgentStatusChanged", agentId: "a-own", status: "Done" },
    ])
    expect(transcriptOf(log).agentList).toEqual([
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
