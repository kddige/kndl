import { Autocomplete } from "@base-ui/react/autocomplete"
import { Dialog as BaseDialog } from "@base-ui/react/dialog"
import * as stylex from "@stylexjs/stylex"
import { useMemo, useState } from "react"
import { SearchIcon } from "./icons.tsx"
import { srOnly } from "./shared.ts"
import { color, font, layer, motion, radius, shadow, space, text, weight } from "./tokens.stylex.ts"

/** One thing the palette can do: go somewhere, or act. */
export interface Command {
  /** Unique within the palette. */
  id: string
  label: string
  /** Matched too, and shown after the label: a Session's Repo. */
  meta?: string
  /** Its keys, by name: `C`, `F2`. */
  shortcut?: string
  run: () => void
}

export interface CommandGroup {
  label: string
  commands: ReadonlyArray<Command>
}

export interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  groups: ReadonlyArray<CommandGroup>
  /** What it shows with nothing typed; every group when omitted. */
  initial?: ReadonlyArray<CommandGroup>
  placeholder?: string
}

const styles = stylex.create({
  backdrop: {
    position: "fixed",
    inset: 0,
    minHeight: "100dvh",
    zIndex: layer.dialog,
    backgroundColor: color.overlay,
    opacity: { default: 1, "[data-starting-style]": 0, "[data-ending-style]": 0 },
    transitionProperty: "opacity",
    transitionDuration: {
      default: motion.durationNormal,
      "[data-ending-style]": motion.durationFast,
    },
    transitionTimingFunction: motion.easeOut,
  },
  // High on the screen, where the eye already is, like Linear's and Raycast's.
  popup: {
    position: "fixed",
    zIndex: layer.dialog,
    top: "min(20vh, 10rem)",
    left: "50%",
    width: "min(36rem, calc(100% - 2rem))",
    translate: "-50% 0",
    display: "flex",
    flexDirection: "column",
    maxHeight: "min(30rem, 70dvh)",
    overflow: "hidden",
    backgroundColor: color.surfaceRaised,
    color: color.text,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: radius.xl,
    boxShadow: shadow.lg,
    outline: "none",
    opacity: { default: 1, "[data-starting-style]": 0, "[data-ending-style]": 0 },
    scale: {
      default: 1,
      "[data-starting-style]": motion.enterScale,
      "[data-ending-style]": motion.enterScale,
    },
    transitionProperty: "opacity, scale",
    transitionDuration: {
      default: motion.durationNormal,
      "[data-ending-style]": motion.durationFast,
    },
    transitionTimingFunction: motion.easeOut,
  },
  field: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    flexShrink: 0,
    height: "3rem",
    paddingInline: space.s4,
    borderBottomWidth: "1px",
    borderBottomStyle: "solid",
    borderBottomColor: color.border,
    color: color.textTertiary,
  },
  input: {
    flex: 1,
    minWidth: 0,
    height: "100%",
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: color.text,
    fontFamily: "inherit",
    fontSize: { default: text.md, "@media (pointer: coarse)": text.lg },
    outline: "none",
    "::placeholder": { color: color.textTertiary },
  },
  list: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    overscrollBehavior: "contain",
    padding: space.s2,
    outline: "none",
  },
  group: { paddingBottom: space.s1 },
  groupLabel: {
    paddingTop: space.s2,
    paddingBottom: space.s1,
    paddingInline: space.s2,
    color: color.textSecondary,
    fontSize: text.xs,
    fontWeight: weight.medium,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  item: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    minHeight: { default: "2rem", "@media (pointer: coarse)": "2.5rem" },
    paddingInline: space.s2,
    borderRadius: radius.sm,
    fontSize: text.base,
    cursor: "default",
    userSelect: "none",
    outline: "none",
    backgroundColor: { default: "transparent", "[data-highlighted]": color.surfaceActive },
  },
  label: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  meta: { flexShrink: 0, color: color.textSecondary, fontSize: text.sm },
  end: { marginInlineStart: "auto", display: "flex", alignItems: "center", gap: space.s2 },
  kbd: {
    paddingInline: space.s1,
    borderRadius: radius.sm,
    backgroundColor: color.surfaceMuted,
    color: color.textSecondary,
    fontFamily: font.mono,
    fontSize: text.xs,
  },
  empty: {
    paddingBlock: space.s6,
    paddingInline: space.s2,
    color: color.textTertiary,
    textAlign: "center",
  },
})

const matches = (command: Command, words: ReadonlyArray<string>) => {
  const haystack = `${command.label} ${command.meta ?? ""}`.toLowerCase()
  return words.every((word) => haystack.includes(word))
}

/**
 * ⌘K: one field that goes anywhere and does the common things. Every typed word must appear in a
 * command's label or meta; the groups keep their order, and so do their commands, so whoever
 * builds the groups decides the ranking. Arrow keys move, Enter runs, Escape closes.
 */
export function CommandPalette({
  open,
  onOpenChange,
  groups,
  initial,
  placeholder = "Search Sessions, Settings and actions…",
}: CommandPaletteProps) {
  const [query, setQuery] = useState("")
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = useMemo(
    () =>
      (words.length === 0 && initial ? initial : groups)
        .map((group) => ({
          value: group.label,
          items: group.commands.filter((command) => matches(command, words)),
        }))
        .filter((group) => group.items.length > 0),
    // `words` comes from `query`.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [groups, initial, query],
  )
  const close = () => {
    onOpenChange(false)
    setQuery("")
  }

  return (
    <BaseDialog.Root
      open={open}
      onOpenChange={(next: boolean) => {
        onOpenChange(next)
        if (!next) setQuery("")
      }}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop {...stylex.props(styles.backdrop)} />
        <BaseDialog.Popup aria-label="Command palette" {...stylex.props(styles.popup)}>
          <BaseDialog.Title {...stylex.props(srOnly.root)}>Command palette</BaseDialog.Title>
          <Autocomplete.Root
            inline
            open
            items={shown}
            filteredItems={shown}
            value={query}
            onValueChange={(next: string) => setQuery(next)}
            autoHighlight="always"
            itemToStringValue={(command: Command) => command.label}
          >
            <div {...stylex.props(styles.field)}>
              <SearchIcon />
              <Autocomplete.Input
                autoFocus
                aria-label="Search Sessions, Settings and actions"
                placeholder={placeholder}
                {...stylex.props(styles.input)}
              />
            </div>
            <Autocomplete.Empty>
              <p {...stylex.props(styles.empty)}>Nothing matches “{query}”.</p>
            </Autocomplete.Empty>
            <Autocomplete.List {...stylex.props(styles.list)}>
              {(group: { value: string; items: ReadonlyArray<Command> }) => (
                <Autocomplete.Group
                  key={group.value}
                  items={group.items}
                  {...stylex.props(styles.group)}
                >
                  <Autocomplete.GroupLabel {...stylex.props(styles.groupLabel)}>
                    {group.value}
                  </Autocomplete.GroupLabel>
                  <Autocomplete.Collection>
                    {(command: Command) => (
                      <Autocomplete.Item
                        key={command.id}
                        value={command}
                        onClick={() => {
                          close()
                          command.run()
                        }}
                        {...stylex.props(styles.item)}
                      >
                        <span {...stylex.props(styles.label)}>{command.label}</span>
                        {(command.meta !== undefined || command.shortcut !== undefined) && (
                          <span {...stylex.props(styles.end)}>
                            {command.meta !== undefined && (
                              <span {...stylex.props(styles.meta)}>{command.meta}</span>
                            )}
                            {command.shortcut !== undefined && (
                              <kbd {...stylex.props(styles.kbd)}>{command.shortcut}</kbd>
                            )}
                          </span>
                        )}
                      </Autocomplete.Item>
                    )}
                  </Autocomplete.Collection>
                </Autocomplete.Group>
              )}
            </Autocomplete.List>
          </Autocomplete.Root>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}
