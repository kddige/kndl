import * as stylex from "@stylexjs/stylex"
import type { ReactNode } from "react"
import { chrome, color, leading, space, text } from "./tokens.stylex.ts"
import { textRole } from "./type.ts"
import { useDocumentTitle } from "./useDocumentTitle.ts"

export interface PageHeaderProps {
  /** The page's name, as its h1: a work branch, a Repo, "Shared variables". Shown whole. */
  title: ReactNode
  /** Beside the title: a SessionStatus or Badge saying what state the page's thing is in. */
  badge?: ReactNode
  /** The page's name in the browser tab, where `title` isn't plain text or needs context. */
  pageTitle?: string
  /** One sentence, under 15 words: what the page holds. */
  description?: ReactNode
  /** After the title: small Buttons and IconButtons, an AvatarStack. They wrap under it when narrow. */
  actions?: ReactNode
  sx?: stylex.StyleXStyles
}

const styles = stylex.create({
  // The title and the actions share a row while they fit, and the actions wrap under it when
  // they don't: the header's own content sets the break, whatever the viewport. A one-line title
  // with 32px actions is exactly the bar's height, so its rule sits level with the Sidebar's.
  header: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space.s3,
    rowGap: space.s2,
    flexShrink: 0,
    minHeight: chrome.barHeight,
    paddingBlock: space.s1_5,
    paddingInline: space.s4,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: color.border,
    backgroundColor: color.surface,
  },
  // What the page is, first: the title with its badge, then the description under them.
  heading: {
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
    flex: "1 1 12rem",
    minWidth: 0,
  },
  titleLine: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    minWidth: 0,
  },
  // Focus lands on it when the page opens; it isn't a control, so it shows no ring.
  title: { minWidth: 0, overflowWrap: "anywhere", outline: "none" },
  badge: { display: "inline-flex", flexShrink: 0 },
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s2,
    minWidth: 0,
    maxWidth: "100%",
  },
  description: {
    maxWidth: "60ch",
    color: color.textMuted,
    fontSize: text.sm,
    lineHeight: leading.snug,
    textWrap: "pretty",
  },
})

/**
 * The top of a page beside the Sidebar: its title, what it's about, and what can be done to it.
 * At least as tall as the Sidebar's header, with the same gutter, so the title sits level with the
 * brand. The title shows whole, wrapping if it must.
 */
export function PageHeader({ title, pageTitle, badge, description, actions, sx }: PageHeaderProps) {
  useDocumentTitle(`${pageTitle ?? (typeof title === "string" ? title : "")} · kndl`)
  return (
    <header {...stylex.props(styles.header, sx)}>
      <div {...stylex.props(styles.heading)}>
        <div {...stylex.props(styles.titleLine)}>
          <h1 tabIndex={-1} {...stylex.props(textRole.title, styles.title)}>
            {title}
          </h1>
          {badge && <span {...stylex.props(styles.badge)}>{badge}</span>}
        </div>
        {description && <p {...stylex.props(styles.description)}>{description}</p>}
      </div>
      {actions && <div {...stylex.props(styles.actions)}>{actions}</div>}
    </header>
  )
}
