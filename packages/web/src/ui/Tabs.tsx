import { Tabs as BaseTabs } from "@base-ui/react/tabs"
import * as stylex from "@stylexjs/stylex"
import { type ReactNode, useEffect, useRef } from "react"
import { focus } from "./shared.ts"
import { color, control, icon, motion, radius, space, text, weight } from "./tokens.stylex.ts"

export interface TabsProps {
  /** A TabList, then one TabPanel per Tab. */
  children: ReactNode
  /** The open tab, when the parent tracks it (e.g. in the URL). */
  value?: string
  /** The tab open at first, when Tabs tracks it itself. Defaults to the first tab. */
  defaultValue?: string
  onValueChange?: (value: string) => void
  sx?: stylex.StyleXStyles
}

// Hover styles only where a pointer can hover: on touch, :hover sticks after a tap.
const HOVER = "@media (hover: hover)"

// Beside a 500-weight label, an icon's stroke thickens to match it.
const labelIcon = stylex.createTheme(icon, { stroke: "2px" })

const styles = stylex.create({
  // Too many tabs for the width scroll sideways, and the one cut off at the edge says there's
  // more. The baseline is drawn inside the list, which clips anything outside its box.
  list: {
    position: "relative",
    display: "flex",
    gap: space.s1,
    overflowX: "auto",
    scrollbarWidth: "none",
    scrollPaddingInline: space.s4,
    boxShadow: `inset 0 -1px 0 ${color.border}`,
  },
  tab: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1_5,
    height: control.md,
    paddingInline: space.s2,
    // Room for the indicator, so the label doesn't sit on it.
    marginBottom: "1px",
    borderWidth: 0,
    borderRadius: radius.md,
    backgroundColor: {
      default: "transparent",
      ":hover:not([data-disabled])": { default: null, [HOVER]: color.surfaceHover },
    },
    color: {
      default: color.textMuted,
      ":hover:not([data-disabled])": { default: null, [HOVER]: color.text },
      "[data-active]": color.text,
      "[data-disabled]": color.textSubtle,
    },
    fontFamily: "inherit",
    fontSize: text.base,
    fontWeight: weight.medium,
    whiteSpace: "nowrap",
    cursor: { default: "pointer", "[data-disabled]": "not-allowed" },
    userSelect: "none",
    transitionProperty: "background-color, color",
    transitionDuration: motion.durationFast,
    transitionTimingFunction: motion.easeStandard,
  },
  indicator: {
    position: "absolute",
    left: 0,
    bottom: 0,
    height: "2px",
    width: "var(--active-tab-width)",
    transform: "translateX(var(--active-tab-left))",
    borderRadius: radius.full,
    backgroundColor: color.text,
    transitionProperty: "transform, width",
    transitionDuration: motion.durationMove,
    transitionTimingFunction: motion.easeStandard,
  },
  panel: {
    borderRadius: radius.sm,
  },
})

/** Switches between views of one thing. Arrow keys move between tabs. */
export function Tabs({ children, value, defaultValue, onValueChange, sx }: TabsProps) {
  return (
    <BaseTabs.Root
      {...(value !== undefined && { value })}
      {...(defaultValue !== undefined && { defaultValue })}
      {...(onValueChange && {
        onValueChange: (next: unknown) => {
          if (typeof next === "string") onValueChange(next)
        },
      })}
      {...stylex.props(sx)}
    >
      {children}
    </BaseTabs.Root>
  )
}

export interface TabListProps {
  /** Names the set of tabs for screen readers, e.g. "Session views". */
  label: string
  children: ReactNode
}

export function TabList({ label, children }: TabListProps) {
  return (
    <BaseTabs.List aria-label={label} {...stylex.props(styles.list)}>
      {children}
      <BaseTabs.Indicator {...stylex.props(styles.indicator)} />
    </BaseTabs.List>
  )
}

export interface TabProps {
  value: string
  children: ReactNode
  disabled?: boolean
}

export function Tab({ value, children, disabled = false }: TabProps) {
  // The active tab stays in view in a list that scrolls, without scrolling the page.
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const tab = ref.current
    const list = tab?.parentElement
    if (!tab || !list || !tab.hasAttribute("data-active")) return
    const start = tab.offsetLeft
    const end = start + tab.offsetWidth
    if (start < list.scrollLeft) list.scrollLeft = start
    else if (end > list.scrollLeft + list.clientWidth) list.scrollLeft = end - list.clientWidth
  })
  return (
    <BaseTabs.Tab
      value={value}
      disabled={disabled}
      ref={ref}
      // Inset: the scrolling list would clip a ring drawn outside the tab.
      {...stylex.props(styles.tab, labelIcon, focus.ringInset)}
    >
      {children}
    </BaseTabs.Tab>
  )
}

export interface TabPanelProps {
  value: string
  children: ReactNode
  /** Keep the panel mounted while hidden, e.g. so a terminal keeps its scrollback. */
  keepMounted?: boolean
  sx?: stylex.StyleXStyles
}

export function TabPanel({ value, children, keepMounted = false, sx }: TabPanelProps) {
  return (
    <BaseTabs.Panel
      value={value}
      keepMounted={keepMounted}
      {...stylex.props(styles.panel, focus.ring, sx)}
    >
      {children}
    </BaseTabs.Panel>
  )
}
