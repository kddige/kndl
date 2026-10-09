import { Combobox as BaseCombobox } from "@base-ui/react/combobox"
import * as stylex from "@stylexjs/stylex"
import { Fragment, type ReactNode, useState } from "react"
import { fieldControl } from "./Field.tsx"
import { CheckIcon, ChevronDownIcon, PlusIcon } from "./icons.tsx"
import { focus, popup } from "./shared.ts"
import { color, space } from "./tokens.stylex.ts"

export interface ComboboxOption {
  /** What the text becomes when the option is picked, and what typing filters by. */
  value: string
  /** Shown in the list instead of the value. */
  label?: ReactNode
  /** The heading it is listed under; groups appear in the order they are first used. */
  group?: string
}

/** An entry offered below the options when the text is none of them, such as "+ Create ...". */
export interface ComboboxCreate {
  /** The entry's text for what was typed. */
  label: (text: string) => ReactNode
  onCreate: (text: string) => void
}

export interface ComboboxProps {
  /** The text in the field. Free entry: it need not be one of the options. */
  value: string
  onValueChange: (value: string) => void
  /** Suggestions; typing narrows them to those with the text in their value. */
  options: ReadonlyArray<ComboboxOption>
  create?: ComboboxCreate
  placeholder?: string
  disabled?: boolean
  autoFocus?: boolean
  spellCheck?: boolean
  autoCapitalize?: string
  /** Only needed outside a Field, which names the combo box with its label. */
  "aria-label"?: string
  sx?: stylex.StyleXStyles
}

/**
 * Why Base UI changes the text that mean the person did: typing, pasting, clearing, picking. It
 * also resets the text to the picked option's when the list closes; with free entry, there is no
 * such option, and the text stays as it is.
 */
const changesText = new Set<string>(["input-change", "input-paste", "item-press"])

/** Stands for the create entry as the picked value; never shown, never the text. */
const createValue = "\u0000create"

const styles = stylex.create({
  group: { display: "block" },
  root: { position: "relative", display: "flex", width: "100%", minWidth: 0 },
  input: { paddingInlineEnd: space.s8 },
  trigger: {
    position: "absolute",
    insetBlock: 0,
    insetInlineEnd: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: space.s8,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: { default: color.textMuted, "[data-disabled]": color.textSubtle },
    cursor: { default: "pointer", "[data-disabled]": "not-allowed" },
  },
  popup: { minWidth: "var(--anchor-width)" },
  item: {
    // Room for the check mark, so labels line up whether or not the text is the option.
    paddingInlineStart: space.s1_5,
    paddingInlineEnd: space.s3,
  },
  indicator: { display: "inline-flex", width: "1rem", flexShrink: 0, color: color.text },
  createIcon: { display: "inline-flex", width: "1rem", flexShrink: 0, color: color.textMuted },
  label: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  separator: { borderTopWidth: "1px", borderTopStyle: "solid", borderTopColor: color.border },
})

/** The options with `query` in their value, in groups: `[undefined, ...]` is those with none. */
function grouped(options: ReadonlyArray<ComboboxOption>, query: string) {
  const needle = query.toLowerCase()
  const groups = new Map<string | undefined, Array<ComboboxOption>>()
  for (const option of options) {
    if (!option.value.toLowerCase().includes(needle)) continue
    groups.set(option.group, [...(groups.get(option.group) ?? []), option])
  }
  return [...groups]
}

/**
 * A text field with suggestions: typing narrows the options, picking one fills the text, and the
 * text may be anything (free entry). With `create`, a text that is none of the options is offered
 * as an entry of its own. Put it in a Field for its label.
 */
export function Combobox({ value, onValueChange, options, create, ...field }: ComboboxProps) {
  // What was last typed. Only text the person typed narrows the options: one they picked, or one
  // filled in for them, leaves the whole list to choose another from.
  const [typed, setTyped] = useState<string | null>(null)
  const query = typed === value ? value : ""
  const groups = grouped(options, query)
  const offersCreate =
    create !== undefined && value !== "" && !options.some((option) => option.value === value)
  return (
    <BaseCombobox.Root
      // Free entry: the text is the value, so no option is ever the selected one.
      value={null}
      // Narrowed here, not by Base UI, which needs the items to know the list isn't empty.
      items={[
        ...groups.flatMap(([, members]) => members.map((option) => option.value)),
        ...(offersCreate ? [createValue] : []),
      ]}
      filter={null}
      inputValue={value}
      disabled={field.disabled === true}
      onInputValueChange={(next: string, details) => {
        if (next === createValue || !changesText.has(details.reason)) return
        if (details.reason === "input-change") setTyped(next)
        if (next !== value) onValueChange(next)
      }}
      onValueChange={(picked: string | null) => {
        if (picked === createValue) create?.onCreate(value)
      }}
    >
      <ComboboxField {...field} />
      {(groups.length > 0 || offersCreate) && (
        <BaseCombobox.Portal>
          <BaseCombobox.Positioner sideOffset={4} {...stylex.props(popup.positioner)}>
            <BaseCombobox.Popup {...stylex.props(popup.surface, styles.popup)}>
              <BaseCombobox.List {...stylex.props(popup.list)}>
                {groups.map(([group, members]) => (
                  <Fragment key={group ?? ""}>
                    {group !== undefined && (
                      <BaseCombobox.Group {...stylex.props(styles.group)}>
                        <BaseCombobox.GroupLabel {...stylex.props(popup.groupLabel)}>
                          {group}
                        </BaseCombobox.GroupLabel>
                        {members.map((option) => (
                          <ComboboxItem key={option.value} option={option} selected={value} />
                        ))}
                      </BaseCombobox.Group>
                    )}
                    {group === undefined &&
                      members.map((option) => (
                        <ComboboxItem key={option.value} option={option} selected={value} />
                      ))}
                  </Fragment>
                ))}
                {offersCreate && (
                  <BaseCombobox.Item
                    value={createValue}
                    {...stylex.props(
                      popup.item,
                      styles.item,
                      groups.length > 0 && styles.separator,
                    )}
                  >
                    <span {...stylex.props(styles.createIcon)}>
                      <PlusIcon />
                    </span>
                    <span {...stylex.props(styles.label)}>{create.label(value)}</span>
                  </BaseCombobox.Item>
                )}
              </BaseCombobox.List>
            </BaseCombobox.Popup>
          </BaseCombobox.Positioner>
        </BaseCombobox.Portal>
      )}
    </BaseCombobox.Root>
  )
}

function ComboboxItem({ option, selected }: { option: ComboboxOption; selected: string }) {
  return (
    <BaseCombobox.Item value={option.value} {...stylex.props(popup.item, styles.item)}>
      <span {...stylex.props(styles.indicator)}>{option.value === selected && <CheckIcon />}</span>
      <span {...stylex.props(styles.label)}>{option.label ?? option.value}</span>
    </BaseCombobox.Item>
  )
}

function ComboboxField({
  placeholder,
  disabled = false,
  autoFocus = false,
  spellCheck,
  autoCapitalize,
  "aria-label": ariaLabel,
  sx,
}: Omit<ComboboxProps, "value" | "onValueChange" | "options" | "create">) {
  return (
    <div {...stylex.props(styles.root)}>
      <BaseCombobox.Input
        {...(placeholder !== undefined && { placeholder })}
        {...(autoFocus && { autoFocus })}
        {...(spellCheck !== undefined && { spellCheck })}
        {...(autoCapitalize !== undefined && { autoCapitalize })}
        {...(ariaLabel !== undefined && { "aria-label": ariaLabel })}
        {...stylex.props(
          fieldControl.control,
          fieldControl.input,
          fieldControl.focus,
          styles.input,
          sx,
        )}
      />
      <BaseCombobox.Trigger
        aria-label="Show suggestions"
        tabIndex={-1}
        disabled={disabled}
        {...stylex.props(styles.trigger, focus.ring)}
      >
        <ChevronDownIcon />
      </BaseCombobox.Trigger>
    </div>
  )
}
