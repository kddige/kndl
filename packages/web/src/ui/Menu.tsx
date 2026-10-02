import { Menu as BaseMenu } from "@base-ui/react/menu"
import * as stylex from "@stylexjs/stylex"
import type { ReactElement, ReactNode } from "react"
import { popup } from "./shared.ts"

export type MenuSide = "top" | "bottom" | "left" | "right"
export type MenuAlign = "start" | "center" | "end"

export interface MenuProps {
  /** The button that opens the menu, usually a Button or IconButton. */
  trigger: ReactElement
  /** MenuItems, MenuGroups and MenuSeparators. */
  children: ReactNode
  side?: MenuSide
  align?: MenuAlign
  open?: boolean
  onOpenChange?: (open: boolean) => void
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
          <BaseMenu.Popup {...stylex.props(popup.surface, popup.list)}>{children}</BaseMenu.Popup>
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
}

export function MenuItem({
  children,
  onClick,
  icon,
  intent = "default",
  disabled = false,
  keepOpen = false,
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
    </BaseMenu.Item>
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
