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
  /** Where focus goes as it closes, if not back to the button that opened it. */
  finalFocus?: () => HTMLElement | true
}

const MOTION_OK = "@media (prefers-reduced-motion: no-preference)"
const REDUCED = "@media (prefers-reduced-motion: reduce)"

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
      default: motion.durationSlow,
      "[data-ending-style]": motion.durationNormal,
    },
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
    width: "min(18rem, calc(100% - 3rem))",
    backgroundColor: color.surface,
    color: color.text,
    borderInlineEndWidth: "1px",
    borderInlineEndStyle: "solid",
    borderInlineEndColor: "transparent",
    boxShadow: shadow.lg,
    outline: "none",
    // It slides in from its edge; under reduced motion it fades instead.
    transform: {
      default: "none",
      [MOTION_OK]: {
        default: "none",
        // From the inline start: the left, or the right in a right-to-left page.
        "[data-starting-style]": { default: "translateX(-100%)", ":dir(rtl)": "translateX(100%)" },
        "[data-ending-style]": { default: "translateX(-100%)", ":dir(rtl)": "translateX(100%)" },
      },
    },
    opacity: {
      default: 1,
      [REDUCED]: { default: 1, "[data-starting-style]": 0, "[data-ending-style]": 0 },
    },
    transitionProperty: "transform, opacity",
    transitionDuration: {
      default: motion.durationSlow,
      "[data-ending-style]": motion.durationNormal,
    },
    transitionTimingFunction: motion.easeOut,
  },
})

/**
 * A panel that slides in from the start edge over the page, for navigation on narrow screens. It's
 * a modal dialog: focus is trapped inside, Escape and the backdrop close it, and focus returns to
 * the button that opened it.
 */
export function Drawer({ label, children, open, onOpenChange, finalFocus }: DrawerProps) {
  return (
    <BaseDialog.Root open={open} onOpenChange={(next: boolean) => onOpenChange(next)}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop {...stylex.props(styles.backdrop)} />
        <BaseDialog.Popup
          aria-label={label}
          {...(finalFocus && { finalFocus })}
          {...stylex.props(styles.popup)}
        >
          {children}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}
