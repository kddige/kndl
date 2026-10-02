import { Button as BaseButton } from "@base-ui/react/button"
import * as stylex from "@stylexjs/stylex"
import type { ReactNode } from "react"
import { focus } from "./shared.ts"
import { Spinner } from "./Spinner.tsx"
import { color, control, motion, radius, shadow, space, text, weight } from "./tokens.stylex.ts"
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
    whiteSpace: "nowrap",
    cursor: { default: "pointer", "[data-disabled]": "not-allowed", "[data-loading]": "progress" },
    opacity: { default: 1, "[data-disabled]:not([data-loading])": 0.5 },
    userSelect: "none",
    transitionProperty: "background-color, border-color, color",
    transitionDuration: motion.durationFast,
    transitionTimingFunction: motion.easeStandard,
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

const intents = stylex.create({
  primary: {
    backgroundColor: {
      default: color.accent,
      [ENABLED_HOVER]: color.accentHover,
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
      [ENABLED_HOVER]: color.surfaceHover,
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
      [ENABLED_HOVER]: color.surfaceHover,
      [ENABLED_ACTIVE]: color.surfaceActive,
      "[data-popup-open]": color.surfaceActive,
    },
    borderColor: "transparent",
    color: {
      default: color.textMuted,
      [ENABLED_HOVER]: color.text,
      "[data-popup-open]": color.text,
    },
  },
  danger: {
    backgroundColor: {
      default: color.danger,
      [ENABLED_HOVER]: color.dangerHover,
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
      <span {...stylex.props(styles.content, loading && styles.contentHidden)}>
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
