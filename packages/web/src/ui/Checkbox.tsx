import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox"
import { Switch as BaseSwitch } from "@base-ui/react/switch"
import * as stylex from "@stylexjs/stylex"
import { type ReactNode, useId } from "react"
import { CheckIcon } from "./icons.tsx"
import { focus } from "./shared.ts"
import { color, leading, motion, radius, space, text, weight } from "./tokens.stylex.ts"

export interface CheckboxProps {
  /** Beside the box, and its accessible name. */
  label: ReactNode
  /** Help under the label, such as what turning it on means. */
  description?: ReactNode
  checked: boolean
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
  sx?: stylex.StyleXStyles
}

const styles = stylex.create({
  row: {
    display: "inline-flex",
    alignItems: "flex-start",
    gap: space.s2,
    minWidth: 0,
    cursor: { default: "pointer", "[data-disabled]": "not-allowed" },
    userSelect: "none",
  },
  text: {
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
    minWidth: 0,
    // Lines the first line of the label up with the box.
    paddingTop: "0.0625rem",
  },
  label: {
    fontSize: text.base,
    lineHeight: leading.tight,
    color: color.text,
  },
  labelDisabled: { color: color.textTertiary },
  labelStrong: { fontWeight: weight.medium },
  description: { fontSize: text.sm, lineHeight: leading.snug, color: color.textSecondary },
  box: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    width: "1rem",
    height: "1rem",
    marginTop: "0.0625rem",
    padding: 0,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: { default: color.borderStrong, "[data-checked]": color.accent },
    borderRadius: radius.sm,
    // Disabled shows as faded, checked or not, so a fixed tick still reads as ticked.
    backgroundColor: { default: color.surface, "[data-checked]": color.accent },
    color: color.onAccent,
    opacity: { default: 1, "[data-disabled]": 0.6 },
    transitionProperty: "background-color, border-color",
    transitionDuration: motion.durationFast,
    transitionTimingFunction: motion.easeStandard,
  },
  indicator: {
    display: "inline-flex",
    "[data-unchecked]": { display: "none" },
  },
  check: { width: "0.75rem", height: "0.75rem", strokeWidth: 2 },
  track: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    flexShrink: 0,
    width: "1.75rem",
    height: "1rem",
    marginTop: "0.0625rem",
    padding: "0.125rem",
    borderWidth: 0,
    borderRadius: radius.full,
    backgroundColor: { default: color.borderStrong, "[data-checked]": color.accent },
    opacity: { default: 1, "[data-disabled]": 0.6 },
    transitionProperty: "background-color",
    transitionDuration: motion.durationFast,
    transitionTimingFunction: motion.easeStandard,
  },
  thumb: {
    width: "0.75rem",
    height: "0.75rem",
    borderRadius: radius.full,
    backgroundColor: color.onAccent,
    transform: {
      default: "translateX(0)",
      "[data-checked]": { default: "translateX(0.75rem)", ":dir(rtl)": "translateX(-0.75rem)" },
    },
    transitionProperty: "transform",
    transitionDuration: motion.durationMove,
    transitionTimingFunction: motion.easeStandard,
  },
})

/** How Labelled names its control: by the label's id, and the description's. */
interface Named {
  "aria-labelledby": string
  "aria-describedby"?: string
}

function Labelled({
  label,
  description,
  disabled,
  control,
  sx,
}: {
  label: ReactNode
  description: ReactNode
  disabled: boolean
  /** The control, given the ids to name and describe it by. */
  control: (named: Named) => ReactNode
  sx: stylex.StyleXStyles | undefined
}) {
  const labelId = useId()
  const descriptionId = useId()
  return (
    // Clicking anywhere on the row toggles it; the label alone names it, and the description
    // describes it rather than joining the name.
    <label {...(disabled && { "data-disabled": "" })} {...stylex.props(styles.row, sx)}>
      {control({
        "aria-labelledby": labelId,
        ...(description !== undefined && { "aria-describedby": descriptionId }),
      })}
      <span {...stylex.props(styles.text)}>
        <span
          id={labelId}
          {...stylex.props(
            styles.label,
            description !== undefined && styles.labelStrong,
            disabled && styles.labelDisabled,
          )}
        >
          {label}
        </span>
        {description !== undefined && (
          <span id={descriptionId} {...stylex.props(styles.description)}>
            {description}
          </span>
        )}
      </span>
    </label>
  )
}

/** A tick for something that is on or off within a form, such as "available at build". */
export function Checkbox({
  label,
  description,
  checked,
  onCheckedChange,
  disabled = false,
  sx,
}: CheckboxProps) {
  return (
    <Labelled
      label={label}
      description={description}
      disabled={disabled}
      sx={sx}
      control={(named) => (
        <BaseCheckbox.Root
          {...named}
          checked={checked}
          disabled={disabled}
          {...(onCheckedChange && { onCheckedChange: (next: boolean) => onCheckedChange(next) })}
          {...stylex.props(styles.box, focus.ring)}
        >
          <BaseCheckbox.Indicator keepMounted {...stylex.props(styles.indicator)}>
            <CheckIcon {...stylex.props(styles.check)} />
          </BaseCheckbox.Indicator>
        </BaseCheckbox.Root>
      )}
    />
  )
}

/** A setting that turns a feature on or off, such as Docker in every Sandbox. */
export function Switch({
  label,
  description,
  checked,
  onCheckedChange,
  disabled = false,
  sx,
}: CheckboxProps) {
  return (
    <Labelled
      label={label}
      description={description}
      disabled={disabled}
      sx={sx}
      control={(named) => (
        <BaseSwitch.Root
          {...named}
          checked={checked}
          disabled={disabled}
          {...(onCheckedChange && { onCheckedChange: (next: boolean) => onCheckedChange(next) })}
          {...stylex.props(styles.track, focus.ring)}
        >
          <BaseSwitch.Thumb {...stylex.props(styles.thumb)} />
        </BaseSwitch.Root>
      )}
    />
  )
}
