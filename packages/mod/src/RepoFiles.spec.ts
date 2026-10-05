import { describe, expect, test } from "bun:test"
import { parseRepoInstructions, skillInWorkspace, withRepoInstructions } from "./RepoFiles.ts"

describe("parseRepoInstructions", () => {
  test("reads the Runner's list of instruction files", () => {
    const text = JSON.stringify({
      instructions: [
        { path: "/workspace/CLAUDE.md", content: "Use bun.\n" },
        {
          path: "/workspace/docs/style.md",
          content: "Be brief.\n",
          parent: "/workspace/CLAUDE.md",
        },
      ],
    })
    expect(parseRepoInstructions(text)).toEqual([
      { path: "/workspace/CLAUDE.md", content: "Use bun.\n" },
      { path: "/workspace/docs/style.md", content: "Be brief.\n", parent: "/workspace/CLAUDE.md" },
    ])
  })

  test("leaves out what isn't an instruction file", () => {
    const text = JSON.stringify({
      instructions: [
        { path: "CLAUDE.md", content: "relative" },
        { path: "/workspace/a.md", content: 1 },
        { path: "/workspace/b.md", content: "b", parent: 2 },
        "/workspace/c.md",
        { path: "/workspace/d.md", content: "d", extra: true },
      ],
    })
    expect(parseRepoInstructions(text)).toEqual([{ path: "/workspace/d.md", content: "d" }])
  })

  test("is empty for a file that isn't the list", () => {
    expect(parseRepoInstructions("")).toEqual([])
    expect(parseRepoInstructions("not json")).toEqual([])
    expect(parseRepoInstructions("[]")).toEqual([])
    expect(parseRepoInstructions(JSON.stringify({ instructions: {} }))).toEqual([])
  })
})

describe("withRepoInstructions", () => {
  test("keeps the managed policy, then the Repo's, and drops what came from the host", () => {
    const loaded = [
      { path: "/etc/claude-code/CLAUDE.md", kind: "managed", content: "policy" },
      { path: "/Users/ada/.claude/CLAUDE.md", kind: "user", content: "mine" },
      { path: "/Users/ada/notes/CLAUDE.md", kind: "project", content: "host project" },
      { path: "/Users/ada/notes/CLAUDE.local.md", kind: "local", content: "private" },
      { path: "/Users/ada/.claude/memory/MEMORY.md", kind: "memory", content: "memory" },
    ]
    const repo = [
      { path: "/workspace/CLAUDE.md", content: "Use bun." },
      { path: "/workspace/a.md", content: "A", parent: "/workspace/CLAUDE.md" },
    ]
    expect(withRepoInstructions(loaded, repo)).toEqual([
      { path: "/etc/claude-code/CLAUDE.md", kind: "managed", content: "policy" },
      { path: "/workspace/CLAUDE.md", kind: "project", content: "Use bun." },
      { path: "/workspace/a.md", kind: "project", content: "A", parent: "/workspace/CLAUDE.md" },
    ])
  })
})

describe("skillInWorkspace", () => {
  test("points the skill's directory at the Workspace", () => {
    const text = [
      "Base directory for this skill: /Users/ada/.claude-hub/sessions/s1/repo/.claude/skills/deploy",
      "",
      "Run /Users/ada/.claude-hub/sessions/s1/repo/.claude/skills/deploy/ship.sh.",
    ].join("\n")
    expect(skillInWorkspace(text, "/Users/ada/.claude-hub/sessions/s1/repo/", "/workspace")).toBe(
      [
        "Base directory for this skill: /workspace/.claude/skills/deploy",
        "",
        "Run /workspace/.claude/skills/deploy/ship.sh.",
      ].join("\n"),
    )
  })

  test("leaves a path that only starts the same alone", () => {
    const text = "See /sessions/s1/repository/x and /sessions/s1/repo"
    expect(skillInWorkspace(text, "/sessions/s1/repo", "/workspace")).toBe(text)
  })
})
