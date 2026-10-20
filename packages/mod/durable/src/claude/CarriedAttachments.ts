// Claude Code's own `@file` expansions, carried across a session rebuild.
//
// Claude Code expands an `@file` mention itself (the agent passes `@` through) and writes the
// expansion as an `attachment` record in its session. The agent never sees it, so rebuilding the
// session from the conversation would drop the file while keeping the prompt that refers to it.
// Only `file` attachments are carried: the rest Claude Code writes again each turn, or
// (`edited_text_file`) repeats what's in the conversation already.
//
// Ported from pi-claude-bridge 0.9.3 (MIT, Copyright (c) 2026 Eli Dickinson): see
// THIRD_PARTY_NOTICES.md.

import type { ImportAttachment, JsonlRecord } from "cc-session-io"
import { messageContentToText } from "./Convert.ts"

const ContentBearing = new Set(["file"])

export interface CarriedAttachment {
  readonly attachment: { readonly type: string; readonly [key: string]: unknown }
  /** Where its prompt sits among the session's text-bearing user records. */
  readonly userOrdinal: number
  /** That prompt's text, to check the ordinal still points at the same turn. */
  readonly parentText: string
}

type Rec = Readonly<Record<string, unknown>>

const hasToolResult = (content: unknown) =>
  Array.isArray(content) && content.some((block) => (block as Rec | null)?.type === "tool_result")

/** A user record's prompt text; undefined for one holding tool results, or anything else. */
function userPromptText(record: Rec): string | undefined {
  if (record.type !== "user") return undefined
  const content = (record.message as Rec | undefined)?.content
  if (hasToolResult(content)) return undefined
  const text = messageContentToText(content)
  return text ? text : undefined
}

/**
 * The session's content-bearing attachments, each with where its prompt sits among the
 * text-bearing user records: a rebuild doesn't reproduce the records one for one, but its
 * sequence of prompts is the same conversation. Attachments chain to one another, so an ordinal
 * is inherited up the chain to the prompt.
 */
export function collectCarriedAttachments(
  records: ReadonlyArray<JsonlRecord>,
): Array<CarriedAttachment> {
  const ordinalOf = new Map<string, number>()
  const textOf = new Map<string, string>()
  let ordinal = 0
  const carried: Array<CarriedAttachment> = []

  for (const raw of records) {
    const record = raw as Rec
    const uuid = record.uuid as string
    const prompt = userPromptText(record)
    if (prompt !== undefined) {
      ordinalOf.set(uuid, ordinal++)
      textOf.set(uuid, prompt)
      continue
    }
    if (record.type !== "attachment") continue
    const parent = record.parentUuid as string | null
    if (parent === null) continue
    const inherited = ordinalOf.get(parent)
    const parentText = textOf.get(parent)
    if (inherited === undefined || parentText === undefined) continue
    ordinalOf.set(uuid, inherited)
    textOf.set(uuid, parentText)

    const attachment = record.attachment as CarriedAttachment["attachment"] | undefined
    if (!attachment || !ContentBearing.has(attachment.type)) continue
    carried.push({ attachment, userOrdinal: inherited, parentText })
  }
  return carried
}

/**
 * Each carried attachment's place in the messages about to be imported, after conversion and
 * repair, as `importMessages` reads them. Conservative: a file attached to the wrong turn tells
 * the model it saw something when it didn't, which is worse than losing it, so anything that
 * doesn't line up is reported and dropped.
 */
export function placeCarriedAttachments(
  carried: ReadonlyArray<CarriedAttachment>,
  messages: ReadonlyArray<{ readonly role: string; readonly content: unknown }>,
): { attachments: Array<ImportAttachment>; skipped: Array<string> } {
  const prompts: Array<{ index: number; text: string }> = []
  messages.forEach((msg, index) => {
    if (msg.role !== "user" || hasToolResult(msg.content)) return
    const text = messageContentToText(msg.content)
    if (text) prompts.push({ index, text })
  })

  const attachments: Array<ImportAttachment> = []
  const skipped: Array<string> = []
  for (const item of carried) {
    const name = String(item.attachment.filename ?? item.attachment.type)
    const candidate = prompts[item.userOrdinal]
    if (!candidate) {
      skipped.push(`${name}: prompt #${item.userOrdinal} is no longer in history`)
      continue
    }
    if (candidate.text !== item.parentText) {
      skipped.push(`${name}: prompt #${item.userOrdinal} changed`)
      continue
    }
    attachments.push({ afterIndex: candidate.index, attachment: { ...item.attachment } })
  }
  return { attachments, skipped }
}
