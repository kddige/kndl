import { Menu as BaseMenu } from "@base-ui/react/menu"
import * as stylex from "@stylexjs/stylex"
import type { ReactElement, ReactNode } from "react"
import { CheckIcon, ChevronRightIcon } from "./icons.tsx"
import { popup } from "./shared.ts"
import { color, space, text } from "./tokens.stylex.ts"

const styles = stylex.create({
  // It points to the inline end, whichever way the page reads.
  submenuChevron: { transform: { default: "none", ":dir(rtl)": "scaleX(-1)" } },
  /** A row with a second line under its label. */
  itemTwoLine: {
    paddingBlock: space.s1_5,
  },
  itemText: {
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
    flex: 1,
    minWidth: 0,
  },
  description: {
    color: color.textMuted,
    fontSize: text.sm,
  },
  /** The slot at the end of a row: a radio item's check, a submenu's value and chevron. */
  end: {
    display: "inline-flex",
    alignItems: "center",
    gap: space.s1,
    flexShrink: 0,
    marginInlineStart: "auto",
    color: color.textMuted,
  },
  check: {
    display: "inline-flex",
    width: "1rem",
    color: color.text,
  },
})

export type MenuSide = "top" | "bottom" | "left" | "right"
export type MenuAlign = "start" | "center" | "end"

export interface MenuProps {
  /** The button that opens the menu, usually a Button or IconButton. */
  trigger: ReactElement
  /** MenuItems, MenuGroups, MenuRadioGroups, MenuSubmenus and MenuSeparators. */
  children: ReactNode
  side?: MenuSide
  align?: MenuAlign
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Sizing overrides for the popup (a width for rows with descriptions). */
  sx?: stylex.StyleXStyles
}

/**
 * A list of actions behind a button. Arrow keys move between items, typing jumps to one, and
 * Escape closes the menu and returns focus to the trigger.
 */
export function Menu({
  trigger,
  children,
  side = "bottom",
  align = "start",
  open,
  onOpenChange,
  sx,
}: MenuProps) {
  return (
    <BaseMenu.Root
      {...(open !== undefined && { open })}
      {...(onOpenChange && { onOpenChange: (next: boolean) => onOpenChange(next) })}
    >
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner
          side={side}
          align={align}
          sideOffset={4}
          {...stylex.props(popup.positioner)}
        >
          <BaseMenu.Popup {...stylex.props(popup.surface, popup.list, sx)}>
            {children}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  )
}

/** `danger` for destructive actions, which also get a confirmation step elsewhere. */
export type MenuItemIntent = "default" | "danger"

export interface MenuItemProps {
  children: ReactNode
  onClick?: () => void
  /** A leading 16px icon. */
  icon?: ReactNode
  intent?: MenuItemIntent
  disabled?: boolean
  /** Keep the menu open after choosing this item. */
  keepOpen?: boolean
  /** What shows at the row's end, such as the value a further panel sets. */
  end?: ReactNode
}

export function MenuItem({
  children,
  onClick,
  icon,
  intent = "default",
  disabled = false,
  keepOpen = false,
  end,
}: MenuItemProps) {
  const danger = intent === "danger"
  return (
    <BaseMenu.Item
      {...(onClick && { onClick: () => onClick() })}
      disabled={disabled}
      closeOnClick={!keepOpen}
      {...stylex.props(popup.item, danger && popup.itemDanger)}
    >
      {icon && (
        <span {...stylex.props(popup.itemIcon, danger && popup.itemIconDanger)}>{icon}</span>
      )}
      {children}
      {end !== undefined && <span {...stylex.props(styles.end)}>{end}</span>}
    </BaseMenu.Item>
  )
}

export interface MenuRadioGroupProps<Value extends string> {
  /** The chosen value; one no item has leaves every item unchecked. */
  value: Value | undefined
  onValueChange: (value: Value) => void
  /** A heading for the group, also its accessible name. */
  label?: ReactNode
  /** Its MenuRadioItems. */
  children: ReactNode
}

/** A set of rows of which one is chosen, shown with a check. */
export function MenuRadioGroup<Value extends string>({
  value,
  onValueChange,
  label,
  children,
}: MenuRadioGroupProps<Value>) {
  return (
    <BaseMenu.RadioGroup
      // Base UI tells an uncontrolled group from a controlled one by `undefined`: null keeps it
      // controlled with nothing chosen.
      value={value ?? null}
      onValueChange={(next: Value) => onValueChange(next)}
    >
      {label !== undefined && (
        <BaseMenu.GroupLabel {...stylex.props(popup.groupLabel)}>{label}</BaseMenu.GroupLabel>
      )}
      {children}
    </BaseMenu.RadioGroup>
  )
}

export interface MenuRadioItemProps {
  value: string
  /** Its name, which typing jumps to. */
  label: string
  /** A line under the name on what it is. */
  description?: ReactNode
  disabled?: boolean
  /** Keep the menu open after choosing this item. */
  keepOpen?: boolean
}

export function MenuRadioItem({
  value,
  label,
  description,
  disabled = false,
  keepOpen = false,
}: MenuRadioItemProps) {
  return (
    <BaseMenu.RadioItem
      value={value}
      label={label}
      disabled={disabled}
      closeOnClick={!keepOpen}
      {...stylex.props(popup.item, description !== undefined && styles.itemTwoLine)}
    >
      <span {...stylex.props(styles.itemText)}>
        <span>{label}</span>
        {description !== undefined && (
          <span {...stylex.props(styles.description)}>{description}</span>
        )}
      </span>
      <span {...stylex.props(styles.end, styles.check)}>
        <BaseMenu.RadioItemIndicator>
          <CheckIcon />
        </BaseMenu.RadioItemIndicator>
      </span>
    </BaseMenu.RadioItem>
  )
}

export interface MenuSubmenuProps {
  /** The row that opens it. */
  label: string
  /** What shows at the row's end, such as the value chosen in it. */
  value?: ReactNode
  disabled?: boolean
  /** Its rows. */
  children: ReactNode
  /** Sizing overrides for its popup. */
  sx?: stylex.StyleXStyles
}

/**
 * A row that opens a further menu beside this one, on hover, click, or the right arrow key; the
 * left arrow key goes back. A phone has no room beside the menu: there, show its rows in the
 * menu itself, behind a MenuItem that switches to them, as the model picker does.
 */
export function MenuSubmenu({ label, value, disabled = false, children, sx }: MenuSubmenuProps) {
  return (
    <BaseMenu.SubmenuRoot>
      <BaseMenu.SubmenuTrigger label={label} disabled={disabled} {...stylex.props(popup.item)}>
        {label}
        <span {...stylex.props(styles.end)}>
          {value}
          <ChevronRightIcon {...stylex.props(styles.submenuChevron)} />
        </span>
      </BaseMenu.SubmenuTrigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner
          side="right"
          align="start"
          alignOffset={-4}
          sideOffset={4}
          {...stylex.props(popup.positioner)}
        >
          <BaseMenu.Popup {...stylex.props(popup.surface, popup.list, sx)}>
            {children}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.SubmenuRoot>
  )
}

export function MenuSeparator() {
  return <BaseMenu.Separator {...stylex.props(popup.separator)} />
}

export interface MenuGroupProps {
  /** A heading for the group, also its accessible name. */
  label: ReactNode
  children: ReactNode
}

export function MenuGroup({ label, children }: MenuGroupProps) {
  return (
    <BaseMenu.Group>
      <BaseMenu.GroupLabel {...stylex.props(popup.groupLabel)}>{label}</BaseMenu.GroupLabel>
      {children}
    </BaseMenu.Group>
  )
}
