// The Child Session tools: a call's input as the Hub's request, and the Hub's reply as the model
// reads it.

import { describe, expect, test } from "bun:test"
import { SessionId } from "@claude-hub/protocol"
import type { ChildSummary } from "@claude-hub/protocol"
import {
  childReplyText,
  childToolRequest,
  childTools,
  MaxListedReport,
  parentTools,
} from "./ChildTools.ts"

const child: ChildSummary = {
  id: SessionId.make("s-2"),
  title: "API docs",
  baseBranch: "main",
  workBranch: "claude/s-2",
  state: "Active",
  working: false,
  queued: 0,
}

describe("a call to a Child Session tool", () => {
  test("is each tool's request", () => {
    expect(
      childToolRequest("mcp__hub-link__create_child", {
        task: "Document the API.",
        name: "API docs",
        base: " release ",
      }),
    ).toEqual({
      _tag: "CreateChild",
      prompt: "Document the API.",
      name: "API docs",
      baseBranch: "release",
    })
    expect(
      childToolRequest("mcp__hub-link__message_child", { child_id: "s-2", message: "Go on." }),
    ).toEqual({ _tag: "MessageChild", childId: child.id, text: "Go on." })
    expect(childToolRequest("mcp__hub-link__list_children", {})).toEqual({ _tag: "ListChildren" })
    expect(childToolRequest("mcp__hub-link__read_child", { child_id: "s-2" })).toEqual({
      _tag: "ReadChild",
      childId: child.id,
    })
    expect(childToolRequest("mcp__hub-link__archive_child", { child_id: "s-2" })).toEqual({
      _tag: "ArchiveChild",
      childId: child.id,
    })
    expect(childToolRequest("mcp__hub-link__message_parent", { message: "A question." })).toEqual({
      _tag: "MessageParent",
      text: "A question.",
    })
  })

  test("is no request for any other tool", () => {
    expect(childToolRequest("Bash", { command: "ls" })).toBeUndefined()
    expect(childToolRequest("mcp__github__create_issue", {})).toBeUndefined()
  })

  test("says what is wrong with input it can't take", () => {
    expect(childToolRequest("mcp__hub-link__create_child", { task: "" })).toEqual({
      invalid: expect.stringContaining("create_child was called with input it can't take"),
    })
    expect(childToolRequest("mcp__hub-link__message_child", { child_id: "s-2" })).toEqual({
      invalid: expect.any(String),
    })
    expect(childToolRequest("mcp__hub-link__message_parent", { message: "" })).toEqual({
      invalid: expect.stringContaining("message_parent was called with input it can't take"),
    })
    expect(childToolRequest("mcp__hub-link__spawn", {})).toEqual({
      invalid: "mcp__hub-link__spawn is not a Child Session tool.",
    })
  })

  test("names every tool the mod registers", () => {
    for (const tool of [...childTools, ...parentTools])
      expect(childToolRequest(`mcp__hub-link__${tool.name}`, {})).not.toEqual({
        invalid: `mcp__hub-link__${tool.name} is not a Child Session tool.`,
      })
  })
})

describe("the Hub's reply", () => {
  test("names the new child by name and id", () => {
    expect(childReplyText({ _tag: "ChildCreated", child })).toEqual({
      text: expect.stringContaining('Created Child Session "API docs" (id s-2): Active, idle;'),
    })
  })

  test("lists each child with its last Report, cut when long", () => {
    const long = "y".repeat(MaxListedReport + 10)
    const reply = childReplyText({
      _tag: "ChildList",
      children: [
        { ...child, working: true, queued: 2, lastReport: { text: "All done.", at: 0 } },
        { ...child, id: SessionId.make("s-3"), title: "Tests", lastReport: { text: long, at: 0 } },
        { ...child, id: SessionId.make("s-4"), title: "Fix" },
      ],
    })
    expect(reply).toEqual({
      text: [
        '- "API docs" (id s-2): Active, working, 2 queued; Work branch claude/s-2, from main',
        "  Last Report, 1970-01-01T00:00:00.000Z:",
        "  All done.",
        "",
        '- "Tests" (id s-3): Active, idle; Work branch claude/s-2, from main',
        "  Last Report, 1970-01-01T00:00:00.000Z:",
        `  ${"y".repeat(MaxListedReport)}… (cut)`,
        "",
        '- "Fix" (id s-4): Active, idle; Work branch claude/s-2, from main',
        "  No Report yet.",
      ].join("\n"),
    })
  })

  test("says when there are no children", () => {
    expect(childReplyText({ _tag: "ChildList", children: [] })).toEqual({
      text: "You have no Child Sessions that aren't archived.",
    })
  })

  test("says when the Parent Session reads a message, and that the Report still follows", () => {
    const parent = { id: SessionId.make("s-1"), title: "Release 0.4" }
    expect(childReplyText({ _tag: "ParentMessaged", parent, working: false })).toEqual({
      text: 'Queued your message for your Parent Session "Release 0.4" (id s-1). It reads it as soon as it is ready. Any answer reaches you as a prompt after this Turn ends, and your Report still goes to it then.',
    })
  })

  test("is a refusal when the Hub refused", () => {
    expect(childReplyText({ _tag: "ChildRefused", message: "No." })).toEqual({ refused: "No." })
  })
})
