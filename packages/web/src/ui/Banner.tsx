import * as stylex from "@stylexjs/stylex"
import type { ReactNode } from "react"
import { color, leading, radius, space, text, weight } from "./tokens.stylex.ts"

/**
 * - `neutral`: information. The accent stays off Banners: it marks the one primary action and
 *   where you are, and a tint of it reads too close to a warning.
 * - `warning`, `danger`: something is wrong or about to be.
 * - `frozen`, `asleep`: a Session in that state, in the same colours as its SessionStatus.
 */
export type BannerIntent = "neutral" | "warning" | "danger" | "frozen" | "asleep"

export interface BannerProps {
  title: ReactNode
  /** One or two sentences: what it means and what happens next. */
  children?: ReactNode
  intent?: BannerIntent
  icon?: ReactNode
  /** A button that deals with it. */
  action?: ReactNode
  /** More to show under the description, such as a Disclosure with a log: block content. */
  detail?: ReactNode
  /** One line where it fits: the title and its description run on, for notices across the app. */
  slim?: boolean
  sx?: stylex.StyleXStyles
}

// The Banner's own width, not the viewport's: under it, the action moves under the text.
const NARROW = "@container (width < 28rem)"

const styles = stylex.create({
  root: {
    containerType: "inline-size",
    borderWidth: "1px",
    borderStyle: "solid",
    borderRadius: radius.lg,
    fontSize: text.sm,
    lineHeight: leading.snug,
  },
  // Icon, text and action in columns, so a wrapped action lines up with the text, not the edge.
  grid: {
    display: "grid",
    alignItems: "start",
    columnGap: space.s3,
    rowGap: space.s2,
    paddingBlock: space.s2_5,
    paddingInline: space.s3,
  },
  // One line where there's room, centred on its action; narrow, it wraps from the top.
  slim: { paddingBlock: space.s1_5, alignItems: { default: "center", [NARROW]: "start" } },
  slimIcon: { paddingTop: { default: 0, [NARROW]: "0.125rem" } },
  columns: (template: string) => ({ gridTemplateColumns: template }),
  icon: {
    display: "inline-flex",
    paddingTop: "0.125rem",
  },
  body: {
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
    minWidth: 0,
  },
  title: { fontWeight: weight.semibold, textWrap: "balance" },
  description: { color: color.text, opacity: 0.85, textWrap: "pretty" },
  // Slim: the title and its description run on as one line.
  slimLine: { textWrap: "pretty" },
  slimDescription: { opacity: 0.85 },
  detail: { marginTop: space.s1_5, minWidth: 0 },
  action: {
    display: "flex",
    alignItems: "center",
    alignSelf: { default: "center", [NARROW]: "start" },
    gridRow: { default: "auto", [NARROW]: "2" },
  },
  // Narrow, the action sits under the text: in the text's column, beside an icon.
  actionUnderText: { gridColumn: { default: "auto", [NARROW]: "2" } },
  actionUnderTextNoIcon: { gridColumn: { default: "auto", [NARROW]: "1" } },
  // Beside a detail that can open, it stays by the title rather than moving with the detail.
  actionTop: { alignSelf: "start" },
})

const intents = stylex.create({
  neutral: {
    backgroundColor: color.surfaceMuted,
    borderColor: color.border,
    color: color.text,
  },
  warning: {
    backgroundColor: color.warningTint,
    borderColor: "transparent",
    color: color.warningText,
  },
  danger: {
    backgroundColor: color.dangerTint,
    borderColor: "transparent",
    color: color.dangerText,
  },
  frozen: {
    backgroundColor: color.sessionFrozenTint,
    borderColor: "transparent",
    color: color.sessionFrozenText,
  },
  asleep: {
    backgroundColor: color.sessionAsleepTint,
    borderColor: "transparent",
    color: color.sessionAsleepText,
  },
})

/**
 * A strip across a view that says what state it's in, such as a Frozen Session's. It isn't a live
 * region: a page's state is read with the page, and the app announces what changes on its own.
 */
export function Banner({
  title,
  children,
  intent = "neutral",
  icon,
  action,
  detail,
  slim = false,
  sx,
}: BannerProps) {
  const columns = [icon && "auto", "minmax(0, 1fr)", action && "auto"].filter(Boolean).join(" ")
  return (
    <div data-banner="" {...stylex.props(styles.root, intents[intent], sx)}>
      <div {...stylex.props(styles.grid, slim && styles.slim, styles.columns(columns))}>
        {icon && (
          <span aria-hidden="true" {...stylex.props(styles.icon, slim && styles.slimIcon)}>
            {icon}
          </span>
        )}
        <div {...stylex.props(styles.body)}>
          {slim ? (
            <p {...stylex.props(styles.slimLine)}>
              <span {...stylex.props(styles.title)}>{title}</span>
              {children && (
                <>
                  {" "}
                  <span {...stylex.props(styles.slimDescription)}>{children}</span>
                </>
              )}
            </p>
          ) : (
            <>
              <p {...stylex.props(styles.title)}>{title}</p>
              {children && <p {...stylex.props(styles.description)}>{children}</p>}
            </>
          )}
          {detail && <div {...stylex.props(styles.detail)}>{detail}</div>}
        </div>
        {action && (
          <div
            {...stylex.props(
              styles.action,
              icon ? styles.actionUnderText : styles.actionUnderTextNoIcon,
              Boolean(detail) && styles.actionTop,
            )}
          >
            {action}
          </div>
        )}
      </div>
    </div>
  )
}
