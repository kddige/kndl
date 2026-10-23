import { expect, test } from "bun:test"
import type { OpenQuestion, SessionSummary } from "@kndl/protocol"
import type { TurnView } from "../src/hub/transcript.ts"
import { ProgressEveryMs, VoiceBridge, type VoiceEvent } from "../src/session/voiceBridge.ts"
import { heardEvent, wireEvent } from "../src/session/voiceProtocol.ts"

const summary = (extra: Partial<SessionSummary> = {}) =>
  ({ id: "s1", currentTurn: null, ...extra }) as unknown as SessionSummary

const turn = (prompt: string, blocks: TurnView["blocks"], ended: boolean, at = 1000): TurnView =>
  ({
    turnId: `t-${prompt}`,
    seq: 1,
    at,
    prompt,
    blocks,
    stopRequests: [],
    unread: [],
    end: ended ? { reason: "stop" } : null,
  }) as unknown as TurnView

const tool = (name: string, input: string): TurnView["blocks"][number] =>
  ({ kind: "tool", key: name, call: { toolCallId: name, tool: name, input } }) as never
const text = (said: string): TurnView["blocks"][number] => ({ kind: "text", key: said, text: said })

function bridge() {
  const sent: Array<VoiceEvent> = []
  const prompts: Array<string> = []
  const replies: Array<string> = []
  let now = 1000
  const voice = new VoiceBridge(
    {
      sendPrompt: (said) => (prompts.push(said), true),
      reply: (_question, said) => (replies.push(said), true),
    },
    (event) => sent.push(event),
    () => now,
  )
  return { voice, sent, prompts, replies, tick: (ms: number) => (now += ms) }
}

test("what was said since the last delegation becomes the Session's prompt", () => {
  const { voice, sent, prompts } = bridge()
  voice.heard("Add a test ")
  voice.heard(" for the   parser.")
  voice.delegated("d1")
  expect(prompts).toEqual(["Add a test for the parser."])
  expect(sent.at(-1)).toMatchObject({ kind: "quiet", delegationId: "d1" })
  // Nothing new said: nothing sent.
  voice.delegated("d2")
  expect(prompts).toHaveLength(1)
})

test("the Turn's progress is told quietly, and its answer to say when it ends", () => {
  const { voice, sent, tick } = bridge()
  voice.heard("Fix the build")
  voice.delegated("d1")
  voice.observe({
    summary: summary(),
    turns: [turn("Fix the build", [tool("Bash", '{"command":"bun test"}')], false)],
  })
  expect(sent.at(-1)).toMatchObject({
    kind: "quiet",
    delegationId: "d1",
    content: expect.stringContaining("Bash"),
  })
  const before = sent.length
  // Not again so soon.
  voice.observe({
    summary: summary(),
    turns: [turn("Fix the build", [tool("Bash", "a"), tool("Edit", "b")], false)],
  })
  expect(sent).toHaveLength(before)
  tick(ProgressEveryMs)
  voice.observe({
    summary: summary(),
    turns: [
      turn("Fix the build", [text("Looking."), tool("Edit", "b"), text("Fixed: a typo.")], true),
    ],
  })
  expect(sent.at(-1)).toEqual({
    kind: "say",
    id: expect.any(String),
    delegationId: "d1",
    content: "The agent finished. Its answer: Fixed: a typo.",
  })
  // Once.
  const after = sent.length
  voice.observe({ summary: summary(), turns: [turn("Fix the build", [text("x")], true)] })
  expect(sent).toHaveLength(after)
})

test("the agent's question is put to the person, and their answer replies to it", () => {
  const { voice, sent, prompts, replies } = bridge()
  const question = {
    turnId: "t",
    toolCallId: "q1",
    questions: [
      {
        question: "Which database?",
        header: "DB",
        options: [{ label: "Postgres" }, { label: "SQLite" }],
        multiSelect: false,
      },
    ],
    askedAt: 1,
  } as unknown as OpenQuestion
  voice.observe({ summary: summary({ openQuestion: question }), turns: [] })
  expect(sent.at(-1)).toMatchObject({
    kind: "say",
    content: expect.stringContaining("Which database? (options: Postgres, SQLite)"),
  })
  voice.heard("SQLite please")
  voice.delegated("d1")
  expect(replies).toEqual(["SQLite please"])
  expect(prompts).toEqual([])
})

test("the work GPT-Live names, through ChatGPT, is the prompt over what was heard", () => {
  const { voice, prompts } = bridge()
  voice.heard(" yes")
  voice.delegated("d1", "Use SQLite for the cache")
  expect(prompts).toEqual(["Use SQLite for the cache"])
})

test("GPT-Live's two protocols, each way", () => {
  const quiet = { kind: "quiet", id: "k1", delegationId: "d1", content: "working" } as const
  expect(wireEvent("Live", quiet)).toEqual({
    type: "session.thinking.append",
    event_id: "k1",
    delegation_id: "d1",
    content: "working",
  })
  expect(wireEvent("Codex", { ...quiet, kind: "say" })).toEqual({
    type: "delegation.context.append",
    delegation_item_id: "d1",
    channel: "speakable",
    content: [{ type: "input_text", text: "working" }],
  })
  expect(wireEvent("Codex", { ...quiet, delegationId: null })).toMatchObject({
    type: "session.context.append",
    channel: "commentary",
  })

  expect(
    heardEvent("Live", JSON.stringify({ type: "session.input_transcript.delta", delta: "hi" })),
  ).toEqual({ kind: "heard", text: "hi" })
  expect(
    heardEvent(
      "Live",
      JSON.stringify({
        type: "session.delegation.created",
        delegation: { id: "d1", type: "delegation", target: "client" },
      }),
    ),
  ).toEqual({ kind: "delegated", id: "d1" })
  expect(
    heardEvent("Codex", JSON.stringify({ type: "input_transcript.added", item: { text: "hi" } })),
  ).toEqual({ kind: "heard", text: " hi" })
  expect(
    heardEvent(
      "Codex",
      JSON.stringify({
        type: "delegation.created",
        item: {
          type: "delegation",
          target: "client",
          id: "d2",
          content: [{ type: "input_text", text: "Run the tests" }],
        },
      }),
    ),
  ).toEqual({ kind: "delegated", id: "d2", asked: "Run the tests" })
  // Each protocol's own events only.
  expect(
    heardEvent("Codex", JSON.stringify({ type: "session.input_transcript.delta", delta: "x" })),
  ).toBeUndefined()
})

test("the Turn is followed by its prompt's id from the queue, whatever text it starts with", () => {
  const { voice, sent } = bridge()
  const creator = { id: "dev:alice", login: "alice", name: "Alice" }
  const withCreator = summary({ creator } as never)
  voice.observe({ summary: withCreator, turns: [] })
  voice.heard("Fix the build")
  voice.delegated("d1")
  // Queued as Alice's, with its id.
  voice.observe({
    summary: withCreator,
    turns: [],
    queue: [{ id: "p1", text: "Fix the build", sender: creator, queuedAt: 1 } as never],
  })
  // Its Turn says something else, but carries the id.
  voice.observe({
    summary: withCreator,
    turns: [
      {
        ...turn("[Alice] Fix the build, please", [text("Done.")], true),
        turnId: "t-1",
        promptId: "p1",
      } as TurnView,
    ],
  })
  expect(sent.at(-1)).toMatchObject({
    kind: "say",
    content: "The agent finished. Its answer: Done.",
  })
})

test("a prompt riding in a background agent's notification is found by its text", () => {
  const { voice, sent } = bridge()
  voice.observe({ summary: summary(), turns: [] })
  voice.heard("Run the tests")
  voice.delegated("d1")
  const notification = `<task-notification><task-id>a1</task-id></task-notification>\n\nRun the tests`
  voice.observe({
    summary: summary(),
    turns: [{ ...turn(notification, [text("All pass.")], true), turnId: "t-2" } as TurnView],
  })
  expect(sent.at(-1)).toMatchObject({
    kind: "say",
    content: "The agent finished. Its answer: All pass.",
  })
})

test("an older Turn with the same words isn't taken for the new one", () => {
  const { voice, sent } = bridge()
  const old = { ...turn("Run the tests", [text("Old answer.")], true), turnId: "t-old" } as TurnView
  voice.observe({ summary: summary(), turns: [old] })
  voice.heard("Run the tests")
  voice.delegated("d1")
  const before = sent.length
  voice.observe({ summary: summary(), turns: [old] })
  expect(sent).toHaveLength(before)
  voice.observe({
    summary: summary(),
    turns: [
      old,
      { ...turn("Run the tests", [text("New answer.")], true), turnId: "t-new" } as TurnView,
    ],
  })
  expect(sent.at(-1)).toMatchObject({ content: "The agent finished. Its answer: New answer." })
})
