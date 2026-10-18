/**
 * Styles more than one component uses: the focus ring, and everything about floating surfaces
 * (Menu, Popover, Select, Tooltip): the panel, its motion, and the rows of list-like popups.
 *
 * Base UI sets data-starting-style and data-ending-style for a frame around mount and unmount,
 * and --transform-origin on the popup, so a CSS transition is all the motion needs.
 */
import * as stylex from "@stylexjs/stylex"
import {
  color,
  layer,
  leading,
  motion,
  radius,
  shadow,
  space,
  text,
  weight,
} from "./tokens.stylex.ts"

export const focus = stylex.create({
  /** The one focus ring: keyboard focus only, never on click. */
  ring: {
    outlineStyle: { default: "none", ":focus-visible": "solid" },
    outlineWidth: "2px",
    outlineColor: color.focus,
    outlineOffset: "2px",
  },
  /** For fields, whose border already frames them: the ring hugs the border. */
  ringInset: {
    outlineStyle: { default: "none", ":focus-visible": "solid" },
    outlineWidth: "2px",
    outlineColor: color.focus,
    outlineOffset: "-1px",
  },
})

export const popup = stylex.create({
  positioner: {
    zIndex: layer.popover,
    outline: "none",
  },
  surface: {
    boxSizing: "border-box",
    backgroundColor: color.surfaceRaised,
    color: color.text,
    // The edge is in the shadow; the transparent border is what forced colors draw.
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: radius.lg,
    boxShadow: shadow.md,
    outline: "none",
    transformOrigin: "var(--transform-origin)",
    opacity: { default: 1, "[data-starting-style]": 0, "[data-ending-style]": 0 },
    transform: {
      default: "none",
      "[data-starting-style]": `scale(${motion.enterScale})`,
      "[data-ending-style]": `scale(${motion.enterScale})`,
    },
    transitionProperty: "opacity, transform",
    transitionDuration: {
      default: motion.durationNormal,
      "[data-ending-style]": motion.durationFast,
      // Keyboard-opened popups and instant hand-offs between tooltips skip the motion.
      "[data-instant]": "0s",
    },
    transitionTimingFunction: motion.easeOut,
  },
  /** A list of selectable rows: menu items, select options. */
  list: {
    padding: space.s1,
    minWidth: "10rem",
    maxHeight: "var(--available-height)",
    overflowY: "auto",
    overscrollBehavior: "contain",
  },
  item: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    // One row height and radius with the sidebar's rows; taller on touch.
    minHeight: { default: "1.75rem", "@media (pointer: coarse)": "2.25rem" },
    paddingInline: space.s2,
    // Concentric with the panel: 4px + its 4px padding + 1px border ≈ its 8px corner.
    borderRadius: radius.sm,
    fontSize: text.base,
    lineHeight: leading.tight,
    color: { default: color.text, "[data-disabled]": color.textDisabled },
    // surfaceActive: on the raised fill in dark, surfaceHover would barely show.
    backgroundColor: { default: "transparent", "[data-highlighted]": color.surfaceActive },
    cursor: { default: "default", "[data-disabled]": "not-allowed" },
    userSelect: "none",
    outline: "none",
    scrollMargin: space.s1,
  },
  itemDanger: {
    color: color.dangerText,
    backgroundColor: { default: "transparent", "[data-highlighted]": color.dangerTint },
  },
  /** The icon slot at the start of a row; takes the row's colour when the row is dangerous. */
  itemIcon: {
    display: "inline-flex",
    flexShrink: 0,
    color: color.textSecondary,
  },
  itemIconDanger: {
    color: "currentColor",
  },
  separator: {
    height: "1px",
    marginBlock: space.s1,
    marginInline: `calc(${space.s1} * -1)`,
    backgroundColor: color.separator,
    borderWidth: 0,
  },
  groupLabel: {
    paddingTop: space.s1_5,
    paddingBottom: space.s1,
    paddingInline: space.s2,
    fontSize: text.xs,
    fontWeight: weight.medium,
    color: color.textSecondary,
    userSelect: "none",
  },
})

export const textLink = stylex.create({
  /** A link in running text: underlined, from the font's own metrics, so it never relies on colour. */
  underline: {
    textDecorationLine: "underline",
    textDecorationThickness: "from-font",
    textUnderlinePosition: "from-font",
    textDecorationColor: { default: color.borderStrong, ":hover": "currentColor" },
  },
})

/** Read out, not shown: the 1px clip, for a live region or a label only screen readers need. */
export const srOnly = stylex.create({
  root: {
    position: "absolute",
    width: "1px",
    height: "1px",
    margin: "-1px",
    padding: 0,
    overflow: "hidden",
    clip: "rect(0 0 0 0)",
    whiteSpace: "nowrap",
    borderWidth: 0,
  },
})
