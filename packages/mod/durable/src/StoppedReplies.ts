// What a model reads of a reply someone stopped. Pi Durable keeps a stopped reply in the
// conversation, with what had streamed and the stop reason `aborted`, but leaves every such
// message out of the context it builds: the model never sees what it had said, nor that it was
// stopped, and the prompts around it read as if it had never answered. Claude Code keeps the
// partial reply, and "[Request interrupted by user]" after it, and so did kndl's pi extension.
//
// So a stop writes one entry after the stopped reply: Claude Code's marker, with a context edit
// that gives the reply back as one Pi Durable keeps, its text alone. Its reasoning is left out, as
// partial. A stopped reply's tool calls are left out too: its tool round never began, so none ran
// and none has a result, and a call with no result (OpenAI refuses one) is worse than none.
//
// The Claude bridge keeps a stopped reply in Claude Code's own session already (Rewind.ts), so a
// reply of its Models is left as it is. A reply that ended in an error is left out, as Pi Durable
// leaves it: no one stopped it, and the next request, a retry among them, starts again from the
// last whole reply, rather than from a failed one the Provider may refuse again.

import type { EntryDraft, EntryRecord } from "@earendil-works/pi-durable"
import { ClaudeProvider } from "./claude/Names.ts"

/** What the model reads after a stopped reply: Claude Code's words for it. */
export const StopMarker = "[Request interrupted by user]"

/** The entry that says a reply was stopped, and what the model reads of it instead. */
export const StoppedEntry = "kndl.stopped"

/** The reply of an entry, if someone stopped it and the model should still read it. */
const stoppedReply = (entry: EntryRecord) => {
  const message = entry.model?.[0]
  return message?.role === "assistant" &&
    message.stopReason === "aborted" &&
    message.provider !== ClaudeProvider
    ? message
    : undefined
}

/**
 * The entry that keeps a stopped reply in what the model reads, as Claude Code keeps it: the
 * reply's text, then the marker. Undefined for an entry that isn't a stopped reply.
 */
export const stoppedReplyDraft = (entry: EntryRecord, now: number): EntryDraft | undefined => {
  const reply = stoppedReply(entry)
  if (reply === undefined) return undefined
  const content = reply.content.flatMap((block): typeof reply.content =>
    // Without its signature: an OpenAI message id, tied to the reasoning left out.
    block.type === "text" && block.text.trim() !== "" ? [{ type: "text", text: block.text }] : [],
  )
  const { errorMessage: _stopped, ...kept } = reply
  return {
    kind: StoppedEntry,
    data: { reply: entry.id },
    model: [{ role: "user", content: StopMarker, timestamp: now }],
    edits: [
      content.length === 0
        ? { target: entry.id, action: "omit" }
        : {
            target: entry.id,
            action: "replace",
            messages: [{ ...kept, content, stopReason: "stop" }],
          },
    ],
  }
}
