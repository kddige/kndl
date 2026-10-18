// What a model sees of a reply someone stopped. pi keeps a stopped reply in its session, with
// what had streamed and the stop reason `aborted`, but pi-ai leaves every such message out of the
// requests it builds (`transformMessages`), so the model never sees what it had said, nor that it
// was stopped: the prompts around it read as if it had never answered. Claude Code keeps the
// partial reply, and "[Request interrupted by user]" after it.
//
// So, for each request to a Gateway model, the extension's `context` handler gives pi a copy of
// the conversation with each stopped reply as a reply pi-ai keeps: its text, and its tool calls
// that ran, with their results, then Claude Code's marker. Its reasoning is left out, as partial,
// and so are its calls with no result, cut off mid-arguments or never run, so no call or result
// is left without the other (OpenAI refuses a result whose call is missing). pi's session keeps
// the stopped reply as it was.
//
// The Claude bridge keeps a stopped reply in Claude Code's own session already (Rewind.ts), so its
// requests are left as pi builds them. A reply that ended in an error is left out, as pi-ai
// leaves it: no one stopped it, and the next request, pi's retry of it among them, starts again
// from the last whole reply, rather than from a failed one the Provider may refuse again.

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai"
import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { ClaudeApi } from "./claude/Names.ts"

type PiMessage = ContextEvent["messages"][number]

/** What the model reads after a stopped reply: Claude Code's words for it. */
export const StopMarker = "[Request interrupted by user]"

/** The custom message the marker is, in a request only: pi's session never holds one. */
const stoppedMessage = "kndl-stopped"

const isStopped = (message: PiMessage): message is AssistantMessage =>
  message.role === "assistant" && message.stopReason === "aborted"

/**
 * pi's messages for a request, with each stopped reply kept, as Claude Code keeps it: the reply's
 * text and its tool calls that have a result, then its results, then {@link StopMarker}. The
 * messages given are left as they are. Undefined when there is no stopped reply.
 */
export const withStoppedReplies = (
  messages: ReadonlyArray<PiMessage>,
): Array<PiMessage> | undefined => {
  if (!messages.some(isStopped)) return undefined
  const request: Array<PiMessage> = []
  // A stopped reply's results, moved up to right after it.
  const moved = new Set<PiMessage>()
  messages.forEach((message, at) => {
    if (moved.has(message)) return
    if (!isStopped(message)) {
      request.push(message)
      return
    }
    const calls = new Set(
      message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : [])),
    )
    const results = messages
      .slice(at + 1)
      .filter(
        (later): later is ToolResultMessage =>
          later.role === "toolResult" && calls.has(later.toolCallId),
      )
    const ran = new Set(results.map((each) => each.toolCallId))
    const content = message.content.flatMap((block): AssistantMessage["content"] => {
      if (block.type === "text")
        // Without its signature: an OpenAI message id, tied to the reasoning left out.
        return block.text.trim() === "" ? [] : [{ type: "text", text: block.text }]
      if (block.type === "toolCall") return ran.has(block.id) ? [block] : []
      return []
    })
    if (content.length > 0) {
      const { errorMessage: _stopped, ...kept } = message
      request.push({ ...kept, content, stopReason: ran.size > 0 ? "toolUse" : "stop" })
    }
    for (const each of results) {
      moved.add(each)
      request.push(each)
    }
    request.push({
      role: "custom",
      customType: stoppedMessage,
      content: StopMarker,
      display: false,
      timestamp: message.timestamp,
    })
  })
  return request
}

/**
 * Keeps each stopped reply in the requests a pi session makes to a Gateway model, through pi's
 * `context` event, which hands its handlers a copy of the conversation for the request only. An
 * extension factory: the Session's own pi, and each subagent's session.
 */
export const keepStoppedReplies = (pi: ExtensionAPI): void => {
  pi.on("context", (event, ctx) => {
    if (ctx.model === undefined || ctx.model.api === ClaudeApi) return undefined
    const messages = withStoppedReplies(event.messages)
    return messages === undefined ? undefined : { messages }
  })
}
