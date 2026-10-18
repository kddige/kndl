import * as stylex from "@stylexjs/stylex"
import { useLayoutEffect, useRef } from "react"
import { color, font, leading, radius, space, text } from "./tokens.stylex.ts"

export interface LogViewProps {
  /** The output so far; it grows as more streams in. */
  children: string
  /** Names the region, such as "Test build log". */
  label: string
  /** Shown while there is no output yet. */
  placeholder?: string
  sx?: stylex.StyleXStyles
}

const styles = stylex.create({
  log: {
    margin: 0,
    maxHeight: "20rem",
    minHeight: "6rem",
    overflow: "auto",
    paddingBlock: space.s2_5,
    paddingInline: space.s3,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.md,
    backgroundColor: color.surfaceMuted,
    color: color.text,
    fontFamily: font.mono,
    fontSize: text.sm,
    lineHeight: leading.normal,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  },
  placeholder: { color: color.textTertiary },
})

/**
 * Streaming output, such as a build's: monospace, scrolled to the end as lines arrive unless the
 * reader has scrolled up to read.
 */
export function LogView({ children, label, placeholder, sx }: LogViewProps) {
  const ref = useRef<HTMLPreElement>(null)
  const atEnd = useRef(true)
  useLayoutEffect(() => {
    const element = ref.current
    if (element && atEnd.current) element.scrollTop = element.scrollHeight
  }, [children])
  return (
    <pre
      ref={ref}
      role="log"
      aria-label={label}
      // Focusable, so the log can be scrolled from the keyboard.
      tabIndex={0}
      onScroll={(event) => {
        const element = event.currentTarget
        atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 8
      }}
      {...stylex.props(styles.log, children === "" && styles.placeholder, sx)}
    >
      {children === "" ? (placeholder ?? "") : children}
    </pre>
  )
}
