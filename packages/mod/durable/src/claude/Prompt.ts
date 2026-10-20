// What a call brings the bridge, as Claude Code is to get it: the conversation, its system prompt
// and its tools. Pi Durable hands a provider a transcript, the system prompt's sections and the
// tool set as positional system messages within the conversation, re-sent only where they change;
// pi-ai replays them into the current prompt and tools. The prompt is the durable agent's own
// sections, all of it portable, so it is appended to Claude Code's own preset whole: no harness
// text of pi's to take out, as the pi extension had to.
//
// Ported in part from pi-claude-bridge 0.9.3 (MIT, Copyright (c) 2026 Eli Dickinson): see
// THIRD_PARTY_NOTICES.md.

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai"
import type { Message, Tool } from "@earendil-works/pi-ai"
import { userTurnText } from "./Convert.ts"
import type { BridgeLog } from "./Log.ts"
import { nonSystemMessages, turnStart } from "./SessionMirror.ts"

/** A call's transcript, read: the conversation without its system messages, its prompt, tools. */
export interface BridgeContext {
  readonly messages: Array<Message>
  readonly systemPrompt?: string
  readonly tools?: Array<Tool>
}

/** The transcript a call brings, as the bridge reads it. */
export function toBridgeContext(messages: ReadonlyArray<{ readonly role: string }>): BridgeContext {
  const systemPrompt = getCurrentSystemPrompt(messages)
  const tools = getCurrentTools(messages)
  return {
    messages: nonSystemMessages(messages) as unknown as Array<Message>,
    ...(systemPrompt.length > 0 ? { systemPrompt } : {}),
    ...(tools.length > 0 ? { tools } : {}),
  }
}

/** A block of a prompt to Claude Code. */
export type PromptBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image"
      readonly source: {
        readonly type: "base64"
        readonly media_type: string
        readonly data: string
      }
    }

/** The current user turn as text, or null when the last message isn't a user message. */
export function extractUserPrompt(messages: ReadonlyArray<Message>): string | null {
  const turn = messages.slice(turnStart(messages))
  if (turn.length === 0) return null
  // Empties out first, so an all-empty turn is "" for the empty-prompt guard.
  return userTurnText(turn)
}

/** The current user turn as blocks, keeping its images; null when it has none. */
export function extractUserPromptBlocks(
  messages: ReadonlyArray<Message>,
  log?: BridgeLog,
): Array<PromptBlock> | null {
  const turn = messages.slice(turnStart(messages))
  if (turn.length === 0) return null

  let hasImage = false
  const blocks: Array<PromptBlock> = []
  for (const message of turn) {
    if (message.role !== "user") continue
    const content =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content
    // Off-type content breaks UserMessage's contract: almost always another extension's message.
    if (!Array.isArray(content)) {
      throw new Error(
        `extractUserPromptBlocks: user message content must be a string or block array, got ${typeof content} — likely a malformed message from another extension`,
      )
    }
    for (const block of content) {
      if (block.type === "text" && block.text) {
        blocks.push({ type: "text", text: block.text })
      } else if (block.type === "image") {
        if (!block.data || !block.mimeType) {
          log?.debug(`image block missing data or mimeType, skipping`)
          continue
        }
        hasImage = true
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: block.mimeType, data: block.data },
        })
      }
    }
  }
  return hasImage ? blocks : null
}

/** The trailing user turn as blocks, images kept, or null when there's none. */
export function steerBlocks(
  messages: ReadonlyArray<Message>,
  log?: BridgeLog,
): Array<PromptBlock> | null {
  const blocks = extractUserPromptBlocks(messages, log)
  if (blocks) return blocks
  const text = extractUserPrompt(messages)
  return text ? [{ type: "text", text }] : null
}

/**
 * A prompt's blocks as the SDK takes a user message's content. An image's type is pi-ai's, which
 * the Messages API checks: one it doesn't take fails the request there, as it would from pi-ai.
 */
export const promptContent = (blocks: ReadonlyArray<PromptBlock>) =>
  blocks as unknown as SDKUserMessage["message"]["content"]

/**
 * pi's own preamble, which pi's coding agent starts every prompt it renders with. Forwarding it
 * makes Claude Code's subscription path read the request as a third-party app.
 */
export const PiPreamble = "You are an expert coding assistant operating inside pi"

/** Both doc paths of pi's documentation line: Anthropic's subscription gate refuses the pair. */
const ThirdPartyTriggers = ["docs/custom-provider.md", "docs/packages.md"]

/**
 * Refuses a system prompt that carries pi's harness text, or the phrase pair Anthropic's
 * subscription gate refuses: Claude Code's request would fail with 400 or bill as Extra Usage. The
 * durable agent writes neither; a section someone added that copies pi's would.
 */
export function assertSendablePrompt(systemPrompt: string | undefined): void {
  if (systemPrompt === undefined) return
  const findings: Array<string> = []
  const offset = preambleAtLineStart(systemPrompt)
  if (offset !== -1) {
    findings.push(
      `pi's preamble ("${PiPreamble}") at offset ${offset} of ${systemPrompt.length} chars`,
    )
  }
  if (ThirdPartyTriggers.every((trigger) => systemPrompt.includes(trigger)))
    findings.push(ThirdPartyTriggers.join(" and "))
  if (findings.length === 0) return

  throw new Error(
    [
      "claude bridge: refusing to send this system prompt. Claude's subscription reads a request",
      "  carrying pi's harness text, or the phrase pair its gate rejects, as a third-party app: it",
      "  fails with 400 or is billed as extra usage.",
      ...findings.map((finding) => `  Found: ${finding}.`),
      "  Reword or remove that text where it comes from: the instructions in this workspace's",
      "  AGENTS.md or CLAUDE.md, or one of its skills.",
    ].join("\n"),
  )
}

/** The offset of pi's preamble at the start of a line, or -1: mid-line, it's a mention of it. */
function preambleAtLineStart(text: string): number {
  for (
    let offset = text.indexOf(PiPreamble);
    offset !== -1;
    offset = text.indexOf(PiPreamble, offset + PiPreamble.length)
  ) {
    if (offset === 0 || text[offset - 1] === "\n") return offset
  }
  return -1
}
