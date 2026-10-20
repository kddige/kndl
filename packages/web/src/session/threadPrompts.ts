import type { AttachmentId, EventSeq, SessionLogEntry, ThreadId } from "@kndl/protocol"

/** Local previews have no PromptId: the Hub mints it. Match each logged echo once, in send order,
 * then advance the watermark even for unmatched previews so an identical later reply cannot
 * consume an older echo. The logged prompt owns rendering as soon as its echo arrives. */
export interface PendingThreadPrompt {
  readonly key: number
  readonly after: EventSeq | undefined
  readonly text: string
  readonly attachments: ReadonlyArray<AttachmentId>
  readonly failed?: string
}

export function pendingThreadPrompts(
  pending: ReadonlyArray<PendingThreadPrompt>,
  log: ReadonlyArray<SessionLogEntry>,
  threadId: ThreadId,
  senderId: string | undefined,
): ReadonlyArray<PendingThreadPrompt> {
  const last = log.at(-1)?.seq
  if (pending.length === 0 || last === undefined || pending.every(prompt => prompt.after === last)) return pending
  const used = new Set<EventSeq>()
  return pending.flatMap(prompt => {
    const echo = log.find(entry => {
      const event = entry.event
      return (prompt.after === undefined || entry.seq > prompt.after) && !used.has(entry.seq) &&
        event._tag === "ThreadPromptSent" && event.threadId === threadId &&
        event.sender.id === senderId && event.text === prompt.text &&
        (event.attachments?.map(file => file.id).join("\0") ?? "") === prompt.attachments.join("\0")
    })
    if (echo) { used.add(echo.seq); return [] }
    return [{ ...prompt, after: last }]
  })
}
