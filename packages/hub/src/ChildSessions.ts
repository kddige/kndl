// What the Hub writes for the model when Sessions talk to each other (ADR 0012): a Parent
// Session's messages to its Child Session, and the note around each Report back. Also how a Report
// is found in a Turn, and a Child Session's conversation as its parent reads it. SessionRelay.ts
// does the rest.

import {
  LoopGuardExchanges,
  type PromptSender,
  type SessionLogEntry,
  type SessionRef,
  type TurnEndReason,
} from "@claude-hub/protocol"

/** Why a Child Session can't create one: the tree is one level deep. */
export const oneLevelDeep =
  "A Child Session can't create Child Sessions of its own: Sessions nest one level deep. Do the work yourself, or report back to your Parent Session."

/** A Parent Session's message, as its Child Session's model reads it. */
export const parentMessageText = (parent: SessionRef, text: string) =>
  `[Message from your Parent Session "${parent.title}" (${parent.id})]\n\n${text}`

/**
 * A Child Session's Report, as its Parent Session's model reads it: a note saying which child sent
 * it and what it is, then the child's final message. `exchanges` is the loop guard's count
 * (see {@link LoopGuardExchanges}); from that many on, the note asks the parent to check that the
 * work is still moving.
 */
export const reportText = (child: SessionRef, message: string, exchanges: number) => {
  const note = [
    `[Report from Child Session "${child.title}" (${child.id})]`,
    "This is a Report, not a prompt from a person: the final message of a Turn your Child Session just ended. The people in this Session don't see Reports, so relay what matters to them. More Reports may follow while it works.",
  ]
  if (exchanges >= LoopGuardExchanges) {
    note.push(
      `You and this Child Session have gone back and forth ${exchanges} times with no person's prompt in between. Check that the work is still making progress before you message it again; if it isn't, stop and tell the people here.`,
    )
  }
  return `${note.join("\n")}\n\n${message}`
}

/** What a Report says when the Turn ended with no text after its last tool call. */
const noFinalMessage = (reason: TurnEndReason) => {
  switch (reason) {
    case "Answered":
      return "(The Child Session's Turn ended with no final message.)"
    case "Stopped":
      return "(The Child Session's Turn was stopped before it wrote a final message.)"
    case "Refused":
      return "(The model refused, and the Child Session's Turn ended with no final message.)"
    case "Failed":
      return "(An API error ended the Child Session's Turn before it wrote a final message.)"
  }
}

/**
 * A Turn's final message: the main loop's text after its last tool call, from the Turn's entries
 * as `SessionLog.lastTurn` gives them, and who sent the prompt it started with. When there is no
 * such text, a line saying why.
 */
export const finalMessage = (
  entries: ReadonlyArray<SessionLogEntry>,
): { readonly text: string; readonly sender: PromptSender | undefined } => {
  let sender: PromptSender | undefined
  let text = ""
  let reason: TurnEndReason = "Answered"
  for (const { event } of entries) {
    if ("agentId" in event && event.agentId !== undefined) continue
    switch (event._tag) {
      case "TurnStarted":
        sender = event.sender
        text = ""
        break
      case "TextDelta":
        text += event.text
        break
      case "ToolCallStarted":
      case "ToolCallEnded":
        text = ""
        break
      case "TurnEnded":
        reason = event.reason
        break
    }
  }
  const trimmed = text.trim()
  return { text: trimmed === "" ? noFinalMessage(reason) : trimmed, sender }
}

/** Whether a person sent the prompt: through the web UI, or typed at the terminal. */
export const isPerson = (sender: PromptSender) =>
  sender._tag === "FromParticipant" || sender._tag === "FromTerminal"

/** The most of a Child Session's conversation its parent reads at once, in characters. */
export const MaxConversationLength = 24_000

const senderLabel = (sender: PromptSender) => {
  switch (sender._tag) {
    case "FromParticipant":
      return `Prompt from ${sender.participant.name} (@${sender.participant.login})`
    case "FromTerminal":
      return "Typed at the terminal"
    case "FromParentSession":
      return "From the Parent Session"
    case "FromChildSession":
      return `Report from Child Session "${sender.session.title}"`
  }
}

/**
 * A Session's log entries as text, for its Parent Session to read: prompts, Claude's text, tool
 * calls by name and state changes, oldest first; subagents left out. Its last
 * {@link MaxConversationLength} characters.
 */
export const conversationText = (entries: ReadonlyArray<SessionLogEntry>) => {
  const parts: Array<string> = []
  let text = ""
  const flush = () => {
    if (text.trim() !== "") parts.push(text.trim())
    text = ""
  }
  for (const { event } of entries) {
    if ("agentId" in event && event.agentId !== undefined) continue
    switch (event._tag) {
      case "TurnStarted":
        flush()
        parts.push(
          event.text === ""
            ? `[${senderLabel(event.sender)}]`
            : `[${senderLabel(event.sender)}]\n${event.text}`,
        )
        break
      case "TextDelta":
        text += event.text
        break
      case "ToolCallStarted":
        flush()
        parts.push(`[Tool call: ${event.tool}]`)
        break
      case "TurnEnded":
        flush()
        parts.push(`[Turn ended: ${event.reason}]`)
        break
      case "SessionStateChanged":
        flush()
        parts.push(`[${event.state}${event.message === undefined ? "" : `: ${event.message}`}]`)
        break
    }
  }
  flush()
  const all = parts.join("\n\n")
  if (all === "") return "(Nothing has happened in it yet.)"
  return all.length > MaxConversationLength
    ? `(Earlier conversation left out.)\n\n${all.slice(-MaxConversationLength)}`
    : all
}
