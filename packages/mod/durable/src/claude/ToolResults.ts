// A turn's tool results, from the call's transcript: Pi Durable doesn't hand a provider its tools'
// results, it appends them to the conversation and calls the provider again, so they're read back
// off the end.
//
// Ported from pi-claude-bridge 0.9.3 (MIT, Copyright (c) 2026 Eli Dickinson): see
// THIRD_PARTY_NOTICES.md.

import type { LooseBlock } from "./Convert.ts"

export type McpContent = Array<
  { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
>

/** A tool's result as MCP answers a `tools/call`, with the tool call it answers. */
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

/** A message of the transcript, loosely. */
export interface LooseMessage {
  readonly role: string
  readonly content?: unknown
  readonly toolCallId?: string
  readonly toolName?: string
  readonly isError?: boolean
}

/**
 * This turn's tool results: the trailing ones, back to the nearest assistant message, past user
 * messages (steers) placed among them. `stopIdx` is that assistant message's
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

/**
 * Whether this turn's results hold one Pi Durable wrote for a call it aborted: the run was stopped
 * (Esc) while the tools ran, and the call bringing them is a new run's, not the stopped one's
 * going on. Pi Durable's own words, in the `<harness>` block it appends to a result
 * (`Tool <name> was aborted`).
 */
export function hasAbortedResult(messages: ReadonlyArray<LooseMessage>): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg === undefined) continue
    if (msg.role === "assistant") return false
    if (msg.role !== "toolResult" || msg.isError !== true) continue
    const said = `[error] Tool ${msg.toolName ?? ""} was aborted`
    const texts = toolResultToMcpContent(msg.content).flatMap((block) =>
      block.type === "text" ? [block.text] : [],
    )
    if (texts.some((text) => text.includes("<harness>") && text.includes(said))) return true
  }
  return false
}
