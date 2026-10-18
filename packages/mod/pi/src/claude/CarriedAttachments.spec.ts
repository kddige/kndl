// Carrying Claude Code's `@file` expansions across a session rebuild (CarriedAttachments.ts).
// Ported from pi-claude-bridge 0.9.3's unit-attachments.mjs (MIT, Copyright (c) 2026 Eli
// Dickinson).

import { describe, expect, test } from "bun:test"
import type { JsonlRecord } from "cc-session-io"
import { collectCarriedAttachments, placeCarriedAttachments } from "./CarriedAttachments.ts"
import type { CarriedAttachment } from "./CarriedAttachments.ts"

const user = (uuid: string, text: string) =>
  ({
    type: "user",
    uuid,
    message: { role: "user", content: [{ type: "text", text }] },
  }) as unknown as JsonlRecord
const toolResultUser = (uuid: string) =>
  ({
    type: "user",
    uuid,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
  }) as unknown as JsonlRecord
const attach = (uuid: string, parentUuid: string, type: string, filename?: string) =>
  ({
    type: "attachment",
    uuid,
    parentUuid,
    attachment: { type, filename },
  }) as unknown as JsonlRecord

const filenames = (carried: ReadonlyArray<CarriedAttachment>) =>
  carried.map((c) => c.attachment.filename)

describe("collectCarriedAttachments", () => {
  test("keeps content-bearing kinds and drops the ones Claude Code regenerates", () => {
    const carried = collectCarriedAttachments([
      user("u1", "review @a.js"),
      attach("a1", "u1", "file", "/a.js"),
      attach("a2", "u1", "skill_listing"),
      attach("a3", "u1", "task_reminder"),
      // Not carried: the edit is in pi's history already, as a tool call.
      attach("a4", "u1", "edited_text_file", "/b.js"),
    ])
    expect(filenames(carried)).toEqual(["/a.js"])
  })

  test("counts ordinals over prompts only, skipping tool-result user records", () => {
    const carried = collectCarriedAttachments([
      user("u1", "first"),
      toolResultUser("u2"),
      user("u3", "review @a.js"),
      attach("a1", "u3", "file", "/a.js"),
    ])
    expect(carried[0]?.userOrdinal).toBe(1)
    expect(carried[0]?.parentText).toBe("review @a.js")
  })

  test("ignores an attachment whose parent is not a prompt", () => {
    const carried = collectCarriedAttachments([
      user("u1", "first"),
      attach("a1", "missing-uuid", "file", "/a.js"),
    ])
    expect(carried).toHaveLength(0)
  })
})

describe("placeCarriedAttachments", () => {
  const carried: Array<CarriedAttachment> = [
    { attachment: { type: "file", filename: "/a.js" }, userOrdinal: 1, parentText: "review @a.js" },
  ]

  test("resolves the ordinal to an index in the array being imported", () => {
    const { attachments, skipped } = placeCarriedAttachments(carried, [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "text", text: "review @a.js" }] },
    ])
    expect(skipped).toHaveLength(0)
    expect(attachments).toEqual([
      { afterIndex: 2, attachment: { type: "file", filename: "/a.js" } },
    ])
  })

  test("drops it when that prompt changed rather than guessing", () => {
    const { attachments, skipped } = placeCarriedAttachments(carried, [
      { role: "user", content: "first" },
      { role: "user", content: "something else entirely" },
    ])
    expect(attachments).toHaveLength(0)
    expect(skipped[0]).toMatch(/changed/)
  })

  test("drops it when history no longer reaches that prompt", () => {
    const { attachments, skipped } = placeCarriedAttachments(carried, [
      { role: "user", content: "first" },
    ])
    expect(attachments).toHaveLength(0)
    expect(skipped[0]).toMatch(/no longer in history/)
  })
})

describe("attachments chained to other attachments", () => {
  test("inherits the ordinal up a run so the whole run keys to one prompt", () => {
    const carried = collectCarriedAttachments([
      user("u1", "first"),
      user("u2", "edit the files"),
      attach("a1", "u2", "file", "/a.js"),
      attach("a2", "a1", "edited_text_file", "/b.js"),
      attach("a3", "a2", "file", "/c.js"),
    ])
    // The kind not carried still has to resolve, or the run breaks after it.
    expect(filenames(carried)).toEqual(["/a.js", "/c.js"])
    expect(carried.map((c) => c.userOrdinal)).toEqual([1, 1])
  })

  test("resolves through a kind it does not carry", () => {
    const carried = collectCarriedAttachments([
      user("u1", "go"),
      attach("a1", "u1", "skill_listing"),
      attach("a2", "a1", "file", "/a.js"),
    ])
    expect(filenames(carried)).toEqual(["/a.js"])
    expect(carried[0]?.userOrdinal).toBe(0)
  })
})
