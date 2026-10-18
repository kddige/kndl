// oxlint-disable react/no-array-index-key -- a parsed Markdown tree has no identity but position, and it is re-parsed whole on every change
import * as stylex from "@stylexjs/stylex"
import { Fragment, memo, type ReactNode } from "react"
import { type Block, type Inline, parseMarkdown } from "./markdown.ts"
import { textLink } from "./shared.ts"
import { color, font, leading, radius, space, text, weight } from "./tokens.stylex.ts"
import { textRole } from "./type.ts"

export interface MarkdownProps {
  /** Markdown source, such as Claude's answer. Partial (streaming) text renders too. */
  text: string
  sx?: stylex.StyleXStyles
}

const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2_5,
    minWidth: 0,
    lineHeight: leading.normal,
    overflowWrap: "anywhere",
  },
  // Prose stops at about 75 characters a line; code blocks and tables run as wide as they need.
  paragraph: { whiteSpace: "pre-line", maxWidth: "60ch" },
  // Headings sit under the host's: a Markdown h1 is a section heading, never a page title.
  h3: { color: color.textMuted },
  list: {
    maxWidth: "60ch",
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    paddingInlineStart: space.s5,
  },
  bullets: { listStyleType: "disc" },
  numbers: { listStyleType: "decimal" },
  item: {
    display: "list-item",
    "::marker": { color: color.textSubtle },
  },
  itemBody: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
  },
  quote: {
    maxWidth: "60ch",
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    paddingInlineStart: space.s3,
    borderInlineStartWidth: "2px",
    borderInlineStartStyle: "solid",
    borderInlineStartColor: color.borderStrong,
    color: color.textMuted,
  },
  rule: {
    height: 0,
    borderWidth: 0,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: color.border,
  },
  pre: {
    margin: 0,
    padding: space.s3,
    overflowX: "auto",
    backgroundColor: color.surfaceMuted,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.md,
    fontFamily: font.mono,
    fontSize: text.sm,
    lineHeight: leading.snug,
    whiteSpace: "pre",
    overflowWrap: "normal",
  },
  code: {
    paddingInline: "0.3em",
    paddingBlock: "0.1em",
    backgroundColor: color.surfaceMuted,
    borderRadius: radius.sm,
    fontFamily: font.mono,
    fontSize: "0.9em",
  },
  strong: { fontWeight: weight.semibold },
  link: { color: color.accentSubtleText },
  tableWrap: { overflowX: "auto" },
  table: {
    borderCollapse: "collapse",
    fontSize: text.sm,
  },
  cell: {
    paddingBlock: space.s1,
    paddingInline: space.s2_5,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    textAlign: "start",
    verticalAlign: "top",
  },
  headCell: {
    fontWeight: weight.semibold,
    backgroundColor: color.surfaceMuted,
  },
})

const aligns = stylex.create({
  left: { textAlign: "left" },
  center: { textAlign: "center" },
  right: { textAlign: "right" },
})

/** Renders Markdown as React elements; never as HTML, so it can't inject markup. */
export const Markdown = memo(function Markdown({ text: source, sx }: MarkdownProps) {
  return <div {...stylex.props(styles.root, sx)}>{renderBlocks(parseMarkdown(source))}</div>
})

function renderBlocks(blocks: ReadonlyArray<Block>): ReactNode {
  return blocks.map((block, index) => <Fragment key={index}>{renderBlock(block)}</Fragment>)
}

function renderBlock(block: Block): ReactNode {
  switch (block.type) {
    case "paragraph":
      return <p {...stylex.props(styles.paragraph)}>{renderInlines(block.children)}</p>
    case "heading": {
      const style =
        block.level === 1
          ? textRole.heading
          : block.level === 2
            ? textRole.subheading
            : [textRole.subheading, styles.h3]
      const Tag = (["h3", "h4", "h5", "h6"] as const)[Math.min(block.level, 4) - 1] ?? "h6"
      return <Tag {...stylex.props(style)}>{renderInlines(block.children)}</Tag>
    }
    case "code":
      return (
        <pre {...stylex.props(styles.pre)} data-lang={block.lang || undefined}>
          <code>{block.text}</code>
        </pre>
      )
    case "list": {
      const items = block.items.map((item, index) => (
        <li key={index} {...stylex.props(styles.item)}>
          <div {...stylex.props(styles.itemBody)}>{renderBlocks(item)}</div>
        </li>
      ))
      return block.ordered ? (
        <ol start={block.start} {...stylex.props(styles.list, styles.numbers)}>
          {items}
        </ol>
      ) : (
        <ul {...stylex.props(styles.list, styles.bullets)}>{items}</ul>
      )
    }
    case "quote":
      return <blockquote {...stylex.props(styles.quote)}>{renderBlocks(block.children)}</blockquote>
    case "rule":
      return <hr {...stylex.props(styles.rule)} />
    case "table":
      return (
        <div {...stylex.props(styles.tableWrap)}>
          <table {...stylex.props(styles.table)}>
            <thead>
              <tr>
                {block.head.map((cell, index) => (
                  <th
                    key={index}
                    {...stylex.props(styles.cell, styles.headCell, alignStyle(block.align[index]))}
                  >
                    {renderInlines(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, index) => (
                    <td key={index} {...stylex.props(styles.cell, alignStyle(block.align[index]))}>
                      {renderInlines(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
  }
}

function alignStyle(align: "left" | "center" | "right" | null | undefined) {
  return align ? aligns[align] : null
}

function renderInlines(inlines: ReadonlyArray<Inline>): ReactNode {
  return inlines.map((inline, index) => <Fragment key={index}>{renderInline(inline)}</Fragment>)
}

function renderInline(inline: Inline): ReactNode {
  switch (inline.type) {
    case "text":
      return inline.text
    case "code":
      return <code {...stylex.props(styles.code)}>{inline.text}</code>
    case "strong":
      return <strong {...stylex.props(styles.strong)}>{renderInlines(inline.children)}</strong>
    case "em":
      return <em>{renderInlines(inline.children)}</em>
    case "del":
      return <del>{renderInlines(inline.children)}</del>
    case "link":
      return (
        <a
          href={inline.href}
          target="_blank"
          rel="noreferrer noopener"
          {...stylex.props(textLink.underline, styles.link)}
        >
          {renderInlines(inline.children)}
        </a>
      )
  }
}
