import { Collapsible } from "@base-ui/react/collapsible"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import * as stylex from "@stylexjs/stylex"
import { type ReactElement, type ReactNode, useId, useState } from "react"
import { ChevronRightIcon } from "./icons.tsx"
import { focus } from "./shared.ts"
import {
  chrome,
  color,
  control,
  leading,
  motion,
  radius,
  space,
  text,
  weight,
} from "./tokens.stylex.ts"
import { Tooltip } from "./Tooltip.tsx"

const TOUCH = "@media (pointer: coarse)"

const styles = stylex.create({
  sidebar: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minWidth: 0,
    backgroundColor: color.surface,
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    flexShrink: 0,
    height: chrome.barHeight,
    paddingInlineStart: space.s4,
    paddingInlineEnd: space.s2,
  },
  nav: {
    display: "flex",
    flexDirection: "column",
    gap: space.s4,
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    overscrollBehavior: "contain",
    paddingBlock: space.s2,
    paddingInline: space.s2,
  },
  footer: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    flexShrink: 0,
    padding: space.s2,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: color.border,
  },
  section: { display: "flex", flexDirection: "column" },
  sectionLabel: {
    paddingTop: space.s1,
    paddingBottom: space.s1,
    paddingInline: space.s2,
    fontSize: text.xs,
    fontWeight: weight.medium,
    color: color.textSubtle,
    userSelect: "none",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  item: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    minHeight: { default: "1.75rem", [TOUCH]: "2.25rem" },
    paddingInline: space.s2,
    borderRadius: radius.md,
    fontSize: text.base,
    lineHeight: leading.tight,
    color: { default: color.textMuted, ":hover": color.text },
    backgroundColor: { default: "transparent", ":hover": color.surfaceHover },
    textDecoration: "none",
  },
  // Not by colour alone: a bar at the start and a heavier label as well as the fill.
  current: {
    color: { default: color.text, ":hover": color.text },
    backgroundColor: { default: color.surfaceActive, ":hover": color.surfaceActive },
    fontWeight: weight.medium,
    "::before": {
      content: "''",
      position: "absolute",
      insetInlineStart: 0,
      top: space.s1_5,
      bottom: space.s1_5,
      width: "2px",
      borderRadius: radius.full,
      backgroundColor: color.accent,
    },
  },
  // A 16px slot, so icons, chevrons and status dots line up down the sidebar.
  slot: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    width: "1rem",
    height: "1rem",
  },
  label: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  trailing: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    flexShrink: 0,
    color: color.textSubtle,
  },
  groupHeader: {
    display: "flex",
    alignItems: "center",
    gap: space.s0_5,
    borderRadius: radius.md,
    backgroundColor: { default: "transparent", ":hover": color.surfaceHover },
  },
  toggle: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    flex: 1,
    minWidth: 0,
    minHeight: { default: "1.75rem", [TOUCH]: "2.25rem" },
    paddingInline: space.s2,
    borderWidth: 0,
    borderRadius: radius.md,
    backgroundColor: "transparent",
    color: color.text,
    fontSize: text.base,
    fontWeight: weight.medium,
    lineHeight: leading.tight,
    textAlign: "start",
    cursor: "pointer",
  },
  chevron: {
    color: color.textSubtle,
    transitionProperty: "transform",
    transitionDuration: motion.durationFast,
    transitionTimingFunction: motion.easeStandard,
  },
  chevronOpen: { transform: "rotate(90deg)" },
  groupAction: {
    display: "inline-flex",
    flexShrink: 0,
    paddingInlineEnd: space.s1,
  },
  panel: {
    overflow: "hidden",
    height: {
      default: "var(--collapsible-panel-height)",
      "[data-starting-style]": 0,
      "[data-ending-style]": 0,
    },
    transitionProperty: "height",
    transitionDuration: motion.durationNormal,
    transitionTimingFunction: motion.easeOut,
  },
  // Under the Repo's name, past the chevron's slot: one level of nesting, plainly.
  groupList: {
    paddingTop: space.s0_5,
    paddingInlineStart: space.s6,
  },
  // For the small icon links a group header carries, like "Open on GitHub".
  iconLink: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: control.sm,
    height: control.sm,
    borderRadius: radius.sm,
    color: { default: color.textSubtle, ":hover": color.text },
    backgroundColor: { default: "transparent", ":hover": color.surfaceActive },
  },
})

export interface SidebarProps {
  /** Names the navigation for screen readers. */
  label: string
  /** The top row: the brand, and an action such as "New Session". */
  header?: ReactNode
  /** NavSections. */
  children: ReactNode
  /** Ambient status and the account, pinned to the bottom. */
  footer?: ReactNode
  sx?: stylex.StyleXStyles
}

/**
 * The app's navigation column: a header, NavSections that scroll, and a footer. It fills its
 * container's height; the page decides how wide it is and whether it's a drawer.
 */
export function Sidebar({ label, header, children, footer, sx }: SidebarProps) {
  return (
    <div {...stylex.props(styles.sidebar, sx)}>
      {header && <div {...stylex.props(styles.header)}>{header}</div>}
      <nav aria-label={label} {...stylex.props(styles.nav)}>
        {children}
      </nav>
      {footer && <div {...stylex.props(styles.footer)}>{footer}</div>}
    </div>
  )
}

export interface NavSectionProps {
  /** A short heading over the section, such as "Sessions". Omit it for the top section. */
  label?: string
  /** NavItems and NavGroups. */
  children: ReactNode
}

/** A list of NavItems and NavGroups, under a heading that also names it for screen readers. */
export function NavSection({ label, children }: NavSectionProps) {
  const id = useId()
  return (
    <div {...stylex.props(styles.section)}>
      {label && (
        <div id={id} {...stylex.props(styles.sectionLabel)}>
          {label}
        </div>
      )}
      <ul {...(label && { "aria-labelledby": id })} {...stylex.props(styles.list)}>
        {children}
      </ul>
    </div>
  )
}

export interface NavItemProps {
  /** The link, usually a router Link; the item fills in its content and styles. */
  render: ReactElement
  /** The label: one or two words, or a name that may be truncated. */
  children: ReactNode
  /** A leading 16px icon or status dot. */
  icon?: ReactNode
  /** This item leads to the page being shown: `aria-current="page"`, and marked to the eye. */
  current?: boolean
  /** Indicators at the end, such as a Spinner: each in a 16px slot. */
  trailing?: ReactNode
  /** The full label as a native tooltip, for labels that may be truncated. */
  title?: string
}

/** One destination in a NavSection or NavGroup: a link with an icon, a label and indicators. */
export function NavItem({
  render,
  children,
  icon,
  current = false,
  trailing,
  title,
}: NavItemProps) {
  const link = useRender({
    defaultTagName: "a",
    render,
    props: mergeProps<"a">(
      {
        ...stylex.props(styles.item, current && styles.current, focus.ringInset),
        ...(current && { "aria-current": "page" }),
        ...(title !== undefined && { title }),
      },
      {
        children: (
          <>
            {icon && <span {...stylex.props(styles.slot)}>{icon}</span>}
            <span {...stylex.props(styles.label)}>{children}</span>
            {trailing && <span {...stylex.props(styles.trailing)}>{trailing}</span>}
          </>
        ),
      },
    ),
  })
  return <li>{link}</li>
}

/** A 16px slot in a NavItem's trailing rail, so indicators line up from row to row. */
export function NavSlot({ children }: { children: ReactNode }) {
  return <span {...stylex.props(styles.slot)}>{children}</span>
}

export interface NavGroupProps {
  /** The group's name; its header toggles it open and closed. */
  label: ReactNode
  /** NavItems. */
  children: ReactNode
  /** Open unless set; controlled when `open` is given. */
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** A control at the end of the header, separate from the toggle, such as a NavIconLink. */
  action?: ReactNode
}

/**
 * A collapsible group of NavItems, such as a Repo's Sessions. The header is a disclosure button
 * (`aria-expanded`, `aria-controls`); several groups can be open at once.
 */
export function NavGroup({
  label,
  children,
  defaultOpen = true,
  open,
  onOpenChange,
  action,
}: NavGroupProps) {
  const [ownOpen, setOwnOpen] = useState(defaultOpen)
  const isOpen = open ?? ownOpen
  return (
    <Collapsible.Root
      render={<li />}
      open={isOpen}
      onOpenChange={(next: boolean) => {
        setOwnOpen(next)
        onOpenChange?.(next)
      }}
    >
      <div {...stylex.props(styles.groupHeader)}>
        <Collapsible.Trigger {...stylex.props(styles.toggle, focus.ringInset)}>
          <span {...stylex.props(styles.slot)}>
            <ChevronRightIcon {...stylex.props(styles.chevron, isOpen && styles.chevronOpen)} />
          </span>
          <span {...stylex.props(styles.label)}>{label}</span>
        </Collapsible.Trigger>
        {action && <span {...stylex.props(styles.groupAction)}>{action}</span>}
      </div>
      <Collapsible.Panel
        render={<ul />}
        {...stylex.props(styles.panel, styles.list, styles.groupList)}
      >
        {children}
      </Collapsible.Panel>
    </Collapsible.Root>
  )
}

export interface NavIconLinkProps {
  /** Where it goes. Opens in a new tab: it leaves the app. */
  href: string
  /** What it does, as its accessible name and tooltip: "Open kddige/claude-hub on GitHub". */
  label: string
  /** The 16px icon. */
  children: ReactNode
}

/** A small icon link to somewhere outside the app, for a NavGroup's header. */
export function NavIconLink({ href, label, children }: NavIconLinkProps) {
  return (
    <Tooltip content={label}>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        aria-label={label}
        {...stylex.props(styles.iconLink, focus.ringInset)}
      >
        {children}
      </a>
    </Tooltip>
  )
}
