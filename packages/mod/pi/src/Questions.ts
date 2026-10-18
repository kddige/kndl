// The question tool (ADR 0029, #193): pi has none, so kndl's extension adds `ask_user_question`,
// with the shape of Claude Code's AskUserQuestion that the protocol's Question has, so the web's
// Open question needs no change.
//
// A call is the Session's Open question until it closes: the Creator answers it from the web UI
// (DeliverAnswer), or the person at pi's own terminal does in a dialog; the first answer is the one
// the model reads, and one after it comes too late (AnswerFailed), as hub-link-commands has it. A
// stopped Turn cancels it.
//
// It takes pi's dialogs in a plain shape, so it runs under `bun test` without pi.

import { Type } from "@earendil-works/pi-ai/compat"
import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { Question, QuestionAnswer, QuestionOutcome } from "@kndl/protocol"
import { askedQuestions, deliveredPrompt } from "../../src/HubMessages.ts"
import type { Command, Sender } from "../../src/HubMessages.ts"

/** The tool's name, as the model calls it. */
export const questionTool = "ask_user_question"

/** What the model reads of the tool, whichever model it is. */
export const questionToolDescription = [
  "Asks the people in this session one to four questions, and waits for their answer.",
  "Use it when you need a decision or a fact only they have: to choose between approaches, to settle what an ambiguous request means, or to confirm something hard to undo. Don't ask what you can find out yourself, and don't ask for permission to do what you were asked to do.",
  "Give each question two to four options, or none for one answered in their own words. They can always answer in their own words instead of picking, or dismiss the questions.",
  "The result says what they chose, what they said instead, or that they dismissed the questions.",
].join(" ")

/** The tool's parameters: the protocol's Question, which the web shows as it is. */
export const questionParameters = Type.Object({
  questions: Type.Array(
    Type.Object({
      question: Type.String({
        description: "The complete question, ending with a question mark.",
      }),
      header: Type.String({
        description: 'A very short label for it, up to 12 characters, such as "Auth method".',
      }),
      options: Type.Array(
        Type.Object({
          label: Type.String({
            description: "What the option says, in a few words: it is also the answer.",
          }),
          description: Type.Optional(
            Type.String({ description: "What choosing it means, or what follows from it." }),
          ),
        }),
        {
          maxItems: 4,
          description:
            'Two to four distinct choices, or none for a free-text answer. Leave out "Other": an answer in their own words is always possible.',
        },
      ),
      multiSelect: Type.Boolean({
        description: "Whether several options may be picked, rather than one.",
      }),
    }),
    { minItems: 1, maxItems: 4, description: "The questions to ask, one to four." },
  ),
})

type Outcome = typeof QuestionOutcome.Encoded
type DeliverAnswer = Command<"DeliverAnswer">

/** How an Open question closed: its outcome, and who answered from the web UI, if anyone did. */
export interface Closed {
  readonly outcome: Outcome
  readonly by?: Sender | undefined
}

/** What the model reads once its questions closed. */
export const questionResultText = (
  questions: ReadonlyArray<Question>,
  { outcome, by }: Closed,
): string => {
  const who = by?.name ?? "The person at the terminal"
  switch (outcome._tag) {
    case "Answered": {
      const asked = new Set(questions.map((question) => question.question))
      const lines = [
        ...questions.map(
          ({ question }) => `- "${question}": ${outcome.answers[question] ?? "(no answer)"}`,
        ),
        // An answer keyed by a question the call didn't ask, which the web shouldn't send.
        ...Object.entries(outcome.answers)
          .filter(([question]) => !asked.has(question))
          .map(([question, answer]) => `- "${question}": ${answer}`),
      ]
      return [
        `${who} answered your questions:`,
        ...lines,
        "Continue with these answers in mind.",
      ].join("\n")
    }
    case "Replied":
      return [
        `${who} didn't pick an answer, and replied instead:`,
        by === undefined
          ? outcome.text
          : deliveredPrompt(by, outcome.text, outcome.attachments ?? []),
        "Follow what they said.",
      ].join("\n")
    case "Dismissed":
      return `${who} dismissed the questions without answering. Stop what you are doing and wait for them to tell you how to proceed.`
    case "Cancelled":
      return "The questions were closed without an answer: the Turn was stopped."
  }
}

/** pi's dialogs, as `ctx.ui` has them: each resolves undefined when closed without an answer. */
export interface DialogUI {
  select(
    title: string,
    options: Array<string>,
    opts?: { signal?: AbortSignal },
  ): Promise<string | undefined>
  input(
    title: string,
    placeholder?: string,
    opts?: { signal?: AbortSignal },
  ): Promise<string | undefined>
}

/** The choice at the end of a question's options, for an answer in one's own words. */
const typeOwn = "Type an answer…"

/**
 * Asks the questions at pi's own terminal, one dialog at a time: a pick of each question's options
 * or an answer typed instead, or typed for a question with none. An answer left empty skips its
 * question. Esc dismisses them all. Undefined once `signal` closes the dialogs, as when the
 * question was answered from the web UI first.
 */
export const askAtTerminal = async (
  ui: DialogUI,
  questions: ReadonlyArray<Question>,
  signal: AbortSignal,
): Promise<Outcome | undefined> => {
  const answers: Record<string, string> = {}
  for (const question of questions) {
    const title = `${question.header}: ${question.question}`
    let answer: string | undefined
    if (question.options.length > 0) {
      const choices = question.options.map((option) =>
        option.description === undefined ? option.label : `${option.label} — ${option.description}`,
      )
      const picked = await ui.select(title, [...choices, typeOwn], { signal })
      if (signal.aborted) return undefined
      if (picked === undefined) return { _tag: "Dismissed" }
      const index = choices.indexOf(picked)
      answer = index === -1 ? undefined : question.options[index]?.label
    }
    if (answer === undefined) {
      answer = await ui.input(
        title,
        question.multiSelect ? "One or more, separated by commas" : undefined,
        { signal },
      )
      if (signal.aborted) return undefined
      if (answer === undefined) return { _tag: "Dismissed" }
    }
    if (answer.trim() !== "") answers[question.question] = answer.trim()
  }
  return { _tag: "Answered", answers }
}

export interface AskOptions {
  /** The Turn it is asked in; undefined when there is none to report it in. */
  readonly turnId: string | undefined
  /** The tool call that asks it, which the Hub's answer names. */
  readonly toolCallId: string
  readonly questions: ReadonlyArray<Question>
  /** The Turn's, which stops it. */
  readonly signal?: AbortSignal | undefined
  /**
   * Asks the person at pi's own terminal, until `signal` closes the dialogs: their answer, or
   * undefined when there was none.
   */
  readonly terminal?:
    | ((questions: ReadonlyArray<Question>, signal: AbortSignal) => Promise<Outcome | undefined>)
    | undefined
}

export class Questions {
  /** The questions waiting for an answer, by tool call: each takes one, and says if it was first. */
  private readonly open = new Map<string, (closed: Closed) => boolean>()

  constructor(
    private readonly options: { readonly report: (event: Record<string, unknown>) => void },
  ) {}

  /** Asks the questions, as the Session's Open question; how it closed, once it has. */
  ask({ turnId, toolCallId, questions, signal, terminal }: AskOptions): Promise<Closed> {
    const { report } = this.options
    if (turnId !== undefined) report({ _tag: "QuestionAsked", turnId, toolCallId, questions })
    const dialogs = new AbortController()
    return new Promise<Closed>((resolve) => {
      const settle = (closed: Closed) => {
        if (this.open.get(toolCallId) !== settle) return false
        this.open.delete(toolCallId)
        signal?.removeEventListener("abort", cancel)
        dialogs.abort()
        if (turnId !== undefined)
          report({
            _tag: "QuestionClosed",
            turnId,
            toolCallId,
            outcome: closed.outcome,
            ...(closed.by === undefined ? {} : { by: closed.by }),
          })
        resolve(closed)
        return true
      }
      const cancel = () => settle({ outcome: { _tag: "Cancelled" } })
      this.open.set(toolCallId, settle)
      if (signal?.aborted) return void cancel()
      signal?.addEventListener("abort", cancel, { once: true })
      terminal?.(questions, dialogs.signal).then(
        (outcome) => {
          if (outcome !== undefined) settle({ outcome })
        },
        // The terminal can't ask; the web UI still can.
        () => undefined,
      )
    })
  }

  /** The Creator's answer from the web UI (DeliverAnswer): too late once the question closed. */
  answer(command: DeliverAnswer) {
    const answered = this.open.get(command.toolCallId)?.({
      outcome: command.answer satisfies QuestionAnswer,
      by: command.sender,
    })
    if (answered !== true)
      this.options.report({
        _tag: "AnswerFailed",
        toolCallId: command.toolCallId,
        senderId: command.sender.id,
        message: "The question was answered or closed already.",
      })
  }
}

/** The question tool, as pi registers it. */
export const questionToolDefinition = ({
  questions,
  turnId,
}: {
  readonly questions: Questions
  /** The main loop's running Turn. */
  readonly turnId: () => string | undefined
}): ToolDefinition<typeof questionParameters, Closed> => ({
  name: questionTool,
  label: "Question",
  description: questionToolDescription,
  promptSnippet: "Ask the people in this session questions, and wait for their answer",
  parameters: questionParameters,
  // It asks people: never from another tool, and never in a subagent.
  exposure: "model-only",
  execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
    const asked = askedQuestions(params.questions)
    const closed = await questions.ask({
      turnId: turnId(),
      toolCallId,
      questions: asked,
      signal,
      terminal: ctx.hasUI ? (each, dialogs) => askAtTerminal(ctx.ui, each, dialogs) : undefined,
    })
    return { content: [{ type: "text", text: questionResultText(asked, closed) }], details: closed }
  },
})
