// hub-link-commands in Claude Code's own mod runtime (`claude plugin test`): Open questions
// (#193) answered from the web UI or at the terminal. Apart from register.test.ts, as a file of
// more than 20 tests hangs (see support.ts).

import { describe, expect, mock, test } from "claude-code/testing"
import { ada, askedSession, linkedSession } from "./support.ts"

describe("Open questions (#193)", () => {
  /** What the dialog's call ends with once its Turn is stopped. */
  const refused = "Error: The user doesn't want to proceed with this tool use."
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
  const asked = {
    _tag: "QuestionAsked",
    turnId: "t1",
    questions: [
      {
        question: "Which library?",
        header: "Library",
        options: [
          { label: "date-fns", description: "Small and familiar" },
          { label: "Temporal", description: "The platform's own" },
        ],
        multiSelect: false,
      },
    ],
  }

  test("a Participant's answer is Claude's, and closes the dialog", async ($, on) => {
    const { dialog, posted } = askedSession(on, {
      _tag: "Answered",
      answers: { "Which library?": "Temporal" },
    })
    const clock = mock.clock(on)

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    await $.turn.start({ turnId: "t1", text: "Pick a date library." } as never)
    const call = $.tool.call({ tool: "AskUserQuestion", questions } as never)
    await clock.advance(200)

    expect(await call).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          answers: { "Which library?": "Temporal" },
          annotations: {},
        }),
      }),
    )
    expect(dialog.signal?.aborted).toBe(true)
    expect(posted()).toEqual([
      { ...asked, toolCallId: dialog.id },
      {
        _tag: "QuestionClosed",
        turnId: "t1",
        toolCallId: dialog.id,
        outcome: { _tag: "Answered", answers: { "Which library?": "Temporal" } },
        by: ada,
      },
    ])
  })

  test("one dismissed is refused, as Esc refuses it", async ($, on) => {
    const { dialog, posted } = askedSession(on, { _tag: "Dismissed" })
    const clock = mock.clock(on)

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    await $.turn.start({ turnId: "t1", text: "Pick a date library." } as never)
    const call = $.tool.call({ tool: "AskUserQuestion", questions } as never)
    await clock.advance(200)

    expect(await call).toEqual(
      expect.objectContaining({
        deny: expect.stringContaining("The user doesn't want to proceed with this tool use."),
      }),
    )
    expect(posted().at(-1)).toEqual({
      _tag: "QuestionClosed",
      turnId: "t1",
      toolCallId: dialog.id,
      outcome: { _tag: "Dismissed" },
      by: ada,
    })
  })

  test("one answered at the terminal first is reported, and a later one refused", async ($, on) => {
    const atTerminal = {
      result: { questions, answers: { "Which library?": "date-fns" }, annotations: {} },
    }
    const { dialog, posted } = askedSession(on, { _tag: "Replied", text: "Neither" }, atTerminal)
    const clock = mock.clock(on)

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    await $.turn.start({ turnId: "t1", text: "Pick a date library." } as never)
    const done = await $.tool.call({ tool: "AskUserQuestion", questions } as never)
    await clock.advance(200)

    expect(done).toEqual(expect.objectContaining(atTerminal))
    expect(posted()).toEqual([
      { ...asked, toolCallId: dialog.id },
      {
        _tag: "QuestionClosed",
        turnId: "t1",
        toolCallId: dialog.id,
        outcome: { _tag: "Answered", answers: { "Which library?": "date-fns" } },
      },
      {
        _tag: "AnswerFailed",
        toolCallId: dialog.id,
        senderId: "p1",
        message: "The question was answered or closed already.",
      },
    ])
  })

  test("one dismissed with Esc at the terminal, which stops the Turn, is dismissed (#206)", async ($, on) => {
    const escaped = { isError: true, result: refused }
    const { dialog, posted } = askedSession(on, { _tag: "Dismissed" }, escaped)
    const clock = mock.clock(on)

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    await $.turn.start({ turnId: "t1", text: "Pick a date library." } as never)
    await $.tool.call({ tool: "AskUserQuestion", questions } as never)
    await clock.advance(200)

    expect(posted()[1]).toEqual({
      _tag: "QuestionClosed",
      turnId: "t1",
      toolCallId: dialog.id,
      outcome: { _tag: "Dismissed" },
    })
  })

  test("one whose Turn is stopped from the web UI is cancelled (#206)", async ($, on) => {
    let opened: (() => void) | undefined
    const { posted } = linkedSession(
      on,
      [{ _tag: "StopTurn", sessionId: "s1" }],
      new Promise((resolve) => (opened = resolve)),
    )
    const clock = mock.clock(on)
    on("turn.start", (_, e) => ({ turnId: e.turnId }))
    // Claude Code's Stop ends the dialog's call refused, as Esc does.
    let stop: (() => void) | undefined
    on("turn.abort", () => {
      stop?.()
      return { value: undefined }
    })
    on("tool.call", () => {
      opened?.()
      return new Promise((resolve) => {
        stop = () => resolve({ isError: true, result: refused })
      }) as never
    })

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    await $.turn.start({ turnId: "t1", text: "Pick a date library." } as never)
    await $.tool.call({ tool: "AskUserQuestion", questions } as never)
    await clock.advance(200)

    expect(posted()[1]).toEqual({
      _tag: "QuestionClosed",
      turnId: "t1",
      toolCallId: expect.any(String),
      outcome: { _tag: "Cancelled" },
    })
  })

  test("one whose dialog timed out on its own is cancelled, not skipped at the terminal (#206)", async ($, on) => {
    const timedOut = { result: { questions, answers: {}, afkTimeoutMs: 60_000 } }
    const { dialog, posted } = askedSession(on, { _tag: "Dismissed" }, timedOut)
    const clock = mock.clock(on)

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    await $.turn.start({ turnId: "t1", text: "Pick a date library." } as never)
    const done = await $.tool.call({ tool: "AskUserQuestion", questions } as never)
    await clock.advance(200)

    expect(done).toEqual(expect.objectContaining(timedOut))
    expect(posted()[1]).toEqual({
      _tag: "QuestionClosed",
      turnId: "t1",
      toolCallId: dialog.id,
      outcome: { _tag: "Cancelled" },
    })
  })

  test("one asked with no Turn on the main loop, a background agent's, is the terminal's alone", async ($, on) => {
    const { posted } = askedSession(on, { _tag: "Dismissed" })
    const clock = mock.clock(on)

    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    void $.tool.call({ tool: "AskUserQuestion", questions } as never)
    await clock.advance(200)

    expect(posted()).toEqual([expect.objectContaining({ _tag: "AnswerFailed", senderId: "p1" })])
  })
})
