import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip"
import * as stylex from "@stylexjs/stylex"
import type { ReactElement, ReactNode } from "react"
import { popup } from "./shared.ts"
import { color, layer, leading, radius, shadow, space, text } from "./tokens.stylex.ts"

export type TooltipSide = "top" | "bottom" | "left" | "right"

export interface TooltipProps {
  /** A short hint. Supplementary only: never put something here the user must read. */
  content: ReactNode
  /** The element the tooltip describes. It must be focusable, so keyboard users get the hint too. */
  children: ReactElement
  side?: TooltipSide
  /** Turns the tooltip off without changing the element it wraps. */
  disabled?: boolean
}

const styles = stylex.create({
  positioner: { zIndex: layer.tooltip },
  tooltip: {
    maxWidth: "16rem",
    paddingBlock: space.s1,
    paddingInline: space.s2,
    borderColor: "transparent",
    borderRadius: radius.md,
    backgroundColor: color.surfaceInverse,
    color: color.textInverse,
    fontSize: text.sm,
    lineHeight: leading.snug,
    boxShadow: shadow.sm,
    pointerEvents: "none",
  },
})

/**
 * A hover and focus hint for one element. Base UI does not show tooltips on touch, and screen
 * readers don't hear them, so use a Popover or inline text for anything that matters. The trigger
 * is a focusable, named control, and the content only repeats its name or adds a hint to it, as
 * IconButton's does.
 */
export function Tooltip({ content, children, side = "top", disabled = false }: TooltipProps) {
  return (
    <BaseTooltip.Root disabled={disabled}>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={6} {...stylex.props(styles.positioner)}>
          <BaseTooltip.Popup {...stylex.props(popup.surface, styles.tooltip)}>
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  )
}

/** Groups tooltips so moving between them skips the open delay. Mounted once by UIProvider. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <BaseTooltip.Provider delay={500} closeDelay={0}>
      {children}
    </BaseTooltip.Provider>
  )
}
