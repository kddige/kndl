import { Select as BaseSelect } from "@base-ui/react/select"
import * as stylex from "@stylexjs/stylex"
import type { ReactNode } from "react"
import { CheckIcon, ChevronUpDownIcon } from "./icons.tsx"
import { focus, popup } from "./shared.ts"
import { color, control, motion, radius, space, text } from "./tokens.stylex.ts"

export interface SelectOption<Value extends string> {
  value: Value
  label: ReactNode
  disabled?: boolean
}

export type SelectSize = "sm" | "md"

export interface SelectProps<Value extends string> {
  options: ReadonlyArray<SelectOption<Value>>
  value?: Value | null
  defaultValue?: Value | null
  onValueChange?: (value: Value) => void
  /** Shown while nothing is chosen. */
  placeholder?: ReactNode
  size?: SelectSize
  disabled?: boolean
  required?: boolean
  /** Submitted with the form under this name. In a Field, give the Field the name instead. */
  name?: string
  /** Only needed outside a Field, which names the select with its label. */
  "aria-label"?: string
  sx?: stylex.StyleXStyles
}

// Hover styles only where a pointer can hover: on touch, :hover sticks after a tap.
const HOVER = "@media (hover: hover)"

const styles = stylex.create({
  trigger: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s2,
    height: control.md,
    minWidth: "9rem",
    margin: 0,
    paddingInlineStart: space.s2_5,
    paddingInlineEnd: space.s2,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: { default: color.borderControl, "[data-invalid]": color.danger },
    borderRadius: radius.md,
    backgroundColor: {
      default: color.surface,
      ":hover:not([data-disabled])": { default: null, [HOVER]: color.surfaceHover },
      "[data-popup-open]": color.surfaceHover,
      "[data-disabled]": color.surfaceMuted,
    },
    color: { default: color.text, "[data-disabled]": color.textDisabled },
    fontFamily: "inherit",
    fontSize: text.base,
    lineHeight: 1,
    textAlign: "start",
    whiteSpace: "nowrap",
    cursor: { default: "pointer", "[data-disabled]": "not-allowed" },
    userSelect: "none",
    transitionProperty: "background-color",
    transitionDuration: motion.durationFast,
    transitionTimingFunction: motion.easeStandard,
  },
  triggerSm: {
    height: control.sm,
    paddingInlineStart: space.s2,
    paddingInlineEnd: space.s1_5,
    borderRadius: radius.sm,
    fontSize: text.sm,
  },
  value: {
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  placeholder: {
    color: color.textTertiary,
  },
  icon: {
    display: "inline-flex",
    flexShrink: 0,
    color: color.textSecondary,
  },
  popup: {
    minWidth: "var(--anchor-width)",
  },
  item: {
    // Room for the check mark, so labels line up whether or not they're chosen.
    paddingInlineStart: space.s1_5,
    paddingInlineEnd: space.s3,
  },
  indicator: {
    display: "inline-flex",
    width: "1rem",
    flexShrink: 0,
    color: color.text,
  },
})

/** Picks one value from a short list. Put it in a Field for its label. */
export function Select<Value extends string>({
  options,
  value,
  defaultValue,
  onValueChange,
  placeholder,
  size = "md",
  disabled = false,
  required = false,
  name,
  "aria-label": ariaLabel,
  sx,
}: SelectProps<Value>) {
  const items = options.map((option) => ({ value: option.value, label: option.label }))
  return (
    <BaseSelect.Root
      items={items}
      disabled={disabled}
      required={required}
      {...(value !== undefined && { value })}
      {...(defaultValue !== undefined && { defaultValue })}
      {...(name !== undefined && { name })}
      {...(onValueChange && {
        onValueChange: (next: Value | null) => {
          if (next !== null) onValueChange(next)
        },
      })}
    >
      <BaseSelect.Trigger
        {...(ariaLabel !== undefined && { "aria-label": ariaLabel })}
        {...stylex.props(styles.trigger, size === "sm" && styles.triggerSm, focus.ring, sx)}
      >
        <BaseSelect.Value
          {...(placeholder !== undefined && { placeholder })}
          {...stylex.props(styles.value)}
        >
          {(selected: Value | null) =>
            selected === null ? (
              <span {...stylex.props(styles.placeholder)}>{placeholder}</span>
            ) : (
              options.find((option) => option.value === selected)?.label
            )
          }
        </BaseSelect.Value>
        <BaseSelect.Icon {...stylex.props(styles.icon)}>
          <ChevronUpDownIcon />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={4} {...stylex.props(popup.positioner)}>
          <BaseSelect.Popup {...stylex.props(popup.surface, styles.popup)}>
            <BaseSelect.List {...stylex.props(popup.list)}>
              {options.map((option) => (
                <BaseSelect.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled === true}
                  {...stylex.props(popup.item, styles.item)}
                >
                  <span {...stylex.props(styles.indicator)}>
                    <BaseSelect.ItemIndicator render={<CheckIcon />} />
                  </span>
                  <BaseSelect.ItemText>{option.label}</BaseSelect.ItemText>
                </BaseSelect.Item>
              ))}
            </BaseSelect.List>
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  )
}
