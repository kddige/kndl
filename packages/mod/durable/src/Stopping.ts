// Stopping a conversation (StopTurn, StopThread). Pi Durable's abort() ends the run, and withdraws
// every input still queued: a steer the Turn hadn't read, an async answer, a prompt queued to
// follow the run. The Hub counts those delivered, and none of them was the stop's to cancel, so
// they stay in the conversation (ADR 0018): a steer or an answer as a write, which survives the
// abort and is read with the next prompt, ahead of it; a queued prompt as the input it was, which
// runs now, as it would have when the run ended. A stopped reply stays too, with the marker that
// it was stopped (StoppedReplies.ts).

import { InboxDoc } from "@earendil-works/pi-durable"
import type { Conversation, EntryRecord, JsonObject } from "@earendil-works/pi-durable"
import { AnswerEntry, freeRequestId, PromptEntry, withdrawn } from "./Inputs.ts"
import type { Runtime } from "./Runtime.ts"
import { stoppedReplyDraft } from "./StoppedReplies.ts"

/** The kinds of input that are people's words, which a stop doesn't cancel. */
const kept: ReadonlyArray<string> = [PromptEntry, AnswerEntry]

/** How many of the newest entries are looked through for the reply a stop ended. */
const lookback = 50

/**
 * Stops a conversation: its run and the work of it end, and what people said to it stays. Resolves
 * once it is idle.
 */
export const stopConversation = async (runtime: Runtime, conversation: Conversation) => {
  const { context } = runtime
  const harness = runtime.harness()
  const newest = (await conversation.entries({}, 1, undefined, context)).items[0]?.id ?? 0
  // Withdrawn by the abort, so read before it.
  const queued = (await harness.snapshot(InboxDoc, conversation.id, context))?.items ?? []
  await conversation.abort(context)
  const added: Array<EntryRecord> = (
    await conversation.entries({}, lookback, undefined, context)
  ).items.filter((entry) => entry.id > newest)
  for (const entry of added.toReversed()) {
    const draft = stoppedReplyDraft(entry, Date.now())
    // One write per reply, however often it is stopped.
    if (draft !== undefined)
      await conversation.submit(
        { type: "write", entry: draft, requestId: `stopped:${entry.id}` },
        context,
      )
  }
  for (const item of queued) {
    if (item.mode === "write" || item.entry === undefined || !kept.includes(item.entry.kind))
      continue
    const record = await (await harness.submission(item.id, context))?.status(context)
    if (record === undefined || !withdrawn(record)) continue
    const requestId =
      record.requestId === undefined
        ? undefined
        : await freeRequestId(conversation, record.requestId, context)
    // Given again already, as by an earlier stop.
    if (record.requestId !== undefined && requestId === undefined) continue
    const entry = item.entry as unknown as { kind: string; data: JsonObject }
    if (item.mode === "steer")
      await conversation.submit(
        {
          type: "write",
          ...(requestId === undefined ? {} : { requestId }),
          entry: {
            kind: entry.kind,
            data: entry.data,
            model: [{ role: "user", content: item.content, timestamp: Date.now() }],
          },
        },
        context,
      )
    else
      await conversation.submit(
        {
          type: "input",
          content: item.content,
          whenBusy: "followUp",
          ...(requestId === undefined ? {} : { requestId }),
          entry,
        },
        context,
      )
  }
}
