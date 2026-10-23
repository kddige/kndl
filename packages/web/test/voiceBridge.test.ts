import { expect, test } from "bun:test"
import type { OpenQuestion, SessionSummary } from "@kndl/protocol"
import type { TurnView } from "../src/hub/transcript.ts"
import { ProgressEveryMs, VoiceBridge, type VoiceEvent } from "../src/session/voiceBridge.ts"

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
  expect(sent.at(-1)).toMatchObject({ type: "session.thinking.append", delegation_id: "d1" })
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
    type: "session.thinking.append",
    delegation_id: "d1",
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
    type: "session.commentary.append",
    event_id: expect.any(String),
    delegation_id: "d1",
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
    type: "session.commentary.append",
    content: expect.stringContaining("Which database? (options: Postgres, SQLite)"),
  })
  voice.heard("SQLite please")
  voice.delegated("d1")
  expect(replies).toEqual(["SQLite please"])
  expect(prompts).toEqual([])
})
