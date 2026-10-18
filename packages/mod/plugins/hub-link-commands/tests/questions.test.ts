// hub-link-commands in Claude Code's own mod runtime (`claude plugin test`): Open questions
// (#193) asked with the question tool, which replaces AskUserQuestion, answered from the web UI or
// at the terminal; and the ones asked `async`. Apart from register.test.ts, as a file of more than
// 20 tests hangs (see support.ts).

import type { On } from "claude-code"
import { describe, expect, mock, test } from "claude-code/testing"
import type { Engine } from "claude-code/testing"
import {
  ada,
  answeredSession,
  deliveredWrites,
  linkedSession,
  questionId,
  questionTool,
} from "./support.ts"

const questions = [
  {
    question: "Which library?",
    header: "Library",
    options: [
      { label: "date-fns", description: "Small and familiar" },
      { label: "Temporal", description: "The platform's own" },
    ],
    multiSelect: false,
  },
]

const asked = { _tag: "QuestionAsked", turnId: "t1", toolCallId: questionId, questions }

/** The text a call of the tool ends with. */
const said = (done: { readonly result?: unknown }) =>
  (Array.isArray(done.result) ? done.result : [])
    .map((block: { readonly text?: string }) => block.text ?? "")
    .join("\n")

/** Starts a Turn that asks, then has the Hub answer. */
const ask = async ($: Engine, on: On, answers: Array<Record<string, unknown>>) => {
  const { posted, release } = answeredSession(on, answers)
  const clock = mock.clock(on)
  await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
  await clock.advance(0)
  await $.turn.start({ turnId: "t1", text: "Pick a date library." } as never)
  const call = $.tool.call({ tool: questionTool, tool_use_id: questionId, questions } as never)
  release()
  await clock.advance(200)
  return { call, posted }
}

describe("Open questions (#193)", () => {
  test("a Participant's answer is Claude's result", async ($, on) => {
    const { call, posted } = await ask($, on, [
      { _tag: "Answered", answers: { "Which library?": "Temporal" } },
    ])

    const done = await call
    expect(said(done)).toContain("Ada Lovelace answered your questions:")
    expect(said(done)).toContain('- "Which library?": Temporal')
    expect(posted()).toEqual([
      asked,
      {
        _tag: "QuestionClosed",
        turnId: "t1",
        toolCallId: questionId,
        outcome: { _tag: "Answered", answers: { "Which library?": "Temporal" } },
        by: ada,
      },
    ])
  })

  test("one dismissed tells Claude to stop and wait", async ($, on) => {
    const { call, posted } = await ask($, on, [{ _tag: "Dismissed" }])

    expect(said(await call)).toContain("Ada Lovelace dismissed the questions without answering")
    expect(posted().at(-1)).toEqual({
      _tag: "QuestionClosed",
      turnId: "t1",
      toolCallId: questionId,
      outcome: { _tag: "Dismissed" },
      by: ada,
    })
  })

  test("a reply is what Claude reads, with its sender's name", async ($, on) => {
    const { call } = await ask($, on, [{ _tag: "Replied", text: "Neither, use Intl" }])

    const done = await call
    expect(said(done)).toContain("Ada Lovelace didn't pick an answer, and replied instead:")
    expect(said(done)).toContain("[Ada Lovelace] Neither, use Intl")
  })

  test("a second answer is refused, saying the question closed already", async ($, on) => {
    const { call, posted } = await ask($, on, [
      { _tag: "Answered", answers: { "Which library?": "Temporal" } },
      { _tag: "Dismissed" },
    ])

    await call
    expect(posted().map((event) => (event as { _tag: string })._tag)).toEqual([
      "QuestionAsked",
      "QuestionClosed",
      "AnswerFailed",
    ])
    expect(posted().at(-1)).toEqual({
      _tag: "AnswerFailed",
      toolCallId: questionId,
      senderId: "p1",
      message: "The question was answered or closed already.",
    })
  })

  test("a subagent's question, or one with no Turn on the main loop, is refused and not reported", async ($, on) => {
    const { posted } = linkedSession(on)
    const clock = mock.clock(on)
    on("turn.start", (_, e) => ({ turnId: e.turnId }))
    on("turn.complete", (_, e) => ({ text: e.answer }))

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    const noTurn = await $.tool.call({ tool: questionTool, questions } as never)
    await $.turn.start({ turnId: "t1", text: "Pick a date library." } as never)
    const subagent = await $.tool.call({
      tool: questionTool,
      agentId: "agent-1",
      questions,
    } as never)
    await clock.advance(200)

    expect(noTurn).toEqual(expect.objectContaining({ deny: expect.stringContaining("linked") }))
    expect(subagent).toEqual(
      expect.objectContaining({
        deny: "Subagents can't ask the people in this session questions.",
      }),
    )
    expect(posted()).toEqual([])
  })
})

describe("an async question", () => {
  const answer = {
    _tag: "DeliverAnswer",
    sessionId: "s1",
    toolCallId: questionId,
    answer: { _tag: "Answered", answers: { "Which library?": "Temporal" } },
    sender: ada,
  }
  const closed = {
    _tag: "QuestionClosed",
    turnId: "t1",
    toolCallId: questionId,
    outcome: { _tag: "Answered", answers: { "Which library?": "Temporal" } },
    by: ada,
  }

  test("returns at once, and is reported async", async ($, on) => {
    const { posted } = linkedSession(on)
    const clock = mock.clock(on)
    on("turn.start", (_, e) => ({ turnId: e.turnId }))
    on("turn.complete", (_, e) => ({ text: e.answer }))

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    await $.turn.start({ turnId: "t1", text: "Pick a date library." } as never)
    const done = await $.tool.call({
      tool: questionTool,
      tool_use_id: questionId,
      questions,
      async: true,
    } as never)
    await clock.advance(200)

    expect(said(done)).toContain("Don't wait or poll for the answer")
    expect(posted()).toEqual([{ ...asked, async: true }])
  })

  test("its answer is a note Claude reads at its next step, while a Turn runs", async ($, on) => {
    let release: (() => void) | undefined
    const { posted } = linkedSession(on, [answer], new Promise((resolve) => (release = resolve)))
    const clock = mock.clock(on)
    const session = mock.session(on)
    on("turn.start", (_, e) => ({ turnId: e.turnId }))
    on("turn.complete", (_, e) => ({ text: e.answer }))

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    await $.turn.start({ turnId: "t1", text: "Pick a date library." } as never)
    await $.tool.call({
      tool: questionTool,
      tool_use_id: questionId,
      questions,
      async: true,
    } as never)
    release?.()
    await clock.advance(200)

    expect(session.appended()).toEqual([
      expect.objectContaining({
        door: "note",
        message: {
          type: "user",
          content: [
            {
              type: "text",
              text: expect.stringContaining(
                "Ada Lovelace answered the questions you asked earlier:",
              ),
            },
          ],
        },
      }),
    ])
    expect(posted()).toEqual([{ ...asked, async: true }, closed])
  })

  test("its answer, once the Turn has ended, starts a Turn of its own from whoever gave it", async ($, on) => {
    let release: (() => void) | undefined
    linkedSession(on, [answer], new Promise((resolve) => (release = resolve)))
    const clock = mock.clock(on)
    const writes = deliveredWrites(on)
    const submitted: Array<string> = []
    on("turn.start", (_, e) => ({ turnId: e.turnId }))
    on("turn.complete", (_, e) => ({ text: e.answer }))
    on("prompt.submit", (_, e) => {
      submitted.push(e.text)
      return { text: e.text }
    })

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    await $.turn.start({ turnId: "t1", text: "Pick a date library." } as never)
    await $.tool.call({
      tool: questionTool,
      tool_use_id: questionId,
      questions,
      async: true,
    } as never)
    await $.turn.complete({
      turnId: "t1",
      reason: "answer",
      answer: "Asked.",
      durationMs: 1,
      isAborted: false,
    } as never)
    release?.()
    await clock.advance(200)

    expect(submitted).toEqual([
      expect.stringContaining("Ada Lovelace answered the questions you asked earlier:"),
    ])
    expect(writes).toEqual([{ promptId: `answer-${questionId}`, sender: ada, text: submitted[0] }])
  })

  test("is still open when its Turn ends, and refuses another question meanwhile", async ($, on) => {
    const { posted } = linkedSession(on)
    const clock = mock.clock(on)
    on("turn.start", (_, e) => ({ turnId: e.turnId }))
    on("turn.complete", (_, e) => ({ text: e.answer }))

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    await $.turn.start({ turnId: "t1", text: "Pick a date library." } as never)
    await $.tool.call({
      tool: questionTool,
      tool_use_id: questionId,
      questions,
      async: true,
    } as never)
    await $.turn.complete({
      turnId: "t1",
      reason: "answer",
      answer: "Asked.",
      durationMs: 1,
      isAborted: false,
    } as never)
    await $.turn.start({ turnId: "t2", text: "Go on." } as never)
    const again = await $.tool.call({
      tool: questionTool,
      tool_use_id: "toolu_q2",
      questions,
    } as never)
    await clock.advance(200)

    expect(said(again)).toContain("still waiting for an answer")
    expect(posted()).toEqual([{ ...asked, async: true }])
  })
})
