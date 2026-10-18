/**
 * The type roles: each pairs a size with its weight, line height and tracking, so a heading is
 * the same heading on every screen. Set text with a role, not with bare `text.*` sizes.
 *
 * Headings descend: a page's `title`, then `heading` for its sections, then `subheading`.
 * `overline` labels a group; `meta` is the small print: times, counts, versions.
 */
import * as stylex from "@stylexjs/stylex"
import { color, leading, text, tracking, weight } from "./tokens.stylex.ts"

export const textRole = stylex.create({
  /** A page's or a dialog's title: 16px semibold. */
  title: {
    fontSize: text.lg,
    fontWeight: weight.semibold,
    lineHeight: leading.tight,
    letterSpacing: tracking.tight,
  },
  /** A section of a page: 14px semibold. */
  heading: {
    fontSize: text.md,
    fontWeight: weight.semibold,
    lineHeight: "1.3",
  },
  /** A part of a section, or a card's name: 13px semibold. */
  subheading: {
    fontSize: text.base,
    fontWeight: weight.semibold,
    lineHeight: "1.3",
  },
  /** A group's label, above its rows: 11px uppercase, muted. */
  overline: {
    fontSize: text.xs,
    fontWeight: weight.medium,
    lineHeight: leading.tight,
    letterSpacing: tracking.wide,
    textTransform: "uppercase",
    color: color.textSecondary,
    fontVariantNumeric: "tabular-nums",
  },
  /** Running text and controls: 13px. */
  body: {
    fontSize: text.base,
    fontWeight: weight.normal,
    lineHeight: leading.normal,
  },
  /** Times, counts, versions: 12px muted, with figures that don't jitter as they change. */
  meta: {
    fontSize: text.sm,
    fontWeight: weight.normal,
    lineHeight: leading.snug,
    color: color.textSecondary,
    fontVariantNumeric: "tabular-nums",
  },
})
