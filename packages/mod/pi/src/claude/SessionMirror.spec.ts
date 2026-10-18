// Claude Code's session as a mirror of pi's history (SessionMirror.ts): when a turn resumes it,
// when it's rebuilt, and checking a written session file. Ported from pi-claude-bridge 0.9.3's
// unit-sync-shared-session.mjs and unit-session-integrity.mjs (MIT, Copyright (c) 2026 Eli
// Dickinson).

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSession, deleteSession, openSession } from "cc-session-io"
import { configureLog } from "./Log.ts"
import {
  clearSessionStates,
  sessionStateFor,
  setClaudeDir,
  setSessionStateFor,
  syncSharedSession,
  verifyWrittenSession,
} from "./SessionMirror.ts"

const claudeDir = mkdtempSync(join(tmpdir(), "kndl-claude-mirror-"))
afterAll(() => rmSync(claudeDir, { recursive: true, force: true }))

const sync = (messages: ReadonlyArray<unknown>, cwd: string) =>
  syncSharedSession(messages as never, cwd, new Map())

describe("syncSharedSession", () => {
  let cwd: string
  beforeEach(() => {
    setClaudeDir(claudeDir)
    clearSessionStates()
    cwd = mkdtempSync(join(tmpdir(), "kndl-claude-mirror-cwd-"))
  })
  afterEach(() => {
    clearSessionStates()
    configureLog({ debug: false })
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
    expect(result.sessionId).toBeNull()
    expect(result.preserveSharedSession).toBeUndefined()
    expect(sessionStateFor(null)).toBeNull()
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
    setSessionStateFor(null, { sessionId, cursor: 2, cwd })

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
    expect(sessionStateFor(null)?.cursor).toBe(2)
    const session = openSession({ sessionId, projectPath: cwd, claudeDir })
    expect(session.messages.map((m) => m.type)).toEqual(["user", "assistant"])
    deleteSession(sessionId, cwd, claudeDir)
  })

  // A context shorter than the mirror's cursor (a pruned one, a subagent's) can't continue it: it
  // starts afresh, and the mirror is kept.
  test("starts a fresh session for a shorter context and preserves the existing one", () => {
    const mainSession = { sessionId: "11111111-1111-4111-8111-111111111111", cursor: 42, cwd }
    setSessionStateFor(null, mainSession)

    const result = sync(
      [{ role: "user", content: "Summarize this conversation.", timestamp: Date.now() }],
      cwd,
    )

    expect(result.sessionId).toBeNull()
    expect(result.preserveSharedSession).toBe(true)
    expect(sessionStateFor(null)).toEqual(mainSession)
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

    setSessionStateFor(null, { sessionId, cursor: 0, cwd })
    configureLog({ debug: false, report: (text) => reports.push(text) })
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
    setSessionStateFor(null, { sessionId, cursor: 0, cwd, needsRebuild: true })
    expect(sync(history, cwd).sessionId).toBe(sessionId)

    setSessionStateFor(null, { sessionId, cursor: 2, cwd, needsRebuild: true, forceRotate: true })
    const rotated = sync(history, cwd).sessionId
    expect(rotated).not.toBeNull()
    expect(rotated).not.toBe(sessionId)
    expect(sessionStateFor(null)).toMatchObject({ sessionId: rotated, cursor: 2 })
    expect(sessionStateFor(null)?.needsRebuild).toBeUndefined()
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
