import type { AttachmentId, EventSeq, RequestId, SessionLogEntry, ThreadId } from "@kndl/protocol"

/**
 * A reply being sent, shown until the Hub's echo of it is logged. The Hub redacts a reply's text
 * before it logs it, so a reply is matched to its echo by the request id it was sent with, and to
 * a refusal by the same: never by what it says.
 */
export interface PendingThreadPrompt {
  readonly requestId: RequestId
  /** The last entry of the log when it was sent: its echo comes after. */
  readonly after: EventSeq | undefined
  readonly text: string
  readonly attachments: ReadonlyArray<AttachmentId>
  /** Why it was not sent; with `unconfirmed`, why it is not known to have been. */
  readonly failed?: string
  /** It may have arrived: the connection dropped before the Hub answered. */
  readonly unconfirmed?: true
}

/**
 * The replies in `pending` that the log has no echo for yet: a logged prompt takes over from its
 * reply as soon as it arrives. `pending` itself if none is echoed.
 */
export function pendingThreadPrompts(
  pending: ReadonlyArray<PendingThreadPrompt>,
  log: ReadonlyArray<SessionLogEntry>,
  threadId: ThreadId,
): ReadonlyArray<PendingThreadPrompt> {
  if (pending.length === 0) return pending
  const waiting = new Set<RequestId>(pending.map((prompt) => prompt.requestId))
  // Only what came after the oldest send can be an echo of it.
  const floor = Math.min(...pending.map((prompt) => prompt.after ?? -1))
  const echoed = new Set<RequestId>()
  for (let at = log.length - 1; at >= 0; at--) {
    const entry = log[at]
    if (entry === undefined || entry.seq <= floor) break
    const { event } = entry
    if (
      event._tag === "ThreadPromptSent" &&
      event.threadId === threadId &&
      event.requestId !== undefined &&
      waiting.has(event.requestId)
    )
      echoed.add(event.requestId)
  }
  if (echoed.size === 0) return pending
  return pending.filter((prompt) => !echoed.has(prompt.requestId))
}

/** The replies in `pending`, with the one sent as `requestId` failed, as the Hub refused it. */
export function failedThreadPrompt(
  pending: ReadonlyArray<PendingThreadPrompt>,
  requestId: RequestId,
  message: string,
): ReadonlyArray<PendingThreadPrompt> {
  return pending.map((prompt) =>
    prompt.requestId === requestId && prompt.failed === undefined
      ? { ...prompt, failed: message }
      : prompt,
  )
}

/**
 * The replies in `pending` the Hub hasn't answered, marked as not known to have arrived, as the
 * connection to it dropped. `pending` itself if there are none.
 */
export function unconfirmedThreadPrompts(
  pending: ReadonlyArray<PendingThreadPrompt>,
): ReadonlyArray<PendingThreadPrompt> {
  if (pending.every((prompt) => prompt.failed !== undefined)) return pending
  return pending.map((prompt) =>
    prompt.failed === undefined
      ? { ...prompt, failed: "the connection to the Hub dropped", unconfirmed: true }
      : prompt,
  )
}
