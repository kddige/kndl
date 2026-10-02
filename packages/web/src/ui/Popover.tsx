import { Popover as BasePopover } from "@base-ui/react/popover"
import * as stylex from "@stylexjs/stylex"
import type { ReactElement, ReactNode } from "react"
import { popup } from "./shared.ts"
import { color, leading, space, text, weight } from "./tokens.stylex.ts"

export type PopoverSide = "top" | "bottom" | "left" | "right"
export type PopoverAlign = "start" | "center" | "end"

export interface PopoverProps {
  /** The element that toggles the popover, usually a Button. */
  trigger: ReactElement
  /** Names the popover for screen readers, and is shown as its heading. */
  title?: ReactNode
  description?: ReactNode
  children?: ReactNode
  side?: PopoverSide
  align?: PopoverAlign
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Layout overrides for the panel, e.g. a width. */
  sx?: stylex.StyleXStyles
}

const styles = stylex.create({
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: space.s2,
    width: "max-content",
    maxWidth: "min(22rem, var(--available-width))",
    padding: space.s3,
  },
  heading: {
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
  },
  title: {
    fontSize: text.base,
    fontWeight: weight.semibold,
    lineHeight: leading.snug,
  },
  description: {
    color: color.textMuted,
    fontSize: text.sm,
    lineHeight: leading.snug,
  },
})

/**
 * A non-modal panel anchored to a trigger, for extra detail or a few controls. Escape and clicking
 * outside close it; focus moves in when it opens and back to the trigger when it closes.
 */
export function Popover({
  trigger,
  title,
  description,
  children,
  side = "bottom",
  align = "center",
  open,
  onOpenChange,
  sx,
}: PopoverProps) {
  return (
    <BasePopover.Root
      {...(open !== undefined && { open })}
      {...(onOpenChange && { onOpenChange: (next: boolean) => onOpenChange(next) })}
    >
      <BasePopover.Trigger render={trigger} />
      <BasePopover.Portal>
        <BasePopover.Positioner
          side={side}
          align={align}
          sideOffset={6}
          {...stylex.props(popup.positioner)}
        >
          <BasePopover.Popup {...stylex.props(popup.surface, styles.panel, sx)}>
            {(title || description) && (
              <div {...stylex.props(styles.heading)}>
                {title && (
                  <BasePopover.Title {...stylex.props(styles.title)}>{title}</BasePopover.Title>
                )}
                {description && (
                  <BasePopover.Description {...stylex.props(styles.description)}>
                    {description}
                  </BasePopover.Description>
                )}
              </div>
            )}
            {children}
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  )
}
