import type { AgentStatus as Status } from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { color, leading, radius, space, text, weight } from "./tokens.stylex.ts"

export interface AgentStatusProps {
  status: Status
  /** `dot` alone for dense lists, where a row says the status in words. */
  variant?: "badge" | "dot"
  sx?: stylex.StyleXStyles
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
  dotAlone: { width: "0.5rem", height: "0.5rem", verticalAlign: "middle" },
  // A Stopped agent won't go on by itself: a hollow dot, as for a Session that isn't running.
  hollow: {
    backgroundColor: "transparent",
    borderWidth: "1.5px",
    borderStyle: "solid",
  },
})

const badges = stylex.create({
  Running: { backgroundColor: color.sessionActiveTint, color: color.sessionActiveText },
  Done: { backgroundColor: color.successTint, color: color.successText },
  Stopped: { backgroundColor: color.surfaceActive, color: color.textSecondary },
  Interrupted: { backgroundColor: color.warningTint, color: color.warningText },
})

const dots = stylex.create({
  Running: { backgroundColor: color.sessionActive },
  // Finished: quiet, so the green of a running agent stands out.
  Done: { backgroundColor: color.textTertiary },
  Stopped: { borderColor: color.textTertiary },
  Interrupted: { backgroundColor: color.warning },
})

/** Where a subagent is (ADR 0014): running, done, stopped, or interrupted by its Session stopping. */
export function AgentStatus({ status, variant = "badge", sx }: AgentStatusProps) {
  const dot = (alone: boolean) => (
    <span
      {...stylex.props(
        styles.dot,
        alone && styles.dotAlone,
        status === "Stopped" && styles.hollow,
        dots[status],
        alone && sx,
      )}
      {...(alone ? { role: "img", "aria-label": status } : { "aria-hidden": true })}
    />
  )
  if (variant === "dot") return dot(true)
  return (
    <span {...stylex.props(styles.badge, badges[status], sx)}>
      {dot(false)}
      {status}
    </span>
  )
}
