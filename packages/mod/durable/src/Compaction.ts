// What a compaction made, for the Hub to be told: the summary Pi Durable's compaction task wrote,
// wherever it is by the time the reporter asks (Loops.ts).

import { InboxDoc } from "@earendil-works/pi-durable"
import type { ConversationId, EntryId, SubmissionId, TaskId } from "@earendil-works/pi-durable"
import { isRecord } from "./hub/HubMessages.ts"
import { contentText } from "./Inputs.ts"
import type { Runtime } from "./Runtime.ts"
import { turnErrorMessage } from "./Turns.ts"

/**
 * Why a compaction failed, as the Hub shows it, whoever reports it: redacted, on one line, and
 * clipped as a Turn's error is.
 */
export const compactionError = (error: unknown, secrets: ReadonlyArray<string>): string =>
  turnErrorMessage(String(error), secrets) ?? "Compaction failed."

/** The summary a compaction made, wherever it is now; undefined when it made none. */
export const compactionSummary = async (
  runtime: Pick<Runtime, "harness" | "context">,
  conversationId: ConversationId,
  taskId: TaskId,
): Promise<string | undefined> => {
  const { context } = runtime
  const harness = runtime.harness()
  const task = await harness.getTask(taskId, context)
  const outcome = task?.state.status === "terminal" ? task.state.outcome : undefined
  const result =
    outcome?.status === "completed" && isRecord(outcome.result) ? outcome.result : undefined
  if (result === undefined) return undefined
  const conversation = await harness.conversation(conversationId, context)
  const entryText = async (id: unknown) => {
    if (typeof id !== "number" || conversation === undefined) return undefined
    const page = await conversation.entries(
      { minEntryId: id as EntryId, maxEntryId: id as EntryId },
      1,
      undefined,
      context,
    )
    return contentText(page.items[0]?.model?.[0]?.content)
  }
  if (result.entryId !== undefined) return (await entryText(result.entryId)) ?? ""
  if (typeof result.submissionId !== "number") return undefined
  const placed = await (
    await harness.submission(result.submissionId as SubmissionId, context)
  )?.status(context)
  if (placed?.entry !== undefined) return (await entryText(placed.entry)) ?? ""
  // Still queued, for the next boundary: its entry waits in the inbox.
  const inbox = await harness.snapshot(InboxDoc, conversationId, context)
  const item = inbox?.items.find((each) => each.id === result.submissionId)
  const draft = item?.mode === "write" ? item.entry : undefined
  const model = isRecord(draft) && Array.isArray(draft.model) ? draft.model[0] : undefined
  return isRecord(model) ? contentText(model.content) : ""
}
