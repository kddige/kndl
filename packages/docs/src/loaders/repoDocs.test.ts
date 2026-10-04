import { describe, expect, test } from "bun:test"
import { adrLabel, glossaryBody, rewriteLinks, splitFrontmatter, takeTitle } from "./repoDocs.ts"

describe("splitFrontmatter", () => {
  test("reads the attributes and returns the rest", () => {
    const { attributes, body } = splitFrontmatter(
      "---\nstatus: superseded by 0010\n---\n\n# Title\n",
    )
    expect(attributes).toEqual({ status: "superseded by 0010" })
    expect(body).toBe("\n# Title\n")
  })

  test("leaves a file without frontmatter alone", () => {
    expect(splitFrontmatter("# Title\n")).toEqual({ attributes: {}, body: "# Title\n" })
  })
})

describe("takeTitle", () => {
  test("takes the first top-level heading out", () => {
    expect(takeTitle("# One\n\nText\n\n# Two\n")).toEqual({
      title: "One",
      body: "\n\nText\n\n# Two\n",
    })
  })

  test("ignores deeper headings", () => {
    expect(takeTitle("## Sub\n").title).toBeUndefined()
  })
})

test("adrLabel keeps the part of the title before a ; or :", () => {
  expect(adrLabel("0003", "Sessions belong to the Repo; not a person")).toBe(
    "0003 · Sessions belong to the Repo",
  )
  expect(adrLabel("0008", "Stack")).toBe("0008 · Stack")
})

describe("rewriteLinks", () => {
  test("points links between ADRs at their pages", () => {
    expect(rewriteLinks("See [0005](./0005-git-remote.md#why).")).toBe(
      "See [0005](/reference/decisions/0005-git-remote/#why).",
    )
    expect(rewriteLinks("[x](0001-claude-on-host.md)")).toBe(
      "[x](/reference/decisions/0001-claude-on-host/)",
    )
  })

  test("points links to the glossary at its page", () => {
    expect(rewriteLinks("[Sandbox](../../GLOSSARY.md#sandbox)")).toBe(
      "[Sandbox](/reference/glossary/#sandbox)",
    )
  })

  test("leaves other links alone", () => {
    const text = "[README](../../README.md) and [site](https://example.com/0001-x.md)"
    expect(rewriteLinks(text)).toBe(text)
  })
})

test("glossaryBody turns bold term lines into headings", () => {
  expect(glossaryBody("**Runner**:\nA process.\n**Not** a term: inline.\n")).toBe(
    "### Runner\nA process.\n**Not** a term: inline.\n",
  )
})
