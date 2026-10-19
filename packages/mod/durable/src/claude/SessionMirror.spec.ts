// Claude Code's session as a mirror of a conversation (SessionMirror.ts): when a turn resumes it,
// when it's rebuilt, and checking a written session file. Ported from pi-claude-bridge 0.9.3's
// unit-sync-shared-session.mjs and unit-session-integrity.mjs (MIT, Copyright (c) 2026 Eli
// Dickinson).

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createSession,
  deleteSession,
  getSessionPath,
  normalizeProjectPath,
  openSession,
} from "cc-session-io"
import { createLog, silentLog } from "./Log.ts"
import type { Checkpoint } from "./Rewind.ts"
import { prefixHash, SessionMirrors, verifyWrittenSession } from "./SessionMirror.ts"

const claudeDir = mkdtempSync(join(tmpdir(), "kndl-claude-mirror-"))
afterAll(() => rmSync(claudeDir, { recursive: true, force: true }))

let mirrors = new SessionMirrors({ claudeDir, log: silentLog })

const sync = (messages: ReadonlyArray<unknown>, cwd: string) =>
  mirrors.sync(messages as never, cwd, new Map())

describe("syncSharedSession", () => {
  let cwd: string
  beforeEach(() => {
    mirrors = new SessionMirrors({ claudeDir, log: silentLog })
    cwd = mkdtempSync(join(tmpdir(), "kndl-claude-mirror-cwd-"))
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  // The system prompt comes as a leading system message: prompt state, not history. A fresh
  // session still starts clean, rather than rebuilding a session file of nothing but a system
  // head, which makes resume fail with "No conversation found".
  test("takes the clean-start path when a transcript system message precedes the first user message", () => {
    const result = sync(
      [
        { role: "system", content: "You are Claude Code.", timestamp: Date.now() },
        { role: "user", content: "Hello", timestamp: Date.now() },
      ],
      cwd,
    )
    expect(result).toEqual({ sessionId: null, promptFrom: 0 })
    expect(mirrors.state(null)).toBeNull()
  })

  // Tool changes mid-conversation come as system messages: they mustn't count toward the cursor,
  // or every turn would rebuild.
  test("keeps cursor arithmetic consistent when system messages punctuate the history", () => {
    const sessionId = randomUUID()
    const seeded = createSession({ sessionId, projectPath: cwd, claudeDir })
    seeded.importMessages([
      { role: "user", content: "Hi" },
      { role: "assistant", content: [{ type: "text", text: "Hello." }] },
    ])
    seeded.save()
    mirrors.setState(null, { sessionId, cursor: 2, cwd })

    const result = sync(
      [
        { role: "user", content: "Hi", timestamp: Date.now() },
        { role: "assistant", content: [{ type: "text", text: "Hello." }], timestamp: Date.now() },
        {
          role: "system",
          content: "",
          toolsAdded: [{ name: "grep", description: "", parameters: {} }],
          timestamp: Date.now(),
        },
        { role: "user", content: "Next", timestamp: Date.now() },
      ],
      cwd,
    )

    expect(result.sessionId).toBe(sessionId)
    expect(mirrors.state(null)?.cursor).toBe(2)
    const session = openSession({ sessionId, projectPath: cwd, claudeDir })
    expect(session.messages.map((m) => m.type)).toEqual(["user", "assistant"])
    deleteSession(sessionId, cwd, claudeDir)
  })

  // A conversation shorter than its mirror was rewritten (a reset to nothing): it starts afresh,
  // and the mirror's session, never to be resumed again, goes.
  test("starts a fresh session for a conversation shorter than its mirror, dropping the mirror", () => {
    const sessionId = randomUUID()
    const seeded = createSession({ sessionId, projectPath: cwd, claudeDir })
    seeded.importMessages([{ role: "user", content: "Hi" }])
    seeded.save()
    mirrors.setState(null, { sessionId, cursor: 42, cwd })

    const result = sync([{ role: "user", content: "Start over.", timestamp: Date.now() }], cwd)

    expect(result.sessionId).toBeNull()
    expect(mirrors.state(null)).toBeNull()
    expect(existsSync(seeded.jsonlPath)).toBe(false)
  })

  // A carried `@file` expansion is an attachment record, which `session.messages` leaves out:
  // counting messages reported every such rebuild as a corrupt session.
  test("does not report a count mismatch when a rebuild carries an attachment", () => {
    const sessionId = randomUUID()
    const prompt = "Review @fixture.txt and remember it."
    const reports: Array<string> = []
    const seeded = createSession({ sessionId, projectPath: cwd, claudeDir })
    seeded.importMessages(
      [
        { role: "user", content: prompt },
        { role: "assistant", content: [{ type: "text", text: "Noted." }] },
      ],
      {
        attachments: [
          {
            afterIndex: 0,
            attachment: {
              type: "file",
              filename: join(cwd, "fixture.txt"),
              content: {
                type: "text",
                file: { filePath: join(cwd, "fixture.txt"), content: "token" },
              },
            },
          },
        ],
      },
    )
    seeded.save()

    mirrors = new SessionMirrors({
      claudeDir,
      log: createLog({
        debug: false,
        path: join(cwd, "log"),
        report: (text) => reports.push(text),
      }),
    })
    mirrors.setState(null, { sessionId, cursor: 0, cwd })
    sync(
      [
        { role: "user", content: prompt, timestamp: Date.now() },
        { role: "assistant", content: [{ type: "text", text: "Noted." }], timestamp: Date.now() },
        { role: "user", content: "Now what did it say?", timestamp: Date.now() },
      ],
      cwd,
    )

    // Without the attachment carried, this would prove nothing about the count.
    expect(openSession({ sessionId, projectPath: cwd, claudeDir }).attachments).toHaveLength(1)
    expect(reports).toEqual([])
    deleteSession(sessionId, cwd, claudeDir)
  })

  test("rebuilds under a new id after an abort, and under the same id otherwise", () => {
    const history = [
      { role: "user", content: "Hi", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "Hello." }], timestamp: 2 },
      { role: "user", content: "Next", timestamp: 3 },
    ]
    const sessionId = randomUUID()
    mirrors.setState(null, { sessionId, cursor: 0, cwd, needsRebuild: true })
    expect(sync(history, cwd).sessionId).toBe(sessionId)

    mirrors.setState(null, { sessionId, cursor: 2, cwd, needsRebuild: true, forceRotate: true })
    const rotated = sync(history, cwd).sessionId
    expect(rotated).not.toBeNull()
    expect(rotated).not.toBe(sessionId)
    expect(mirrors.state(null)).toMatchObject({ sessionId: rotated, cursor: 2 })
    expect(mirrors.state(null)?.needsRebuild).toBeUndefined()
    // The session it rotated from is never resumed again: its file goes.
    expect(existsSync(getSessionPath(sessionId, normalizeProjectPath(cwd), claudeDir))).toBe(false)
  })

  test("a failed query's mirror goes, with its session file; another session's stays", () => {
    const sessionId = randomUUID()
    const seeded = createSession({ sessionId, projectPath: cwd, claudeDir })
    seeded.importMessages([{ role: "user", content: "Hi" }])
    seeded.save()
    mirrors.setState("failed", { sessionId, cursor: 1, cwd })
    mirrors.setState("other", { sessionId: randomUUID(), cursor: 1, cwd })
    mirrors.queryFailed("failed")
    expect(mirrors.state("failed")).toBeNull()
    expect(existsSync(seeded.jsonlPath)).toBe(false)
    expect(mirrors.state("other")).not.toBeNull()
  })
})

// After a stopped query, the session is cut back to where the query began, rather than rebuilt
// from the conversation, which holds none of Claude Code's own records (attachments, fillers): their
// loss costs the prompt cache from the first of them on.
describe("syncSharedSession after a stopped query", () => {
  let cwd: string
  let sessionId: string
  let path: string
  beforeEach(() => {
    mirrors = new SessionMirrors({ claudeDir, log: silentLog })
    cwd = mkdtempSync(join(tmpdir(), "kndl-claude-rewind-cwd-"))
    sessionId = randomUUID()
    path = getSessionPath(sessionId, normalizeProjectPath(cwd), claudeDir)
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
    deleteSession(sessionId, cwd, claudeDir)
  })

  const u1 = { role: "user", content: "one", timestamp: 1 }
  const a1 = { role: "assistant", content: [{ type: "text", text: "Hello." }], timestamp: 2 }
  const u2 = { role: "user", content: "tell me a story", timestamp: 3 }
  const aborted = {
    role: "assistant",
    content: [{ type: "text", text: "Once upon" }],
    stopReason: "aborted",
    timestamp: 4,
  }
  const u3 = { role: "user", content: "three", timestamp: 5 }

  /** A session as Claude Code leaves the first turn: with an attachment pi never sees. */
  function firstTurn(): Checkpoint {
    const session = createSession({ sessionId, projectPath: cwd, claudeDir })
    session.importMessages(
      [
        { role: "user", content: "one" },
        { role: "assistant", content: [{ type: "text", text: "Hello." }] },
      ],
      { attachments: [{ afterIndex: 0, attachment: { type: "environment", cwd } }] },
    )
    session.save()
    return {
      sessionId,
      cursor: 2,
      bytes: Buffer.byteLength(readFileSync(path, "utf8")),
      lastTimestamp: a1.timestamp,
    }
  }

  /** Records as Claude Code writes them, chained on from the session's last. */
  function claudeCodeWrites(records: ReadonlyArray<Record<string, unknown>>): void {
    let parent = openSession({ sessionId, projectPath: cwd, claudeDir }).records.at(-1)?.uuid
    for (const record of records) {
      if (record.type === "queue-operation") {
        appendFileSync(path, `${JSON.stringify({ ...record, sessionId })}\n`)
        continue
      }
      const uuid = randomUUID()
      appendFileSync(
        path,
        `${JSON.stringify({ ...record, uuid, parentUuid: parent, sessionId })}\n`,
      )
      parent = uuid
    }
  }

  const stoppedTurn = [
    { type: "queue-operation", operation: "enqueue" },
    { type: "user", message: { role: "user", content: "tell me a story" } },
    { type: "attachment", attachment: { type: "total_tokens_reminder" } },
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Once" }] },
    },
    {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
    },
  ]

  /** What the session holds, one line a record: its type, and its text or attachment. */
  const records = () =>
    openSession({ sessionId, projectPath: cwd, claudeDir }).records.map((record) => {
      const r = record as Record<string, unknown>
      if (r.type === "attachment") return `attachment:${(r.attachment as { type: string }).type}`
      const message = r.message as { content: unknown } | undefined
      if (message === undefined) return String(r.type)
      const content =
        typeof message.content === "string"
          ? message.content
          : (message.content as Array<{ text?: string; type: string }>)
              .map((b) => b.text ?? b.type)
              .join("")
      return `${String(r.type)}:${content}`
    })

  test("keeps the session and everything before the stopped reply, and writes the conversation's after", () => {
    const checkpoint = firstTurn()
    const before = readFileSync(path)
    claudeCodeWrites(stoppedTurn)
    mirrors.setState(null, { sessionId, cursor: 3, cwd, rewindTo: checkpoint })

    const result = sync([u1, a1, u2, aborted, u3], cwd)

    expect(result.sessionId).toBe(sessionId)
    expect(readFileSync(path).subarray(0, before.length).equals(before)).toBe(true)
    expect(records()).toEqual([
      "user:one",
      "attachment:environment",
      "assistant:Hello.",
      "queue-operation",
      "user:tell me a story",
      "attachment:total_tokens_reminder",
      "assistant:Once upon",
    ])
    expect(mirrors.state(null)).toMatchObject({ sessionId, cursor: 4 })
    expect(mirrors.state(null)?.rewindTo).toBeUndefined()
    // The next stop cuts back to here.
    expect(result.checkpoint).toMatchObject({ sessionId, cursor: 4, bytes: statSync(path).size })
  })

  test("writes the prompt from the conversation's when Claude Code hadn't, or it's cut off", () => {
    const checkpoint = firstTurn()
    appendFileSync(path, '{"type":"user","message":{"role":"us')
    mirrors.setState(null, { sessionId, cursor: 3, cwd, rewindTo: checkpoint })

    expect(sync([u1, a1, u2, aborted, u3], cwd).sessionId).toBe(sessionId)
    expect(records()).toEqual([
      "user:one",
      "attachment:environment",
      "assistant:Hello.",
      "user:tell me a story",
      "assistant:Once upon",
    ])
  })

  test("writes nothing for a reply stopped before any output", () => {
    const checkpoint = firstTurn()
    claudeCodeWrites(stoppedTurn.slice(0, 3))
    mirrors.setState(null, { sessionId, cursor: 3, cwd, rewindTo: checkpoint })
    const empty = { ...aborted, content: [] }

    expect(sync([u1, a1, u2, empty, u3], cwd).sessionId).toBe(sessionId)
    expect(records()).toEqual([
      "user:one",
      "attachment:environment",
      "assistant:Hello.",
      "queue-operation",
      "user:tell me a story",
      "attachment:total_tokens_reminder",
    ])
  })

  test("rebuilds when the conversation changed before where the query began", () => {
    const checkpoint = firstTurn()
    claudeCodeWrites(stoppedTurn)
    mirrors.setState(null, { sessionId, cursor: 3, cwd, rewindTo: checkpoint })
    const rewritten = { ...a1, content: [{ type: "text", text: "Hi." }], timestamp: 9 }

    expect(sync([u1, rewritten, u2, aborted, u3], cwd).sessionId).toBe(sessionId)
    expect(records()).toEqual([
      "user:one",
      "assistant:Hi.",
      "user:tell me a story",
      "assistant:Once upon",
    ])
  })

  test("rebuilds under a new id while the stopped Claude Code may still be running", () => {
    const checkpoint = firstTurn()
    claudeCodeWrites(stoppedTurn)
    mirrors.setState(null, { sessionId, cursor: 3, cwd, rewindTo: checkpoint, forceRotate: true })

    const rotated = sync([u1, a1, u2, aborted, u3], cwd).sessionId
    expect(rotated).not.toBe(sessionId)
    if (rotated !== null) deleteSession(rotated, cwd, claudeDir)
  })

  test("rebuilds when a compaction rewrote the history since", () => {
    const checkpoint = firstTurn()
    claudeCodeWrites(stoppedTurn)
    mirrors.setState(null, {
      sessionId,
      cursor: 3,
      cwd,
      rewindTo: checkpoint,
      needsRebuild: true,
    })
    const summary = { role: "user", content: "Summary: we said hello.", timestamp: 10 }

    expect(sync([summary, u2, aborted, u3], cwd).sessionId).toBe(sessionId)
    expect(records()).toEqual([
      "user:Summary: we said hello.",
      "user:tell me a story",
      "assistant:Once upon",
    ])
  })

  test("rebuilds when the session file isn't the one the checkpoint was taken of", () => {
    const checkpoint = firstTurn()
    mirrors.setState(null, {
      sessionId,
      cursor: 3,
      cwd,
      rewindTo: { ...checkpoint, bytes: checkpoint.bytes - 3 },
    })

    expect(sync([u1, a1, u2, aborted, u3], cwd).sessionId).toBe(sessionId)
    expect(records()).toEqual([
      "user:one",
      "assistant:Hello.",
      "user:tell me a story",
      "assistant:Once upon",
    ])
  })
})

// Pi Durable says nothing of a compaction or a reset: the mirror keeps a hash of the messages it
// holds, and a conversation that doesn't start with them any more was rewritten.
describe("a conversation rewritten under its mirror", () => {
  let cwd: string
  beforeEach(() => {
    mirrors = new SessionMirrors({ claudeDir, log: silentLog })
    cwd = mkdtempSync(join(tmpdir(), "kndl-claude-prefix-cwd-"))
  })
  afterEach(() => rmSync(cwd, { recursive: true, force: true }))

  const u1 = { role: "user", content: "one", timestamp: 1 }
  const a1 = { role: "assistant", content: [{ type: "text", text: "Hello." }], timestamp: 2 }
  const u2 = { role: "user", content: "two", timestamp: 3 }
  const a2 = { role: "assistant", content: [{ type: "text", text: "Again." }], timestamp: 4 }
  const u3 = { role: "user", content: "three", timestamp: 5 }

  /** A mirror holding `held`, in a session file that holds them too. */
  function mirrorOf(held: ReadonlyArray<Record<string, unknown>>): string {
    const sessionId = randomUUID()
    mirrors.setState(null, { sessionId, cursor: 0, cwd, needsRebuild: true })
    sync([...held, { role: "user", content: "next", timestamp: 99 }], cwd)
    return sessionId
  }

  test("resumes it as it is while the conversation starts with what it holds", () => {
    const sessionId = mirrorOf([u1, a1])
    expect(mirrors.state(null)).toMatchObject({
      sessionId,
      cursor: 2,
      prefixHash: prefixHash([u1, a1], 2),
    })

    expect(sync([u1, a1, u2], cwd).sessionId).toBe(sessionId)
    expect(mirrors.state(null)).toMatchObject({ sessionId, cursor: 2 })
    mirrors.queryCompleted(null, {
      sessionId,
      history: [u1, a1, u2] as never,
      cwd,
      incomplete: false,
      checkpoint: undefined,
    })
    // Ahead by the answer only, which Claude Code's session has already: resumed, the answer
    // counted.
    expect(sync([u1, a1, u2, a2, u3], cwd).sessionId).toBe(sessionId)
    expect(mirrors.state(null)).toMatchObject({
      sessionId,
      cursor: 4,
      prefixHash: prefixHash([u1, a1, u2, a2], 4),
    })
  })

  test("rebuilds, under its id, once the conversation is compacted", () => {
    const sessionId = mirrorOf([u1, a1, u2, a2])
    const summary = { role: "user", content: "Summary: we said hello twice.", timestamp: 10 }

    expect(sync([summary, a2, u3], cwd).sessionId).toBe(sessionId)
    expect(openSession({ sessionId, projectPath: cwd, claudeDir }).messages).toHaveLength(2)
    expect(mirrors.state(null)).toMatchObject({
      cursor: 2,
      prefixHash: prefixHash([summary, a2], 2),
    })
  })

  test("rebuilds when a message it holds changed in place", () => {
    const sessionId = mirrorOf([u1, a1])
    const edited = { ...a1, content: [{ type: "text", text: "Hi." }] }

    expect(sync([u1, edited, u2], cwd).sessionId).toBe(sessionId)
    const session = openSession({ sessionId, projectPath: cwd, claudeDir })
    expect(JSON.stringify(session.messages.at(-1))).toContain("Hi.")
  })

  test("a held turn's results and a completed query hold what the last call brought", () => {
    const sessionId = mirrorOf([u1, a1])
    const call = {
      role: "assistant",
      content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }],
      timestamp: 6,
    }
    const result = { role: "toolResult", toolCallId: "t1", content: "ok", timestamp: 7 }
    const history = [u1, a1, u2, call, result] as never

    mirrors.resultsDelivered(null, history)
    expect(mirrors.state(null)).toMatchObject({ cursor: 5, prefixHash: prefixHash(history, 5) })

    mirrors.queryCompleted(null, {
      sessionId,
      history,
      cwd,
      incomplete: false,
      checkpoint: undefined,
    })
    expect(mirrors.state(null)).toMatchObject({ cursor: 5, prefixHash: prefixHash(history, 5) })
  })
})

describe("a conversation's first query, stopped", () => {
  test("leaves a mirror of the session it started, to rebuild under its id", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kndl-claude-first-cwd-"))
    mirrors = new SessionMirrors({ claudeDir, log: silentLog })
    const sessionId = randomUUID()
    expect(mirrors.queryStopped("conversation", undefined, sessionId, cwd)).toBe("rebuild")
    expect(mirrors.state("conversation")).toMatchObject({
      sessionId,
      needsRebuild: true,
      forceRotate: true,
    })
    mirrors.stoppedClaudeCodeExited("conversation", true)

    const history = [
      { role: "user", content: "one", timestamp: 1 },
      { role: "user", content: "two", timestamp: 3 },
      { role: "assistant", content: [{ type: "text", text: "Both." }], timestamp: 4 },
      { role: "user", content: "three", timestamp: 5 },
    ]
    expect(
      mirrors.sync(history as never, cwd, new Map(), undefined, "conversation").sessionId,
    ).toBe(sessionId)
    rmSync(cwd, { recursive: true, force: true })
  })
})

// A restarted bridge knows each conversation's Claude Code session only by its id: it rebuilds it
// under that id, rather than leaving its file behind.
describe("the mirrors a bridge before this one kept", () => {
  test("are rebuilt under their ids", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kndl-claude-saved-cwd-"))
    const savePath = join(cwd, "saved", "sessions.json")
    const before = new SessionMirrors({ claudeDir, log: silentLog, savePath })
    const sessionId = randomUUID()
    before.setState("conversation", { sessionId, cursor: 3, cwd, prefixHash: "x" })
    expect(JSON.parse(readFileSync(savePath, "utf8"))).toEqual({
      version: 1,
      sessions: { conversation: { sessionId, cwd } },
    })

    const after = new SessionMirrors({ claudeDir, log: silentLog, savePath })
    expect(after.state("conversation")).toEqual({ sessionId, cursor: 0, cwd, needsRebuild: true })
    const history = [
      { role: "user", content: "one", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "Hello." }], timestamp: 2 },
      { role: "user", content: "two", timestamp: 3 },
    ]
    expect(after.sync(history as never, cwd, new Map(), undefined, "conversation").sessionId).toBe(
      sessionId,
    )

    after.forget("conversation")
    expect(JSON.parse(readFileSync(savePath, "utf8")).sessions).toEqual({})
    rmSync(cwd, { recursive: true, force: true })
  })
})

const rec = (sessionId: string, i: number) => JSON.stringify({ sessionId, idx: i })

describe("verifyWrittenSession", () => {
  const dir = mkdtempSync(join(tmpdir(), "kndl-verify-session-"))
  const path = join(dir, "session.jsonl")
  const sid = "abc-123"
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test("no warnings when the file round-trips", () => {
    writeFileSync(path, `${[rec(sid, 0), rec(sid, 1), rec(sid, 2)].join("\n")}\n`)
    expect(verifyWrittenSession(path, sid, 3)).toEqual([])
  })

  test("warns when the file is missing", () => {
    const warnings = verifyWrittenSession(join(dir, "nope.jsonl"), sid, 0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/file missing/)
  })

  test("warns on a record count mismatch", () => {
    writeFileSync(path, `${[rec(sid, 0), rec(sid, 1)].join("\n")}\n`)
    const warnings = verifyWrittenSession(path, sid, 5)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/record count mismatch.*expected=5.*actual=2/)
  })

  test("warns on sessionId drift", () => {
    writeFileSync(path, `${[rec(sid, 0), rec("different-sid", 1)].join("\n")}\n`)
    const warnings = verifyWrittenSession(path, sid, 2)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/sessionId drift/)
  })

  test("warns on malformed JSONL", () => {
    writeFileSync(path, "not json\n")
    const warnings = verifyWrittenSession(path, sid, 1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/malformed JSONL/)
  })
})
