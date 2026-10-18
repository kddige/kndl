import { Field as BaseField } from "@base-ui/react/field"
import { Input as BaseInput } from "@base-ui/react/input"
import * as stylex from "@stylexjs/stylex"
import type { ClipboardEventHandler, KeyboardEventHandler, ReactNode } from "react"
import { color, control, leading, motion, radius, space, text, weight } from "./tokens.stylex.ts"

// iOS zooms the page into a focused field under 16px, so fields are 16px on touch screens.
const TOUCH = "@media (pointer: coarse)"

export interface FieldProps {
  /** Every control needs a visible label; it is also the control's accessible name. */
  label: ReactNode
  /** Help under the control, read out with it. */
  description?: ReactNode
  /** Shown, and the control marked invalid, while `invalid` is true. */
  error?: ReactNode
  /** Set when your own validation (or the server) rejects the value. */
  invalid?: boolean
  disabled?: boolean
  /** Submitted with the form under this name. */
  name?: string
  /** One Input, Textarea or Select. */
  children: ReactNode
  sx?: stylex.StyleXStyles
}

// Hover styles only where a pointer can hover: on touch, :hover sticks after a tap.
const HOVER = "@media (hover: hover)"

const styles = stylex.create({
  field: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1_5,
    minWidth: 0,
  },
  label: {
    fontSize: text.base,
    fontWeight: weight.medium,
    lineHeight: leading.tight,
    color: { default: color.text, "[data-disabled]": color.textSubtle },
  },
  description: {
    fontSize: text.sm,
    lineHeight: leading.snug,
    color: color.textMuted,
    textWrap: "pretty",
  },
  error: {
    fontSize: text.sm,
    lineHeight: leading.snug,
    color: color.dangerSubtleText,
  },
  control: {
    width: "100%",
    minWidth: 0,
    margin: 0,
    paddingInline: space.s2_5,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: {
      default: color.borderStrong,
      ":hover:not([data-disabled]):not(:focus)": { default: null, [HOVER]: color.textSubtle },
      "[data-invalid]": color.danger,
    },
    borderRadius: radius.md,
    backgroundColor: { default: color.surface, "[data-disabled]": color.surfaceMuted },
    color: { default: color.text, "[data-disabled]": color.textSubtle },
    fontFamily: "inherit",
    fontSize: { default: text.base, [TOUCH]: text.lg },
    lineHeight: leading.normal,
    cursor: { default: "text", "[data-disabled]": "not-allowed" },
    transitionProperty: "border-color",
    transitionDuration: motion.durationFast,
    transitionTimingFunction: motion.easeStandard,
    "::placeholder": { color: color.textSubtle },
  },
  // :focus, not :focus-visible: a text field shows where typing goes however it was focused.
  controlFocus: {
    outlineStyle: { default: "none", ":focus": "solid" },
    outlineWidth: "2px",
    outlineColor: color.focus,
    outlineOffset: "-1px",
  },
  input: {
    height: control.md,
  },
  // On touch, 16px text needs the 32px box, as sidebar rows grow there too.
  inputSm: {
    height: { default: control.sm, [TOUCH]: control.md },
    paddingInline: space.s2,
    fontSize: { default: text.sm, [TOUCH]: text.lg },
  },
  // A field that edits a title in place, in the title's type: 16px on touch, as every field is.
  title: {
    fontSize: { default: text.md, [TOUCH]: text.lg },
    fontWeight: weight.semibold,
  },
  textarea: {
    display: "block",
    minHeight: `calc(${control.md} * 2)`,
    paddingBlock: space.s1_5,
    resize: "vertical",
  },
  // Grows with its content (where the browser supports it) up to maxRows.
  autoResize: {
    fieldSizing: "content",
    resize: "none",
  },
})

/**
 * A label, a control, and its help and error text, wired together: the label names the control,
 * the description and error are read out with it, and an invalid field is announced as such.
 */
export function Field({
  label,
  description,
  error,
  invalid,
  disabled = false,
  name,
  children,
  sx,
}: FieldProps) {
  return (
    <BaseField.Root
      disabled={disabled}
      {...(invalid !== undefined && { invalid })}
      {...(name !== undefined && { name })}
      {...stylex.props(styles.field, sx)}
    >
      <BaseField.Label {...stylex.props(styles.label)}>{label}</BaseField.Label>
      {children}
      {description && (
        <BaseField.Description {...stylex.props(styles.description)}>
          {description}
        </BaseField.Description>
      )}
      {/* Our error while `invalid`; otherwise the browser's message for required, pattern, etc. */}
      {invalid && error ? (
        <BaseField.Error match {...stylex.props(styles.error)}>
          {error}
        </BaseField.Error>
      ) : (
        <BaseField.Error {...stylex.props(styles.error)} />
      )}
    </BaseField.Root>
  )
}

/** The look of a text field, for kit components that are one (Combobox). */
export const fieldControl = {
  control: styles.control,
  input: styles.input,
  focus: styles.controlFocus,
}

/** Type for a field's text, where it isn't the field's own: `title` for a title edited in place. */
export const fieldText = {
  title: styles.title,
}

export type InputSize = "sm" | "md"

export interface InputProps extends Omit<
  BaseInput.Props,
  "className" | "style" | "size" | "render"
> {
  size?: InputSize
  sx?: stylex.StyleXStyles
}

/** A single-line text input. Put it in a Field for its label. */
export function Input({ size = "md", sx, ...props }: InputProps) {
  return (
    <BaseInput
      {...props}
      {...stylex.props(
        styles.control,
        styles.input,
        size === "sm" && styles.inputSm,
        styles.controlFocus,
        sx,
      )}
    />
  )
}

export interface TextareaProps {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>
  onPaste?: ClipboardEventHandler<HTMLTextAreaElement>
  placeholder?: string
  /** Visible rows when empty. */
  rows?: number
  /** Grow with the text instead of scrolling (the composer). Set a max height via `sx`. */
  autoResize?: boolean
  disabled?: boolean
  required?: boolean
  name?: string
  autoFocus?: boolean
  "aria-label"?: string
  sx?: stylex.StyleXStyles
}

/** A multi-line text input. Put it in a Field for its label. */
export function Textarea({
  rows = 3,
  autoResize = false,
  onValueChange,
  onKeyDown,
  onPaste,
  sx,
  ...props
}: TextareaProps) {
  return (
    <BaseInput
      {...props}
      {...(onValueChange && { onValueChange: (next: string) => onValueChange(next) })}
      {...stylex.props(
        styles.control,
        styles.textarea,
        autoResize && styles.autoResize,
        styles.controlFocus,
        sx,
      )}
      render={
        <textarea rows={rows} {...(onKeyDown && { onKeyDown })} {...(onPaste && { onPaste })} />
      }
    />
  )
}
