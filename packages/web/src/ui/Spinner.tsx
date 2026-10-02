import * as stylex from "@stylexjs/stylex"
import { radius } from "./tokens.stylex.ts"

export type SpinnerSize = "sm" | "md" | "lg"

export interface SpinnerProps {
  size?: SpinnerSize
  /** Announced to screen readers. Omit when the surrounding control already says it is busy. */
  label?: string
  sx?: stylex.StyleXStyles
}

const spin = stylex.keyframes({
  to: { transform: "rotate(360deg)" },
})

const styles = stylex.create({
  spinner: {
    display: "inline-block",
    flexShrink: 0,
    borderWidth: "1.5px",
    borderStyle: "solid",
    borderColor: "currentColor",
    borderRightColor: "transparent",
    borderRadius: radius.full,
    opacity: 0.8,
    animationName: spin,
    // Progress feedback is essential motion, so it slows down rather than stopping.
    animationDuration: { default: "700ms", "@media (prefers-reduced-motion: reduce)": "1.6s" },
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
  sm: { width: "0.75rem", height: "0.75rem" },
  md: { width: "1rem", height: "1rem" },
  lg: { width: "1.5rem", height: "1.5rem", borderWidth: "2px" },
})

/** An indeterminate progress indicator in the current text colour. */
export function Spinner({ size = "md", label, sx }: SpinnerProps) {
  return (
    <span
      {...stylex.props(styles.spinner, styles[size], sx)}
      {...(label ? { role: "status", "aria-label": label } : { "aria-hidden": true })}
    />
  )
}
