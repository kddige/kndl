import * as stylex from "@stylexjs/stylex"
import { useRef, useState } from "react"
import { Input, type InputSize } from "./Field.tsx"

export interface InlineEditProps {
  /** The text to start from, selected so typing replaces it. */
  defaultValue: string
  /** The field's accessible name, as it has no visible label: "Session name". */
  label: string
  /** Shown while the field is empty: what clearing it leaves. */
  placeholder?: string
  maxLength?: number
  /**
   * Enter, or leaving the field: the text as typed, untrimmed. Return false when it couldn't be
   * saved, to keep editing what was typed.
   */
  onCommit: (value: string) => void | boolean
  /** Escape: the edit is dropped. */
  onCancel: () => void
  size?: InputSize
  sx?: stylex.StyleXStyles
}

/**
 * A text field that edits a value in place, such as a name in a header or a sidebar row: it takes
 * focus with its text selected, Enter or leaving it commits, and Escape cancels. The caller shows
 * the value again once either is called.
 */
export function InlineEdit({
  defaultValue,
  label,
  placeholder,
  maxLength,
  onCommit,
  onCancel,
  size = "sm",
  sx,
}: InlineEditProps) {
  const [value, setValue] = useState(defaultValue)
  // Once committed or cancelled, the blur as the field goes away mustn't commit again.
  const done = useRef(false)
  const finish = (commit: boolean) => {
    if (done.current) return
    done.current = true
    if (!commit) onCancel()
    else if (onCommit(value) === false) done.current = false
  }
  return (
    <Input
      size={size}
      value={value}
      onValueChange={(next: string) => setValue(next)}
      aria-label={label}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault()
          finish(true)
        } else if (event.key === "Escape") {
          // Not the Drawer or Dialog around it: Escape here only drops the edit.
          event.stopPropagation()
          event.preventDefault()
          finish(false)
        }
      }}
      {...(placeholder !== undefined && { placeholder })}
      {...(maxLength !== undefined && { maxLength })}
      sx={[styles.field, sx]}
    />
  )
}

const styles = stylex.create({
  field: { flex: 1, minWidth: 0 },
})
