// Claude Code's usage counters onto a pi-ai assistant message. The cost is pi-ai's own reckoning
// from the Model's prices, which the bridge registers as zero (Models.ts): kndl shows the cost
// pi-ai reports, and invents none.
//
// Ported from pi-claude-bridge 0.9.3 (MIT, Copyright (c) 2026 Eli Dickinson): see
// THIRD_PARTY_NOTICES.md.

import { calculateCost } from "@earendil-works/pi-ai"
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai"

/**
 * The usage counters Claude Code reports, as `Usage`/`MessageDeltaUsage` in @anthropic-ai/sdk.
 * Every field is optional: `message_start`, `message_delta` and a whole assistant message each
 * carry a different subset.
 */
export interface SdkUsage {
  readonly input_tokens?: number | null
  readonly output_tokens?: number | null
  readonly cache_read_input_tokens?: number | null
  readonly cache_creation_input_tokens?: number | null
  readonly output_tokens_details?: { readonly thinking_tokens?: number | null } | null
}

/** What updateUsage derived but doesn't keep on the message, for the debug log. */
export interface UsageReport {
  /** The cache-read share of the prompt, a whole percentage; 0 for an empty prompt. */
  readonly cachePct: number
  /** Thinking tokens this frame carried, if any. */
  readonly reasoning?: number
}

/**
 * Applies one SDK usage frame onto `output.usage`, then works out its total and cost. A counter
 * the frame leaves out keeps its value, so a partial frame never zeroes an earlier one.
 */
export function updateUsage(
  output: AssistantMessage,
  usage: SdkUsage,
  model: Model<Api>,
): UsageReport {
  if (usage.input_tokens != null) output.usage.input = usage.input_tokens
  if (usage.output_tokens != null) output.usage.output = usage.output_tokens
  if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens
  if (usage.cache_creation_input_tokens != null)
    output.usage.cacheWrite = usage.cache_creation_input_tokens
  // A part of output_tokens, never added to the total or the cost on its own.
  const reasoning = usage.output_tokens_details?.thinking_tokens
  if (reasoning != null) output.usage.reasoning = reasoning
  output.usage.totalTokens =
    output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite
  calculateCost(model, output.usage)
  const promptTokens = output.usage.input + output.usage.cacheRead + output.usage.cacheWrite
  const cachePct = promptTokens > 0 ? Math.round((output.usage.cacheRead / promptTokens) * 100) : 0
  return reasoning == null ? { cachePct } : { cachePct, reasoning }
}
