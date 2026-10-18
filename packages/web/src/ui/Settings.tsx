import * as stylex from "@stylexjs/stylex"
import {
  Children,
  cloneElement,
  createContext,
  Fragment,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  useContext,
  useId,
} from "react"
import { Button, IconButton } from "./Button.tsx"
import { MoreIcon } from "./icons.tsx"
import { Menu } from "./Menu.tsx"
import { focus, srOnly } from "./shared.ts"
import { color, control, radius, shadow, space, text, weight } from "./tokens.stylex.ts"
import { textRole } from "./type.ts"
import { useDocumentTitle } from "./useDocumentTitle.ts"

// The settings pages' one template (#401): a centered column holding the page's header and its
// sections, so the title, the section headings and the rows share one left edge and the page's
// action ends where its lists end. A section is a heading over one bordered list; a row is a
// thing with at most one action of its own, the rest in its ⋯ menu.

const HOVER = "@media (hover: hover)"
// The column's room, not the window's: a phone, or a column squeezed by the sidebar.
const NARROW = "@container (max-width: 40rem)"
const MOTION_OK = "@media (prefers-reduced-motion: no-preference)"

/** A row's height: as tall as the app's bars, two lines of text, or a Button with room around it. */
const rowHeight = "2.75rem"
/** A row's leading icon, avatar or dot sits in a slot this wide, so the names line up. */
const iconSlot = "1.25rem"

const pulse = stylex.keyframes({
  "0%": { opacity: 1 },
  "50%": { opacity: 0.55 },
  "100%": { opacity: 1 },
})

const styles = stylex.create({
  view: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 },
  scroll: {
    flex: 1,
    overflowY: "auto",
    containerType: "inline-size",
    // A control reached by Tab doesn't land under the apply bar.
    scrollPaddingBlockEnd: "5rem",
  },
  column: {
    // 48rem of content, its gutters outside it.
    boxSizing: "content-box",
    display: "flex",
    flexDirection: "column",
    gap: space.s8,
    maxWidth: "48rem",
    marginInline: "auto",
    paddingBlock: space.s8,
    paddingInline: { default: space.s6, [NARROW]: space.s4 },
  },

  header: { display: "flex", flexDirection: "column", gap: space.s1 },
  // The action shares the title's line while both fit, and wraps under it when they don't.
  titleLine: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space.s3,
    rowGap: space.s2,
    minHeight: control.sm,
  },
  titleGroup: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    flex: "1 1 12rem",
    minWidth: 0,
  },
  // Focus lands on it when the page opens; it isn't a control, so it shows no ring.
  title: { margin: 0, minWidth: 0, overflowWrap: "anywhere", outline: "none" },
  badge: { display: "inline-flex", flexShrink: 0 },
  headerAction: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s2,
    marginInlineStart: "auto",
  },
  description: { margin: 0, maxWidth: "60ch", textWrap: "pretty" },

  section: { display: "flex", flexDirection: "column", gap: space.s3, minWidth: 0 },
  sectionHead: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-end",
    columnGap: space.s3,
    rowGap: space.s2,
  },
  sectionText: {
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
    flex: "1 1 16rem",
    minWidth: 0,
  },
  sectionTitle: { margin: 0 },
  note: { margin: 0, maxWidth: "65ch", textWrap: "pretty" },
  sectionAction: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: space.s2 },

  // Further from the list above it than from its own: space groups it.
  group: { display: "flex", flexDirection: "column", gap: space.s2, paddingTop: space.s2 },
  groupLabel: { margin: 0 },

  list: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
    padding: 0,
    listStyle: "none",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.lg,
    backgroundColor: color.surface,
    overflow: "hidden",
  },
  // Rows under a row, indented to its name, each with a hairline above.
  subList: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
    paddingBlock: 0,
    paddingInlineEnd: 0,
    paddingInlineStart: `calc(${space.s3} + ${iconSlot} + ${space.s3})`,
    listStyle: "none",
  },

  // A hairline between rows: above each but the first, or above every row under a row.
  item: {
    borderTopWidth: { default: "1px", ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: color.border,
  },
  nestedItem: { borderTopWidth: "1px" },

  head: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space.s3,
    rowGap: space.s2,
    minHeight: rowHeight,
    paddingBlock: space.s2,
    paddingInline: space.s3,
    color: color.text,
    textDecoration: "none",
  },
  nestedHead: { paddingInlineStart: 0 },
  // A row that opens its detail, or is a link: the whole row is the target.
  target: {
    cursor: "pointer",
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: color.surfaceHover },
    },
  },
  icon: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    width: iconSlot,
    color: color.textSecondary,
  },
  text: {
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
    flex: "1 1 12rem",
    minWidth: 0,
  },
  name: {
    minWidth: 0,
    fontSize: text.base,
    fontWeight: weight.medium,
    lineHeight: "1.3",
    overflowWrap: "anywhere",
  },
  meta: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space.s1_5,
    rowGap: space.s0_5,
    margin: 0,
    minWidth: 0,
  },
  dot: { color: color.textTertiary },
  badges: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s1_5,
  },
  end: {
    display: "flex",
    alignItems: "center",
    gap: space.s1,
    flexShrink: 0,
    marginInlineStart: "auto",
  },
  detail: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
    paddingBottom: space.s3,
    paddingInlineEnd: space.s3,
    paddingInlineStart: `calc(${space.s3} + ${space.s6})`,
  },
  detailWithIcon: { paddingInlineStart: `calc(${space.s3} + ${iconSlot} + ${space.s3})` },
  nestedDetail: { paddingInlineStart: space.s6 },

  free: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
    paddingBlock: space.s3,
    paddingInline: space.s3,
  },
  freeNested: { paddingInlineStart: 0 },

  property: { containerType: "inline-size" },
  propertyInner: {
    display: "flex",
    flexDirection: { default: "row", "@container (max-width: 30rem)": "column" },
    alignItems: { default: "center", "@container (max-width: 30rem)": "stretch" },
    justifyContent: "space-between",
    columnGap: space.s4,
    rowGap: space.s2,
    minHeight: "3rem",
    paddingBlock: space.s2,
    paddingInline: space.s3,
  },
  propertyBare: { paddingInline: 0 },
  propertyNested: { paddingInlineStart: 0 },
  propertyText: {
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
    flex: "1 1 14rem",
    minWidth: 0,
  },
  propertyLabel: { fontSize: text.base, fontWeight: weight.medium, lineHeight: "1.3" },
  propertyControl: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s2,
    minWidth: 0,
  },

  empty: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space.s4,
    rowGap: space.s3,
    paddingBlock: space.s3,
    paddingInline: space.s3,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.lg,
    backgroundColor: color.surface,
  },
  emptyText: {
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
    flex: "1 1 16rem",
    minWidth: 0,
  },
  emptyTitle: { margin: 0, fontSize: text.base, fontWeight: weight.medium },
  emptyMore: { flexBasis: "100%", minWidth: 0 },

  skeletonRow: {
    display: "flex",
    alignItems: "center",
    gap: space.s3,
    minHeight: rowHeight,
    paddingBlock: space.s2,
    paddingInline: space.s3,
  },
  skeletonText: { display: "flex", flexDirection: "column", gap: space.s1_5, flex: 1 },
  bar: {
    display: "block",
    borderRadius: radius.sm,
    backgroundColor: color.surfaceActive,
    animationName: { default: null, [MOTION_OK]: pulse },
    animationDuration: "1.4s",
    animationTimingFunction: "ease-in-out",
    animationIterationCount: "infinite",
  },
  barDot: { width: "0.75rem", height: "0.75rem", borderRadius: radius.full, flexShrink: 0 },
  barName: { width: "28%", height: "0.625rem" },
  barMeta: { width: "44%", height: "0.5rem" },

  // Floats over the column's foot while the page scrolls under it, inside its edges.
  applyBar: {
    position: "sticky",
    insetBlockEnd: space.s4,
    zIndex: 1,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space.s3,
    rowGap: space.s2,
    paddingBlock: space.s2,
    paddingInlineStart: space.s4,
    paddingInlineEnd: space.s2,
    // The edge is in the shadow; the transparent border is what forced colors draw.
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: radius.lg,
    backgroundColor: color.surfaceRaised,
    boxShadow: shadow.md,
  },
  applyText: {
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
    flex: "1 1 14rem",
    minWidth: 0,
  },
  applyTitle: { fontSize: text.base, fontWeight: weight.medium },
  applyActions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.s2,
    marginInlineStart: "auto",
  },
})

export interface SettingsPageProps {
  /** The page's name, as its h1. */
  title: ReactNode
  /** The page's name in the browser tab, where `title` isn't plain text or needs context. */
  pageTitle?: string
  /** Beside the title: a Badge saying what state the page's thing is in. */
  badge?: ReactNode
  /** One sentence, under 15 words: what the page holds. */
  description?: ReactNode
  /** The page's one primary Button, at the end of the title's line. */
  action?: ReactNode
  /** Its SettingsSections, and Banners above them. */
  children: ReactNode
  /** A StickyApplyBar, for a page that edits a draft. */
  applyBar?: ReactNode
}

/**
 * A settings page: its header and sections in one centered column, 48rem wide, so the title, the
 * section headings and the lists share their left edge, and the action ends where the lists end.
 */
export function SettingsPage({
  title,
  pageTitle,
  badge,
  description,
  action,
  children,
  applyBar,
}: SettingsPageProps) {
  useDocumentTitle(`${pageTitle ?? (typeof title === "string" ? title : "")} · kndl`)
  return (
    <main {...stylex.props(styles.view)}>
      <div {...stylex.props(styles.scroll)}>
        <div {...stylex.props(styles.column)}>
          <header {...stylex.props(styles.header)}>
            <div {...stylex.props(styles.titleLine)}>
              <div {...stylex.props(styles.titleGroup)}>
                <h1 tabIndex={-1} {...stylex.props(textRole.title, styles.title)}>
                  {title}
                </h1>
                {badge && <span {...stylex.props(styles.badge)}>{badge}</span>}
              </div>
              {action && <div {...stylex.props(styles.headerAction)}>{action}</div>}
            </div>
            {description && (
              <p {...stylex.props(textRole.meta, styles.description)}>{description}</p>
            )}
          </header>
          {children}
          {applyBar}
        </div>
      </div>
    </main>
  )
}

export interface SettingsSectionProps {
  /** Its h2: 14px semibold on every page. */
  title: ReactNode
  /** One line under the heading, on what the section holds. */
  note?: ReactNode
  /** A small Button at the end of the heading's line, adding to the section. */
  action?: ReactNode
  children: ReactNode
  sx?: stylex.StyleXStyles
}

/** A part of a settings page: a heading, then its list, its rows or its form. */
export function SettingsSection({ title, note, action, children, sx }: SettingsSectionProps) {
  const id = useId()
  return (
    <section aria-labelledby={id} {...stylex.props(styles.section, sx)}>
      <div {...stylex.props(styles.sectionHead)}>
        <div {...stylex.props(styles.sectionText)}>
          <h2 id={id} {...stylex.props(textRole.heading, styles.sectionTitle)}>
            {title}
          </h2>
          {note && <p {...stylex.props(textRole.meta, styles.note)}>{note}</p>}
        </div>
        {action && <div {...stylex.props(styles.sectionAction)}>{action}</div>}
      </div>
      {children}
    </section>
  )
}

/**
 * A group of rows inside a section, under an overline: Subscriptions and API keys under Connect a
 * Provider. Never a section's own heading.
 */
export function SettingsGroup({ label, children }: { label: string; children: ReactNode }) {
  const id = useId()
  return (
    <div role="group" aria-labelledby={id} {...stylex.props(styles.group)}>
      <h3 id={id} {...stylex.props(textRole.overline, styles.groupLabel)}>
        {label}
      </h3>
      {children}
    </div>
  )
}

/** Where a row is: in a section's list, under another row, or in a row's detail. */
type Place = "list" | "nested" | "detail"
const PlaceContext = createContext<Place>("detail")

/** A section's one bordered list: SettingsRows, PropertyRows and SettingsItems, split by hairlines. */
export function SettingsList({
  label,
  children,
  sx,
}: {
  /** What it lists, for screen readers: "Runners". */
  label: string
  children: ReactNode
  sx?: stylex.StyleXStyles
}) {
  return (
    <PlaceContext value="list">
      <ul aria-label={label} {...stylex.props(styles.list, sx)}>
        {children}
      </ul>
    </PlaceContext>
  )
}

export interface SettingsRowProps {
  /** The row's name for screen readers, plain: "studio". Its ⋯ menu is "Actions for {label}". */
  label: string
  /** A 16px icon, an Avatar or a status dot, in a slot of its own so names line up. */
  icon?: ReactNode
  /** What it is: 13px medium. */
  name: ReactNode
  /** Facts about it, 12px muted on one line: several are joined with " · ". */
  meta?: ReactNode | ReadonlyArray<ReactNode>
  /** Lines under the facts: how an update is going, why something can't be done. */
  notes?: ReactNode
  /** States as Badges: neutral for a kind, coloured only for what needs attention. */
  badges?: ReactNode
  /** At most one Button: the row's next step, such as Update when it's behind. */
  action?: ReactNode
  /** MenuItems for its ⋯ menu: verb and object ("Re-pair studio"), destructive ones last. */
  menu?: ReactNode
  /** Shown under the row, indented, without a border of its own. */
  detail?: ReactNode
  /**
   * A click on the row, outside its controls, toggles its detail. That is for a pointer: put the
   * same in its ⋯ menu, which is the way to it from a keyboard.
   */
  onToggle?: () => void
  /** The row's one target, a link: the whole row renders as it. */
  link?: ReactElement
  /** Rows under this one, indented to its name: an MCP server's Installations. */
  rows?: ReactNode
  /** What `rows` lists, for screen readers. */
  rowsLabel?: string
  ref?: Ref<HTMLLIElement>
  sx?: stylex.StyleXStyles
}

/**
 * A thing in a list: [icon] [name and facts] [badges] [≤1 action] [⋯]. Its detail opens inline
 * under it, and its own rows, if it has any, follow indented.
 */
export function SettingsRow({
  label,
  icon,
  name,
  meta,
  notes,
  badges,
  action,
  menu,
  detail,
  onToggle,
  link,
  rows,
  rowsLabel,
  ref,
  sx,
}: SettingsRowProps) {
  const place = useContext(PlaceContext)
  const nested = place === "nested"
  const facts = Array.isArray(meta) ? joinFacts(meta) : meta
  const content = (
    <>
      {icon !== undefined && <span {...stylex.props(styles.icon)}>{icon}</span>}
      <div {...stylex.props(styles.text)}>
        <span {...stylex.props(styles.name)}>{name}</span>
        {facts !== undefined && facts !== null && facts !== false && (
          <div {...stylex.props(textRole.meta, styles.meta)}>{facts}</div>
        )}
        {notes}
      </div>
      {badges && <div {...stylex.props(styles.badges)}>{badges}</div>}
      {(action || menu) && (
        <div {...stylex.props(styles.end)}>
          {action}
          {menu && (
            <Menu
              align="end"
              trigger={
                <IconButton label={`Actions for ${label}`} size="sm">
                  <MoreIcon />
                </IconButton>
              }
            >
              {menu}
            </Menu>
          )}
        </div>
      )}
    </>
  )
  const headStyles = [styles.head, nested && styles.nestedHead] as const
  const toggle =
    onToggle &&
    ((event: MouseEvent<HTMLDivElement>) => {
      const row = event.currentTarget
      const target = event.target as Element
      // Its controls do their own thing, and what's portaled out of it (a menu, a popover) isn't
      // the row, though React bubbles its clicks here.
      if (!row.contains(target)) return
      const own = target.closest("a, button, input, label, select, textarea")
      if (own !== null && row.contains(own)) return
      // Selecting its text isn't a click on it.
      if (window.getSelection()?.isCollapsed === false) return
      onToggle()
    })
  return (
    <li
      ref={ref}
      aria-label={label}
      {...stylex.props(place !== "detail" && styles.item, nested && styles.nestedItem, sx)}
    >
      {link ? (
        cloneElement(
          link as ReactElement<Record<string, unknown>>,
          stylex.props(...headStyles, styles.target, focus.ringInset),
          content,
        )
      ) : (
        <div onClick={toggle} {...stylex.props(...headStyles, toggle && styles.target)}>
          {content}
        </div>
      )}
      {detail && (
        <PlaceContext value="detail">
          <div
            {...stylex.props(
              styles.detail,
              icon !== undefined && styles.detailWithIcon,
              nested && styles.nestedDetail,
            )}
          >
            {detail}
          </div>
        </PlaceContext>
      )}
      {rows && (
        <PlaceContext value="nested">
          <ul aria-label={rowsLabel} {...stylex.props(styles.subList)}>
            {rows}
          </ul>
        </PlaceContext>
      )}
    </li>
  )
}

/** Facts, with a muted dot between each two; the ones that are false or empty are left out. */
function joinFacts(facts: ReadonlyArray<ReactNode>): ReactNode {
  const shown = facts.filter((fact) => fact !== undefined && fact !== null && fact !== false)
  if (shown.length === 0) return undefined
  return Children.toArray(shown).map((fact, index) => (
    // The facts are a fixed sequence, not a list that reorders.
    // oxlint-disable-next-line react/no-array-index-key
    <Fragment key={index}>
      {index > 0 && (
        <span aria-hidden="true" {...stylex.props(styles.dot)}>
          ·
        </span>
      )}
      <span>{fact}</span>
    </Fragment>
  ))
}

/** A list item that isn't a row: a form, a release's notes, a line of text. */
export function SettingsItem({
  label,
  children,
  sx,
}: {
  label?: string
  children: ReactNode
  sx?: stylex.StyleXStyles
}) {
  const place = useContext(PlaceContext)
  return (
    <li
      {...(label !== undefined && { "aria-label": label })}
      {...stylex.props(
        styles.free,
        place !== "detail" && styles.item,
        place === "nested" && [styles.nestedItem, styles.freeNested],
        sx,
      )}
    >
      {children}
    </li>
  )
}

export interface PropertyRowProps {
  /** What it sets: 13px medium. */
  label: ReactNode
  /** What the choice does, 12px muted. */
  description?: ReactNode
  /**
   * The control, at the row's end. A function gets the label's and the description's ids, for a
   * control that takes its name from them.
   */
  children:
    | ReactNode
    | ((ids: { readonly labelId: string; readonly descriptionId: string | undefined }) => ReactNode)
}

/**
 * One setting: its label and what it does at the start, its control at the end. Under 30rem, the
 * control goes under them. In a SettingsList it's a row; in a detail, a line.
 */
export function PropertyRow({ label, description, children }: PropertyRowProps) {
  const place = useContext(PlaceContext)
  const labelId = useId()
  const descriptionId = useId()
  const inList = place !== "detail"
  const body = (
    <div
      {...stylex.props(
        styles.propertyInner,
        !inList && styles.propertyBare,
        place === "nested" && styles.propertyNested,
      )}
    >
      <div {...stylex.props(styles.propertyText)}>
        <span id={labelId} {...stylex.props(styles.propertyLabel)}>
          {label}
        </span>
        {description && (
          <span id={descriptionId} {...stylex.props(textRole.meta)}>
            {description}
          </span>
        )}
      </div>
      <div {...stylex.props(styles.propertyControl)}>
        {typeof children === "function"
          ? children({ labelId, descriptionId: description ? descriptionId : undefined })
          : children}
      </div>
    </div>
  )
  return inList ? (
    <li {...stylex.props(styles.property, styles.item, place === "nested" && styles.nestedItem)}>
      {body}
    </li>
  ) : (
    <div {...stylex.props(styles.property)}>{body}</div>
  )
}

export interface SettingsEmptyProps {
  /** What's missing, as one line: "No Runners yet". */
  title: ReactNode
  /** One sentence: what goes here, or how to add one. */
  description?: ReactNode
  /** One Button, the way forward. */
  action?: ReactNode
  /** Something to copy, such as the command that adds one. */
  children?: ReactNode
}

/** A section with nothing in it yet: in its list's place, the same shape, not page-size. */
export function SettingsEmpty({ title, description, action, children }: SettingsEmptyProps) {
  return (
    <div {...stylex.props(styles.empty)}>
      <div {...stylex.props(styles.emptyText)}>
        <p {...stylex.props(styles.emptyTitle)}>{title}</p>
        {description && <p {...stylex.props(textRole.meta, styles.note)}>{description}</p>}
      </div>
      {action}
      {children && <div {...stylex.props(styles.emptyMore)}>{children}</div>}
    </div>
  )
}

/**
 * Rows still loading: three skeleton rows at a row's height in a list's frame, so the page
 * doesn't jump when they come. `label` is read out.
 */
export function SettingsLoading({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div role="status" {...stylex.props(styles.list)}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} aria-hidden="true" {...stylex.props(styles.skeletonRow, styles.item)}>
          <span {...stylex.props(styles.bar, styles.barDot)} />
          <span {...stylex.props(styles.skeletonText)}>
            <span {...stylex.props(styles.bar, styles.barName)} />
            <span {...stylex.props(styles.bar, styles.barMeta)} />
          </span>
        </div>
      ))}
      {/* Last, so the first skeleton row is the first child and draws no hairline. */}
      <span {...stylex.props(srOnly.root)}>{label}</span>
    </div>
  )
}

export interface StickyApplyBarProps {
  /** What's waiting: "Unsaved changes". */
  title?: ReactNode
  /** Under the title: what applying needs first, or how a check went. */
  children?: ReactNode
  /** Drops the draft. Left out where there's nothing to go back to. */
  onDiscard?: () => void
  /** A secondary Button before Apply, such as Test build. */
  secondary?: ReactNode
  /** The primary Button that applies the draft. */
  apply: ReactNode
}

/**
 * A form's save, in view wherever the page is scrolled to: shown while the draft differs from
 * what's saved, floating over the foot of the column. Pass it to SettingsPage as `applyBar`.
 */
export function StickyApplyBar({
  title = "Unsaved changes",
  children,
  onDiscard,
  secondary,
  apply,
}: StickyApplyBarProps) {
  const id = useId()
  return (
    <div role="group" aria-labelledby={id} {...stylex.props(styles.applyBar)}>
      <div {...stylex.props(styles.applyText)}>
        <span id={id} {...stylex.props(styles.applyTitle)}>
          {title}
        </span>
        {children}
      </div>
      <div {...stylex.props(styles.applyActions)}>
        {onDiscard && (
          <Button intent="ghost" onClick={onDiscard}>
            Discard
          </Button>
        )}
        {secondary}
        {apply}
      </div>
    </div>
  )
}
