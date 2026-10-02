import * as stylex from "@stylexjs/stylex"
import type { ReactNode } from "react"
import { color, leading, radius, space, text, weight } from "./tokens.stylex.ts"

/**
 * - `neutral`, `accent`: information.
 * - `warning`, `danger`: something is wrong or about to be.
 * - `frozen`, `asleep`: a Session in that state, in the same colours as its SessionStatus.
 */
export type BannerIntent = "neutral" | "accent" | "warning" | "danger" | "frozen" | "asleep"

export interface BannerProps {
  title: ReactNode
  /** One or two sentences: what it means and what happens next. */
  children?: ReactNode
  intent?: BannerIntent
  icon?: ReactNode
  /** A button that deals with it. */
  action?: ReactNode
  sx?: stylex.StyleXStyles
}

const styles = stylex.create({
  root: {
    display: "flex",
    alignItems: "flex-start",
    flexWrap: "wrap",
    gap: space.s3,
    paddingBlock: space.s2_5,
    paddingInline: space.s3,
    borderWidth: "1px",
    borderStyle: "solid",
    borderRadius: radius.lg,
    fontSize: text.sm,
    lineHeight: leading.snug,
  },
  icon: {
    display: "inline-flex",
    flexShrink: 0,
    paddingTop: "0.125rem",
  },
  body: {
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
    flex: "1 1 14rem",
    minWidth: 0,
  },
  title: { fontWeight: weight.semibold },
  description: { color: color.text, opacity: 0.85 },
  action: {
    display: "flex",
    alignItems: "center",
    flexShrink: 0,
    alignSelf: "center",
  },
})

const intents = stylex.create({
  neutral: {
    backgroundColor: color.surfaceMuted,
    borderColor: color.border,
    color: color.text,
  },
  accent: {
    backgroundColor: color.accentSubtle,
    borderColor: "transparent",
    color: color.accentSubtleText,
  },
  warning: {
    backgroundColor: color.warningSubtle,
    borderColor: "transparent",
    color: color.warningSubtleText,
  },
  danger: {
    backgroundColor: color.dangerSubtle,
    borderColor: "transparent",
    color: color.dangerSubtleText,
  },
  frozen: {
    backgroundColor: color.sessionFrozenSubtle,
    borderColor: "transparent",
    color: color.sessionFrozenText,
  },
  asleep: {
    backgroundColor: color.sessionAsleepSubtle,
    borderColor: "transparent",
    color: color.sessionAsleepText,
  },
})

/** A strip across a view that says what state it's in, such as a Frozen Session's. */
export function Banner({ title, children, intent = "neutral", icon, action, sx }: BannerProps) {
  return (
    <div role="status" {...stylex.props(styles.root, intents[intent], sx)}>
      {icon && (
        <span aria-hidden="true" {...stylex.props(styles.icon)}>
          {icon}
        </span>
      )}
      <div {...stylex.props(styles.body)}>
        <p {...stylex.props(styles.title)}>{title}</p>
        {children && <p {...stylex.props(styles.description)}>{children}</p>}
      </div>
      {action && <div {...stylex.props(styles.action)}>{action}</div>}
    </div>
  )
}
