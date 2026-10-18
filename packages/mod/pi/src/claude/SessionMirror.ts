// Claude Code's session as a mirror of pi's history. Each Claude turn resumes a Claude Code
// session (`resume`) holding pi's conversation up to the turn's prompt, which keeps Claude's
// prompt cache warm. After a stopped query, the session is cut back to where the query began and
// pi's messages since are written after it (Rewind.ts). When pi's history moved on without it
// (another Provider took a turn, a compaction), the session is rewritten from pi's history
// (cc-session-io), in Claude Code's state directory, on the Session's volume.
//
// Ported from pi-claude-bridge 0.9.3 (MIT, Copyright (c) 2026 Eli Dickinson): see
// THIRD_PARTY_NOTICES.md.

import { readFileSync, statSync, truncateSync } from "node:fs"
import type { Message } from "@earendil-works/pi-ai"
import {
  createSession,
  deleteSession,
  getSessionPath,
  normalizeProjectPath,
  openSession,
  parseJsonlFile,
  repairToolPairing,
  Session,
} from "cc-session-io"
import type { BaseRecordFields, JsonlRecord } from "cc-session-io"
import { collectCarriedAttachments, placeCarriedAttachments } from "./CarriedAttachments.ts"
import type { CarriedAttachment } from "./CarriedAttachments.ts"
import { convertPiMessages, userTurnText } from "./Convert.ts"
import { debug, diag } from "./Log.ts"
import { checkpointAt, planRewind, readTail } from "./Rewind.ts"
import type { Checkpoint } from "./Rewind.ts"
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
  /**
   * A query stopped before it ended (an abort, or a steer that never reached it): the next sync
   * cuts the session back to where that query began, and writes pi's messages since after it.
   * Only once its Claude Code has exited (forceRotate cleared); else, or when pi's history
   * doesn't follow on from there, it rebuilds.
   */
  readonly rewindTo?: Checkpoint | undefined
}

export interface SyncResult {
  /** The session to resume, or null to start one. */
  readonly sessionId: string | null
  /** The query mustn't take over the session it's given: it's a shorter context's own. */
  readonly preserveSharedSession?: boolean
  /** Where the query begins in the session it resumes, to cut back to should it stop. */
  readonly checkpoint?: Checkpoint
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

/** The session file Claude Code keeps `sessionId` in, for the Workspace `cwd`. */
const sessionPath = (sessionId: string, cwd: string) =>
  getSessionPath(sessionId, normalizeProjectPath(cwd), claudeDir())

/** How many of `messages` lead with user messages: a turn's prompt. */
const promptLength = (messages: ReadonlyArray<{ readonly role: string }>) => {
  const end = messages.findIndex((message) => message.role !== "user")
  return end === -1 ? messages.length : end
}

/** Opens a session file to write after its records, writing pi's assistant messages as `modelId`. */
function reopenSession(jsonlPath: string, sessionId: string, cwd: string, modelId?: string) {
  const records: Array<JsonlRecord> = parseJsonlFile(jsonlPath)
  const first = records.find((record) => record.type === "user" || record.type === "assistant") as
    | Partial<BaseRecordFields>
    | undefined
  return new Session({
    sessionId,
    projectPath: normalizeProjectPath(cwd),
    jsonlPath,
    records,
    fileExists: true,
    ...(first?.slug === undefined ? {} : { slug: first.slug }),
    ...(first?.cwd === undefined ? {} : { cwd: first.cwd }),
    ...(first?.version === undefined ? {} : { version: first.version }),
    ...(first?.gitBranch === undefined ? {} : { gitBranch: first.gitBranch }),
    ...(modelId ? { model: modelId } : {}),
  })
}

/** Says why a stopped query's session can't be cut back, for the caller to rebuild instead. */
const refuse = (why: string): undefined => {
  debug(`rewind: ${why}; rebuilding instead`)
  return undefined
}

/**
 * Cuts the session back to where the stopped query began (Rewind.ts) and writes pi's messages
 * since after it, keeping the session's id and every record Claude Code wrote before. Undefined
 * when it can't: pi's history doesn't follow on from the checkpoint, or the file isn't the one the
 * checkpoint was taken of. The caller then rebuilds.
 */
function rewindSharedSession(
  state: SessionState,
  checkpoint: Checkpoint,
  priorMessages: PiMessages,
  cwd: string,
  customToolNameToSdk: Map<string, string>,
  modelId: string | undefined,
  piSessionId: string | null | undefined,
): SyncResult | undefined {
  if (checkpoint.sessionId !== state.sessionId) return refuse("the session changed since")
  if (priorMessages.length < checkpoint.cursor) return refuse("pi's history is shorter")
  if (
    checkpoint.cursor > 0 &&
    priorMessages[checkpoint.cursor - 1]?.timestamp !== checkpoint.lastTimestamp
  )
    return refuse("pi's history changed before the checkpoint")
  const since = priorMessages.slice(checkpoint.cursor)
  if (since.length > 0 && since[0]?.role !== "user")
    return refuse("pi's messages since don't start at a prompt")

  const jsonlPath = sessionPath(state.sessionId, cwd)
  try {
    const tail = readTail(jsonlPath, checkpoint)
    if (tail === undefined) return refuse("the session file isn't the one checkpointed")
    const prompt = promptLength(since)
    const plan = planRewind(tail, userTurnText(since.slice(0, prompt)))
    truncateSync(jsonlPath, checkpoint.bytes + plan.keep)
    const session = reopenSession(jsonlPath, state.sessionId, cwd, modelId)
    const rest = plan.keptPrompt ? since.slice(prompt) : since
    // The prompt's `@file` expansions, when it's written again from pi's.
    const carried = plan.keptPrompt ? [] : collectCarriedAttachments(plan.cut)
    convertAndImportMessages(session, rest, customToolNameToSdk, carried)
    session.save()
    for (const warning of verifyWrittenSession(
      session.jsonlPath,
      session.sessionId,
      session.records.length,
    ))
      diag("session_verify_fail", { warning, cwd, claudeDir: claudeDir() ?? null })
    setSessionStateFor(piSessionId, {
      sessionId: state.sessionId,
      cursor: priorMessages.length,
      cwd,
      piSessionId: piSessionId ?? undefined,
    })
    debug(
      `syncResult: path=truncate sessionId=${state.sessionId} kept=${checkpoint.bytes + plan.keep}B ` +
        `prompt=${plan.keptPrompt ? "kept" : "rewritten"} cut=${plan.cut.length} records, ` +
        `wrote ${rest.length} pi msgs`,
    )
    const next = checkpointAt(state.sessionId, jsonlPath, priorMessages)
    return { sessionId: state.sessionId, ...(next === undefined ? {} : { checkpoint: next }) }
  } catch (error) {
    return refuse(`it failed: ${String(error)}`)
  }
}

/**
 * Makes Claude Code's session for `piSessionId` hold pi's history up to the current user turn, and
 * says which to resume.
 *
 * - Reuse: in step with the mirror, or ahead of it only by the final assistant message pi appends
 *   after a turn (which Claude Code's session has already). Resumes it, keeping the cache warm.
 * - Truncate: a query stopped (rewindTo). Cuts the session back to where it began, and writes pi's
 *   messages since after it: Claude Code's own records before stay, and the cache with them.
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
  const rewindTo = sharedSession?.rewindTo

  if (
    sharedSession &&
    !sharedSession.needsRebuild &&
    rewindTo === undefined &&
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
      const checkpoint = checkpointAt(
        sharedSession.sessionId,
        sessionPath(sharedSession.sessionId, cwd),
        priorMessages,
      )
      return {
        sessionId: sharedSession.sessionId,
        ...(checkpoint === undefined ? {} : { checkpoint }),
      }
    }
  }
  if (
    sharedSession &&
    !sharedSession.needsRebuild &&
    priorMessages.length < (rewindTo?.cursor ?? sharedSession.cursor)
  ) {
    debug(
      `Case 1 synthetic: clean start for shorter context, preserving shared session ${sharedSession.sessionId.slice(0, 8)}`,
    )
    return { sessionId: null, preserveSharedSession: true }
  }
  if (sharedSession && rewindTo !== undefined && !sharedSession.needsRebuild) {
    // A Claude Code that may still be running could write past the cut.
    const rewound = sharedSession.forceRotate
      ? (debug("rewind: the stopped Claude Code may still be running; rebuilding instead"),
        undefined)
      : rewindSharedSession(
          sharedSession,
          rewindTo,
          priorMessages,
          cwd,
          customToolNameToSdk,
          modelId,
          piSessionId,
        )
    if (rewound !== undefined) return rewound
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
  // The session rotated from is never resumed again.
  if (sharedSession && !preserveId) deleteClaudeSession(sharedSession.sessionId, sharedSession.cwd)
  debug(
    `syncResult: path=rebuild sessionId=${session.sessionId} priors=${priorMessages.length} ${previousSessionId === undefined ? "first" : preserveId ? "preserved" : "rotated-post-abort"}`,
  )
  const checkpoint = checkpointAt(session.sessionId, session.jsonlPath, priorMessages)
  return { sessionId: session.sessionId, ...(checkpoint === undefined ? {} : { checkpoint }) }
}

/** Deletes a Claude Code session the bridge made and won't resume. */
export function deleteClaudeSession(sessionId: string, cwd: string): void {
  try {
    deleteSession(sessionId, cwd, claudeDir())
  } catch (error) {
    debug(`WARNING: could not delete session ${sessionId.slice(0, 8)}:`, error)
  }
}

// --- What happens to a pi session's mirror, as the bridge tells it ---

/** Changes `piSessionId`'s mirror, if it has one; the mirror as it was. */
function change(
  piSessionId: string | null | undefined,
  edit: (state: SessionState) => SessionState,
): SessionState | null {
  const state = sessionStateFor(piSessionId)
  if (state) setSessionStateFor(piSessionId, edit(state))
  return state
}

/**
 * pi replaced the session's history under the mirror (a compaction, tree navigation): the next
 * sync rebuilds it from pi's. The mirror as it was, if there is one.
 */
export function historyReplaced(piSessionId: string | null | undefined): SessionState | null {
  return change(piSessionId, (state) => ({ ...state, needsRebuild: true }))
}

/**
 * A steer never reached Claude Code, though the cursor counts it already: the next sync rebuilds,
 * taking it from pi's history.
 */
export function steerMissed(piSessionId: string | null | undefined): void {
  change(piSessionId, (state) => ({ ...state, needsRebuild: true }))
}

/**
 * A query stopped before its end (an abort), and its Claude Code may still write to the session
 * for a moment. The next sync cuts the session back to where the query began (`checkpoint`), once
 * that Claude Code has exited ({@link stoppedClaudeCodeExited}). With no checkpoint of this
 * session to cut back to, it rebuilds under a new id. Says which, when there is a mirror.
 */
export function queryStopped(
  piSessionId: string | null | undefined,
  checkpoint: Checkpoint | undefined,
  capturedSessionId?: string,
): "cut back" | "rebuild" | undefined {
  let next: "cut back" | "rebuild" | undefined
  change(piSessionId, (state) => {
    const rewindTo =
      checkpoint?.sessionId === state.sessionId &&
      (capturedSessionId === undefined || capturedSessionId === checkpoint.sessionId)
        ? checkpoint
        : undefined
    next = rewindTo ? "cut back" : "rebuild"
    return { ...state, forceRotate: true, ...(rewindTo ? { rewindTo } : { needsRebuild: true }) }
  })
  return next
}

/**
 * A stopped query's Claude Code has exited, so the session can be cut back now; or it hadn't in
 * time, and the session is rebuilt under a new id, which it can't write to.
 */
export function stoppedClaudeCodeExited(
  piSessionId: string | null | undefined,
  exited: boolean,
): void {
  change(piSessionId, (state) =>
    exited
      ? { ...state, forceRotate: undefined }
      : { ...state, needsRebuild: true, forceRotate: true },
  )
}

/**
 * A query held at a tool call was discarded, as pi replaced the history under it: its Claude Code
 * was killed, and may still write, so the next sync rebuilds under a new id.
 */
export function queryDiscarded(piSessionId: string | null | undefined): void {
  change(piSessionId, (state) => ({ ...state, needsRebuild: true, forceRotate: true }))
}

/** A held turn's tool results went to its query: the session holds pi's history to `cursor`. */
export function resultsDelivered(piSessionId: string | null | undefined, cursor: number): void {
  change(piSessionId, (state) => ({ ...state, cursor }))
}

/**
 * A query ran to its result in Claude Code's session `sessionId`, which holds pi's history up to
 * `cursor`. One that didn't run as pi holds it (`incomplete`: a steer that never reached Claude
 * Code, or a request the API failed, whose failure Claude Code writes into the session) left
 * records pi's history doesn't have: the next sync cuts the session back to where the query began
 * (`checkpoint`), or, without one of this session, rebuilds. Returns whether it is to be cut back,
 * once the query's Claude Code has exited.
 */
export function queryCompleted(
  piSessionId: string | null | undefined,
  query: {
    readonly sessionId: string
    readonly cursor: number
    readonly cwd: string
    readonly incomplete: boolean
    readonly checkpoint: Checkpoint | undefined
  },
): boolean {
  const state = sessionStateFor(piSessionId)
  const rewindTo =
    query.incomplete && query.checkpoint?.sessionId === query.sessionId
      ? query.checkpoint
      : undefined
  setSessionStateFor(piSessionId, {
    ...state,
    sessionId: query.sessionId,
    cursor: Math.max(query.cursor, state?.cursor ?? 0),
    cwd: query.cwd,
    piSessionId: piSessionId ?? undefined,
    needsRebuild: rewindTo ? undefined : query.incomplete || state?.needsRebuild,
    rewindTo,
  })
  return rewindTo !== undefined
}

/**
 * A query failed, and Claude Code's session is in a state the bridge can't know: the mirror goes,
 * and the session file with it. The next query rebuilds from pi's history.
 */
export function queryFailed(piSessionId: string | null | undefined): void {
  const state = sessionStateFor(piSessionId)
  setSessionStateFor(piSessionId, null)
  if (state) deleteClaudeSession(state.sessionId, state.cwd)
}

/**
 * The pi session ended (its own shutdown, or a new conversation in its place): its mirror goes.
 * Other sessions' mirrors, such as subagents', stay for their next turns.
 */
export function forgetSession(piSessionId: string | null | undefined): void {
  setSessionStateFor(piSessionId, null)
}
