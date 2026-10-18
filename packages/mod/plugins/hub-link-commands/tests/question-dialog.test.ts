// hub-link-commands in Claude Code's own mod runtime (`claude plugin test`): the question dialog
// the plugin draws in the terminal (#193, ADR 0031), a pane beside the web UI's: whichever answers
// first wins. Apart from questions.test.ts, as a file of more than 20 tests hangs (see support.ts).

import type { On } from "claude-code"
import { describe, expect, mock, test } from "claude-code/testing"
import type { Engine } from "claude-code/testing"
import {
  ada,
  answeredSession,
  deliveredWrites,
  linkedSession,
  paneProps,
  questionId,
  questionPane,
  questionTool,
  terminal,
} from "./support.ts"

const library = {
  question: "Which library?",
  header: "Library",
  options: [
    { label: "date-fns", description: "Small and familiar" },
    { label: "Temporal", description: "The platform's own" },
  ],
  multiSelect: false,
}
const features = {
  question: "Which features?",
  header: "Features",
  options: [{ label: "Zones" }, { label: "Durations" }, { label: "Calendars, other" }],
  multiSelect: true,
}

/** The text a call of the tool ends with. */
const said = (done: { readonly result?: unknown }) =>
  (Array.isArray(done.result) ? done.result : [])
    .map((block: { readonly text?: string }) => block.text ?? "")
    .join("\n")

/** The person typing /question. */
const typedQuestion = {
  command: "question",
  args: "",
  origin: { kind: "composer" },
  presentation: { isFullscreen: false, columns: 120 },
} as never

const webAnswer = {
  _tag: "DeliverAnswer",
  sessionId: "s1",
  toolCallId: questionId,
  answer: { _tag: "Answered", answers: { "Which library?": "date-fns" } },
  sender: ada,
}

/**
 * A session whose Turn asks `questions` (async or not), with the Hub's `commands` delivered once
 * `release` is called. The call is not awaited: a blocking one waits for its answer.
 */
const asking = async (
  $: Engine,
  on: On,
  questions: Array<Record<string, unknown>>,
  options: { async?: boolean; narrow?: true; commands?: Array<Record<string, unknown>> } = {},
) => {
  let release: (() => void) | undefined
  const hub = linkedSession(
    on,
    options.commands ?? [],
    new Promise((resolve) => (release = resolve)),
  )
  const panes = terminal(on)
  if (options.narrow) panes.placed.is = false
  const clock = mock.clock(on)
  on("turn.start", (_, e) => ({ turnId: e.turnId }))
  on("turn.complete", (_, e) => ({ text: e.answer }))
  await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
  await clock.advance(0)
  await $.turn.start({ turnId: "t1", text: "Pick a date library." } as never)
  const call = $.tool.call({
    tool: questionTool,
    tool_use_id: questionId,
    questions,
    ...(options.async && { async: true }),
  } as never)
  await clock.advance(10)
  const pane = () =>
    $.ui.mount({
      plugin: "hub-link-commands",
      surface: "terminal",
      component: "Pane",
      requestId: questionPane,
      props: paneProps,
    })
  return { ...hub, ...panes, call, clock, pane, release: () => release?.() }
}

const eventTags = (posted: () => Array<unknown>) =>
  posted().map((event) => (event as { _tag: string })._tag)

describe("the question pane", () => {
  test("opens when Claude asks, to take the keyboard", async ($, on) => {
    const { opened, toasts } = await asking($, on, [library])

    expect(opened).toEqual([
      expect.objectContaining({
        id: questionPane,
        title: "Question",
        focus: true,
      }),
    ])
    expect(opened[0]).not.toHaveProperty("closeOnEscape")
    expect(toasts).toEqual([])
  })

  test("tells the person to type /question, or widen the terminal, when it waits undrawn", async ($, on) => {
    const { toasts, opened } = await asking($, on, [library], { narrow: true })

    expect(opened).toHaveLength(1)
    expect(toasts).toEqual(["The agent has a question: type /question, or widen the terminal."])
  })

  test("draws the question, its options and the way to answer another way", async ($, on) => {
    const { pane } = await asking($, on, [library])
    const ui = await pane()

    expect(await ui.find({ text: /Library: Which library\?/ })).toBeDefined()
    expect(await ui.find({ key: "option-0" })).toMatchObject({ type: "Button" })
    expect(await ui.find({ text: /2\. Temporal/ })).toBeDefined()
    expect(await ui.find({ text: /The platform's own/ })).toBeDefined()
    expect(await ui.find({ key: "other" })).toMatchObject({ type: "Input" })
    expect(await ui.find({ key: "skip" })).toBeDefined()
    expect(await ui.find({ text: /waits for your answer, here or in the web UI/ })).toBeDefined()
  })

  test("says the agent works on meanwhile, of an async question", async ($, on) => {
    const { pane } = await asking($, on, [library], { async: true })

    expect(await (await pane()).find({ text: /works on meanwhile/ })).toBeDefined()
  })

  test("pressing an option answers for the person at the terminal, and closes the pane", async ($, on) => {
    const { call, pane, posted, closed, clock } = await asking($, on, [library])
    const ui = await pane()

    await ui.press({ key: "option-1" })
    const done = await call
    await clock.advance(200)

    expect(said(done)).toContain("The person at the terminal answered your questions:")
    expect(said(done)).toContain('- "Which library?": Temporal')
    // Without a `by`, since no Participant answered.
    expect(posted().at(-1)).toEqual({
      _tag: "QuestionClosed",
      turnId: "t1",
      toolCallId: questionId,
      outcome: { _tag: "Answered", answers: { "Which library?": "Temporal" } },
    })
    expect(closed).toEqual([{ id: questionPane, origin: "plugin" }])
  })

  test("text typed in the field answers, and skipping leaves a question unanswered", async ($, on) => {
    const { call, pane } = await asking($, on, [library, { ...library, question: "Which zone?" }])
    const ui = await pane()

    await ui.input({ key: "other", text: "  Intl  " })
    await ui.press({ key: "skip" })
    const done = await call

    expect(said(done)).toContain('- "Which library?": Intl')
    expect(said(done)).toContain('- "Which zone?": (no answer)')
  })

  test("picks of a multi-select question are joined, and sent with the last one's Submit", async ($, on) => {
    const { call, pane } = await asking($, on, [library, features])
    const ui = await pane()

    await ui.press({ key: "option-0" })
    expect(await ui.find({ text: /Features: Which features\? \(2 of 2\)/ })).toBeDefined()
    await ui.press({ key: "option-0" })
    await ui.press({ key: "option-2" })
    expect(await ui.find({ text: /\[x\] 3\. Calendars, other/ })).toBeDefined()
    await ui.press({ key: "next" })
    const done = await call

    expect(said(done)).toContain('- "Which library?": date-fns')
    expect(said(done)).toContain('- "Which features?": Zones, "Calendars, other"')
  })

  test("the Dismiss button dismisses the question for the person at the terminal", async ($, on) => {
    const { call, pane, posted, closed, clock } = await asking($, on, [library])
    const ui = await pane()

    expect(await ui.find({ key: "dismiss" })).toMatchObject({ type: "Button" })
    await ui.press({ key: "dismiss" })
    const done = await call
    await clock.advance(200)

    expect(said(done)).toContain("The person at the terminal dismissed the questions")
    expect(posted().at(-1)).toEqual({
      _tag: "QuestionClosed",
      turnId: "t1",
      toolCallId: questionId,
      outcome: { _tag: "Dismissed" },
    })
    expect(closed).toEqual([{ id: questionPane, origin: "plugin" }])
  })

  test("an answer from the web UI closes the pane, and dismisses nothing", async ($, on) => {
    const { call, closed, posted, release, clock } = await asking($, on, [library], {
      commands: [webAnswer],
    })

    release()
    await clock.advance(200)
    const done = await call

    expect(said(done)).toContain("Ada Lovelace answered your questions:")
    expect(closed).toEqual([{ id: questionPane, origin: "plugin" }])
    expect(eventTags(posted)).toEqual(["QuestionAsked", "QuestionClosed"])
  })

  test("an answer from the web UI after the pane's is told it came too late", async ($, on) => {
    const { call, pane, posted, release, clock } = await asking($, on, [library], {
      commands: [webAnswer],
    })
    const ui = await pane()

    await ui.press({ key: "option-0" })
    await call
    release()
    await clock.advance(200)

    expect(eventTags(posted)).toEqual(["QuestionAsked", "QuestionClosed", "AnswerFailed"])
    expect(posted().at(-1)).toEqual({
      _tag: "AnswerFailed",
      toolCallId: questionId,
      senderId: "p1",
      message: "The question was answered or closed already.",
    })
  })

  test("an async question answered in the pane gives Claude a note, from no Participant", async ($, on) => {
    const session = mock.session(on)
    const writes = deliveredWrites(on)
    const { call, pane, posted, closed, clock } = await asking($, on, [library], { async: true })
    const ui = await pane()

    expect(said(await call)).toContain("Don't wait or poll for the answer")
    await ui.press({ key: "option-0" })
    await clock.advance(200)

    expect(session.appended()).toEqual([
      expect.objectContaining({
        message: {
          type: "user",
          content: [
            {
              type: "text",
              text: expect.stringContaining(
                "The person at the terminal answered the questions you asked earlier:",
              ),
            },
          ],
        },
      }),
    ])
    // No sender to name, so hub-link reports the Turn as the terminal's.
    expect(writes).toEqual([])
    expect(posted().at(-1)).toEqual({
      _tag: "QuestionClosed",
      turnId: "t1",
      toolCallId: questionId,
      outcome: { _tag: "Answered", answers: { "Which library?": "date-fns" } },
    })
    expect(closed).toEqual([{ id: questionPane, origin: "plugin" }])
  })

  test("/question opens it again where it waited undrawn", async ($, on) => {
    const { placed, opened, toasts } = await asking($, on, [library], { narrow: true })
    expect(toasts).toHaveLength(1)
    opened.length = 0
    placed.is = true

    const reopened = await $.command.run(typedQuestion)

    expect(reopened.text).toBe("The question is open in a pane.")
    expect(opened).toEqual([expect.objectContaining({ id: questionPane, focus: true })])
  })

  test("/question says no question is open, with none", async ($, on) => {
    linkedSession(on)
    const clock = mock.clock(on)
    const { opened } = terminal(on)
    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)

    const none = await $.command.run(typedQuestion)

    expect(none.text).toBe("No question is open.")
    expect(opened).toEqual([])
  })
})

describe("with no pane", () => {
  test("the web UI answers all the same, and the pane draws none", async ($, on) => {
    const { posted, release } = answeredSession(on, [webAnswer.answer])
    // No terminal under the session: every pane call rejects, which must not fail the answer.
    const clock = mock.clock(on)
    await $.session.start({ cwd: "/tmp/session", surface: null, isInteractive: true })
    await clock.advance(0)
    await $.turn.start({ turnId: "t1", text: "Pick a date library." } as never)
    const call = $.tool.call({
      tool: questionTool,
      tool_use_id: questionId,
      questions: [library],
    } as never)
    release()
    await clock.advance(200)

    expect(said(await call)).toContain("Ada Lovelace answered your questions:")
    expect(eventTags(posted)).toEqual(["QuestionAsked", "QuestionClosed"])
    const pane = await $.ui.mount({
      plugin: "hub-link-commands",
      surface: "terminal",
      component: "Pane",
      requestId: questionPane,
      props: paneProps,
    })
    expect(await pane.find({ text: /No question is open\./ })).toBeDefined()
  })
})
