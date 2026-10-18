import { Radio } from "@base-ui/react/radio"
import { RadioGroup } from "@base-ui/react/radio-group"
import * as stylex from "@stylexjs/stylex"
import { focus } from "./shared.ts"
import { color, control, motion, radius, shadow, space, text, weight } from "./tokens.stylex.ts"

export interface SegmentedOption<Value extends string> {
  value: Value
  label: string
}

export interface SegmentedControlProps<Value extends string> {
  /** The group's accessible name, such as the field label it sits under. */
  label: string
  /** A few short options, side by side. */
  options: ReadonlyArray<SegmentedOption<Value>>
  value: Value
  onValueChange: (value: Value) => void
  disabled?: boolean
  sx?: stylex.StyleXStyles
}

// Hover styles only where a pointer can hover: on touch, :hover sticks after a tap.
const HOVER = "@media (hover: hover)"

const styles = stylex.create({
  group: {
    display: "inline-flex",
    alignSelf: "flex-start",
    gap: space.s0_5,
    padding: space.s0_5,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.md,
    // Sunk below the card it is on: the chosen one, raised and outlined, stands out either way.
    backgroundColor: color.bg,
  },
  segment: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    height: `calc(${control.md} - ${space.s1})`,
    paddingInline: space.s3,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: { default: "transparent", "[data-checked]": color.borderControl },
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", "[data-checked]": color.surface },
    boxShadow: { default: "none", "[data-checked]": shadow.sm },
    color: {
      default: color.textSecondary,
      ":hover:not([data-disabled])": { default: null, [HOVER]: color.text },
      "[data-checked]": color.text,
    },
    fontSize: text.base,
    fontWeight: weight.medium,
    whiteSpace: "nowrap",
    cursor: { default: "pointer", "[data-disabled]": "not-allowed" },
    opacity: { default: 1, "[data-disabled]": 0.6 },
    userSelect: "none",
    transitionProperty: "background-color, border-color, color, box-shadow",
    transitionDuration: motion.durationFast,
    transitionTimingFunction: motion.easeStandard,
  },
})

/**
 * One of a few short options, side by side, the one chosen raised: a setting that takes effect
 * when chosen. A radio group: the arrow keys move between options and choose.
 */
export function SegmentedControl<Value extends string>({
  label,
  options,
  value,
  onValueChange,
  disabled = false,
  sx,
}: SegmentedControlProps<Value>) {
  return (
    <RadioGroup
      aria-label={label}
      value={value}
      onValueChange={(next) => {
        const option = options.find((each) => each.value === next)
        if (option !== undefined && option.value !== value) onValueChange(option.value)
      }}
      disabled={disabled}
      {...stylex.props(styles.group, sx)}
    >
      {options.map((option) => (
        <Radio.Root
          key={option.value}
          value={option.value}
          {...stylex.props(styles.segment, focus.ring)}
        >
          {option.label}
        </Radio.Root>
      ))}
    </RadioGroup>
  )
}
