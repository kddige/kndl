// Cutting Claude Code's session back to where a stopped query began, keeping Claude Code's own
// records.
//
// Claude Code writes records the conversation never holds into its session: attachments on each
// prompt (its environment, the model, the date, a token count), and fillers of its own. They're
// part of every request it makes, so a session rebuilt from the conversation differs from the one
// Claude Code wrote
// from the first of them on, and the prompt cache misses almost all of it. A stopped query leaves
// the session file holding everything up to where it began, byte for byte: cut back there, and
// the next query's request starts as the stopped one's did.
//
// What the stopped query wrote first, its prompt and the attachments Claude Code put on it, is
// kept too when it's whole and is the prompt the conversation holds, so the cache the stopped query
// wrote is read back as well. Everything after it (the stopped reply, Claude Code's "[Request
// interrupted by user]", a tool call's cancelled result) is replaced by the conversation's
// messages, so Claude Code's session and the conversation hold the same turn.

import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs"
import type { JsonlRecord } from "cc-session-io"
import { messageContentToText } from "./Convert.ts"

/** Where a query began in Claude Code's session: what it held, as the conversation's messages and as bytes. */
export interface Checkpoint {
  readonly sessionId: string
  /** How many of the conversation's messages (system messages aside) the session held. */
  readonly cursor: number
  /** The session file's length: where the query's own records begin. */
  readonly bytes: number
  /** The last of those messages' timestamp, to tell the conversation wasn't replaced under it. */
  readonly lastTimestamp: number | undefined
}

/** A checkpoint at the session file as it is now; undefined when there's no file to cut back. */
export function checkpointAt(
  sessionId: string,
  jsonlPath: string,
  prior: ReadonlyArray<{ readonly timestamp?: number }>,
): Checkpoint | undefined {
  let bytes: number
  try {
    bytes = statSync(jsonlPath).size
  } catch {
    return undefined
  }
  if (bytes === 0) return undefined
  return { sessionId, cursor: prior.length, bytes, lastTimestamp: prior.at(-1)?.timestamp }
}

/** What a stopped query left past its checkpoint, and how much of it to keep. */
export interface RewindPlan {
  /** Bytes past the checkpoint to keep: the stopped query's prompt and its attachments, or 0. */
  readonly keep: number
  /** Whether those are kept: the conversation's prompt messages are then in the session already. */
  readonly keptPrompt: boolean
  /** The records cut, as far as they parse. */
  readonly cut: ReadonlyArray<JsonlRecord>
}

type Rec = Readonly<Record<string, unknown>>

const ChainTypes = new Set(["user", "assistant", "attachment", "system"])

/**
 * Reads the session file past `checkpoint`: undefined when the file isn't the one the checkpoint
 * was taken of (shorter, or not cut at a record's end there).
 */
export function readTail(jsonlPath: string, checkpoint: Checkpoint): Buffer | undefined {
  const fd = openSync(jsonlPath, "r")
  try {
    const size = fstatSync(fd).size
    if (size < checkpoint.bytes) return undefined
    const tail = Buffer.alloc(size - checkpoint.bytes + 1)
    readSync(fd, tail, 0, tail.length, checkpoint.bytes - 1)
    if (tail[0] !== 0x0a) return undefined
    return tail.subarray(1)
  } finally {
    closeSync(fd)
  }
}

/**
 * How much of a stopped query's records to keep: its prompt, when it's the first record of the
 * query's own (bookkeeping records aside) and says `prompt`, with the attachments around it, up to
 * the first record of anything else. Nothing, when the prompt isn't there whole.
 */
export function planRewind(tail: Buffer, prompt: string): RewindPlan {
  const records: Array<{ readonly record: Rec; readonly end: number }> = []
  for (let start = 0; start < tail.length;) {
    const newline = tail.indexOf(0x0a, start)
    // A record cut off mid-write: the killed Claude Code's last.
    if (newline === -1) break
    const line = tail.subarray(start, newline).toString("utf8")
    start = newline + 1
    if (!line.trim()) continue
    try {
      records.push({ record: JSON.parse(line) as Rec, end: start })
    } catch {
      break
    }
  }

  let keep = 0
  let keptPrompt = false
  let kept = 0
  for (const { record, end } of records) {
    const type = record.type
    const chained = typeof record.uuid === "string" && ChainTypes.has(String(type))
    if (!chained || type === "attachment") {
      // Bookkeeping (queue operations, titles, costs) and Claude Code's attachments.
    } else if (type === "user" && !keptPrompt && isPrompt(record, prompt)) {
      keptPrompt = true
    } else {
      break
    }
    keep = end
    kept++
  }
  if (!keptPrompt) {
    keep = 0
    kept = 0
  }
  return {
    keep,
    keptPrompt,
    cut: records.slice(kept).map(({ record }) => record as JsonlRecord),
  }
}

/** A user record that's the prompt `text`: not Claude Code's own, and not a tool's result. */
function isPrompt(record: Rec, text: string): boolean {
  if (record.isMeta === true || record.isSidechain === true) return false
  const content = (record.message as Rec | undefined)?.content
  if (
    Array.isArray(content) &&
    content.some((block) => (block as Rec | null)?.type === "tool_result")
  )
    return false
  return messageContentToText(content) === text
}
