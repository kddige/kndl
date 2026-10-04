import { Dialog as BaseDialog } from "@base-ui/react/dialog"
import * as stylex from "@stylexjs/stylex"
import type { ReactNode } from "react"
import { color, layer, motion, shadow } from "./tokens.stylex.ts"

export interface DrawerProps {
  /** Names the drawer for screen readers, such as "Navigation". */
  label: string
  /** The panel's content, usually a Sidebar that fills it. */
  children: ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
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
    transitionDuration: motion.durationSlow,
    transitionTimingFunction: motion.easeOut,
  },
  popup: {
    position: "fixed",
    top: 0,
    bottom: 0,
    insetInlineStart: 0,
    zIndex: layer.dialog,
    display: "flex",
    flexDirection: "column",
    // Wide enough for a branch name, with a strip of the page left showing to tap away.
    width: "min(18rem, calc(100vw - 3rem))",
    backgroundColor: color.surface,
    color: color.text,
    borderInlineEndWidth: "1px",
    borderInlineEndStyle: "solid",
    borderInlineEndColor: color.border,
    boxShadow: shadow.lg,
    outline: "none",
    transform: {
      default: "none",
      "[data-starting-style]": "translateX(-100%)",
      "[data-ending-style]": "translateX(-100%)",
    },
    transitionProperty: "transform",
    transitionDuration: motion.durationSlow,
    transitionTimingFunction: { default: motion.easeOut, "[data-ending-style]": motion.easeIn },
  },
})

/**
 * A panel that slides in from the start edge over the page, for navigation on narrow screens. It's
 * a modal dialog: focus is trapped inside, Escape and the backdrop close it, and focus returns to
 * the button that opened it.
 */
export function Drawer({ label, children, open, onOpenChange }: DrawerProps) {
  return (
    <BaseDialog.Root open={open} onOpenChange={(next: boolean) => onOpenChange(next)}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop {...stylex.props(styles.backdrop)} />
        <BaseDialog.Popup aria-label={label} {...stylex.props(styles.popup)}>
          {children}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}
