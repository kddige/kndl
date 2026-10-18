// pi hands a provider a transcript: the system prompt and tools as system messages within the
// conversation. The bridge reads them back out as the prompt and tools fields, rendered in pi's
// own section order, which is what its prompt captures are keyed by (PromptCapture.ts).
//
// Ported from pi-claude-bridge 0.9.3 (MIT, Copyright (c) 2026 Eli Dickinson): see
// THIRD_PARTY_NOTICES.md.

import { contentText, getCurrentSystemMessage, getCurrentTools } from "@earendil-works/pi-ai"
import type { Context, SystemMessage } from "@earendil-works/pi-ai"

/**
 * pi's built-in sections in its builder's order. A name not here is a custom section (one an
 * extension set through `systemPromptOptions.sections`, like kndl's own), which the builder
 * renders after every built-in.
 */
const SectionRank = new Map<string, number>([
  ["preamble", 0],
  ["tools", 1],
  ["rules", 2],
  ["docs", 3],
  ["addendum", 4],
  ["project_context", 5],
  ["skills", 6],
  ["cwd", 7],
])

/** The sections, stably sorted by rank: custom ones last, keeping their replayed order. */
function stableRanked(
  sections: Map<string, string>,
  ranks: Map<string, number>,
): Map<string, string> {
  const customRank = Math.max(...ranks.values()) + 1
  const ranked = [...sections].map(([name, value]) => ({
    name,
    value,
    rank: ranks.get(name) ?? customRank,
  }))
  ranked.sort((a, b) => a.rank - b.rank)
  return new Map(ranked.map(({ name, value }) => [name, value]))
}

/** The replayed system state, rendered in pi's builder's section order. */
function canonicalSystemPrompt(message: SystemMessage | undefined): string | undefined {
  if (!message) return undefined
  const sections = new Map<string, string>(
    Object.entries(message.sections ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== null,
    ),
  )
  const parts = [
    contentText(message.content),
    ...stableRanked(sections, SectionRank).values(),
  ].filter((part) => part.length > 0)
  return parts.length > 0 ? parts.join("\n\n") : undefined
}

/**
 * The context with its prompt and tools fields restored and the system messages taken out of the
 * conversation; one without system messages is returned as it is.
 */
export function toBridgeContext(context: Context): Context {
  if (!context.messages.some((message) => message.role === "system")) return context
  const tools = getCurrentTools(context.messages)
  const systemPrompt = canonicalSystemPrompt(getCurrentSystemMessage(context.messages))
  return {
    messages: nonSystemMessages(context.messages),
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    ...(tools.length > 0 ? { tools } : {}),
  }
}

/** The messages without pi's prompt-state system messages. */
export function nonSystemMessages<T extends { readonly role: string }>(
  messages: ReadonlyArray<T>,
): Array<Exclude<T, SystemMessage>> {
  return messages.filter((message) => message.role !== "system") as Array<Exclude<T, SystemMessage>>
}
