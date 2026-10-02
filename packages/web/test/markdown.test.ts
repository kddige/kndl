import { describe, expect, test } from "bun:test"
import { parseInline, parseMarkdown } from "../src/ui/markdown.ts"

const text = (value: string) => ({ type: "text", text: value })

describe("blocks", () => {
  test("paragraphs split on blank lines; single newlines stay in the paragraph", () => {
    expect<unknown>(parseMarkdown("One\nstill one\n\nTwo")).toEqual([
      { type: "paragraph", children: [text("One\nstill one")] },
      { type: "paragraph", children: [text("Two")] },
    ])
  })

  test("headings, rules and quotes", () => {
    expect<unknown>(parseMarkdown("## Plan ##\n---\n> quoted\n> more")).toEqual([
      { type: "heading", level: 2, children: [text("Plan")] },
      { type: "rule" },
      { type: "quote", children: [{ type: "paragraph", children: [text("quoted\nmore")] }] },
    ])
  })

  test("a fenced code block keeps its text as is, with its language", () => {
    expect<unknown>(parseMarkdown("```ts\nconst a = **1**\n\n  indented\n```\nafter")).toEqual([
      { type: "code", lang: "ts", text: "const a = **1**\n\n  indented" },
      { type: "paragraph", children: [text("after")] },
    ])
  })

  test("an unclosed fence, as while streaming, runs to the end", () => {
    expect<unknown>(parseMarkdown("Look:\n```\nline one\nline")).toEqual([
      { type: "paragraph", children: [text("Look:")] },
      { type: "code", lang: "", text: "line one\nline" },
    ])
  })

  test("bullet and numbered lists, with nested content and lazy lines", () => {
    expect<unknown>(
      parseMarkdown("- one\n- two\n  - nested\n\n3. three\n4. four\ncontinued"),
    ).toEqual([
      {
        type: "list",
        ordered: false,
        start: 1,
        items: [
          [{ type: "paragraph", children: [text("one")] }],
          [
            { type: "paragraph", children: [text("two")] },
            {
              type: "list",
              ordered: false,
              start: 1,
              items: [[{ type: "paragraph", children: [text("nested")] }]],
            },
          ],
        ],
      },
      {
        type: "list",
        ordered: true,
        start: 3,
        items: [
          [{ type: "paragraph", children: [text("three")] }],
          [{ type: "paragraph", children: [text("four\ncontinued")] }],
        ],
      },
    ])
  })

  test("blank lines between items keep one list", () => {
    const [list] = parseMarkdown("1. a\n\n2. b")
    expect(list).toMatchObject({ type: "list", items: [[{}], [{}]] })
  })

  test("a table with alignment", () => {
    expect<unknown>(
      parseMarkdown("| Tool | Calls |\n|:--|--:|\n| Bash | 3 |\n| `Read` | 1 |"),
    ).toEqual([
      {
        type: "table",
        align: ["left", "right"],
        head: [[text("Tool")], [text("Calls")]],
        rows: [
          [[text("Bash")], [text("3")]],
          [[{ type: "code", text: "Read" }], [text("1")]],
        ],
      },
    ])
  })
})

describe("inline", () => {
  test("code, strong, emphasis and strikethrough", () => {
    expect<unknown>(parseInline("Run `bun test`, **now** and *carefully*, not ~~later~~.")).toEqual(
      [
        text("Run "),
        { type: "code", text: "bun test" },
        text(", "),
        { type: "strong", children: [text("now")] },
        text(" and "),
        { type: "em", children: [text("carefully")] },
        text(", not "),
        { type: "del", children: [text("later")] },
        text("."),
      ],
    )
  })

  test("marks nest", () => {
    expect<unknown>(parseInline("**a *b* c**")).toEqual([
      { type: "strong", children: [text("a "), { type: "em", children: [text("b")] }, text(" c")] },
    ])
  })

  test("underscores inside words and unclosed marks stay literal", () => {
    expect<unknown>(parseInline("snake_case_name and 2 * 3 and **open")).toEqual([
      text("snake_case_name and 2 * 3 and **open"),
    ])
  })

  test("marks in code spans aren't marks", () => {
    expect<unknown>(parseInline("`a *b* c`")).toEqual([{ type: "code", text: "a *b* c" }])
  })

  test("links keep only safe targets", () => {
    expect<unknown>(
      parseInline("[docs](https://example.com) and [x](javascript:alert(1))"),
    ).toEqual([
      { type: "link", href: "https://example.com", children: [text("docs")] },
      text(" and "),
      text("x"),
      text(")"),
    ])
    expect<unknown>(parseInline("<https://example.com/a>")).toEqual([
      { type: "link", href: "https://example.com/a", children: [text("https://example.com/a")] },
    ])
  })

  test("a backslash escapes a mark", () => {
    expect<unknown>(parseInline("\\*not em\\*")).toEqual([text("*not em*")])
  })
})
