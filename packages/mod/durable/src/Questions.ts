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
import { QuestionsDoc } from "./Docs.ts"
import type { QuestionRecord } from "./Docs.ts"
import { AnswerEntry, freeRequestId } from "./Inputs.ts"
import type { Runtime } from "./Runtime.ts"

export { questionTool }

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
      const record = (await this.harness.snapshot(QuestionsDoc, this.runtime.context))?.open[
        toolCallId
      ]
      if (record === undefined) return cancelled
      // Keep the receipt: execute() may replay after this read but before its result commits.
      if (record.closed !== undefined) return record.closed as unknown as Closed
      const aborted = await new Promise<boolean>((resolve) => {
        if (signal?.aborted) return resolve(true)
        const onAbort = () => {
          this.waiting.delete(toolCallId)
          resolve(true)
        }
        signal?.addEventListener("abort", onAbort, { once: true })
        this.waiting.set(toolCallId, () => {
          signal?.removeEventListener("abort", onAbort)
          this.waiting.delete(toolCallId)
          resolve(false)
        })
      })
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
