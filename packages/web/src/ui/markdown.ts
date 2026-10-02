// A small Markdown parser for Claude's answers: paragraphs, headings, lists, quotes, fenced code,
// tables and the common inline marks. It builds a tree that Markdown.tsx renders as React
// elements, so nothing is ever set as HTML. Text that is still streaming parses too: an
// unclosed code fence runs to the end, and an unclosed mark stays literal.

export type Inline =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "code"; readonly text: string }
  | { readonly type: "strong" | "em" | "del"; readonly children: ReadonlyArray<Inline> }
  | { readonly type: "link"; readonly href: string; readonly children: ReadonlyArray<Inline> }

export type Align = "left" | "center" | "right" | null

export type Block =
  | { readonly type: "paragraph"; readonly children: ReadonlyArray<Inline> }
  | { readonly type: "heading"; readonly level: number; readonly children: ReadonlyArray<Inline> }
  | { readonly type: "code"; readonly lang: string; readonly text: string }
  | {
      readonly type: "list"
      readonly ordered: boolean
      readonly start: number
      readonly items: ReadonlyArray<ReadonlyArray<Block>>
    }
  | { readonly type: "quote"; readonly children: ReadonlyArray<Block> }
  | { readonly type: "rule" }
  | {
      readonly type: "table"
      readonly align: ReadonlyArray<Align>
      readonly head: ReadonlyArray<ReadonlyArray<Inline>>
      readonly rows: ReadonlyArray<ReadonlyArray<ReadonlyArray<Inline>>>
    }

const fence = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/
const heading = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const rule = /^ {0,3}([-*_])(\s*\1){2,}\s*$/
const listItem = /^( {0,3})([-*+]|\d{1,9}[.)])\s+(.*)$/
const quote = /^ {0,3}>\s?(.*)$/
const tableDivider = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

export function parseMarkdown(source: string): ReadonlyArray<Block> {
  return parseBlocks(source.replaceAll("\r\n", "\n").split("\n"))
}

function parseBlocks(lines: ReadonlyArray<string>): Array<Block> {
  const blocks: Array<Block> = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ""
    if (line.trim() === "") {
      index++
      continue
    }

    const open = fence.exec(line)
    if (open) {
      const marker = open[1] ?? "```"
      const body: Array<string> = []
      index++
      while (index < lines.length) {
        const next = lines[index] ?? ""
        if (next.trim().startsWith(marker) && next.trim().replaceAll(marker[0] ?? "`", "") === "") {
          index++
          break
        }
        body.push(next)
        index++
      }
      blocks.push({ type: "code", lang: open[2] ?? "", text: body.join("\n") })
      continue
    }

    const title = heading.exec(line)
    if (title) {
      blocks.push({
        type: "heading",
        level: title[1]?.length ?? 1,
        children: parseInline(title[2] ?? ""),
      })
      index++
      continue
    }

    if (rule.test(line)) {
      blocks.push({ type: "rule" })
      index++
      continue
    }

    if (quote.test(line)) {
      const inner: Array<string> = []
      while (index < lines.length) {
        const match = quote.exec(lines[index] ?? "")
        if (!match) break
        inner.push(match[1] ?? "")
        index++
      }
      blocks.push({ type: "quote", children: parseBlocks(inner) })
      continue
    }

    const item = listItem.exec(line)
    if (item) {
      const [list, next] = parseList(lines, index)
      blocks.push(list)
      index = next
      continue
    }

    if (line.includes("|") && tableDivider.test(lines[index + 1] ?? "")) {
      const head = cells(line)
      const align = cells(lines[index + 1] ?? "").map(alignment)
      const rows: Array<Array<ReadonlyArray<Inline>>> = []
      index += 2
      while (index < lines.length && (lines[index] ?? "").includes("|")) {
        rows.push(cells(lines[index] ?? "").map(parseInline))
        index++
      }
      blocks.push({ type: "table", align, head: head.map(parseInline), rows })
      continue
    }

    // A paragraph runs until a blank line or the start of another block.
    const text: Array<string> = [line.trim()]
    index++
    while (index < lines.length) {
      const next = lines[index] ?? ""
      if (
        next.trim() === "" ||
        fence.test(next) ||
        heading.test(next) ||
        rule.test(next) ||
        quote.test(next) ||
        listItem.test(next)
      ) {
        break
      }
      text.push(next.trim())
      index++
    }
    blocks.push({ type: "paragraph", children: parseInline(text.join("\n")) })
  }
  return blocks
}

/** A list and the line after it. Items hold blocks: lines indented under an item belong to it. */
function parseList(lines: ReadonlyArray<string>, from: number): [Block, number] {
  const first = listItem.exec(lines[from] ?? "")
  const ordered = /\d/.test(first?.[2] ?? "")
  const start = ordered ? Number.parseInt(first?.[2] ?? "1", 10) : 1
  const items: Array<Array<Block>> = []
  let index = from
  while (index < lines.length) {
    const match = listItem.exec(lines[index] ?? "")
    if (!match || /\d/.test(match[2] ?? "") !== ordered) break
    const indent = (match[1]?.length ?? 0) + (match[2]?.length ?? 0) + 1
    const body: Array<string> = [match[3] ?? ""]
    index++
    while (index < lines.length) {
      const next = lines[index] ?? ""
      if (next.trim() === "") {
        // A blank line continues the item only if indented content follows it.
        const after = lines[index + 1] ?? ""
        if (after.startsWith(" ".repeat(Math.min(indent, 2))) && after.trim() !== "") {
          body.push("")
          index++
          continue
        }
        break
      }
      if (/^\s{2,}/.test(next)) {
        body.push(next.slice(Math.min(indent, next.length - next.trimStart().length)))
        index++
        continue
      }
      // A lazy continuation: a plain line straight after the item's text.
      if (!listItem.test(next) && !fence.test(next) && !heading.test(next) && !quote.test(next)) {
        body.push(next)
        index++
        continue
      }
      break
    }
    items.push(parseBlocks(body))
    // Blank lines between items keep the list going.
    while ((lines[index] ?? "x").trim() === "" && listItem.test(lines[index + 1] ?? "")) index++
  }
  return [{ type: "list", ordered, start, items }, index]
}

function cells(row: string): Array<string> {
  let trimmed = row.trim()
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1)
  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) trimmed = trimmed.slice(0, -1)
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replaceAll("\\|", "|"))
}

function alignment(divider: string): Align {
  const left = divider.startsWith(":")
  const right = divider.endsWith(":")
  if (left && right) return "center"
  if (right) return "right"
  if (left) return "left"
  return null
}

const safeHref = /^(https?:\/\/|mailto:|\/|#)/i

export function parseInline(source: string): ReadonlyArray<Inline> {
  const out: Array<Inline> = []
  let buffer = ""
  const flush = () => {
    if (buffer !== "") out.push({ type: "text", text: buffer })
    buffer = ""
  }
  let index = 0
  while (index < source.length) {
    const char = source[index] ?? ""
    const rest = source.slice(index)

    if (char === "\\" && /^[\\`*_{}[\]()#+\-.!|~>]/.test(source[index + 1] ?? "")) {
      buffer += source[index + 1]
      index += 2
      continue
    }

    if (char === "`") {
      const ticks = /^`+/.exec(rest)?.[0] ?? "`"
      const close = source.indexOf(ticks, index + ticks.length)
      if (close !== -1) {
        flush()
        const code = source.slice(index + ticks.length, close)
        out.push({ type: "code", text: code.length > 2 && /^ .* $/.test(code) ? code.slice(1, -1) : code })
        index = close + ticks.length
        continue
      }
    }

    const strong = rest.startsWith("**") ? "**" : rest.startsWith("__") ? "__" : null
    if (strong && !/\s/.test(source[index + 2] ?? " ")) {
      const close = findClose(source, strong, index + 2)
      if (close !== -1 && (strong === "**" || !isWordChar(source[close + 2]))) {
        flush()
        out.push({ type: "strong", children: parseInline(source.slice(index + 2, close)) })
        index = close + 2
        continue
      }
    }

    if (rest.startsWith("~~") && !/\s/.test(source[index + 2] ?? " ")) {
      const close = findClose(source, "~~", index + 2)
      if (close !== -1) {
        flush()
        out.push({ type: "del", children: parseInline(source.slice(index + 2, close)) })
        index = close + 2
        continue
      }
    }

    if ((char === "*" || char === "_") && !/\s/.test(source[index + 1] ?? " ")) {
      // An underscore inside a word (snake_case) is just an underscore.
      const opens = char === "*" || !isWordChar(source[index - 1])
      const close = opens ? findClose(source, char, index + 1) : -1
      if (close !== -1 && (char === "*" || !isWordChar(source[close + 1]))) {
        flush()
        out.push({ type: "em", children: parseInline(source.slice(index + 1, close)) })
        index = close + 1
        continue
      }
    }

    if (char === "[") {
      const link = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest)
      if (link) {
        flush()
        const children = parseInline(link[1] ?? "")
        const href = link[2] ?? ""
        if (safeHref.test(href)) out.push({ type: "link", href, children })
        else out.push(...children)
        index += link[0].length
        continue
      }
    }

    if (char === "<") {
      const auto = /^<(https?:\/\/[^\s>]+)>/.exec(rest)
      if (auto) {
        flush()
        const href = auto[1] ?? ""
        out.push({ type: "link", href, children: [{ type: "text", text: href }] })
        index += auto[0].length
        continue
      }
    }

    buffer += char
    index++
  }
  flush()
  return out
}

/** Where `marker` closes a mark opened before `from`: not after whitespace, not empty. */
function findClose(source: string, marker: string, from: number): number {
  let at = source.indexOf(marker, from)
  while (at !== -1) {
    if (at > from && !/\s/.test(source[at - 1] ?? "")) {
      // `**` inside a `*` mark is the strong mark, not this one's end.
      if (marker.length === 1 && source[at + 1] === marker) {
        at = source.indexOf(marker, at + 2)
        continue
      }
      return at
    }
    at = source.indexOf(marker, at + marker.length)
  }
  return -1
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char)
}
