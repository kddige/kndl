import { Combobox as BaseCombobox } from "@base-ui/react/combobox"
import * as stylex from "@stylexjs/stylex"
import { type ReactElement, type ReactNode, useState } from "react"
import { CheckIcon, SearchIcon } from "./icons.tsx"
import type { MenuAlign, MenuSide } from "./Menu.tsx"
import { popup } from "./shared.ts"
import { color, font, space, text } from "./tokens.stylex.ts"

export interface SearchSelectOption {
  /** What picking it sets. */
  value: string
  /** Its name in the list, which typing searches. */
  label: string
  /** More text typing searches, never shown, such as an id. */
  keywords?: string
}

export interface SearchSelectGroup {
  /** The group's heading, which typing searches too. */
  label: string
  options: ReadonlyArray<SearchSelectOption>
}

export interface SearchSelectProps {
  /** The button that opens it, usually a Button showing what is picked. */
  trigger: ReactElement
  /**
   * The trigger's accessible name: a combobox never takes it from its content. Where the trigger
   * shows the value, include it, so the visible text stays part of the name: `Model: Opus 5.5`.
   */
  label: string
  groups: ReadonlyArray<SearchSelectGroup>
  /** The value picked; none of the options' leaves none checked. */
  value: string | undefined
  onValueChange: (value: string) => void
  /** The search field's accessible name and placeholder: `Search Models`. */
  searchLabel: string
  /** What the list says when typing matches nothing: `No Models match "x"`. */
  noMatch: (query: string) => string
  /** What it shows with no options at all, in place of the search and the list. */
  empty?: ReactNode
  side?: MenuSide
  align?: MenuAlign
  /** Sizing overrides for the popup. */
  sx?: stylex.StyleXStyles
}

// iOS zooms the page into a focused field under 16px, so the filter is 16px on touch screens.
const TOUCH = "@media (pointer: coarse)"

const styles = stylex.create({
  popup: {
    display: "flex",
    flexDirection: "column",
    width: "18rem",
    maxWidth: "calc(100vw - 2rem)",
    maxHeight: "min(24rem, var(--available-height))",
  },
  // A long list keeps its height as typing narrows it, so the search field stays where it is,
  // above the button or below it.
  tall: { height: "min(24rem, var(--available-height))" },
  search: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    flexShrink: 0,
    paddingInline: space.s3,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: color.border,
    color: color.textSecondary,
  },
  input: {
    flex: 1,
    minWidth: 0,
    height: "2.25rem",
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: color.text,
    fontFamily: font.sans,
    fontSize: { default: text.base, [TOUCH]: text.lg },
    outline: "none",
    "::placeholder": { color: color.textTertiary },
  },
  list: {
    flex: 1,
    minHeight: 0,
    maxHeight: "none",
    overflowY: "auto",
    overscrollBehavior: "contain",
  },
  // Each heading stays at the top while its group scrolls under it.
  groupLabel: {
    position: "sticky",
    top: `calc(${space.s1} * -1)`,
    zIndex: 1,
    backgroundColor: color.surface,
  },
  label: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  check: { display: "inline-flex", width: "1rem", flexShrink: 0, color: color.text },
  message: {
    margin: 0,
    paddingBlock: space.s3,
    paddingInline: space.s3,
    color: color.textSecondary,
    fontSize: text.sm,
  },
})

/** How many options a list has before it opens at its full height. */
const tallFrom = 10

/** Whether every word typed is in the option's label, keywords or group. */
function matches(option: SearchSelectOption, group: string, words: ReadonlyArray<string>) {
  const haystack = `${option.label} ${option.keywords ?? ""} ${group}`.toLowerCase()
  return words.every((word) => haystack.includes(word))
}

/** The groups with only the options matching `query`, and none left empty. */
export function searchGroups(
  groups: ReadonlyArray<SearchSelectGroup>,
  query: string,
): ReadonlyArray<SearchSelectGroup> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return groups
  return groups.flatMap((group) => {
    const options = group.options.filter((option) => matches(option, group.label, words))
    return options.length === 0 ? [] : [{ ...group, options }]
  })
}

/**
 * One choice among a long list, in groups, behind a button: the popup opens with a search field,
 * typing narrows the list by every word typed, the arrow keys move through what is left, Enter
 * picks, and Escape closes it and returns focus to the button. The picked option has a check.
 */
export function SearchSelect({
  trigger,
  label,
  groups,
  value,
  onValueChange,
  searchLabel,
  noMatch,
  empty,
  side = "bottom",
  align = "start",
  sx,
}: SearchSelectProps) {
  const [query, setQuery] = useState("")
  const shown = searchGroups(groups, query)
  const count = groups.reduce((sum, group) => sum + group.options.length, 0)
  return (
    <BaseCombobox.Root
      value={value ?? null}
      onValueChange={(picked: string | null) => {
        if (picked !== null && picked !== value) onValueChange(picked)
      }}
      // Narrowed here, not by Base UI, which needs the items to know what's left.
      items={shown.flatMap((group) => group.options.map((option) => option.value))}
      filter={null}
      inputValue={query}
      onInputValueChange={(next: string, details) => {
        // Only typing narrows the list: picking leaves the search as it was.
        if (details.reason.startsWith("input")) setQuery(next)
      }}
      onOpenChange={(open: boolean) => {
        if (!open) setQuery("")
      }}
      autoHighlight
    >
      <BaseCombobox.Trigger render={trigger} aria-label={label} />
      <BaseCombobox.Portal>
        <BaseCombobox.Positioner
          side={side}
          align={align}
          sideOffset={4}
          {...stylex.props(popup.positioner)}
        >
          <BaseCombobox.Popup
            aria-label={searchLabel}
            {...stylex.props(popup.surface, styles.popup, count > tallFrom && styles.tall, sx)}
          >
            {count === 0 ? (
              <div {...stylex.props(styles.message)}>{empty}</div>
            ) : (
              <>
                <label {...stylex.props(styles.search)}>
                  <SearchIcon />
                  <BaseCombobox.Input
                    aria-label={searchLabel}
                    placeholder={`${searchLabel}…`}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoComplete="off"
                    {...stylex.props(styles.input)}
                  />
                </label>
                <BaseCombobox.Empty {...stylex.props(shown.length === 0 && styles.message)}>
                  {shown.length === 0 ? noMatch(query.trim()) : null}
                </BaseCombobox.Empty>
                <BaseCombobox.List {...stylex.props(popup.list, styles.list)}>
                  {shown.map((group) => (
                    <BaseCombobox.Group key={group.label}>
                      <BaseCombobox.GroupLabel
                        {...stylex.props(popup.groupLabel, styles.groupLabel)}
                      >
                        {group.label}
                      </BaseCombobox.GroupLabel>
                      {group.options.map((option) => (
                        <BaseCombobox.Item
                          key={option.value}
                          value={option.value}
                          {...stylex.props(popup.item)}
                        >
                          <span {...stylex.props(styles.label)} title={option.label}>
                            {option.label}
                          </span>
                          <BaseCombobox.ItemIndicator {...stylex.props(styles.check)}>
                            <CheckIcon />
                          </BaseCombobox.ItemIndicator>
                        </BaseCombobox.Item>
                      ))}
                    </BaseCombobox.Group>
                  ))}
                </BaseCombobox.List>
              </>
            )}
          </BaseCombobox.Popup>
        </BaseCombobox.Positioner>
      </BaseCombobox.Portal>
    </BaseCombobox.Root>
  )
}
