// The question tool (#193, ADR 0031): `ask_user_question`, with the shape of Claude Code's
// AskUserQuestion that the protocol's Question has, on the main loop only. A call is the Session's
// Open question until it closes: a Participant answers it from the web (DeliverAnswer), and the
// first answer is the one the model reads; one after it comes too late (AnswerFailed). A stopped
// Turn cancels it.
//
// Each Open question is kept in `kndl.questions`, so one survives a restart: a call that waited is
// replay-safe, and runs again under the Resumed Turn, asking its question again, so the people see
// it again (the Hub closed it Cancelled when the agent stopped) and the model still gets its
// answer; an answer that came meanwhile is found there. An `async` question returns at once and
// stays open past its Turn; its answer is given to the main loop as an input of its own, steered
// into the run going, or starting a Turn from whoever answered. One async question is open at a
// time.

import type { JsonValue } from "@earendil-works/chord"
import { Type } from "@earendil-works/pi-ai"
import { defineExtension, defineTool } from "@earendil-works/pi-durable"
import type { Extension } from "@earendil-works/pi-durable"
import type { Question, QuestionOutcome } from "@kndl/protocol"
import { QuestionsDoc } from "./Docs.ts"
import type { QuestionRecord } from "./Docs.ts"
import { askedQuestions, deliveredPrompt } from "./hub/HubMessages.ts"
import type { Command, Sender } from "./hub/HubMessages.ts"
import { AnswerEntry, freeRequestId } from "./Inputs.ts"
import type { Runtime } from "./Runtime.ts"

// ── What the agent reads ───────────────────────────────────────────────────

/** The tool's name. */
const questionTool = "ask_user_question"

/** What the agent reads of the tool. */
export const questionToolDescription = [
  "Asks the people in this session one to four questions.",
  "Use it when you need a decision or a fact only they have: to choose between approaches, to settle what an ambiguous request means, or to confirm something hard to undo. Don't ask what you can find out yourself, and don't ask for permission to do what you were asked to do.",
  "Give each question two to four options, or none for one answered in their own words. They can always answer in their own words instead of picking, or dismiss the questions.",
  "By default the call waits for their answer: the result says what they chose, what they said instead, or that they dismissed the questions.",
  "Set async to true when you can make progress without the answer: the call returns at once and you keep working, and their answer comes to you later as a message, after one of your next tool calls, or as a new turn if you have finished by then. Don't wait or poll for it, and don't ask again until it comes.",
].join(" ")

/** What the agent reads of the `async` parameter. */
const asyncDescription =
  "Whether to keep working while they answer. True: the call returns at once, and their answer reaches you later as a message. Omit it to wait for the answer. Only one question can be open at a time."

/** The parameters' descriptions. */
const questionDescriptions = {
  questions: "The questions to ask, one to four.",
  question: "The complete question, ending with a question mark.",
  header: 'A very short label for it, up to 12 characters, such as "Auth method".',
  label: "What the option says, in a few words: it is also the answer.",
  optionDescription: "What choosing it means, or what follows from it.",
  options:
    'Two to four distinct choices, or none for a free-text answer. Leave out "Other": an answer in their own words is always possible.',
  multiSelect: "Whether several options may be picked, rather than one.",
} as const

/** How a question closed: its outcome, and who answered from the web UI, if anyone did. */
interface Closed {
  readonly outcome: typeof QuestionOutcome.Encoded
  readonly by?: Sender | undefined
}

/**
 * What the agent reads once its questions closed. Of questions it waited for, the tool's result;
 * of an `async` one, the message that comes to it later, so it says which questions they were.
 */
export const questionResultText = (
  questions: ReadonlyArray<Question>,
  { outcome, by }: Closed,
  async = false,
): string => {
  const who = by?.name ?? "The person at the terminal"
  const yours = "the questions you asked earlier"
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
        `${who} answered ${async ? yours : "your questions"}:`,
        ...lines,
        "Continue with these answers in mind.",
      ].join("\n")
    }
    case "Replied":
      return [
        `${who} didn't pick an answer${async ? ` to ${yours}` : ""}, and replied instead:`,
        by === undefined
          ? outcome.text
          : deliveredPrompt(by, outcome.text, outcome.attachments ?? []),
        "Follow what they said.",
      ].join("\n")
    case "Dismissed":
      return async
        ? `${who} dismissed ${yours} without answering. Carry on without an answer, and don't ask again unless you can't go on.`
        : `${who} dismissed the questions without answering. Stop what you are doing and wait for them to tell you how to proceed.`
    case "Cancelled":
      return "The questions were closed without an answer: the Turn was stopped."
  }
}

/** What the call of an `async` question returns at once. */
export const askedAsyncText =
  "The people have your questions. Don't wait or poll for the answer: carry on with whatever doesn't depend on it. It comes to you as a message, after one of your next tool calls, or as a new turn if you have finished by then. Don't ask again until it does."

/** Why a question is refused while an `async` one is still open. */
const stillOpenText =
  "An earlier question you asked async is still waiting for an answer. Only one can be open at a time: carry on without, and ask again once the answer has come."

// ── The tool and its Open questions ────────────────────────────────────────

/** The tool's parameters: the protocol's Question, which the web shows as it is. */
const questionParameters = Type.Object({
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

const cancelled = { outcome: { _tag: "Cancelled" } } as const

/** Why a question is refused when no Turn of the conversation is reported to the Hub. */
const noTurnText =
  "The question wasn't asked: the session has no turn running for it to belong to. Carry on without, or ask again in a moment."

/** A record out of a commit's draft, to keep after it. */
const copy = (record: QuestionRecord): QuestionRecord => JSON.parse(JSON.stringify(record))

/** The Session's Open questions, and the calls that wait for theirs. */
export class Questions {
  /** The calls waiting, by tool call: told when the answer is in `kndl.questions`. */
  private readonly waiting = new Map<string, () => void>()

  constructor(private readonly runtime: Runtime) {}

  private get harness() {
    return this.runtime.harness()
  }

  private asked(toolCallId: string, record: QuestionRecord) {
    this.runtime.report({
      _tag: "QuestionAsked",
      turnId: record.turnId,
      toolCallId,
      questions: record.questions,
      ...(record.async && { async: true }),
    })
  }

  /**
   * The questions still open at start: each `async` one is asked again, so the Hub shows it again;
   * one a call waits for is asked again by that call, as it runs again. Accepted async answers
   * whose inputs weren't admitted before the crash are delivered first, by their request ids.
   */
  async reaskAsync() {
    const doc = await this.harness.snapshot(QuestionsDoc, this.runtime.context)
    for (const [toolCallId, record] of Object.entries(doc?.open ?? {})) {
      if (!record.async) continue
      if (record.closed === undefined) this.asked(toolCallId, record)
      else if (!record.answerSubmitted) await this.deliverAsync(toolCallId, record)
    }
  }

  /** The question tool, as the main loop has it. */
  extension(): Extension {
    const tool = defineTool({
      name: questionTool,
      description: questionToolDescription,
      parameters: questionParameters,
      // It asks people: never from another tool, such as a script.
      callers: ["model"],
      replay: "safe",
      execute: async (args, api, context) => {
        const toolCallId = api.callId
        const turnId = this.runtime.loops.get(api.conversationId)?.turnId
        const questions = askedQuestions(args.questions)
        const asked = await this.harness.commit(async (tx) => {
          const doc = await tx.doc(QuestionsDoc)
          const known = doc.open[toolCallId]
          if (known !== undefined) {
            // A call run again after a restart: its question, asked again under this Turn.
            if (turnId !== undefined && known.closed === undefined) known.turnId = turnId
            return { record: copy(known), again: true }
          }
          if (turnId === undefined) return { refused: noTurnText }
          const otherAsync = Object.values(doc.open).some(
            (record) => record.async && record.closed === undefined,
          )
          if (otherAsync) return { refused: stillOpenText }
          const record: QuestionRecord = {
            conversationId: api.conversationId,
            turnId,
            questions: questions as unknown as JsonValue,
            async: args.async === true,
          }
          doc.open[toolCallId] = record
          return { record, again: false }
        }, context)
        if ("refused" in asked)
          return { output: [{ type: "text", text: asked.refused }], isError: true }
        const { record } = asked
        if (record.closed === undefined && (!asked.again || !record.async))
          this.asked(toolCallId, record)
        if (record.async) return { output: [{ type: "text", text: askedAsyncText }] }
        const closed = await this.closedOf(toolCallId, context.abortSignal)
        return { output: [{ type: "text", text: questionResultText(questions, closed) }] }
      },
    })
    return defineExtension({ name: "kndl-questions", tools: [tool] })
  }

  /**
   * How the question closed, once it has; cancelled when the call's signal aborts as its Turn is
   * stopped. A shutdown leaves it open, for the call to wait again after the restart.
   */
  private async closedOf(toolCallId: string, signal: AbortSignal | undefined): Promise<Closed> {
    for (;;) {
      // Listening before reading: an answer committed between the two still wakes this call.
      let answered!: () => void
      const woken = new Promise<void>((resolve) => {
        answered = resolve
      })
      this.waiting.set(toolCallId, answered)
      const record = (await this.harness.snapshot(QuestionsDoc, this.runtime.context))?.open[
        toolCallId
      ]
      if (record === undefined) {
        this.waiting.delete(toolCallId)
        return cancelled
      }
      // Keep the receipt: execute() may replay after this read but before its result commits.
      if (record.closed !== undefined) {
        this.waiting.delete(toolCallId)
        return record.closed as unknown as Closed
      }
      const aborted = await new Promise<boolean>((resolve) => {
        if (signal?.aborted) return resolve(true)
        const onAbort = () => resolve(true)
        signal?.addEventListener("abort", onAbort, { once: true })
        void woken.then(() => {
          signal?.removeEventListener("abort", onAbort)
          resolve(false)
        })
      })
      this.waiting.delete(toolCallId)
      if (!aborted) continue
      if (this.runtime.closing()) throw new Error("The session is restarting.")
      await this.close(toolCallId, record, cancelled)
      return cancelled
    }
  }

  /** Closes a question, as the Hub hears it. */
  private async close(toolCallId: string, record: QuestionRecord, closed: Closed) {
    await this.harness.commit(async (tx) => {
      const open = (await tx.doc(QuestionsDoc)).open[toolCallId]
      if (open !== undefined && open.closed === undefined)
        open.closed = { outcome: closed.outcome as unknown as JsonValue }
    }, this.runtime.context)
    this.runtime.report({
      _tag: "QuestionClosed",
      turnId: record.turnId,
      toolCallId,
      outcome: closed.outcome,
      ...(closed.by === undefined ? {} : { by: closed.by }),
    })
  }

  /** A Participant's answer from the web (DeliverAnswer): too late once the question closed. */
  async answer(command: Command<"DeliverAnswer">) {
    const { toolCallId, sender } = command
    const by = { id: sender.id, login: sender.login, name: sender.name }
    const closed: Closed = { outcome: command.answer as typeof QuestionOutcome.Encoded, by }
    const record = await this.harness.commit(async (tx) => {
      const doc = await tx.doc(QuestionsDoc)
      const open = doc.open[toolCallId]
      if (open === undefined || open.closed !== undefined) return undefined
      const taken = copy(open)
      open.closed = { outcome: closed.outcome as unknown as JsonValue, by }
      taken.closed = { outcome: closed.outcome as unknown as JsonValue, by }
      return taken
    }, this.runtime.context)
    if (record === undefined) {
      this.runtime.report({
        _tag: "AnswerFailed",
        toolCallId,
        senderId: sender.id,
        message: "The question was answered or closed already.",
      })
      return
    }
    this.runtime.report({
      _tag: "QuestionClosed",
      turnId: record.turnId,
      toolCallId,
      outcome: closed.outcome,
      by,
    })
    if (!record.async) return this.waiting.get(toolCallId)?.()
    await this.deliverAsync(toolCallId, record)
  }

  /** The persisted answer is an outbox: submit once, then acknowledge it, safe across a crash. */
  private async deliverAsync(toolCallId: string, record: QuestionRecord) {
    const closed = record.closed as unknown as Closed | undefined
    if (closed === undefined) return
    const conversation = await this.harness.conversation(
      record.conversationId,
      this.runtime.context,
    )
    if (conversation === undefined) throw new Error("The question's conversation is gone.")
    // A stop may have withdrawn the answer unread; it is then in the conversation as a write.
    const requestId = await freeRequestId(
      conversation,
      `answer:${toolCallId}`,
      this.runtime.context,
    )
    if (requestId !== undefined)
      await conversation.submit(
        {
          type: "input",
          content: questionResultText(record.questions as unknown as Array<Question>, closed, true),
          whenBusy: "steer",
          requestId,
          entry: {
            kind: AnswerEntry,
            data: { toolCallId, ...(closed.by === undefined ? {} : { sender: closed.by }) },
          },
        },
        this.runtime.context,
      )
    await this.harness.commit(async (tx) => {
      const receipt = (await tx.doc(QuestionsDoc)).open[toolCallId]
      if (receipt !== undefined) receipt.answerSubmitted = true
    }, this.runtime.context)
  }
}
