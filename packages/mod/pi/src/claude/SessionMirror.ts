// Claude Code's session as a mirror of pi's history. Each Claude turn resumes a Claude Code
// session (`resume`) holding pi's conversation up to the turn's prompt, which keeps Claude's
// prompt cache warm. When pi's history moved on without it (another Provider took a turn, an
// abort, a compaction), the session is rewritten from pi's history (cc-session-io), in Claude
// Code's state directory, on the Session's volume.
//
// Ported from pi-claude-bridge 0.9.3 (MIT, Copyright (c) 2026 Eli Dickinson): see
// THIRD_PARTY_NOTICES.md.

import { readFileSync, statSync } from "node:fs"
import type { Message } from "@earendil-works/pi-ai"
import { createSession, deleteSession, openSession, repairToolPairing } from "cc-session-io"
import type { Session } from "cc-session-io"
import { collectCarriedAttachments, placeCarriedAttachments } from "./CarriedAttachments.ts"
import type { CarriedAttachment } from "./CarriedAttachments.ts"
import { convertPiMessages } from "./Convert.ts"
import { debug, diag } from "./Log.ts"
import { nonSystemMessages } from "./Transcript.ts"

/** pi's history, as the bridge reads it. */
export type PiMessages = ReadonlyArray<Message>

export interface SessionState {
  readonly sessionId: string
  /** How many of pi's messages (system messages aside) the session holds. */
  readonly cursor: number
  readonly cwd: string
  /** The pi session this conversation serves. */
  readonly piSessionId?: string | undefined
  /**
   * The next sync rebuilds: pi changed its history under the mirror (compaction, tree navigation),
   * or an abort left the session file in an unknown state.
   */
  readonly needsRebuild?: boolean | undefined
  /**
   * Set only where a Claude Code was just killed (an abort, a discarded query): it may still flush
   * a late record into the session file, so the rebuild takes a new id rather than racing it.
   */
  readonly forceRotate?: boolean | undefined
}

export interface SyncResult {
  /** The session to resume, or null to start one. */
  readonly sessionId: string | null
  /** The query mustn't take over the session it's given: it's a shorter context's own. */
  readonly preserveSharedSession?: boolean
}

/** Where Claude Code's sessions are: its state directory, as the bridge's settings say. */
let claudeDirectory: string | undefined

export function setClaudeDir(dir: string | undefined): void {
  claudeDirectory = dir
}

export const claudeDir = () => claudeDirectory ?? process.env.CLAUDE_CONFIG_DIR

/** pi sessions' mirrors, by pi session id ("(none)" for a call that names none). */
const sharedSessions = new Map<string, SessionState>()

const sessionKey = (piSessionId: string | null | undefined) => piSessionId ?? "(none)"

/** The mirror for `piSessionId`, or null when the session has none yet. */
export function sessionStateFor(piSessionId: string | null | undefined): SessionState | null {
  return sharedSessions.get(sessionKey(piSessionId)) ?? null
}

/** Replaces (or plants, or with null drops) the mirror for `piSessionId`. */
export function setSessionStateFor(
  piSessionId: string | null | undefined,
  state: SessionState | null,
): void {
  if (state === null) sharedSessions.delete(sessionKey(piSessionId))
  else sharedSessions.set(sessionKey(piSessionId), state)
}

/** Forgets every mirror. */
export function clearSessionStates(): void {
  sharedSessions.clear()
}

export const sessionStateCount = () => sharedSessions.size

/**
 * The index of the current user turn's first message: the trailing run of user messages not in
 * Claude Code's session yet. Everything before it is history, everything from it the prompt.
 */
export function turnStart(messages: ReadonlyArray<{ readonly role: string }>): number {
  let i = messages.length
  while (i > 0 && messages[i - 1]?.role === "user") i--
  return i
}

/** Claude Code's `@file` expansions in the session about to be replaced: before deleteSession. */
function readCarriedAttachments(sessionId: string, cwd: string): Array<CarriedAttachment> {
  try {
    const dir = claudeDir()
    const previous = openSession({
      sessionId,
      projectPath: cwd,
      ...(dir === undefined ? {} : { claudeDir: dir }),
    })
    return collectCarriedAttachments(previous.records)
  } catch (error) {
    // A killed Claude Code may have left a truncated last line; carrying none is what happened
    // before this existed.
    debug(`WARNING: could not read attachments from session ${sessionId.slice(0, 8)}:`, error)
    return []
  }
}

/**
 * pi's messages into `session`, as Anthropic messages. Lossy: text, thinking (Claude Code's own
 * only) and tool calls survive.
 */
function convertAndImportMessages(
  session: Session,
  messages: PiMessages,
  customToolNameToSdk: Map<string, string>,
  carried: ReadonlyArray<CarriedAttachment>,
): void {
  const { anthropicMessages, sanitizedIds, dropped } = convertPiMessages(
    messages,
    customToolNameToSdk,
  )
  debug(
    `convertAndImportMessages: ${messages.length} pi msgs → ${anthropicMessages.length} anthropic msgs`,
  )
  const droppedParts = [
    dropped.thinking
      ? `${dropped.thinking} thinking (${[...dropped.providers].toSorted().join(", ")})`
      : "",
    dropped.abortedTurns ? `${dropped.abortedTurns} aborted turn(s)` : "",
    ...[...dropped.other].map(([type, n]) => `${n} ${type}`),
  ].filter(Boolean)
  if (droppedParts.length > 0) debug(`convertAndImportMessages: dropped ${droppedParts.join(", ")}`)
  if (sanitizedIds.size > 0) debug(`convertAndImportMessages: sanitized ${sanitizedIds.size} ids`)
  // importMessages repairs too (idempotently); this is for placing the attachments, in the index
  // space importMessages reads.
  const repaired = repairToolPairing(anthropicMessages)
  const placed = carried.length ? placeCarriedAttachments(carried, repaired) : undefined
  if (placed?.skipped.length)
    debug(
      `convertAndImportMessages: dropped ${placed.skipped.length} carried attachment(s): ${placed.skipped.join("; ")}`,
    )
  if (repaired.length) {
    session.importMessages(
      repaired,
      placed?.attachments.length ? { attachments: placed.attachments } : undefined,
    )
  }
}

/** Reads back the session file just written and checks it; says what's wrong, never throws. */
export function verifyWrittenSession(
  jsonlPath: string,
  expectedSessionId: string,
  expectedRecordCount: number,
): Array<string> {
  const warnings: Array<string> = []
  let size: number
  try {
    size = statSync(jsonlPath).size
  } catch (error) {
    warnings.push(`file missing after save — path=${jsonlPath} err=${String(error)}`)
    return warnings
  }
  let content: string
  try {
    content = readFileSync(jsonlPath, "utf8")
  } catch (error) {
    warnings.push(`file unreadable — path=${jsonlPath} size=${size} err=${String(error)}`)
    return warnings
  }
  const lines = content.split("\n").filter((line) => line.trim().length > 0)
  if (lines.length !== expectedRecordCount) {
    warnings.push(
      `record count mismatch — expected=${expectedRecordCount} actual=${lines.length} path=${jsonlPath} bytes=${content.length}`,
    )
    return warnings
  }
  try {
    const first = JSON.parse(lines[0] ?? "") as { sessionId?: unknown }
    const last = JSON.parse(lines[lines.length - 1] ?? "") as { sessionId?: unknown }
    if (first.sessionId !== expectedSessionId || last.sessionId !== expectedSessionId) {
      warnings.push(
        `sessionId drift — expected=${expectedSessionId} first=${String(first.sessionId)} last=${String(last.sessionId)}`,
      )
    }
  } catch (error) {
    warnings.push(`malformed JSONL — path=${jsonlPath} err=${String(error)}`)
  }
  return warnings
}

/**
 * Makes Claude Code's session for `piSessionId` hold pi's history up to the current user turn, and
 * says which to resume.
 *
 * - Reuse: in step with the mirror, or ahead of it only by the final assistant message pi appends
 *   after a turn (which Claude Code's session has already). Resumes it, keeping the cache warm.
 * - Rebuild: no mirror yet, or pi's history moved on without it. Rewrites the session from pi's
 *   history whole, under the same id unless a killed Claude Code might still write to it.
 *
 * A context shorter than the mirror (a pruned one) can't continue it: it starts clean, and leaves
 * the mirror as it is.
 */
export function syncSharedSession(
  messages: PiMessages,
  cwd: string,
  customToolNameToSdk: Map<string, string>,
  modelId?: string,
  piSessionId?: string | null,
): SyncResult {
  // System messages are pi's prompt state, never imported, so never counted.
  const sharedSession = sessionStateFor(piSessionId)
  const history = nonSystemMessages(messages)
  const priorMessages = history.slice(0, turnStart(history))

  if (
    sharedSession &&
    !sharedSession.needsRebuild &&
    priorMessages.length >= sharedSession.cursor
  ) {
    const missed = priorMessages.slice(sharedSession.cursor)
    const trailingAssistantOnly = missed.length === 1 && missed[0]?.role === "assistant"
    if (missed.length === 0 || trailingAssistantOnly) {
      if (trailingAssistantOnly) {
        setSessionStateFor(piSessionId, { ...sharedSession, cursor: priorMessages.length, cwd })
        debug(
          `Case 3: advanced cursor past trailing assistant, resuming session ${sharedSession.sessionId.slice(0, 8)}`,
        )
      } else {
        debug(`Case 3: resuming session ${sharedSession.sessionId.slice(0, 8)}`)
      }
      debug(`syncResult: path=reuse sessionId=${sharedSession.sessionId}`)
      return { sessionId: sharedSession.sessionId }
    }
  }
  if (sharedSession && !sharedSession.needsRebuild && priorMessages.length < sharedSession.cursor) {
    debug(
      `Case 1 synthetic: clean start for shorter context, preserving shared session ${sharedSession.sessionId.slice(0, 8)}`,
    )
    return { sessionId: null, preserveSharedSession: true }
  }

  if (priorMessages.length === 0) {
    debug(`Case 1: clean start, ${history.length} total messages`)
    return { sessionId: null }
  }
  const previousSessionId = sharedSession?.sessionId
  const dir = claudeDir()
  const preserveId = previousSessionId !== undefined && !sharedSession?.forceRotate
  // Before deleteSession, which wipes the file they're in.
  const carried =
    previousSessionId !== undefined ? readCarriedAttachments(previousSessionId, cwd) : []
  if (preserveId) deleteSession(previousSessionId, cwd, dir)
  const session = createSession({
    projectPath: cwd,
    ...(dir === undefined ? {} : { claudeDir: dir }),
    ...(preserveId ? { sessionId: previousSessionId } : {}),
    ...(modelId ? { model: modelId } : {}),
  })
  convertAndImportMessages(session, priorMessages, customToolNameToSdk, carried)
  session.save()
  // Records, not messages: the carried attachments are records too.
  for (const warning of verifyWrittenSession(
    session.jsonlPath,
    session.sessionId,
    session.records.length,
  ))
    diag("session_verify_fail", { warning, cwd, claudeDir: dir ?? null })
  setSessionStateFor(piSessionId, {
    sessionId: session.sessionId,
    cursor: priorMessages.length,
    cwd,
    piSessionId: piSessionId ?? undefined,
  })
  debug(
    `syncResult: path=rebuild sessionId=${session.sessionId} priors=${priorMessages.length} ${previousSessionId === undefined ? "first" : preserveId ? "preserved" : "rotated-post-abort"}`,
  )
  return { sessionId: session.sessionId }
}

/** Deletes a Claude Code session the bridge made and won't resume. */
export function deleteClaudeSession(sessionId: string, cwd: string): void {
  deleteSession(sessionId, cwd, claudeDir())
}
