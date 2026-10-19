// How the durable agent words a Turn for the Hub: its end, its usage, its error, its tools'
// results. Plain functions over pi-ai's shapes, as kndl's pi extension had them (pi/src/Turns.ts).

import type { ConversationUsage, TurnEndReason, TurnUsage } from "@kndl/protocol"
import { clip, isRecord } from "../../src/HubMessages.ts"

/**
 * A model's name as kndl names a Session's model everywhere the mod says one (its hello, a Turn's
 * usage, a subagent's model, a failed switch): `<provider>/<id>`, an id's own slashes kept.
 */
export const modelName = (model: { readonly provider: string; readonly id: string }) =>
  `${model.provider}/${model.id}`

/** What pi-ai says of a finished assistant message: its stop reason, model and usage. */
export interface AssistantEnd {
  readonly provider: string
  readonly model: string
  readonly stopReason: string
  /** What went wrong, when the stop reason is `error`: the Provider's message, or pi-ai's. */
  readonly errorMessage?: string | undefined
  readonly usage?:
    | {
        readonly input: number
        readonly output: number
        readonly cacheRead: number
        readonly cacheWrite: number
        readonly cost?: { readonly total: number } | undefined
      }
    | undefined
}

/**
 * How a Turn ended, from whether it was stopped and pi-ai's stop reason of its last request. A
 * tool that ends the run (`toolUse`) or a deferred response ends it as answered; a run with no
 * request ends in an error.
 */
export const turnEndReason = (aborted: boolean, stopReason: string | undefined): TurnEndReason => {
  if (aborted) return "aborted"
  switch (stopReason) {
    case "length":
    case "error":
    case "aborted":
      return stopReason
    case undefined:
      return "error"
    default:
      return "stop"
  }
}

/** The longest a Turn's error message is, after which it is clipped. */
export const turnErrorMessageLength = 500

/**
 * What looks like a credential in a Provider's message: a bearer token, or a key of a shape
 * Providers give out. A Provider that refuses a key often says part of it back.
 */
const credentialPatterns: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(Bearer\s+)[^\s"',;]+/gi, "$1[redacted]"],
  [
    /\b(?:sk|xai|gsk|csk|ghp|gho|ghu|ghs|ghr|github_pat|hf|nvapi|pplx)[-_][A-Za-z0-9_*.-]{8,}/g,
    "[redacted]",
  ],
  [/\bAIza[A-Za-z0-9_-]{20,}/g, "[redacted]"],
]

/** `text` without the `secrets` or anything that looks like a credential. */
export const redact = (text: string, secrets: ReadonlyArray<string> = []): string => {
  let redacted = text
  for (const secret of secrets)
    if (secret.length >= 8) redacted = redacted.replaceAll(secret, () => "[redacted]")
  for (const [pattern, replacement] of credentialPatterns)
    redacted = redacted.replace(pattern, replacement)
  return redacted
}

/**
 * Why a Turn failed, as the Hub shows it: the Provider's or the agent's message, redacted, on one
 * line, and clipped; undefined when there is nothing to say.
 */
export const turnErrorMessage = (
  message: string | undefined,
  secrets: ReadonlyArray<string> = [],
): string | undefined => {
  if (message === undefined) return undefined
  const text = redact(message, secrets).replace(/\s+/g, " ").trim()
  return text === "" ? undefined : clip(text, turnErrorMessageLength)
}

const tokens = (value: number | undefined) =>
  value !== undefined && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0

/** A cost in dollars, to the nanodollar; 0 for none. */
const dollars = (value: number | undefined) =>
  value !== undefined && Number.isFinite(value) && value > 0 ? Math.round(value * 1e9) / 1e9 : 0

/**
 * A Turn's usage, summed over its model requests, with the model of the last; undefined when no
 * request counted. The cost is pi-ai's, left out when it reports none.
 */
export const turnUsage = (messages: ReadonlyArray<AssistantEnd>): TurnUsage | undefined => {
  const last = messages.at(-1)
  if (last === undefined) return undefined
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
  for (const { usage } of messages) {
    if (usage === undefined) continue
    sum.input += tokens(usage.input)
    sum.output += tokens(usage.output)
    sum.cacheRead += tokens(usage.cacheRead)
    sum.cacheWrite += tokens(usage.cacheWrite)
    sum.cost += dollars(usage.cost?.total)
  }
  const { cost, ...counted } = sum
  if (counted.input + counted.output + counted.cacheRead + counted.cacheWrite === 0)
    return undefined
  return {
    model: modelName({ provider: last.provider, id: last.model }),
    ...counted,
    ...(cost > 0 && { cost: dollars(cost) }),
  }
}

/** A Pi Durable usage ledger (`pi.usage`), as far as kndl reads it. */
interface UsageLedger {
  readonly models: Readonly<Record<string, AssistantEnd["usage"]>>
  readonly tools: Readonly<Record<string, AssistantEnd["usage"]>>
}

/** A conversation's running total, every model and tool it spent on summed. */
export const conversationUsage = (ledger: UsageLedger): ConversationUsage => {
  const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
  for (const usage of [...Object.values(ledger.models), ...Object.values(ledger.tools)]) {
    if (usage === undefined) continue
    sum.input += tokens(usage.input)
    sum.output += tokens(usage.output)
    sum.cacheRead += tokens(usage.cacheRead)
    sum.cacheWrite += tokens(usage.cacheWrite)
    sum.cost += dollars(usage.cost?.total)
  }
  return { ...sum, cost: dollars(sum.cost) }
}

/**
 * A tool's result as the web UI shows it: its text blocks, and a note of each image, never its
 * bytes; clipped.
 */
export const toolResultSummary = (content: unknown): string => {
  if (typeof content === "string") return clip(content)
  if (!Array.isArray(content)) return ""
  return clip(
    content
      .filter(isRecord)
      .map((block) =>
        block.type === "text"
          ? String(block.text ?? "")
          : `[${typeof block.mimeType === "string" ? block.mimeType : String(block.type)}]`,
      )
      .join("\n"),
  )
}
