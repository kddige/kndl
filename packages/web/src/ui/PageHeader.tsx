import * as stylex from "@stylexjs/stylex"
import type { ReactNode } from "react"
import { chrome, color, leading, space, text, tracking, weight } from "./tokens.stylex.ts"

export interface PageHeaderProps {
  /** The page's name, as its h1: a work branch, a Repo, "Shared variables". */
  title: ReactNode
  /** Beside the title: a SessionStatus or Badge saying what state the page's thing is in. */
  badge?: ReactNode
  /** A line under the title: what the page is for, or where its thing comes from. */
  description?: ReactNode
  /** At the end of the title row: small Buttons and IconButtons, an AvatarStack. */
  actions?: ReactNode
  sx?: stylex.StyleXStyles
}

const styles = stylex.create({
  header: {
    flexShrink: 0,
    paddingInline: space.s4,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: color.border,
    backgroundColor: color.surface,
  },
  withDescription: { paddingBottom: space.s2_5 },
  row: {
    display: "flex",
    alignItems: "center",
    gap: space.s3,
    height: chrome.barHeight,
  },
  heading: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    flex: 1,
    minWidth: 0,
  },
  // The brand's type in the Sidebar, so the two read as one line across the top.
  title: {
    minWidth: 0,
    fontSize: text.md,
    fontWeight: weight.semibold,
    letterSpacing: tracking.tight,
    lineHeight: leading.tight,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  badge: { display: "inline-flex", flexShrink: 0 },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    flexShrink: 0,
  },
  // The row is as tall as the brand's, which leaves room under the title: the description takes
  // some of it, so it reads with the title rather than apart from it.
  description: {
    marginTop: `calc(${space.s2} * -1)`,
    color: color.textMuted,
    fontSize: text.sm,
    lineHeight: leading.snug,
  },
})

/**
 * The top of a page beside the Sidebar: its title, what it's about, and what can be done to it. The
 * title row is as tall as the Sidebar's header, with the same gutter and type, so the title sits
 * level with the brand. A title too long for the row is cut short; a string one is its own tooltip.
 */
export function PageHeader({ title, badge, description, actions, sx }: PageHeaderProps) {
  return (
    <header {...stylex.props(styles.header, description ? styles.withDescription : null, sx)}>
      <div {...stylex.props(styles.row)}>
        <div {...stylex.props(styles.heading)}>
          <h1 {...(typeof title === "string" && { title })} {...stylex.props(styles.title)}>
            {title}
          </h1>
          {badge && <span {...stylex.props(styles.badge)}>{badge}</span>}
        </div>
        {actions && <div {...stylex.props(styles.actions)}>{actions}</div>}
      </div>
      {description && <p {...stylex.props(styles.description)}>{description}</p>}
    </header>
  )
}
