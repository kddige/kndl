import { Toast as BaseToast } from "@base-ui/react/toast"
import * as stylex from "@stylexjs/stylex"
import type { ReactNode } from "react"
import { Button, IconButton } from "./Button.tsx"
import { CloseIcon } from "./icons.tsx"
import { focus } from "./shared.ts"
import {
  color,
  layer,
  leading,
  motion,
  radius,
  shadow,
  space,
  text,
  weight,
} from "./tokens.stylex.ts"

/** Colours the toast's marker. `neutral` for plain confirmations, the default. */
export type ToastIntent = "neutral" | "success" | "warning" | "danger"

export interface ToastAction {
  /** The button's text, e.g. "Undo". */
  label: string
  /** Runs when the button is pressed; the toast then closes. */
  onAction: () => void
}

export interface ToastOptions {
  title: ReactNode
  description?: ReactNode
  intent?: ToastIntent
  /** One button in the toast, typically "Undo" after something destructive. */
  action?: ToastAction
  /**
   * Milliseconds before the toast closes on its own; 0 keeps it until dismissed. Defaults to 5s.
   * A toast with an action, such as Undo, or an error stays until dismissed: someone who heard it
   * while busy elsewhere mustn't lose it to a timer. Hovering or focusing toasts pauses this.
   */
  timeout?: number
  /** Showing a toast with the id of an open one replaces it, instead of stacking another. */
  id?: string
}

const manager = BaseToast.createToastManager()

/**
 * Shows and closes toasts from anywhere, inside React or not. Toasts render in the Toaster that
 * UIProvider mounts. F6 moves focus into them, so actions are reachable from the keyboard.
 */
export const toast = {
  /** Shows a toast and returns its id. */
  show({ title, description, intent = "neutral", action, timeout, id }: ToastOptions): string {
    const toastId: string = manager.add({
      title,
      description,
      type: intent,
      timeout: timeout ?? (action !== undefined || intent === "danger" ? 0 : 5_000),
      // Errors interrupt the screen reader; everything else waits its turn.
      priority: intent === "danger" ? "high" : "low",
      ...(id !== undefined && { id }),
      ...(action && {
        actionProps: {
          children: action.label,
          onClick: () => {
            action.onAction()
            manager.close(toastId)
          },
        },
      }),
    })
    return toastId
  },
  /** Closes one toast, or all of them without an id. */
  close(id?: string): void {
    manager.close(id)
  },
}

const styles = stylex.create({
  viewport: {
    position: "fixed",
    zIndex: layer.toast,
    insetInlineEnd: space.s4,
    bottom: space.s4,
    width: `min(22.5rem, calc(100vw - ${space.s8}))`,
    display: "flex",
    // Newest first in the DOM; shown at the bottom, nearest where the eye already is.
    flexDirection: "column-reverse",
    gap: space.s2,
    outline: "none",
  },
  toast: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.s3,
    paddingBlock: space.s3,
    paddingInlineStart: space.s3,
    paddingInlineEnd: space.s2,
    backgroundColor: color.surface,
    color: color.text,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.lg,
    boxShadow: shadow.lg,
    userSelect: "none",
    opacity: {
      default: 1,
      "[data-starting-style]": 0,
      "[data-ending-style]": 0,
      "[data-limited]": 0,
    },
    transform: {
      default: "translateX(var(--toast-swipe-movement-x, 0px))",
      "[data-starting-style]": `translateY(calc(${motion.enterDistance} * 3))`,
    },
    transitionProperty: "opacity, transform",
    transitionDuration: {
      default: motion.durationSlow,
      "[data-ending-style]": motion.durationNormal,
      "[data-swiping]": "0s",
    },
    transitionTimingFunction: motion.easeOut,
  },
  marker: {
    flexShrink: 0,
    width: "0.5rem",
    height: "0.5rem",
    // Centres the dot on the title's first line.
    marginTop: `calc((${text.base} * ${leading.snug} - 0.5rem) / 2)`,
    borderRadius: radius.full,
  },
  text: {
    display: "flex",
    flex: 1,
    flexDirection: "column",
    gap: space.s0_5,
    minWidth: 0,
  },
  title: {
    margin: 0,
    fontSize: text.base,
    fontWeight: weight.medium,
    lineHeight: leading.snug,
    textWrap: "balance",
  },
  description: {
    margin: 0,
    color: color.textMuted,
    fontSize: text.sm,
    lineHeight: leading.snug,
    textWrap: "pretty",
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: space.s1,
    marginBlock: `calc(${space.s0_5} * -1)`,
  },
})

const markers = stylex.create({
  neutral: { backgroundColor: color.textSubtle },
  success: { backgroundColor: color.success },
  warning: { backgroundColor: color.warning },
  danger: { backgroundColor: color.danger },
})

function isIntent(type: string | undefined): type is ToastIntent {
  return type === "neutral" || type === "success" || type === "warning" || type === "danger"
}

function ToastList() {
  const { toasts } = BaseToast.useToastManager()
  return toasts.map((item) => (
    <BaseToast.Root key={item.id} toast={item} {...stylex.props(styles.toast, focus.ringInset)}>
      <span
        aria-hidden="true"
        {...stylex.props(styles.marker, markers[isIntent(item.type) ? item.type : "neutral"])}
      />
      <div {...stylex.props(styles.text)}>
        <BaseToast.Title {...stylex.props(styles.title)} />
        <BaseToast.Description {...stylex.props(styles.description)} />
      </div>
      <div {...stylex.props(styles.actions)}>
        {item.actionProps && <BaseToast.Action render={<Button size="sm" />} />}
        <BaseToast.Close
          render={
            <IconButton label="Dismiss" size="sm" noTooltip>
              <CloseIcon />
            </IconButton>
          }
        />
      </div>
    </BaseToast.Root>
  ))
}

/** Renders the open toasts. Mounted once, by UIProvider. */
export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <BaseToast.Provider toastManager={manager}>
      {children}
      <BaseToast.Portal>
        <BaseToast.Viewport {...stylex.props(styles.viewport)}>
          <ToastList />
        </BaseToast.Viewport>
      </BaseToast.Portal>
    </BaseToast.Provider>
  )
}
