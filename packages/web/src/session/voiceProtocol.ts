// GPT-Live's two data-channel protocols (ADR 0033), each way: what the bridge tells it, as each one's
// events, and what it says, as the call acts on it. Apart from the call, so it is tested without a
// browser.

import type { LiveVoiceProtocol } from "@kndl/protocol"
import type { VoiceEvent } from "./voiceBridge.ts"

/**
 * The most UTF-8 bytes one append to GPT-Live carries, as OpenClaw sends them: a longer one is
 * refused, so the agent's answer goes in several.
 */
export const MaxAppendBytes = 500

const encoder = new TextEncoder()
const bytesOf = (text: string) => encoder.encode(text).length

/**
 * `text` in pieces of at most `maxBytes` UTF-8 bytes, in order, split after a space where one is
 * near enough, so each piece reads as speech; else between characters, never inside one.
 */
export function appendChunks(text: string, maxBytes = MaxAppendBytes): Array<string> {
  if (bytesOf(text) <= maxBytes) return [text]
  const chunks: Array<string> = []
  let rest = text
  while (bytesOf(rest) > maxBytes) {
    // The longest prefix that fits, by whole characters.
    let fits = 0
    let used = 0
    for (const character of rest) {
      const size = bytesOf(character)
      if (used + size > maxBytes) break
      used += size
      fits += character.length
    }
    // Back to the last space within it, in its later half, if any.
    const space = rest.lastIndexOf(" ", fits - 1)
    const cut = space > fits / 2 ? space + 1 : fits
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest !== "") chunks.push(rest)
  return chunks
}

/** The event, as appends that each fit, numbered after its id. */
export const appendsOf = (event: VoiceEvent): Array<VoiceEvent> => {
  const chunks = appendChunks(event.content)
  return chunks.length === 1
    ? [event]
    : chunks.map((content, index) => ({ ...event, id: `${event.id}_${index + 1}`, content }))
}

/**
 * What the bridge tells GPT-Live, in the events of its protocol: the API's `session.thinking.append`
 * and `session.commentary.append`; through ChatGPT, Codex's `delegation.context.append` (or
 * `session.context.append`), quiet on its `commentary` channel and said on `speakable`.
 */
export const wireEvent = (protocol: LiveVoiceProtocol, event: VoiceEvent): object =>
  protocol === "Live"
    ? {
        type: event.kind === "say" ? "session.commentary.append" : "session.thinking.append",
        event_id: event.id,
        delegation_id: event.delegationId,
        content: event.content,
      }
    : {
        type: event.delegationId === null ? "session.context.append" : "delegation.context.append",
        ...(event.delegationId !== null && { delegation_item_id: event.delegationId }),
        channel: event.kind === "say" ? "speakable" : "commentary",
        content: [{ type: "input_text", text: event.content }],
      }

/** What GPT-Live said on its data channel, as the call acts on it, in either protocol. */
export type HeardEvent =
  | { readonly kind: "heard"; readonly text: string }
  | { readonly kind: "spoke"; readonly text: string }
  | { readonly kind: "delegated"; readonly id: string; readonly asked?: string }
  | { readonly kind: "closed"; readonly reason?: string }
  | { readonly kind: "error"; readonly message: string }

/** The value, if it is a string. */
const stringOf = (value: unknown) => (typeof value === "string" ? value : undefined)

/** One of GPT-Live's events, in `protocol`; undefined for one the call needn't act on. */
export function heardEvent(protocol: LiveVoiceProtocol, data: string): HeardEvent | undefined {
  let event: Record<string, unknown>
  try {
    event = JSON.parse(data) as Record<string, unknown>
  } catch {
    return undefined
  }
  const item = (event["item"] ?? {}) as Record<string, unknown>
  switch (event["type"]) {
    case "error": {
      const error = (event["error"] ?? {}) as Record<string, unknown>
      return { kind: "error", message: stringOf(error["message"]) ?? "GPT-Live reported an error." }
    }
    case "session.closed": {
      const reason = stringOf(event["reason"])
      return { kind: "closed", ...(reason !== undefined && { reason }) }
    }
  }
  if (protocol === "Live") {
    switch (event["type"]) {
      case "session.input_transcript.delta": {
        const delta = stringOf(event["delta"])
        return delta === undefined ? undefined : { kind: "heard", text: delta }
      }
      case "session.output_transcript.delta": {
        const delta = stringOf(event["delta"])
        return delta === undefined ? undefined : { kind: "spoke", text: delta }
      }
      case "session.delegation.created": {
        const delegation = (event["delegation"] ?? {}) as Record<string, unknown>
        const id = stringOf(delegation["id"])
        return id !== undefined && delegation["target"] === "client"
          ? { kind: "delegated", id }
          : undefined
      }
    }
    return undefined
  }
  switch (event["type"]) {
    // Whole pieces, not deltas: a space keeps them apart.
    case "input_transcript.added": {
      const said = stringOf(item["text"])
      return said === undefined ? undefined : { kind: "heard", text: ` ${said}` }
    }
    case "output_transcript.added": {
      const said = stringOf(item["text"])
      return said === undefined ? undefined : { kind: "spoke", text: ` ${said}` }
    }
    case "delegation.created": {
      const id = stringOf(item["id"])
      if (id === undefined || item["target"] !== "client") return undefined
      const parts = Array.isArray(item["content"]) ? (item["content"] as Array<unknown>) : []
      const asked = parts
        .map((part) => (part ?? {}) as Record<string, unknown>)
        .filter((part) => part["type"] === "input_text")
        .map((part) => stringOf(part["text"]) ?? "")
        .join("")
      return { kind: "delegated", id, ...(asked.trim() !== "" && { asked }) }
    }
  }
  return undefined
}
