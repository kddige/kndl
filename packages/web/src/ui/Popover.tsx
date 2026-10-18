import { Popover as BasePopover } from "@base-ui/react/popover"
import * as stylex from "@stylexjs/stylex"
import type { ReactElement, ReactNode } from "react"
import { popup } from "./shared.ts"
import { color, leading, space, text } from "./tokens.stylex.ts"
import { textRole } from "./type.ts"

export type PopoverSide = "top" | "bottom" | "left" | "right"
export type PopoverAlign = "start" | "center" | "end"
export type PopoverChangeReason = BasePopover.Root.ChangeEventReason

export interface PopoverProps {
  /** The element that toggles the popover, usually a Button. */
  trigger: ReactElement
  /** Names the popover for screen readers, and is shown as its heading. */
  title?: ReactNode
  /**
   * Names it for screen readers instead of the title, which is then only shown: for a title that
   * is a value, such as the level a thinking slider is on.
   */
  label?: string
  description?: ReactNode
  children?: ReactNode
  side?: PopoverSide
  align?: PopoverAlign
  open?: boolean
  /** With why: `escape-key`, `outside-press`, `trigger-press` and so on. */
  onOpenChange?: (open: boolean, reason: PopoverChangeReason) => void
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
  title: { textWrap: "balance" },
  description: {
    color: color.textSecondary,
    fontSize: text.sm,
    lineHeight: leading.snug,
    textWrap: "pretty",
  },
})

/**
 * A non-modal panel anchored to a trigger, for extra detail or a few controls. Escape and clicking
 * outside close it; focus moves in when it opens and back to the trigger when it closes.
 */
export function Popover({
  trigger,
  title,
  label,
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
      {...(onOpenChange && {
        onOpenChange: (next: boolean, details: BasePopover.Root.ChangeEventDetails) =>
          onOpenChange(next, details.reason),
      })}
    >
      <BasePopover.Trigger render={trigger} />
      <BasePopover.Portal>
        <BasePopover.Positioner
          side={side}
          align={align}
          sideOffset={6}
          {...stylex.props(popup.positioner)}
        >
          <BasePopover.Popup
            {...(label !== undefined && { "aria-label": label })}
            {...stylex.props(popup.surface, styles.panel, sx)}
          >
            {(title || description) && (
              <div {...stylex.props(styles.heading)}>
                {title &&
                  (label === undefined ? (
                    <BasePopover.Title {...stylex.props(textRole.subheading, styles.title)}>
                      {title}
                    </BasePopover.Title>
                  ) : (
                    // Base UI's Title would name the popover, over the label.
                    <p {...stylex.props(textRole.subheading, styles.title)}>{title}</p>
                  ))}
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
