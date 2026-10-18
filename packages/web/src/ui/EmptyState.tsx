import * as stylex from "@stylexjs/stylex"
import type { ReactNode } from "react"
import { color, leading, radius, space } from "./tokens.stylex.ts"
import { textRole } from "./type.ts"

export interface EmptyStateProps {
  /** What's empty, as a statement: "No Sessions yet". */
  title: ReactNode
  /** What to do about it, or why it's empty. */
  description?: ReactNode
  /** A 16px icon, shown enlarged in a tile. */
  icon?: ReactNode
  /**
   * The next step, usually one primary Button. A failure's empty state always offers a way out,
   * such as Try again.
   */
  action?: ReactNode
  /** `compact` inside a panel or list; `page` when it's the whole view. */
  size?: "compact" | "page"
  sx?: stylex.StyleXStyles
}

const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
    gap: space.s1,
    paddingBlock: space.s8,
    paddingInline: space.s4,
  },
  page: {
    paddingBlock: space.s16,
  },
  icon: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "2.5rem",
    height: "2.5rem",
    marginBottom: space.s2,
    borderRadius: radius.lg,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    backgroundColor: color.surfaceMuted,
    color: color.textSecondary,
  },
  title: { color: color.text, textWrap: "balance" },
  description: {
    maxWidth: "24rem",
    color: color.textSecondary,
    lineHeight: leading.snug,
    textWrap: "pretty",
  },
  action: {
    marginTop: space.s3,
  },
})

/** What to show instead of an empty list: what's missing and the way forward. */
export function EmptyState({
  title,
  description,
  icon,
  action,
  size = "compact",
  sx,
}: EmptyStateProps) {
  return (
    <div {...stylex.props(styles.root, size === "page" && styles.page, sx)}>
      {icon && (
        <div aria-hidden="true" {...stylex.props(styles.icon)}>
          {icon}
        </div>
      )}
      <p {...stylex.props(textRole.heading, styles.title)}>{title}</p>
      {description && <p {...stylex.props(styles.description)}>{description}</p>}
      {action && <div {...stylex.props(styles.action)}>{action}</div>}
    </div>
  )
}
