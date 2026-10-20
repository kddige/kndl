// A conversation's pi-ai messages as Anthropic API messages, for writing it into Claude Code's
// session (SessionMirror.ts).
//
// Ported from pi-claude-bridge 0.9.3 (MIT, Copyright (c) 2026 Eli Dickinson): see
// THIRD_PARTY_NOTICES.md.

import type { Message as PiMessage } from "@earendil-works/pi-ai"
import type { ContentBlock, Message as SessionMessage } from "cc-session-io"
import { ClaudeApi, McpToolPrefix } from "./Names.ts"

/** A block of a message's content, loosely: what pi-ai's types promise, and what more may be there. */
export interface LooseBlock {
  readonly type: string
  readonly text?: string
  readonly data?: string
  readonly mimeType?: string
}

/** The conversation's tool call ids, as Claude Code accepts them: letters, digits, `_` and `-`. */
export function sanitizeToolId(id: string, cache: Map<string, string>): string {
  const existing = cache.get(id)
  if (existing !== undefined) return existing
  const clean = id.replace(/[^a-zA-Z0-9_-]/g, "_")
  cache.set(id, clean)
  return clean
}

/**
 * An agent tool's name as the name a rebuilt transcript has to call it by.
 *
 * The query runs with `tools: []`, so every tool Claude can call is one of the agent's, served over
 * MCP, and its name is `mcp__custom-tools__<tool name>` by construction (`resolveMcpTools`). The
 * map is consulted first only because it carries the served tool's exact casing. A name it lacks
 * is a tool the agent ran that isn't served now (an extension since disabled), and naming that after a Claude
 * Code builtin would tell the model a builtin it can't call is available: the condition behind the
 * reference's phantom-call deadlock.
 */
export function mapToolNameToSdk(name: string, customToolNameToSdk: Map<string, string>): string {
  if (!name) return ""
  const normalized = name.toLowerCase()
  // The conversation holds the agent's tool names; an SDK name here was converted twice.
  if (normalized.startsWith(McpToolPrefix)) {
    throw new Error(
      `mapToolNameToSdk: "${name}" is already an SDK tool name — the conversation holds the agent's tool names`,
    )
  }
  return (
    customToolNameToSdk.get(name) ??
    customToolNameToSdk.get(normalized) ??
    `${McpToolPrefix}${name}`
  )
}

export function messageContentToText(
  content: string | ReadonlyArray<LooseBlock> | unknown,
): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: Array<string> = []
  let hasText = false
  for (const block of content as ReadonlyArray<LooseBlock>) {
    if (block.type === "text" && block.text) {
      parts.push(block.text)
      hasText = true
    } else if (block.type !== "text" && block.type !== "image") {
      parts.push(`[${block.type}]`)
    }
  }
  return hasText ? parts.join("\n") : ""
}

/**
 * A user turn's messages as the one prompt the bridge sends Claude Code: their texts, joined. "" when
 * there's none.
 */
export function userTurnText(
  turn: ReadonlyArray<{ readonly role: string; readonly content?: unknown }>,
): string {
  return turn
    .map((message) =>
      message.role === "user"
        ? typeof message.content === "string"
          ? message.content
          : messageContentToText(message.content)
        : "",
    )
    .filter((text) => text)
    .join("\n")
}

/**
 * A tool result's content: flattened to text, which is how Claude Code stores most of them, but
 * kept as blocks when it carries an image, which has no text form.
 */
function toolResultContent(content: string | ReadonlyArray<LooseBlock>): string | ContentBlock[] {
  if (typeof content === "string" || !Array.isArray(content))
    return messageContentToText(content) || ""
  const hasImage = content.some((block) => block.type === "image" && block.data && block.mimeType)
  if (!hasImage) return messageContentToText(content) || ""
  const blocks: ContentBlock[] = []
  for (const block of content) {
    if (block.type === "text" && block.text) blocks.push({ type: "text", text: block.text })
    else if (block.type === "image" && block.data && block.mimeType) {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: block.mimeType, data: block.data },
      })
    } else if (block.type !== "text" && block.type !== "image") {
      // The marker messageContentToText leaves, so both paths describe it the same way.
      blocks.push({ type: "text", text: `[${block.type}]` })
    }
  }
  return blocks
}

/** What convertMessages discarded, for the debug log. */
export interface DroppedContent {
  thinking: number
  abortedTurns: number
  readonly providers: Set<string>
  readonly other: Map<string, number>
}

/** A conversation's messages as Anthropic API messages, for importing into Claude Code's session. */
export function convertMessages(
  messages: ReadonlyArray<PiMessage>,
  customToolNameToSdk: Map<string, string>,
): {
  anthropicMessages: SessionMessage[]
  sanitizedIds: Map<string, string>
  dropped: DroppedContent
} {
  const anthropicMessages: SessionMessage[] = []
  const sanitizedIds = new Map<string, string>()
  // Nothing downstream can tell a stripped thinking block from one that never was: count them.
  const dropped: DroppedContent = {
    thinking: 0,
    abortedTurns: 0,
    providers: new Set(),
    other: new Map(),
  }
  // The user message collecting this assistant turn's tool results, once one is emitted, and the
  // index of the assistant message it belongs to: see the toolResult branch.
  let turnResults: { role: "user"; content: ContentBlock[] } | null = null
  let turnAssistantIdx: number | null = null

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        anthropicMessages.push({ role: "user", content: msg.content || "[empty]" })
      } else if (Array.isArray(msg.content)) {
        const parts: ContentBlock[] = []
        for (const block of msg.content as ReadonlyArray<LooseBlock>) {
          if (block.type === "text" && block.text) parts.push({ type: "text", text: block.text })
          else if (block.type === "image" && block.data && block.mimeType) {
            parts.push({
              type: "image",
              source: { type: "base64", media_type: block.mimeType, data: block.data },
            })
          }
        }
        anthropicMessages.push({ role: "user", content: parts.length ? parts : "[image]" })
      } else {
        anthropicMessages.push({ role: "user", content: "[empty]" })
      }
    } else if (msg.role === "assistant") {
      const content = Array.isArray(msg.content) ? msg.content : []
      const blocks: ContentBlock[] = []
      for (const block of content) {
        if (block.type === "text" && block.text) {
          blocks.push({ type: "text", text: block.text })
        } else if (block.type === "thinking") {
          // Only thinking Claude Code itself produced: a signature minted by any other provider,
          // pi-ai's own Anthropic provider included, isn't ours to hand back.
          const signature = block.thinkingSignature
          if (msg.api === ClaudeApi && signature) {
            blocks.push({ type: "thinking", thinking: block.thinking ?? "", signature })
          } else {
            dropped.thinking++
            dropped.providers.add(msg.provider ?? "unknown")
          }
        } else if (block.type === "toolCall") {
          blocks.push({
            type: "tool_use",
            id: sanitizeToolId(block.id, sanitizedIds),
            name: mapToolNameToSdk(block.name, customToolNameToSdk),
            input: block.arguments ?? {},
          })
        } else {
          const type = (block as LooseBlock).type
          dropped.other.set(type, (dropped.other.get(type) ?? 0) + 1)
        }
      }
      // A turn aborted before anything streamed has no content. A placeholder would invent a
      // reply, early in the prefix, costing the prompt cache on every rebuild: drop it. Not
      // clearing turnResults/turnAssistantIdx is deliberate, so a result after it still joins the
      // last assistant message emitted (an abort between two parallel results).
      if (!content.length) {
        dropped.abortedTurns++
        continue
      }
      // Blocks there, but every one filtered: keep the slot, as the API refuses empty content and
      // dropping the message would break tool pairing.
      if (!blocks.length) blocks.push({ type: "text", text: "[incompatible content omitted]" })
      turnResults = null
      turnAssistantIdx = anthropicMessages.length
      anthropicMessages.push({ role: "assistant", content: blocks })
    } else if (msg.role === "toolResult") {
      // The conversation keeps one message per tool result, but repairToolPairing pairs only
      // results that share the user message straight after their assistant message, so they're
      // collected into the turn's first result message, right after it, past any steer recorded
      // between them.
      const block: ContentBlock = {
        type: "tool_result",
        tool_use_id: sanitizeToolId(msg.toolCallId, sanitizedIds),
        content: toolResultContent(msg.content as ReadonlyArray<LooseBlock>),
        is_error: msg.isError,
      }
      if (turnResults) {
        turnResults.content.push(block)
      } else {
        turnResults = { role: "user", content: [block] }
        // A result with no assistant message before it is malformed history; appending keeps it
        // in order for repairToolPairing to discard.
        anthropicMessages.splice(
          turnAssistantIdx === null ? anthropicMessages.length : turnAssistantIdx + 1,
          0,
          turnResults,
        )
      }
    }
  }

  return { anthropicMessages, sanitizedIds, dropped }
}
