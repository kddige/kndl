// Claude Code's session as a mirror of a conversation. Each Claude turn resumes a Claude Code
// session (`resume`) holding the conversation up to the turn's prompt, which keeps Claude's prompt
// cache warm. After a stopped query, the session is cut back to where the query began and the
// conversation's messages since are written after it (Rewind.ts). When the conversation moved on
// without it (another Provider took a turn), or was rewritten (a compaction, a reset), the session
// is rewritten from the conversation (cc-session-io), in Claude Code's state directory, on the
// Session's volume.
//
// One mirror per conversation, keyed by the provider session id Pi Durable gives every request of
// it (`SimpleStreamOptions.sessionId`, its `pi.provider` document): it survives a reopen, a
// compaction and a model change, and a fork or a subagent gets its own. Pi Durable says nothing of
// a compaction or reset, so the mirror keeps a hash of the messages it holds, and a conversation
// whose messages no longer start with them was rewritten: it rebuilds.
//
// Ported from pi-claude-bridge 0.9.3 (MIT, Copyright (c) 2026 Eli Dickinson): see
// THIRD_PARTY_NOTICES.md.

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, statSync, truncateSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
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
import type { BridgeLog } from "./Log.ts"
import { checkpointAt, planRewind, readTail } from "./Rewind.ts"
import type { Checkpoint } from "./Rewind.ts"

/** A conversation's messages, as the bridge reads them: system messages aside. */
export type PiMessages = ReadonlyArray<Message>

export interface SessionState {
  readonly sessionId: string
  /** How many of the conversation's messages (system messages aside) the session holds. */
  readonly cursor: number
  /** {@link prefixHash} of those messages: a conversation not starting with them was rewritten. */
  readonly prefixHash?: string | undefined
  readonly cwd: string
  /**
   * The next sync rebuilds: an abort left the session file in an unknown state, a steer never
   * reached Claude Code, or the bridge restarted and knows only the session's id.
   */
  readonly needsRebuild?: boolean | undefined
  /**
   * Set only where a Claude Code was just killed (an abort, a discarded query): it may still flush
   * a late record into the session file, so the rebuild takes a new id rather than racing it.
   */
  readonly forceRotate?: boolean | undefined
  /**
   * A query stopped before it ended (an abort, or a steer that never reached it): the next sync
   * cuts the session back to where that query began, and writes the messages since after it.
   * Only once its Claude Code has exited (forceRotate cleared); else, or when the conversation
   * doesn't follow on from there, it rebuilds.
   */
  readonly rewindTo?: Checkpoint | undefined
}

export interface SyncResult {
  /** The session to resume, or null to start one. */
  readonly sessionId: string | null
  /**
   * Where the query's prompt starts in the conversation (system messages aside): the session
   * holds everything before it. The current user turn, or what of it the session doesn't hold.
   */
  readonly promptFrom: number
  /** Where the query begins in the session it resumes, to cut back to should it stop. */
  readonly checkpoint?: Checkpoint
}

/**
 * The index of the current user turn's first message: the trailing run of user messages not in
 * Claude Code's session yet. Everything before it is history, everything from it the prompt.
 */
export function turnStart(messages: ReadonlyArray<{ readonly role: string }>): number {
  let i = messages.length
  while (i > 0 && messages[i - 1]?.role === "user") i--
  return i
}

/**
 * A hash of the first `length` of `messages`, or undefined when there are fewer: what a mirror
 * holds, to tell a conversation that still starts with it from one rewritten under it. A message
 * is the same message when its role, time, tool call and content are.
 */
export function prefixHash(
  messages: ReadonlyArray<{ readonly role: string }>,
  length: number,
): string | undefined {
  if (length > messages.length) return undefined
  const hash = createHash("sha256")
  for (const message of messages.slice(0, length)) {
    const loose = message as {
      readonly role: string
      readonly timestamp?: unknown
      readonly toolCallId?: unknown
      readonly content?: unknown
    }
    hash.update(
      JSON.stringify([loose.role, loose.timestamp, loose.toolCallId ?? null, loose.content]),
    )
    hash.update("\n")
  }
  return hash.digest("base64url")
}

/** The messages without the conversation's prompt-state system messages. */
export function nonSystemMessages<T extends { readonly role: string }>(
  messages: ReadonlyArray<T>,
): Array<Exclude<T, { readonly role: "system" }>> {
  return messages.filter((message) => message.role !== "system") as Array<
    Exclude<T, { readonly role: "system" }>
  >
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

/** How many of `messages` lead with user messages: a turn's prompt. */
const promptLength = (messages: ReadonlyArray<{ readonly role: string }>) => {
  const end = messages.findIndex((message) => message.role !== "user")
  return end === -1 ? messages.length : end
}

/** What a restarted bridge reads back: each conversation's Claude Code session, by its id. */
interface SavedSessions {
  readonly version: 1
  readonly sessions: Readonly<Record<string, { readonly sessionId: string; readonly cwd: string }>>
}

/** The cursor and hash of a mirror holding all of `messages`. */
const holding = (messages: PiMessages) => ({
  cursor: messages.length,
  prefixHash: prefixHash(messages, messages.length),
})

/**
 * Every conversation's mirror, for one bridge. With `savePath`, each mirror's Claude Code session
 * id is kept there, so a bridge started after a restart rebuilds each conversation's session under
 * the id it had, rather than leaving the file behind and starting another.
 */
export class SessionMirrors {
  /** Mirrors by provider session id ("(none)" for a call that names none). */
  private readonly states = new Map<string, SessionState>()
  private saved = ""

  constructor(
    private readonly options: {
      /** Claude Code's state directory, where its sessions live. */
      readonly claudeDir: string | undefined
      readonly log: BridgeLog
      readonly savePath?: string | undefined
    },
  ) {
    this.load()
  }

  private get log() {
    return this.options.log
  }

  private get claudeDir() {
    return this.options.claudeDir
  }

  /** The mirror for `piSessionId`, or null when the conversation has none yet. */
  state(piSessionId: string | null | undefined): SessionState | null {
    return this.states.get(key(piSessionId)) ?? null
  }

  /** Replaces (or plants, or with null drops) the mirror for `piSessionId`. */
  setState(piSessionId: string | null | undefined, state: SessionState | null): void {
    if (state === null) this.states.delete(key(piSessionId))
    else this.states.set(key(piSessionId), state)
    this.save()
  }

  /** Forgets every mirror, leaving their files. */
  clear(): void {
    this.states.clear()
    this.save()
  }

  /** The session file Claude Code keeps `sessionId` in, for the Workspace `cwd`. */
  sessionPath(sessionId: string, cwd: string): string {
    return getSessionPath(sessionId, normalizeProjectPath(cwd), this.claudeDir)
  }

  /** Deletes a Claude Code session the bridge made and won't resume. */
  deleteClaudeSession(sessionId: string, cwd: string): void {
    try {
      deleteSession(sessionId, cwd, this.claudeDir)
    } catch (error) {
      this.log.debug(`WARNING: could not delete session ${sessionId.slice(0, 8)}:`, error)
    }
  }

  /**
   * Makes Claude Code's session for `piSessionId` hold the conversation up to the current user
   * turn, and says which to resume, and where in the conversation the query's prompt starts.
   *
   * - Reuse: in step with the mirror, or ahead of it only by the final assistant message appended
   *   after a turn (which Claude Code's session has already). Resumes it, keeping the cache warm.
   * - Truncate: a query stopped (rewindTo). Cuts the session back to where it began, and writes
   *   the messages since after it: Claude Code's own records before stay, and the cache with them.
   * - Rebuild: no mirror yet, or the conversation moved on without it, or doesn't start with what
   *   it holds any more (a compaction, a reset). Rewrites the session from the conversation whole,
   *   under the same id unless a killed Claude Code might still write to it.
   */
  sync(
    messages: ReadonlyArray<{ readonly role: string }>,
    cwd: string,
    customToolNameToSdk: Map<string, string>,
    modelId?: string,
    piSessionId?: string | null,
  ): SyncResult {
    // System messages are the conversation's prompt state, never imported, so never counted.
    const history = nonSystemMessages(messages) as unknown as PiMessages
    const promptStart = turnStart(history)
    const priorMessages = history.slice(0, promptStart)
    let sharedSession = this.state(piSessionId)

    if (
      sharedSession &&
      !sharedSession.needsRebuild &&
      sharedSession.prefixHash !== undefined &&
      prefixHash(history, sharedSession.cursor) !== sharedSession.prefixHash
    ) {
      this.log.debug(
        `sync: the conversation doesn't start with the ${sharedSession.cursor} messages session ${sharedSession.sessionId.slice(0, 8)} holds (rewritten): rebuilding`,
      )
      sharedSession = { ...sharedSession, needsRebuild: true, rewindTo: undefined }
    }
    const rewindTo = sharedSession?.rewindTo

    if (
      sharedSession &&
      !sharedSession.needsRebuild &&
      rewindTo === undefined &&
      sharedSession.cursor <= history.length
    ) {
      const missed = history.slice(sharedSession.cursor, promptStart)
      const trailingAssistantOnly = missed.length === 1 && missed[0]?.role === "assistant"
      if (missed.length === 0 || trailingAssistantOnly) {
        if (trailingAssistantOnly) {
          this.setState(piSessionId, { ...sharedSession, ...holding(priorMessages), cwd })
          this.log.debug(
            `Case 3: advanced cursor past trailing assistant, resuming session ${sharedSession.sessionId.slice(0, 8)}`,
          )
        } else {
          this.log.debug(`Case 3: resuming session ${sharedSession.sessionId.slice(0, 8)}`)
        }
        this.log.debug(`syncResult: path=reuse sessionId=${sharedSession.sessionId}`)
        // The session may hold the start of the prompt turn already: a stopped query's prompt.
        const promptFrom = Math.max(promptStart, sharedSession.cursor)
        const checkpoint = checkpointAt(
          sharedSession.sessionId,
          this.sessionPath(sharedSession.sessionId, cwd),
          history.slice(0, promptFrom),
        )
        return {
          sessionId: sharedSession.sessionId,
          promptFrom,
          ...(checkpoint === undefined ? {} : { checkpoint }),
        }
      }
    }
    if (sharedSession && rewindTo !== undefined && !sharedSession.needsRebuild) {
      // A Claude Code that may still be running could write past the cut.
      const rewound = sharedSession.forceRotate
        ? (this.log.debug(
            "rewind: the stopped Claude Code may still be running; rebuilding instead",
          ),
          undefined)
        : this.rewind(
            sharedSession,
            rewindTo,
            history,
            cwd,
            customToolNameToSdk,
            modelId,
            piSessionId,
          )
      if (rewound !== undefined) return rewound
    }

    if (priorMessages.length === 0) {
      this.log.debug(`Case 1: clean start, ${history.length} total messages`)
      // The mirror's session is never resumed again: the query starts one of its own.
      if (sharedSession) {
        this.deleteClaudeSession(sharedSession.sessionId, sharedSession.cwd)
        this.setState(piSessionId, null)
      }
      return { sessionId: null, promptFrom: promptStart }
    }
    const previousSessionId = sharedSession?.sessionId
    const dir = this.claudeDir
    const preserveId = previousSessionId !== undefined && !sharedSession?.forceRotate
    // Before deleteSession, which wipes the file they're in.
    const carried =
      previousSessionId !== undefined ? this.readCarriedAttachments(previousSessionId, cwd) : []
    if (preserveId) deleteSession(previousSessionId, cwd, dir)
    const session = createSession({
      projectPath: cwd,
      ...(dir === undefined ? {} : { claudeDir: dir }),
      ...(preserveId ? { sessionId: previousSessionId } : {}),
      ...(modelId ? { model: modelId } : {}),
    })
    this.importMessages(session, priorMessages, customToolNameToSdk, carried)
    session.save()
    // Records, not messages: the carried attachments are records too.
    for (const warning of verifyWrittenSession(
      session.jsonlPath,
      session.sessionId,
      session.records.length,
    ))
      this.log.diag("session_verify_fail", { warning, cwd, claudeDir: dir ?? null })
    this.setState(piSessionId, {
      sessionId: session.sessionId,
      ...holding(priorMessages),
      cwd,
    })
    // The session rotated from is never resumed again.
    if (sharedSession && !preserveId)
      this.deleteClaudeSession(sharedSession.sessionId, sharedSession.cwd)
    this.log.debug(
      `syncResult: path=rebuild sessionId=${session.sessionId} priors=${priorMessages.length} ${previousSessionId === undefined ? "first" : preserveId ? "preserved" : "rotated-post-abort"}`,
    )
    const checkpoint = checkpointAt(session.sessionId, session.jsonlPath, priorMessages)
    return {
      sessionId: session.sessionId,
      promptFrom: promptStart,
      ...(checkpoint === undefined ? {} : { checkpoint }),
    }
  }

  // --- What happens to a conversation's mirror, as the bridge tells it ---

  /**
   * A steer never reached Claude Code, though the cursor counts it already: the next sync
   * rebuilds, taking it from the conversation.
   */
  steerMissed(piSessionId: string | null | undefined): void {
    this.change(piSessionId, (state) => ({ ...state, needsRebuild: true }))
  }

  /**
   * A query stopped before its end (an abort), and its Claude Code may still write to the session
   * for a moment. The next sync cuts the session back to where the query began (`checkpoint`),
   * once that Claude Code has exited ({@link stoppedClaudeCodeExited}). With no checkpoint of this
   * session to cut back to, it rebuilds, under a new id while that Claude Code may still write.
   * A conversation's first query, which had no mirror, leaves one of the session it started, to be
   * rebuilt under its id rather than left behind. Says which, when there is a mirror.
   */
  queryStopped(
    piSessionId: string | null | undefined,
    checkpoint: Checkpoint | undefined,
    capturedSessionId?: string,
    cwd?: string,
  ): "cut back" | "rebuild" | undefined {
    if (this.state(piSessionId) === null && capturedSessionId !== undefined && cwd !== undefined) {
      this.setState(piSessionId, {
        sessionId: capturedSessionId,
        cursor: 0,
        cwd,
        needsRebuild: true,
        forceRotate: true,
      })
      return "rebuild"
    }
    let next: "cut back" | "rebuild" | undefined
    this.change(piSessionId, (state) => {
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
  stoppedClaudeCodeExited(piSessionId: string | null | undefined, exited: boolean): void {
    this.change(piSessionId, (state) =>
      exited
        ? { ...state, forceRotate: undefined }
        : { ...state, needsRebuild: true, forceRotate: true },
    )
  }

  /**
   * A query held at a tool call was discarded, as the conversation was rewritten under it: its
   * Claude Code was killed, and may still write, so the next sync rebuilds under a new id.
   */
  queryDiscarded(piSessionId: string | null | undefined): void {
    this.change(piSessionId, (state) => ({ ...state, needsRebuild: true, forceRotate: true }))
  }

  /**
   * A held turn's tool results went to its query: the session holds the conversation up to them,
   * `history` (system messages aside).
   */
  resultsDelivered(piSessionId: string | null | undefined, history: PiMessages): void {
    this.change(piSessionId, (state) => ({ ...state, ...holding(history) }))
  }

  /**
   * A query ran to its result in Claude Code's session `sessionId`, which holds the conversation
   * up to the end of `history`, the messages of the last call into it. One that didn't run as the
   * conversation holds it (`incomplete`: a steer that never reached Claude Code, or a request the
   * API failed, whose failure Claude Code writes into the session) left records the conversation
   * doesn't have: the next sync cuts the session back to where the query began (`checkpoint`), or,
   * without one of this session, rebuilds. Returns whether it is to be cut back, once the query's
   * Claude Code has exited.
   */
  queryCompleted(
    piSessionId: string | null | undefined,
    query: {
      readonly sessionId: string
      readonly history: PiMessages
      readonly cwd: string
      readonly incomplete: boolean
      readonly checkpoint: Checkpoint | undefined
    },
  ): boolean {
    const state = this.state(piSessionId)
    const rewindTo =
      query.incomplete && query.checkpoint?.sessionId === query.sessionId
        ? query.checkpoint
        : undefined
    const held =
      state !== null && state.sessionId === query.sessionId && state.cursor > query.history.length
        ? { cursor: state.cursor, prefixHash: state.prefixHash }
        : holding(query.history)
    this.setState(piSessionId, {
      ...state,
      sessionId: query.sessionId,
      ...held,
      cwd: query.cwd,
      needsRebuild: rewindTo ? undefined : query.incomplete || state?.needsRebuild,
      rewindTo,
    })
    return rewindTo !== undefined
  }

  /**
   * A query failed, and Claude Code's session is in a state the bridge can't know: the mirror goes,
   * and the session file with it. The next query rebuilds from the conversation.
   */
  queryFailed(piSessionId: string | null | undefined): void {
    const state = this.state(piSessionId)
    this.setState(piSessionId, null)
    if (state) this.deleteClaudeSession(state.sessionId, state.cwd)
  }

  /** The conversation is gone: its mirror goes, and its session file. */
  forget(piSessionId: string | null | undefined): void {
    this.queryFailed(piSessionId)
  }

  // --- Its insides ---

  /** Changes `piSessionId`'s mirror, if it has one; the mirror as it was. */
  private change(
    piSessionId: string | null | undefined,
    edit: (state: SessionState) => SessionState,
  ): SessionState | null {
    const state = this.state(piSessionId)
    if (state) this.setState(piSessionId, edit(state))
    return state
  }

  /** Claude Code's `@file` expansions in the session about to be replaced: before deleteSession. */
  private readCarriedAttachments(sessionId: string, cwd: string): Array<CarriedAttachment> {
    try {
      const dir = this.claudeDir
      const previous = openSession({
        sessionId,
        projectPath: cwd,
        ...(dir === undefined ? {} : { claudeDir: dir }),
      })
      return collectCarriedAttachments(previous.records)
    } catch (error) {
      // A killed Claude Code may have left a truncated last line; carrying none is what happened
      // before this existed.
      this.log.debug(
        `WARNING: could not read attachments from session ${sessionId.slice(0, 8)}:`,
        error,
      )
      return []
    }
  }

  /**
   * The conversation's messages into `session`, as Anthropic messages. Lossy: text, thinking
   * (Claude Code's own only) and tool calls survive.
   */
  private importMessages(
    session: Session,
    messages: PiMessages,
    customToolNameToSdk: Map<string, string>,
    carried: ReadonlyArray<CarriedAttachment>,
  ): void {
    const { anthropicMessages, sanitizedIds, dropped } = convertPiMessages(
      messages,
      customToolNameToSdk,
    )
    this.log.debug(
      `importMessages: ${messages.length} pi msgs → ${anthropicMessages.length} anthropic msgs`,
    )
    const droppedParts = [
      dropped.thinking
        ? `${dropped.thinking} thinking (${[...dropped.providers].toSorted().join(", ")})`
        : "",
      dropped.abortedTurns ? `${dropped.abortedTurns} aborted turn(s)` : "",
      ...[...dropped.other].map(([type, n]) => `${n} ${type}`),
    ].filter(Boolean)
    if (droppedParts.length > 0)
      this.log.debug(`importMessages: dropped ${droppedParts.join(", ")}`)
    if (sanitizedIds.size > 0) this.log.debug(`importMessages: sanitized ${sanitizedIds.size} ids`)
    // importMessages repairs too (idempotently); this is for placing the attachments, in the index
    // space importMessages reads.
    const repaired = repairToolPairing(anthropicMessages)
    const placed = carried.length ? placeCarriedAttachments(carried, repaired) : undefined
    if (placed?.skipped.length)
      this.log.debug(
        `importMessages: dropped ${placed.skipped.length} carried attachment(s): ${placed.skipped.join("; ")}`,
      )
    if (repaired.length) {
      session.importMessages(
        repaired,
        placed?.attachments.length ? { attachments: placed.attachments } : undefined,
      )
    }
  }

  /** Opens a session file to write after its records, writing assistant messages as `modelId`. */
  private reopenSession(jsonlPath: string, sessionId: string, cwd: string, modelId?: string) {
    const records: Array<JsonlRecord> = parseJsonlFile(jsonlPath)
    const first = records.find(
      (record) => record.type === "user" || record.type === "assistant",
    ) as Partial<BaseRecordFields> | undefined
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

  /**
   * Cuts the session back to where the stopped query began (Rewind.ts) and writes the messages
   * since after it, keeping the session's id and every record Claude Code wrote before. Undefined
   * when it can't: the conversation doesn't follow on from the checkpoint, or the file isn't the
   * one the checkpoint was taken of. The caller then rebuilds.
   *
   * The stopped query's prompt, and the attachments Claude Code put on it, stay when the
   * conversation holds it just as it was sent. Pi Durable leaves a stopped reply out of the
   * conversation, so a prompt stopped before its answer and the next one make one user turn: the
   * stopped one stays in the session, and the query is prompted with the rest (`promptFrom`).
   */
  private rewind(
    state: SessionState,
    checkpoint: Checkpoint,
    history: PiMessages,
    cwd: string,
    customToolNameToSdk: Map<string, string>,
    modelId: string | undefined,
    piSessionId: string | null | undefined,
  ): SyncResult | undefined {
    const refuse = (why: string): undefined => {
      this.log.debug(`rewind: ${why}; rebuilding instead`)
      return undefined
    }
    if (checkpoint.sessionId !== state.sessionId) return refuse("the session changed since")
    if (history.length < checkpoint.cursor) return refuse("the conversation is shorter")
    if (
      checkpoint.cursor > 0 &&
      history[checkpoint.cursor - 1]?.timestamp !== checkpoint.lastTimestamp
    )
      return refuse("the conversation changed before the checkpoint")
    const promptStart = Math.max(turnStart(history), checkpoint.cursor)
    const since = history.slice(checkpoint.cursor)
    if (since.length > 0 && since[0]?.role !== "user")
      return refuse("the messages since don't start at a prompt")

    const jsonlPath = this.sessionPath(state.sessionId, cwd)
    try {
      const tail = readTail(jsonlPath, checkpoint)
      if (tail === undefined) return refuse("the session file isn't the one checkpointed")
      // The stopped query's prompt: the user messages the messages since start with. All of them
      // but one, at most, when nothing but the user turn follows the checkpoint: one is the next
      // query's prompt.
      const leading = promptLength(since)
      const longest = leading < since.length ? leading : leading - 1
      let prompt = 0
      let plan = planRewind(tail, "")
      for (let length = longest; length > 0; length--) {
        const candidate = planRewind(tail, userTurnText(since.slice(0, length)))
        if (!candidate.keptPrompt) continue
        prompt = length
        plan = candidate
        break
      }
      truncateSync(jsonlPath, checkpoint.bytes + plan.keep)
      const session = this.reopenSession(jsonlPath, state.sessionId, cwd, modelId)
      // What the session is to hold, the prompt kept or not: the conversation up to the prompt.
      const promptFrom = Math.max(promptStart, checkpoint.cursor + prompt)
      const rest = history.slice(checkpoint.cursor + prompt, promptFrom)
      // The prompt's `@file` expansions, when it's written again from the conversation's.
      const carried = plan.keptPrompt ? [] : collectCarriedAttachments(plan.cut)
      this.importMessages(session, rest, customToolNameToSdk, carried)
      session.save()
      for (const warning of verifyWrittenSession(
        session.jsonlPath,
        session.sessionId,
        session.records.length,
      ))
        this.log.diag("session_verify_fail", { warning, cwd, claudeDir: this.claudeDir ?? null })
      const held = history.slice(0, promptFrom)
      this.setState(piSessionId, { sessionId: state.sessionId, ...holding(held), cwd })
      this.log.debug(
        `syncResult: path=truncate sessionId=${state.sessionId} kept=${checkpoint.bytes + plan.keep}B ` +
          `prompt=${plan.keptPrompt ? `kept(${prompt})` : "rewritten"} cut=${plan.cut.length} records, ` +
          `wrote ${rest.length} pi msgs`,
      )
      const next = checkpointAt(state.sessionId, jsonlPath, held)
      return {
        sessionId: state.sessionId,
        promptFrom,
        ...(next === undefined ? {} : { checkpoint: next }),
      }
    } catch (error) {
      return refuse(`it failed: ${String(error)}`)
    }
  }

  /**
   * Reads back the sessions a bridge before this one kept: each is rebuilt, under its id, at its
   * conversation's next turn, as what its file holds past its last turn isn't known.
   */
  private load(): void {
    const path = this.options.savePath
    if (path === undefined) return
    let saved: SavedSessions
    try {
      saved = JSON.parse(readFileSync(path, "utf8")) as SavedSessions
    } catch {
      return
    }
    if (saved.version !== 1) return
    for (const [piSessionId, { sessionId, cwd }] of Object.entries(saved.sessions ?? {})) {
      if (typeof sessionId !== "string" || typeof cwd !== "string") continue
      this.states.set(piSessionId, { sessionId, cursor: 0, cwd, needsRebuild: true })
    }
    this.saved = JSON.stringify(this.toSaved())
    this.log.debug(`load: ${this.states.size} conversations' sessions from ${path}`)
  }

  private toSaved(): SavedSessions {
    const sessions: Record<string, { sessionId: string; cwd: string }> = {}
    for (const [piSessionId, state] of this.states)
      sessions[piSessionId] = { sessionId: state.sessionId, cwd: state.cwd }
    return { version: 1, sessions }
  }

  /** Writes each conversation's session id, when one changed: whole, then moved into place. */
  private save(): void {
    const path = this.options.savePath
    if (path === undefined) return
    const text = JSON.stringify(this.toSaved())
    if (text === this.saved) return
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(`${path}.tmp`, text)
      renameSync(`${path}.tmp`, path)
      this.saved = text
    } catch (error) {
      this.log.debug(`WARNING: could not save the sessions to ${path}:`, error)
    }
  }
}

const key = (piSessionId: string | null | undefined) => piSessionId ?? "(none)"
