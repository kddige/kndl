import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import * as stylex from "@stylexjs/stylex"
import { type ReactElement, type ReactNode, useId } from "react"
import { navRow } from "./markers.stylex.ts"
import { focus } from "./shared.ts"
import { chrome, color, control, leading, radius, space, text, weight } from "./tokens.stylex.ts"

const TOUCH = "@media (pointer: coarse)"

// The action's room at the end of a row: its button and a little gap.
const ACTION_ROOM = `calc(${control.sm} + ${space.s1})`

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
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
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
  // The row a NavItem's link and action share, so the action can sit over the link's end.
  row: { position: "relative" },
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
  // Room for the action while it shows, so the label is cut short before it.
  itemWithAction: {
    paddingInlineEnd: {
      default: space.s2,
      [stylex.when.ancestor(":hover", navRow)]: ACTION_ROOM,
      [stylex.when.ancestor(":focus-within", navRow)]: ACTION_ROOM,
    },
  },
  itemWithActionShown: { paddingInlineEnd: ACTION_ROOM },
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
  // In place of the link while editing: the field is what's live, so the row doesn't change on hover.
  editing: {
    paddingInlineEnd: space.s0_5,
    color: { default: color.text, ":hover": color.text },
    backgroundColor: { default: "transparent", ":hover": "transparent" },
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
  // Over the end of the row, shown while the row is hovered or holds focus. Hidden, it takes no
  // pointer, so a tap there still follows the link.
  action: {
    position: "absolute",
    insetInlineEnd: space.s0_5,
    top: "50%",
    display: "inline-flex",
    transform: "translateY(-50%)",
    opacity: {
      default: 0,
      [stylex.when.ancestor(":hover", navRow)]: 1,
      [stylex.when.ancestor(":focus-within", navRow)]: 1,
    },
    pointerEvents: {
      default: "none",
      [stylex.when.ancestor(":hover", navRow)]: "auto",
      [stylex.when.ancestor(":focus-within", navRow)]: "auto",
    },
  },
  actionShown: { opacity: 1, pointerEvents: "auto" },
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
  /**
   * A short heading over the section, such as a Repo's `owner/name`; cut short when too long, with
   * the whole of it as a tooltip. Omit it for the top section.
   */
  label?: string
  /** NavItems. */
  children: ReactNode
}

/** A list of NavItems, under a heading that also names it for screen readers. */
export function NavSection({ label, children }: NavSectionProps) {
  const id = useId()
  return (
    <div {...stylex.props(styles.section)}>
      {label && (
        <div id={id} title={label} {...stylex.props(styles.sectionLabel)}>
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
  /**
   * A small IconButton over the end of the row, apart from the link, such as Rename. It shows
   * while the row is hovered or holds focus, and always on the current item.
   */
  action?: ReactNode
  /** Shown in place of the link and the action while set, such as an InlineEdit: the icon stays. */
  editor?: ReactNode
}

/**
 * One destination in a NavSection: a link with an icon, a label and indicators, and perhaps an
 * action of its own beside the link.
 */
export function NavItem({
  render,
  children,
  icon,
  current = false,
  trailing,
  title,
  action,
  editor,
}: NavItemProps) {
  const iconSlot = icon && <span {...stylex.props(styles.slot)}>{icon}</span>
  const link = useRender({
    defaultTagName: "a",
    render,
    props: mergeProps<"a">(
      {
        ...stylex.props(
          styles.item,
          action !== undefined && (current ? styles.itemWithActionShown : styles.itemWithAction),
          current && styles.current,
          focus.ringInset,
        ),
        ...(current && { "aria-current": "page" }),
        ...(title !== undefined && { title }),
      },
      {
        children: (
          <>
            {iconSlot}
            <span {...stylex.props(styles.label)}>{children}</span>
            {trailing && <span {...stylex.props(styles.trailing)}>{trailing}</span>}
          </>
        ),
      },
    ),
  })
  if (editor !== undefined) {
    return (
      <li>
        <div {...stylex.props(styles.item, styles.editing)}>
          {iconSlot}
          {editor}
        </div>
      </li>
    )
  }
  return (
    <li>
      <div {...stylex.props(styles.row, navRow)}>
        {link}
        {action !== undefined && (
          <span {...stylex.props(styles.action, current && styles.actionShown)}>{action}</span>
        )}
      </div>
    </li>
  )
}

/** A 16px slot in a NavItem's trailing rail, so indicators line up from row to row. */
export function NavSlot({ children }: { children: ReactNode }) {
  return <span {...stylex.props(styles.slot)}>{children}</span>
}
