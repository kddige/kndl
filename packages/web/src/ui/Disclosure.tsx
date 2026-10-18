import { Collapsible } from "@base-ui/react/collapsible"
import * as stylex from "@stylexjs/stylex"
import { type ReactNode, useState } from "react"
import { ChevronRightIcon } from "./icons.tsx"
import { focus } from "./shared.ts"
import { color, control, motion, radius, space, text } from "./tokens.stylex.ts"

export interface DisclosureProps {
  /** The always-visible row that opens and closes the panel: a one-line summary. */
  summary: ReactNode
  /** What opening it shows. Not rendered while closed. */
  children: ReactNode
  /** Closed unless set; most detail is noise until asked for. */
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** `boxed` for a row that stands alone, like a tool call; `plain` inside something framed. */
  variant?: "boxed" | "plain"
  sx?: stylex.StyleXStyles
}

// Hover styles only where a pointer can hover: on touch, :hover sticks after a tap.
const HOVER = "@media (hover: hover)"

const styles = stylex.create({
  root: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
  },
  boxed: {
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.md,
    backgroundColor: color.surface,
  },
  trigger: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    width: "100%",
    minWidth: 0,
    minHeight: control.sm,
    paddingBlock: space.s1,
    paddingInline: space.s2,
    borderWidth: 0,
    borderRadius: radius.md,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: color.surfaceHover },
    },
    color: color.text,
    fontSize: text.sm,
    textAlign: "start",
    cursor: "pointer",
  },
  chevron: {
    flexShrink: 0,
    color: color.textTertiary,
    // Closed, it points to the inline end, whichever way the page reads.
    transform: { default: "none", ":dir(rtl)": "scaleX(-1)" },
    transitionProperty: "transform",
    transitionDuration: motion.durationMove,
    transitionTimingFunction: motion.easeStandard,
  },
  chevronOpen: { transform: "rotate(90deg)" },
  summary: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    flex: 1,
    minWidth: 0,
  },
  panel: {
    overflow: "hidden",
    height: {
      default: "var(--collapsible-panel-height)",
      "[data-starting-style]": 0,
      "[data-ending-style]": 0,
    },
    transitionProperty: "height",
    transitionDuration: motion.durationMove,
    transitionTimingFunction: motion.easeOut,
  },
  boxedPanel: {
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: color.border,
  },
})

/** A summary row that shows or hides the detail under it, such as a tool call's input and output. */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  open,
  onOpenChange,
  variant = "boxed",
  sx,
}: DisclosureProps) {
  const [ownOpen, setOwnOpen] = useState(defaultOpen)
  const isOpen = open ?? ownOpen
  return (
    <Collapsible.Root
      open={isOpen}
      onOpenChange={(next: boolean) => {
        setOwnOpen(next)
        onOpenChange?.(next)
      }}
      {...stylex.props(styles.root, variant === "boxed" && styles.boxed, sx)}
    >
      <Collapsible.Trigger {...stylex.props(styles.trigger, focus.ring)}>
        <ChevronRightIcon {...stylex.props(styles.chevron, isOpen && styles.chevronOpen)} />
        <span {...stylex.props(styles.summary)}>{summary}</span>
      </Collapsible.Trigger>
      <Collapsible.Panel {...stylex.props(styles.panel, variant === "boxed" && styles.boxedPanel)}>
        {children}
      </Collapsible.Panel>
    </Collapsible.Root>
  )
}
