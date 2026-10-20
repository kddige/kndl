// The Turns the durable agent reported, as it keeps them (`kndl.turns`, Docs.ts): which run is
// reported as a Turn and not yet ended, and the entries each Turn began and ended with. A restart
// reads it to know which run the Hub already heard of, and a thread reads it to fork at a Turn's
// answer. The reporter (Loops.ts) writes it as it projects a conversation's events into Turns; a
// subagent's runs are not Turns of the Hub's transcript, so they keep none.

import type {
  Conversation,
  ConversationId,
  EntryId,
  SubmissionId,
} from "@earendil-works/pi-durable"
import { TurnsDoc } from "./Docs.ts"
import type { Runtime } from "./Runtime.ts"

/** Where a conversation's ledger is read and written, and where its failures are logged. */
type LedgerRuntime = Pick<Runtime, "harness" | "context" | "log">

export class TurnLedger {
  constructor(
    private readonly runtime: LedgerRuntime,
    private readonly conversationId: ConversationId,
  ) {}

  /** Keeps which run the agent reported, so a restart knows it. */
  async recordCurrent(
    input: SubmissionId,
    turnIds: ReadonlyArray<string>,
    resumed: boolean,
    entry?: EntryId,
    carried = false,
  ) {
    const { context } = this.runtime
    const harness = this.runtime.harness()
    try {
      await harness.commit(async (tx) => {
        const doc = await tx.doc(TurnsDoc, this.conversationId)
        // A Turn carried on to a new first input keeps the Turns it goes on from: they end with it.
        const earlier =
          (resumed && doc.current?.input === input) || carried ? (doc.current?.turnIds ?? []) : []
        doc.current = {
          input,
          turnIds: [...earlier, ...turnIds.filter((id) => !earlier.includes(id))],
        }
        // Chord copies assigned values. Mutating the RHS returned by `??= {}` would change
        // a detached plain object, not the newly inserted draft, and lose the prompt anchor.
        for (const turnId of turnIds)
          doc.turns[turnId] = { ...doc.turns[turnId], ...(entry === undefined ? {} : { entry }) }
        // A resumed Turn anchors where the Turn it goes on from does.
        const from = earlier[0] === undefined ? undefined : doc.turns[earlier[0]]?.entry
        if (from !== undefined) for (const turnId of turnIds) doc.turns[turnId] = { entry: from }
      }, context)
    } catch (error) {
      this.runtime.log(`kndl: couldn't record a Turn of ${this.conversationId}: ${error}`)
    }
  }

  /** The Turn's answer, or its last entry, for a thread forked at it. */
  async recordEnd(answer: EntryId | undefined, last: EntryId | undefined) {
    const { context } = this.runtime
    const harness = this.runtime.harness()
    try {
      await harness.commit(async (tx) => {
        const doc = await tx.doc(TurnsDoc, this.conversationId)
        for (const turnId of doc.current?.turnIds ?? [])
          doc.turns[turnId] = {
            ...doc.turns[turnId],
            ...(answer === undefined ? {} : { answer }),
            ...(last === undefined ? {} : { last }),
          }
        delete doc.current
      }, context)
    } catch (error) {
      this.runtime.log(`kndl: couldn't record a Turn's end in ${this.conversationId}: ${error}`)
    }
  }

  /** A crash after a run settled but before recordEnd must not leave its fork anchor at the prompt. */
  async settleCurrent() {
    const { context } = this.runtime
    const harness = this.runtime.harness()
    const current = (await harness.snapshot(TurnsDoc, this.conversationId, context))?.current
    if (current === undefined) return
    const record = await (await harness.submission(current.input, context))?.status(context)
    if (record?.status !== "done" && record?.status !== "unanswered") return
    const conversation = await harness.conversation(this.conversationId, context)
    const last = (await conversation?.entries({}, 1, undefined, context))?.items[0]?.id
    await this.recordEnd(record.status === "done" ? record.answer : undefined, last)
  }

  /** Whether the agent reported the run starting with `input` before it restarted. */
  async reportedBefore(input: SubmissionId | undefined) {
    if (input === undefined) return true
    const { context } = this.runtime
    const doc = await this.runtime.harness().snapshot(TurnsDoc, this.conversationId, context)
    return doc?.current?.input === input
  }
}

/**
 * Where a thread off `anchorTurnId` forks the main loop: that Turn's answer, its newest entry if
 * it has none yet, or the main loop's newest entry for a Turn the agent doesn't know.
 */
export const forkPoint = async (
  runtime: LedgerRuntime,
  root: Conversation,
  anchorTurnId: string,
): Promise<EntryId | undefined> => {
  const turns = await runtime.harness().snapshot(TurnsDoc, root.id, runtime.context)
  // A running Turn has no answer/last yet. Fork at its newest committed progress, never an
  // in-flight partial, rather than at the prompt recordCurrent saved when it began.
  if (turns?.current?.turnIds.includes(anchorTurnId)) {
    const newest = await root.entries({}, 1, undefined, runtime.context)
    return newest.items[0]?.id
  }
  const turn = turns?.turns[anchorTurnId]
  const known = turn?.answer ?? turn?.last ?? turn?.entry
  if (known !== undefined) return known
  const newest = await root.entries({}, 1, undefined, runtime.context)
  return newest.items[0]?.id
}
