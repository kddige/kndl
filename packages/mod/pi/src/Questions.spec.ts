import { describe, expect, test } from "bun:test"
import { ModCommand, ModEvent } from "@kndl/protocol"
import type { Question } from "@kndl/protocol"
import { Schema } from "effect"
import { askAtTerminal, questionResultText, Questions } from "./Questions.ts"
import type { DialogUI } from "./Questions.ts"

const ada = { id: "p1", login: "ada", name: "Ada Lovelace" }

const questions: ReadonlyArray<Question> = [
  {
    question: "Which date library?",
    header: "Library",
    options: [{ label: "date-fns", description: "Small and modular" }, { label: "Luxon" }],
    multiSelect: false,
  },
  { question: "Anything else?", header: "Notes", options: [], multiSelect: false },
]

/** A DeliverAnswer as the Hub sends it. */
const answerCommand = (toolCallId: string, answer: Record<string, unknown>) => {
  const command = Schema.decodeUnknownSync(ModCommand)({
    _tag: "DeliverAnswer",
    sessionId: "s1",
    toolCallId,
    answer,
    sender: ada,
  })
  if (command._tag !== "DeliverAnswer") throw new Error("not an answer")
  return command
}

const tracker = () => {
  const events: Array<Record<string, unknown>> = []
  return { questions: new Questions({ report: (event) => events.push(event) }), events }
}

/** Every event decodes as the protocol has it. */
const valid = (events: ReadonlyArray<unknown>) =>
  events.every((event) =>
    Schema.is(Schema.toType(ModEvent))(Schema.decodeUnknownSync(ModEvent)(event)),
  )

describe("what the model reads of an answer", () => {
  test("answered: each question's chosen answer, by who answered", () => {
    expect(
      questionResultText(questions, {
        outcome: { _tag: "Answered", answers: { "Which date library?": "date-fns" } },
        by: ada,
      }),
    ).toBe(
      [
        "Ada Lovelace answered your questions:",
        '- "Which date library?": date-fns',
        '- "Anything else?": (no answer)',
        "Continue with these answers in mind.",
      ].join("\n"),
    )
  })

  test("answered at the terminal, by the person there", () => {
    expect(
      questionResultText(questions.slice(0, 1), {
        outcome: { _tag: "Answered", answers: { "Which date library?": "Luxon" } },
      }),
    ).toStartWith("The person at the terminal answered your questions:\n")
  })

  test("replied: what they said instead, as a prompt reads, with their files' markers", () => {
    expect(
      questionResultText(questions, {
        outcome: {
          _tag: "Replied",
          text: "Neither, use Temporal",
          attachments: [{ id: "att-1", name: "shot.png", mediaType: "image/png", size: 70 }],
        },
        by: ada,
      }),
    ).toBe(
      [
        "Ada Lovelace didn't pick an answer, and replied instead:",
        "[Ada Lovelace] Neither, use Temporal\n[Image #1: shot.png (attachment att-1)]",
        "Follow what they said.",
      ].join("\n"),
    )
  })

  test("dismissed: that they won't answer, and to wait for them", () => {
    expect(questionResultText(questions, { outcome: { _tag: "Dismissed" }, by: ada })).toBe(
      "Ada Lovelace dismissed the questions without answering. Stop what you are doing and wait for them to tell you how to proceed.",
    )
  })
})

describe("an Open question (#193)", () => {
  test("is reported asked, and the Creator's answer closes it, by them, and is what the call returns", async () => {
    const { questions: open, events } = tracker()
    const asked = open.ask({ turnId: "t1", toolCallId: "call-1", questions })
    expect(events).toEqual([
      { _tag: "QuestionAsked", turnId: "t1", toolCallId: "call-1", questions },
    ])
    open.answer(answerCommand("call-1", { _tag: "Answered", answers: { "Anything else?": "no" } }))
    expect(await asked).toEqual({
      outcome: { _tag: "Answered", answers: { "Anything else?": "no" } },
      by: ada,
    })
    expect(events.at(-1)).toEqual({
      _tag: "QuestionClosed",
      turnId: "t1",
      toolCallId: "call-1",
      outcome: { _tag: "Answered", answers: { "Anything else?": "no" } },
      by: ada,
    })
    expect(valid(events)).toBe(true)
  })

  test("a second answer, or one to a question never asked, comes too late", async () => {
    const { questions: open, events } = tracker()
    const asked = open.ask({ turnId: "t1", toolCallId: "call-1", questions })
    open.answer(answerCommand("call-1", { _tag: "Dismissed" }))
    await asked
    open.answer(answerCommand("call-1", { _tag: "Replied", text: "wait" }))
    open.answer(answerCommand("call-9", { _tag: "Dismissed" }))
    expect(events.slice(2)).toEqual([
      {
        _tag: "AnswerFailed",
        toolCallId: "call-1",
        senderId: "p1",
        message: "The question was answered or closed already.",
      },
      {
        _tag: "AnswerFailed",
        toolCallId: "call-9",
        senderId: "p1",
        message: "The question was answered or closed already.",
      },
    ])
    expect(valid(events)).toBe(true)
  })

  test("a stopped Turn cancels it, and an answer after comes too late", async () => {
    const { questions: open, events } = tracker()
    const stop = new AbortController()
    const asked = open.ask({ turnId: "t1", toolCallId: "call-1", questions, signal: stop.signal })
    stop.abort()
    expect(await asked).toEqual({ outcome: { _tag: "Cancelled" } })
    open.answer(answerCommand("call-1", { _tag: "Dismissed" }))
    expect(events.map((event) => event._tag)).toEqual([
      "QuestionAsked",
      "QuestionClosed",
      "AnswerFailed",
    ])
    expect(events[1]).toEqual({
      _tag: "QuestionClosed",
      turnId: "t1",
      toolCallId: "call-1",
      outcome: { _tag: "Cancelled" },
    })
  })

  test("one asked in a Turn already stopped is cancelled at once", async () => {
    const { questions: open } = tracker()
    const asked = open.ask({
      turnId: "t1",
      toolCallId: "call-1",
      questions,
      signal: AbortSignal.abort(),
    })
    expect(await asked).toEqual({ outcome: { _tag: "Cancelled" } })
  })

  test("answered at the terminal first: closed with no one named, and the Creator's answer then comes too late", async () => {
    const { questions: open, events } = tracker()
    const asked = open.ask({
      turnId: "t1",
      toolCallId: "call-1",
      questions,
      terminal: async () => ({ _tag: "Answered", answers: { "Anything else?": "typed" } }),
    })
    expect(await asked).toEqual({
      outcome: { _tag: "Answered", answers: { "Anything else?": "typed" } },
    })
    open.answer(answerCommand("call-1", { _tag: "Dismissed" }))
    expect(events.slice(1).map((event) => event._tag)).toEqual(["QuestionClosed", "AnswerFailed"])
    expect(events[1]).not.toHaveProperty("by")
  })

  test("answered from the web first: the terminal's dialog is closed", async () => {
    const { questions: open } = tracker()
    let dialog: AbortSignal | undefined
    const asked = open.ask({
      turnId: "t1",
      toolCallId: "call-1",
      questions,
      terminal: (_questions, signal) => {
        dialog = signal
        return new Promise((resolve) => signal.addEventListener("abort", () => resolve(undefined)))
      },
    })
    open.answer(answerCommand("call-1", { _tag: "Dismissed" }))
    expect(await asked).toEqual({ outcome: { _tag: "Dismissed" }, by: ada })
    expect(dialog?.aborted).toBe(true)
  })

  test("with no Turn to report it in, it is answered at the terminal alone", async () => {
    const { questions: open, events } = tracker()
    const asked = open.ask({
      turnId: undefined,
      toolCallId: "call-1",
      questions,
      terminal: async () => ({ _tag: "Dismissed" }),
    })
    expect(await asked).toEqual({ outcome: { _tag: "Dismissed" } })
    expect(events).toEqual([])
  })
})

/** A UI that answers each dialog in turn, recording what it was asked. */
const scripted = (replies: Array<string | undefined>) => {
  const asked: Array<{ kind: string; title: string; options?: Array<string> }> = []
  const ui: DialogUI = {
    select: async (title, options) => {
      asked.push({ kind: "select", title, options })
      return replies.shift()
    },
    input: async (title) => {
      asked.push({ kind: "input", title })
      return replies.shift()
    },
  }
  return { ui, asked }
}

describe("asking at pi's own terminal", () => {
  test("each question in turn: a pick of its options or one's own words, and free text for one with none", async () => {
    const { ui, asked } = scripted(["Type an answer…", "Temporal", "nothing"])
    const outcome = await askAtTerminal(ui, questions, new AbortController().signal)
    expect(outcome).toEqual({
      _tag: "Answered",
      answers: { "Which date library?": "Temporal", "Anything else?": "nothing" },
    })
    expect(asked).toEqual([
      {
        kind: "select",
        title: "Library: Which date library?",
        options: ["date-fns — Small and modular", "Luxon", "Type an answer…"],
      },
      { kind: "input", title: "Library: Which date library?" },
      { kind: "input", title: "Notes: Anything else?" },
    ])
  })

  test("a picked option answers with its label", async () => {
    const { ui } = scripted(["date-fns — Small and modular", ""])
    expect(await askAtTerminal(ui, questions, new AbortController().signal)).toEqual({
      _tag: "Answered",
      answers: { "Which date library?": "date-fns" },
    })
  })

  test("Esc dismisses the questions", async () => {
    const { ui } = scripted([undefined])
    expect(await askAtTerminal(ui, questions, new AbortController().signal)).toEqual({
      _tag: "Dismissed",
    })
  })

  test("a dialog closed because the question was answered elsewhere answers nothing", async () => {
    const closed = new AbortController()
    closed.abort()
    const { ui } = scripted([undefined])
    expect(await askAtTerminal(ui, questions, closed.signal)).toBeUndefined()
  })
})
