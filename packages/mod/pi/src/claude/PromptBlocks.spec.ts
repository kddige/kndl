// The current user turn as Claude Code's prompt: its images kept, and never also replayed as the
// session's history.
//
// Ported from pi-claude-bridge 0.9.3's unit-prompt-blocks tests (MIT, Copyright (c) 2026 Eli
// Dickinson): see THIRD_PARTY_NOTICES.md.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Context } from "@earendil-works/pi-ai"
import { extractUserPromptBlocks } from "./Bridge.ts"
import { clearSessionStates, setClaudeDir, syncSharedSession } from "./SessionMirror.ts"

const messages = (list: ReadonlyArray<Record<string, unknown>>) =>
  list as unknown as Context["messages"]

describe("extractUserPromptBlocks", () => {
  test("keeps the images and text of the trailing run of user messages", () => {
    const blocks = extractUserPromptBlocks(
      messages([
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
          ],
        },
        { role: "user", content: "(attachment preview: [#image 1])" },
      ]),
    )

    expect(blocks).toEqual([
      { type: "text", text: "describe this" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
      { type: "text", text: "(attachment preview: [#image 1])" },
    ])
  })

  test("doesn't reach past the current user turn", () => {
    const blocks = extractUserPromptBlocks(
      messages([
        { role: "user", content: [{ type: "image", mimeType: "image/png", data: "b2xk" }] },
        { role: "assistant", content: [{ type: "text", text: "done" }] },
        { role: "user", content: "next turn" },
      ]),
    )

    expect(blocks).toBeNull()
  })

  test("skips a malformed image block rather than throwing", () => {
    const blocks = extractUserPromptBlocks(
      messages([
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", mimeType: "image/png" },
            { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
          ],
        },
      ]),
    )

    expect(blocks).toEqual([
      { type: "text", text: "look" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
    ])
  })

  // Off-type content breaks the contract: fail loudly, naming the shape (usually another
  // extension's message).
  test("throws a legible error on off-type content", () => {
    expect(() => extractUserPromptBlocks(messages([{ role: "user", content: undefined }]))).toThrow(
      /content must be a string or block array, got undefined/,
    )
  })
})

describe("the history/prompt split", () => {
  afterEach(() => {
    clearSessionStates()
    setClaudeDir(undefined)
  })

  // One boundary, both halves from it: no message is replayed as history and sent as the prompt.
  test("doesn't replay the current turn as the session's history", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kndl-turn-split-"))
    const claudeDir = mkdtempSync(join(tmpdir(), "kndl-turn-split-cfg-"))
    setClaudeDir(claudeDir)
    try {
      const history = messages([
        { role: "user", content: "earlier question", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "earlier answer" }], timestamp: 2 },
        // The current turn: an image-bearing message, and an extension's display-only one after it.
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
          ],
          timestamp: 3,
        },
        { role: "user", content: "(attachment preview: [#image 1])", timestamp: 4 },
      ])

      const { sessionId } = syncSharedSession(history, cwd, new Map())
      const projectsDir = join(claudeDir, "projects")
      const [projectDir] = readdirSync(projectsDir)
      if (projectDir === undefined) throw new Error("no session file written")
      const written = readFileSync(join(projectsDir, projectDir, `${sessionId}.jsonl`), "utf8")
      const prompt = JSON.stringify(extractUserPromptBlocks(history))

      expect(prompt).toMatch(/describe this/)
      expect(written).not.toMatch(/describe this/)
      expect(written).toMatch(/earlier question/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(claudeDir, { recursive: true, force: true })
    }
  })
})
