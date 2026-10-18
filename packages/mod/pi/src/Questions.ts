// The question tool (ADR 0029, #193): pi has none, so kndl's extension adds `ask_user_question`,
// with the shape of Claude Code's AskUserQuestion that the protocol's Question has, so the web's
// Open question needs no change.
//
// A call is the Session's Open question until it closes: the Creator answers it from the web UI
// (DeliverAnswer), or the person at pi's own terminal does in a dialog; the first answer is the one
// the model reads, and one after it comes too late (AnswerFailed), as hub-link-commands has it. A
// stopped Turn cancels it.
//
// A call may be `async`: it returns at once, and the model goes on. Its question stays open past
// the Turn, and its answer is given to the main loop as a message once it comes (MainLoopDelivery):
// into the running Turn, or as a Turn of its own. One async question is open at a time.
//
// It takes pi's dialogs in a plain shape, so it runs under `bun test` without pi.

import { Type } from "@earendil-works/pi-ai/compat"
import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import type { Question, QuestionAnswer, QuestionOutcome } from "@kndl/protocol"
import { askedQuestions } from "../../src/HubMessages.ts"
import type { Command } from "../../src/HubMessages.ts"
import {
  askedAsyncText,
  asyncDescription,
  questionDescriptions,
  questionResultText,
  questionTool,
  questionToolDescription,
  stillOpenText,
} from "../../src/Questions.ts"
import type { Closed } from "../../src/Questions.ts"

/** The tool's name, and what the model reads of it, whichever model it is. */
export { questionTool, questionToolDescription, questionResultText }
export type { Closed }

/** The tool's parameters: the protocol's Question, which the web shows as it is. */
export const questionParameters = Type.Object({
  questions: Type.Array(
    Type.Object({
      question: Type.String({ description: questionDescriptions.question }),
      header: Type.String({ description: questionDescriptions.header }),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: questionDescriptions.label }),
          description: Type.Optional(
            Type.String({ description: questionDescriptions.optionDescription }),
          ),
        }),
        { maxItems: 4, description: questionDescriptions.options },
      ),
      multiSelect: Type.Boolean({ description: questionDescriptions.multiSelect }),
    }),
    { minItems: 1, maxItems: 4, description: questionDescriptions.questions },
  ),
  async: Type.Optional(Type.Boolean({ description: asyncDescription })),
})

type Outcome = typeof QuestionOutcome.Encoded
type DeliverAnswer = Command<"DeliverAnswer">

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

/** The answer to an `async` question, once it has come: what the model reads of it. */
export interface AsyncAnswer {
  readonly toolCallId: string
  readonly text: string
  /** Who answered from the web UI; absent when it was at the terminal. */
  readonly by?: Closed["by"]
}

export class Questions {
  /** The questions waiting for an answer, by tool call: each takes one, and says if it was first. */
  private readonly open = new Map<string, (closed: Closed) => boolean>()
  /** The `async` question waiting for an answer, if one is: one at a time. */
  private asyncOpen: string | undefined

  constructor(
    private readonly options: {
      readonly report: (event: Record<string, unknown>) => void
      /** An `async` question closed with an answer for the model to read, as a message. */
      readonly answered: (answer: AsyncAnswer) => void
    },
  ) {}

  /** Whether an `async` question is still waiting for an answer, so no other can be asked. */
  get asyncWaiting(): boolean {
    return this.asyncOpen !== undefined
  }

  /** Asks the questions, as the Session's Open question; how it closed, once it has. */
  ask(options: AskOptions): Promise<Closed> {
    return new Promise<Closed>((resolve) => this.start(options, resolve))
  }

  /**
   * Asks the questions `async`: the Session's Open question, which its Turn ending doesn't close.
   * The model has its call back at once; once the question closes with an answer, `answered` gives
   * it to the model. The Turn's stop doesn't cancel it. Returns false, asking nothing, while
   * another is open, or when there is no Turn to report it in.
   */
  askAsync(options: Omit<AskOptions, "signal">): boolean {
    if (this.asyncOpen !== undefined || options.turnId === undefined) return false
    const { toolCallId, questions } = options
    this.asyncOpen = toolCallId
    this.start(options, (closed) => {
      // Cancelled with nobody to read it, as when the Session's Hub stops it.
      if (closed.outcome._tag === "Cancelled") return
      this.options.answered({
        toolCallId,
        text: questionResultText(questions, closed, true),
        by: closed.by,
      })
    })
    return true
  }

  private start(
    { turnId, toolCallId, questions, signal, terminal }: AskOptions,
    done: (closed: Closed) => void,
  ) {
    const { report } = this.options
    const isAsync = this.asyncOpen === toolCallId
    if (turnId !== undefined)
      report({
        _tag: "QuestionAsked",
        turnId,
        toolCallId,
        questions,
        ...(isAsync && { async: true }),
      })
    const dialogs = new AbortController()
    const settle = (closed: Closed) => {
      if (this.open.get(toolCallId) !== settle) return false
      this.open.delete(toolCallId)
      if (isAsync) this.asyncOpen = undefined
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
      done(closed)
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
}): ToolDefinition<typeof questionParameters, Closed | { readonly async: true }> => ({
  name: questionTool,
  label: "Question",
  description: questionToolDescription,
  promptSnippet: "Ask the people in this session questions, waiting for the answer or going on",
  parameters: questionParameters,
  // It asks people: never from another tool, and never in a subagent.
  exposure: "model-only",
  execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
    const asked = askedQuestions(params.questions)
    const terminal = ctx.hasUI
      ? (each: ReadonlyArray<Question>, dialogs: AbortSignal) =>
          askAtTerminal(ctx.ui, each, dialogs)
      : undefined
    if (questions.asyncWaiting)
      return { content: [{ type: "text", text: stillOpenText }], details: { async: true } }
    if (
      params.async === true &&
      questions.askAsync({ turnId: turnId(), toolCallId, questions: asked, terminal })
    )
      return { content: [{ type: "text", text: askedAsyncText }], details: { async: true } }
    const closed = await questions.ask({
      turnId: turnId(),
      toolCallId,
      questions: asked,
      signal,
      terminal,
    })
    return { content: [{ type: "text", text: questionResultText(asked, closed) }], details: closed }
  },
})
