import * as stylex from "@stylexjs/stylex"
import { color, leading, radius, space, text, weight } from "./tokens.stylex.ts"

/** The Session lifecycle states from GLOSSARY.md. */
export type SessionState = "active" | "asleep" | "frozen" | "archived"

export interface SessionStatusProps {
  state: SessionState
  /** `dot` alone for dense lists, where a row's tooltip or header says the state in words. */
  variant?: "badge" | "dot"
  sx?: stylex.StyleXStyles
}

const LABELS: Record<SessionState, string> = {
  active: "Active",
  asleep: "Asleep",
  frozen: "Frozen",
  archived: "Archived",
}

const styles = stylex.create({
  badge: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1_5,
    height: "1.25rem",
    paddingInline: space.s1_5,
    borderRadius: radius.full,
    fontSize: text.xs,
    fontWeight: weight.medium,
    lineHeight: leading.tight,
    whiteSpace: "nowrap",
    verticalAlign: "middle",
  },
  dot: {
    display: "inline-block",
    flexShrink: 0,
    width: "0.375rem",
    height: "0.375rem",
    borderRadius: radius.full,
  },
  // A lone dot is a little bigger and carries its label for screen readers.
  dotAlone: {
    width: "0.5rem",
    height: "0.5rem",
    verticalAlign: "middle",
  },
  // Frozen and Archived Sessions can't take prompts: a hollow dot says "not live" without colour.
  hollow: {
    backgroundColor: "transparent",
    borderWidth: "1.5px",
    borderStyle: "solid",
  },
})

const badges = stylex.create({
  active: { backgroundColor: color.sessionActiveSubtle, color: color.sessionActiveText },
  asleep: { backgroundColor: color.sessionAsleepSubtle, color: color.sessionAsleepText },
  frozen: { backgroundColor: color.sessionFrozenSubtle, color: color.sessionFrozenText },
  archived: { backgroundColor: color.sessionArchivedSubtle, color: color.sessionArchivedText },
})

const dots = stylex.create({
  active: { backgroundColor: color.sessionActive },
  asleep: { backgroundColor: color.sessionAsleep },
  frozen: { borderColor: color.sessionFrozen },
  archived: { borderColor: color.sessionArchived },
})

/** Where a Session is in its lifecycle, by colour, shape and word. */
export function SessionStatus({ state, variant = "badge", sx }: SessionStatusProps) {
  const hollow = state === "frozen" || state === "archived"
  const dot = (alone: boolean) => (
    <span
      {...stylex.props(
        styles.dot,
        alone && styles.dotAlone,
        hollow && styles.hollow,
        dots[state],
        alone && sx,
      )}
      {...(alone ? { role: "img", "aria-label": LABELS[state] } : { "aria-hidden": true })}
    />
  )
  if (variant === "dot") return dot(true)
  return (
    <span {...stylex.props(styles.badge, badges[state], sx)}>
      {dot(false)}
      {LABELS[state]}
    </span>
  )
}
