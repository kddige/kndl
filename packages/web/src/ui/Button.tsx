import { Button as BaseButton } from "@base-ui/react/button"
import * as stylex from "@stylexjs/stylex"
import type { ReactNode } from "react"
import { focus } from "./shared.ts"
import { Spinner } from "./Spinner.tsx"
import {
  color,
  control,
  icon as iconStroke,
  motion,
  radius,
  shadow,
  space,
  text,
  weight,
} from "./tokens.stylex.ts"
import { Tooltip } from "./Tooltip.tsx"

/**
 * - `primary`: the one main action in a view (Start Session, Send).
 * - `secondary`: everything else; the default.
 * - `ghost`: low-emphasis actions in dense rows and toolbars.
 * - `danger`: destructive actions (Delete, Stop).
 */
export type ButtonIntent = "primary" | "secondary" | "ghost" | "danger"
export type ButtonSize = "sm" | "md" | "lg"

export interface ButtonProps extends Omit<BaseButton.Props, "className" | "style"> {
  intent?: ButtonIntent
  size?: ButtonSize
  /**
   * Shows a spinner and blocks clicks while keeping focus and the accessible name, so the
   * button doesn't jump or lose focus while its action runs.
   */
  loading?: boolean
  /** A leading icon. */
  icon?: ReactNode
  /** Makes the button square, for a lone icon. Give it an `aria-label`, or use IconButton. */
  iconOnly?: boolean
  /** Layout overrides (margins, width). Not for restyling: add an intent instead. */
  sx?: stylex.StyleXStyles
}

const ENABLED_HOVER = ":hover:not([data-disabled])"
const ENABLED_ACTIVE = ":active:not([data-disabled])"
// Hover styles only where a pointer can hover: on touch, :hover sticks after a tap.
const HOVER = "@media (hover: hover)"
const MOTION_OK = "@media (prefers-reduced-motion: no-preference)"

// Beside a 500-weight label, an icon's stroke thickens to match it.
const labelIcon = stylex.createTheme(iconStroke, { stroke: "2px" })

const styles = stylex.create({
  base: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    margin: 0,
    borderWidth: "1px",
    borderStyle: "solid",
    fontFamily: "inherit",
    fontWeight: weight.medium,
    lineHeight: 1,
    // A Button rendered as a link looks like the rest.
    textDecoration: "none",
    whiteSpace: "nowrap",
    cursor: { default: "pointer", "[data-disabled]": "not-allowed", "[data-loading]": "progress" },
    opacity: { default: 1, "[data-disabled]:not([data-loading])": 0.5 },
    userSelect: "none",
    // A press scales down, so a click shows it landed; never on a disabled or loading Button.
    scale: { default: null, [MOTION_OK]: { default: null, [ENABLED_ACTIVE]: motion.pressScale } },
    transitionProperty: "background-color, border-color, color, scale",
    transitionDuration: `${motion.durationFast}, ${motion.durationFast}, ${motion.durationFast}, 150ms`,
    transitionTimingFunction: `${motion.easeStandard}, ${motion.easeStandard}, ${motion.easeStandard}, ease-out`,
  },
  content: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1_5,
  },
  // Hidden but still read out, so the button keeps its width and its name.
  contentHidden: { opacity: 0 },
  spinner: {
    position: "absolute",
    inset: 0,
    margin: "auto",
  },
})

const sizes = stylex.create({
  sm: {
    height: control.sm,
    minWidth: control.sm,
    paddingInline: space.s2,
    fontSize: text.sm,
    borderRadius: radius.sm,
  },
  md: {
    height: control.md,
    minWidth: control.md,
    paddingInline: space.s3,
    fontSize: text.base,
    borderRadius: radius.md,
  },
  lg: {
    height: control.lg,
    minWidth: control.lg,
    paddingInline: space.s4,
    fontSize: text.md,
    borderRadius: radius.md,
  },
  iconOnly: { paddingInline: 0 },
})

// A leading icon looks further in than a letter: its side takes 2px less, judged by eye.
const iconSide = stylex.create({
  sm: { paddingInlineStart: `calc(${space.s2} - 2px)` },
  md: { paddingInlineStart: `calc(${space.s3} - 2px)` },
  lg: { paddingInlineStart: `calc(${space.s4} - 2px)` },
})

const intents = stylex.create({
  primary: {
    backgroundColor: {
      default: color.accent,
      [ENABLED_HOVER]: { default: null, [HOVER]: color.accentHover },
      [ENABLED_ACTIVE]: color.accentHover,
      "[data-popup-open]": color.accentHover,
    },
    borderColor: "transparent",
    color: color.onAccent,
    boxShadow: shadow.sm,
  },
  secondary: {
    backgroundColor: {
      default: color.surface,
      [ENABLED_HOVER]: { default: null, [HOVER]: color.surfaceHover },
      [ENABLED_ACTIVE]: color.surfaceActive,
      "[data-popup-open]": color.surfaceActive,
    },
    borderColor: color.borderStrong,
    color: color.text,
    boxShadow: shadow.sm,
  },
  ghost: {
    backgroundColor: {
      default: "transparent",
      [ENABLED_HOVER]: { default: null, [HOVER]: color.surfaceHover },
      [ENABLED_ACTIVE]: color.surfaceActive,
      "[data-popup-open]": color.surfaceActive,
    },
    borderColor: "transparent",
    color: {
      default: color.textMuted,
      [ENABLED_HOVER]: { default: null, [HOVER]: color.text },
      "[data-popup-open]": color.text,
    },
  },
  danger: {
    backgroundColor: {
      default: color.danger,
      [ENABLED_HOVER]: { default: null, [HOVER]: color.dangerHover },
      [ENABLED_ACTIVE]: color.dangerHover,
      "[data-popup-open]": color.dangerHover,
    },
    borderColor: "transparent",
    color: color.onDanger,
    boxShadow: shadow.sm,
  },
})

export function Button({
  intent = "secondary",
  size = "md",
  loading = false,
  icon,
  iconOnly = false,
  children,
  disabled,
  focusableWhenDisabled,
  sx,
  ...props
}: ButtonProps) {
  return (
    <BaseButton
      {...props}
      {...stylex.props(
        styles.base,
        sizes[size],
        iconOnly && sizes.iconOnly,
        icon !== undefined && !iconOnly && iconSide[size],
        intents[intent],
        focus.ring,
        sx,
      )}
      data-intent={intent}
      data-loading={loading ? "" : undefined}
      aria-busy={loading || undefined}
      disabled={disabled === true || loading}
      focusableWhenDisabled={loading || focusableWhenDisabled === true}
    >
      {loading && <Spinner size={size === "lg" ? "md" : "sm"} sx={styles.spinner} />}
      <span
        {...stylex.props(styles.content, !iconOnly && labelIcon, loading && styles.contentHidden)}
      >
        {icon}
        {children}
      </span>
    </BaseButton>
  )
}

export interface IconButtonProps extends Omit<
  ButtonProps,
  "icon" | "iconOnly" | "children" | "aria-label"
> {
  /** What the button does. Used as its accessible name and shown as a tooltip. */
  label: string
  /** The icon. */
  children: ReactNode
  /** Turn off the tooltip, e.g. where focus lands on the button as a dialog opens. */
  noTooltip?: boolean
}

/** A square, icon-only Button whose label is its accessible name and tooltip. */
export function IconButton({
  label,
  children,
  intent = "ghost",
  noTooltip = false,
  ...props
}: IconButtonProps) {
  const button = (
    <Button {...props} intent={intent} aria-label={label} iconOnly>
      {children}
    </Button>
  )
  if (noTooltip) return button
  return <Tooltip content={label}>{button}</Tooltip>
}
