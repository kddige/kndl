// A turn's tool results, from pi's context: pi doesn't hand a provider its tools' results, it
// appends them to the context and calls the provider again, so they're read back off the end.
//
// Ported from pi-claude-bridge 0.9.3 (MIT, Copyright (c) 2026 Eli Dickinson): see
// THIRD_PARTY_NOTICES.md.

import type { LooseBlock } from "./Convert.ts"

export type McpContent = Array<
  { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
>

/** A tool's result as MCP answers a `tools/call`, with the pi tool call it answers. */
export interface McpResult {
  content: McpContent
  isError?: boolean | undefined
  toolCallId?: string | undefined
}

export function toolResultToMcpContent(content: unknown): McpContent {
  if (typeof content === "string") return [{ type: "text", text: content || "" }]
  if (!Array.isArray(content)) return [{ type: "text", text: "" }]
  const blocks: McpContent = []
  for (const block of content as ReadonlyArray<LooseBlock>) {
    if (block.type === "text" && block.text) blocks.push({ type: "text", text: block.text })
    else if (block.type === "image" && block.data && block.mimeType)
      blocks.push({ type: "image", data: block.data, mimeType: block.mimeType })
  }
  return blocks.length ? blocks : [{ type: "text", text: "" }]
}

/** A message of pi's context, loosely. */
export interface LooseMessage {
  readonly role: string
  readonly content?: unknown
  readonly toolCallId?: string
  readonly isError?: boolean
}

/**
 * This turn's tool results: the trailing ones, back to the nearest assistant message, past user
 * messages (steers, follow-ups) pi may have put among them. `stopIdx` is that assistant message's
 * index, for the debug log.
 */
export function extractAllToolResults(messages: ReadonlyArray<LooseMessage>): {
  results: McpResult[]
  stopIdx: number
} {
  const results: McpResult[] = []
  let stopIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg === undefined) continue
    if (msg.role === "toolResult") {
      results.unshift({
        content: toolResultToMcpContent(msg.content),
        isError: msg.isError,
        toolCallId: msg.toolCallId,
      })
    } else if (msg.role === "assistant") {
      stopIdx = i
      break
    }
  }
  return { results, stopIdx }
}
