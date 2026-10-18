import * as stylex from "@stylexjs/stylex"
import type { ReactNode } from "react"
import { color, leading, radius, space, text, weight } from "./tokens.stylex.ts"

/**
 * - `neutral`: counts and plain labels; the default.
 * - `accent`: something new or yours.
 * - `success`, `warning`, `danger`: an outcome or a state that needs attention.
 */
export type BadgeIntent = "neutral" | "accent" | "success" | "warning" | "danger"

export interface BadgeProps {
  children: ReactNode
  intent?: BadgeIntent
  /** A small leading icon or dot. */
  icon?: ReactNode
  sx?: stylex.StyleXStyles
}

const styles = stylex.create({
  badge: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    height: "1.25rem",
    paddingInline: space.s1_5,
    borderRadius: radius.sm,
    fontSize: text.xs,
    fontWeight: weight.medium,
    lineHeight: leading.tight,
    whiteSpace: "nowrap",
    verticalAlign: "middle",
    fontVariantNumeric: "tabular-nums",
  },
})

const intents = stylex.create({
  neutral: { backgroundColor: color.surfaceActive, color: color.textSecondary },
  accent: { backgroundColor: color.accentTint, color: color.accentText },
  success: { backgroundColor: color.successTint, color: color.successText },
  warning: { backgroundColor: color.warningTint, color: color.warningText },
  danger: { backgroundColor: color.dangerTint, color: color.dangerText },
})

/** A short, non-interactive label: a count, a type, a state. */
export function Badge({ children, intent = "neutral", icon, sx }: BadgeProps) {
  return (
    <span {...stylex.props(styles.badge, intents[intent], sx)}>
      {icon}
      {children}
    </span>
  )
}
