import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import * as stylex from "@stylexjs/stylex"
import {
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useRef,
} from "react"
import { IconButton } from "./Button.tsx"
import { ChevronRightIcon } from "./icons.tsx"
import { navRow } from "./markers.stylex.ts"
import { ContextMenu } from "./Menu.tsx"
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

const TOUCH = "@media (pointer: coarse)"

// The action's room at the end of a row: its button and a little gap.
const ACTION_ROOM = `calc(${control.sm} + ${space.s1})`
// The room for both a nested list's toggle and the action beside it.
const TOGGLE_AND_ACTION_ROOM = `calc(${control.sm} * 2 + ${space.s1} + ${space.s0_5})`
// How far a nested list is indented: its rows' dots line up under the label above them.
const NESTED_INDENT = `calc(1rem + ${space.s2})`

// Hover styles only where a pointer can hover: on touch, :hover sticks after a tap.
const HOVER = "@media (hover: hover)"

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
  landmark: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 },
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
    // A shade at an edge only while there's more past it: two covers in the Sidebar's own fill
    // scroll with the list and hide the shades, which stay put.
    backgroundColor: color.surface,
    backgroundImage: [
      `linear-gradient(${color.surface} 30%, transparent)`,
      `linear-gradient(transparent, ${color.surface} 70%)`,
      `radial-gradient(farthest-side at 50% 0, ${color.borderStrong}, transparent)`,
      `radial-gradient(farthest-side at 50% 100%, ${color.borderStrong}, transparent)`,
    ].join(", "),
    backgroundPosition: "0 0, 0 100%, 0 0, 0 100%",
    backgroundSize: "100% 2.5rem, 100% 2.5rem, 100% 0.75rem, 100% 0.75rem",
    backgroundRepeat: "no-repeat",
    backgroundAttachment: "local, local, scroll, scroll",
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
  aboveFooter: { flexShrink: 0, paddingBlock: space.s1, paddingInline: space.s2 },
  section: { display: "flex", flexDirection: "column" },
  labelRow: { display: "flex", alignItems: "center", gap: space.s1, paddingInlineEnd: space.s0_5 },
  labelGrow: { flex: 1, minWidth: 0 },
  sectionLabel: {
    paddingTop: space.s1,
    paddingBottom: space.s1,
    paddingInline: space.s2,
    fontSize: text.xs,
    fontWeight: weight.medium,
    color: color.textSecondary,
    overflowWrap: "anywhere",
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
    color: { default: color.textSecondary, ":hover": { default: null, [HOVER]: color.text } },
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: color.surfaceHover },
    },
    textDecoration: "none",
  },
  // Room for the action while it shows, so the label is cut short before it.
  itemWithAction: {
    paddingInlineEnd: {
      default: space.s2,
      [stylex.when.ancestor(":hover", navRow)]: { default: null, [HOVER]: ACTION_ROOM },
      [stylex.when.ancestor(":focus-within", navRow)]: ACTION_ROOM,
    },
  },
  itemWithActionShown: { paddingInlineEnd: ACTION_ROOM },
  // With a nested list, its toggle always has room at the end, and the action before it.
  itemWithToggle: { paddingInlineEnd: ACTION_ROOM },
  itemWithToggleAndAction: {
    paddingInlineEnd: {
      default: ACTION_ROOM,
      [stylex.when.ancestor(":hover", navRow)]: { default: null, [HOVER]: TOGGLE_AND_ACTION_ROOM },
      [stylex.when.ancestor(":focus-within", navRow)]: TOGGLE_AND_ACTION_ROOM,
    },
  },
  itemWithToggleAndActionShown: { paddingInlineEnd: TOGGLE_AND_ACTION_ROOM },
  // Not by colour alone: a bar at the start and a heavier label as well as the fill.
  current: {
    color: { default: color.text, ":hover": { default: null, [HOVER]: color.text } },
    backgroundColor: {
      default: color.surfaceActive,
      ":hover": { default: null, [HOVER]: color.surfaceActive },
    },
    fontWeight: weight.medium,
    "::before": {
      content: "''",
      position: "absolute",
      insetInlineStart: 0,
      top: space.s1_5,
      bottom: space.s1_5,
      // A border, not a fill, so forced colors keep the bar.
      width: 0,
      borderInlineStartWidth: "2px",
      borderInlineStartStyle: "solid",
      borderInlineStartColor: color.accent,
      borderRadius: radius.full,
    },
  },
  // In place of the link while editing: the field is what's live, so the row doesn't change on hover.
  editing: {
    paddingInlineEnd: space.s0_5,
    color: { default: color.text, ":hover": { default: null, [HOVER]: color.text } },
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: "transparent" },
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
    color: color.textTertiary,
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
      [stylex.when.ancestor(":hover", navRow)]: { default: null, [HOVER]: 1 },
      [stylex.when.ancestor(":focus-within", navRow)]: 1,
    },
    pointerEvents: {
      default: "none",
      [stylex.when.ancestor(":hover", navRow)]: { default: null, [HOVER]: "auto" },
      [stylex.when.ancestor(":focus-within", navRow)]: "auto",
    },
  },
  actionShown: { opacity: 1, pointerEvents: "auto" },
  actionBesideToggle: { insetInlineEnd: `calc(${space.s0_5} * 2 + ${control.sm})` },
  // A nested list's toggle, at the very end of the row and always shown.
  toggle: {
    position: "absolute",
    insetInlineEnd: space.s0_5,
    top: "50%",
    display: "inline-flex",
    transform: "translateY(-50%)",
  },
  chevron: {
    color: color.textTertiary,
    // Closed, it points to the inline end, whichever way the page reads.
    transform: { default: "none", ":dir(rtl)": "scaleX(-1)" },
    transitionProperty: "transform",
    transitionDuration: motion.durationMove,
    transitionTimingFunction: motion.easeStandard,
  },
  chevronOpen: { transform: "rotate(90deg)" },
  nested: {
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
    margin: 0,
    paddingTop: space.s0_5,
    paddingInlineStart: NESTED_INDENT,
    paddingInlineEnd: 0,
    paddingBottom: 0,
    listStyle: "none",
  },
})

export interface SidebarProps {
  /** Names the navigation for screen readers. */
  label: string
  /** The top row: the brand, and an action such as "New Session". */
  header?: ReactNode
  /** NavSections. */
  children: ReactNode
  /** A quiet line pinned just above the footer, such as the version. */
  aboveFooter?: ReactNode
  /** Ambient status and the account, pinned to the bottom. */
  footer?: ReactNode
  sx?: stylex.StyleXStyles
}

/**
 * The app's navigation column: a header, NavSections that scroll, and a footer. It fills its
 * container's height; the page decides how wide it is and whether it's a drawer.
 */
export function Sidebar({ label, header, children, aboveFooter, footer, sx }: SidebarProps) {
  return (
    <div {...stylex.props(styles.sidebar, sx)}>
      {header && <div {...stylex.props(styles.header)}>{header}</div>}
      {/* One landmark for every link: the list that scrolls, and the rows pinned under it. */}
      <nav aria-label={label} {...stylex.props(styles.landmark)}>
        <div {...stylex.props(styles.nav)}>{children}</div>
        {aboveFooter && <div {...stylex.props(styles.aboveFooter)}>{aboveFooter}</div>}
      </nav>
      {footer && <div {...stylex.props(styles.footer)}>{footer}</div>}
    </div>
  )
}

export interface NavSectionProps {
  /**
   * A short heading over the section, such as a Repo's `owner/name`, wrapping when too long. Omit
   * it for the top section.
   */
  label?: string
  /** A control at the end of the label's row, such as a Repo's ⋯ menu. */
  action?: ReactNode
  /** NavItems. */
  children: ReactNode
}

/** A list of NavItems, under a heading that also names it for screen readers. */
export function NavSection({ label, action, children }: NavSectionProps) {
  const id = useId()
  const heading = label && (
    <h2 id={id} {...stylex.props(styles.sectionLabel, action !== undefined && styles.labelGrow)}>
      {label}
    </h2>
  )
  return (
    <div {...stylex.props(styles.section)}>
      {heading && action !== undefined ? (
        <div {...stylex.props(styles.labelRow)}>
          {heading}
          {action}
        </div>
      ) : (
        heading
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
  /** Items for a menu on the row's right-click, Shift+F10 and Menu key; repeat them in `action`. */
  contextMenu?: ReactNode
  /** F2 on the row: rename it in place, as the file managers do. */
  onRename?: () => void
  /** Shown in place of the link and the action while set, such as an InlineEdit: the icon stays. */
  editor?: ReactNode
  /**
   * NavItems nested under this one, such as a Session's subagents: indented under its row,
   * which gets a chevron button at its end that shows and hides them. Only that button folds
   * them; the link still leads to the item.
   */
  nested?: NestedNavItems
}

export interface NestedNavItems {
  /** The NavItems. */
  children: ReactNode
  /** Whether they show. */
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Names the chevron button, such as "Agents of Release 0.4"; it says if they show. */
  label: string
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
  contextMenu,
  onRename,
  editor,
  nested,
}: NavItemProps) {
  const nestedId = useId()
  const iconSlot = icon && <span {...stylex.props(styles.slot)}>{icon}</span>
  // Where you are is never hidden past the list's edge: the current row scrolls into view.
  const linkRef = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    if (current) linkRef.current?.scrollIntoView?.({ block: "nearest" })
  }, [current])
  const link = useRender({
    defaultTagName: "a",
    render,
    ref: linkRef,
    props: mergeProps<"a">(
      {
        ...stylex.props(
          styles.item,
          nested === undefined
            ? action !== undefined && (current ? styles.itemWithActionShown : styles.itemWithAction)
            : action === undefined
              ? styles.itemWithToggle
              : current
                ? styles.itemWithToggleAndActionShown
                : styles.itemWithToggleAndAction,
          current && styles.current,
          focus.ringInset,
        ),
        ...(current && { "aria-current": "page" }),
        ...(title !== undefined && { title }),
        ...(onRename && {
          onKeyDown: (event: KeyboardEvent<HTMLAnchorElement>) => {
            if (event.key !== "F2") return
            event.preventDefault()
            onRename()
          },
        }),
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
  // The list is there while folded too, empty, for the chevron's aria-controls.
  const nestedList = nested && (
    <ul id={nestedId} hidden={!nested.open} {...stylex.props(styles.nested)}>
      {nested.open && nested.children}
    </ul>
  )
  if (editor !== undefined) {
    return (
      <li>
        <div {...stylex.props(styles.item, styles.editing)}>
          {iconSlot}
          {editor}
        </div>
        {nestedList}
      </li>
    )
  }
  const row = (
    <div {...stylex.props(styles.row, navRow)}>
      {link}
      {action !== undefined && (
        <span
          {...stylex.props(
            styles.action,
            current && styles.actionShown,
            nested && styles.actionBesideToggle,
          )}
        >
          {action}
        </span>
      )}
      {nested && (
        <span {...stylex.props(styles.toggle)}>
          <IconButton
            label={nested.label}
            size="sm"
            aria-expanded={nested.open}
            aria-controls={nestedId}
            onClick={() => nested.onOpenChange(!nested.open)}
          >
            <ChevronRightIcon
              {...stylex.props(styles.chevron, nested.open && styles.chevronOpen)}
            />
          </IconButton>
        </span>
      )}
    </div>
  )
  return (
    <li>
      {contextMenu === undefined ? row : <ContextMenu trigger={row}>{contextMenu}</ContextMenu>}
      {nestedList}
    </li>
  )
}

/** A 16px slot in a NavItem's trailing rail, so indicators line up from row to row. */
export function NavSlot({ children }: { children: ReactNode }) {
  return <span {...stylex.props(styles.slot)}>{children}</span>
}
