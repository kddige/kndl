import { Dialog as BaseDialog } from "@base-ui/react/dialog"
import * as stylex from "@stylexjs/stylex"
import type { ReactElement, ReactNode } from "react"
import { Button, type ButtonIntent, IconButton } from "./Button.tsx"
import { CloseIcon } from "./icons.tsx"
import { color, layer, leading, motion, radius, shadow, space } from "./tokens.stylex.ts"
import { textRole } from "./type.ts"

export type DialogSize = "sm" | "md" | "lg"

export interface DialogProps {
  /** Names the dialog for everyone, including screen readers. */
  title: ReactNode
  /** One or two sentences under the title, also read out when the dialog opens. */
  description?: ReactNode
  /** The body. */
  children?: ReactNode
  /** The actions row, usually a DialogClose to cancel and the confirming Button last. */
  footer?: ReactNode
  /** The element that opens the dialog. Omit it and control `open` to open from elsewhere. */
  trigger?: ReactElement
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  /** `sm` for confirmations, `md` for short forms, `lg` for anything with a list or a preview. */
  size?: DialogSize
}

const styles = stylex.create({
  backdrop: {
    position: "fixed",
    // Base UI: covers the visual viewport on iOS Safari, together with body { position: relative }.
    inset: 0,
    minHeight: "100dvh",
    zIndex: layer.dialog,
    backgroundColor: color.overlay,
    opacity: { default: 1, "[data-starting-style]": 0, "[data-ending-style]": 0 },
    transitionProperty: "opacity",
    transitionDuration: {
      default: motion.durationSlow,
      "[data-ending-style]": motion.durationFast,
    },
    transitionTimingFunction: motion.easeOut,
  },
  viewport: {
    position: "fixed",
    inset: 0,
    zIndex: layer.dialog,
    display: "grid",
    placeItems: "center",
    padding: space.s4,
    overflowY: "auto",
    overscrollBehavior: "contain",
  },
  popup: {
    display: "flex",
    flexDirection: "column",
    maxHeight: `calc(100dvh - ${space.s8})`,
    backgroundColor: color.surfaceRaised,
    color: color.text,
    // The edge is in the shadow; the transparent border is what forced colors draw.
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: radius.xl,
    boxShadow: shadow.lg,
    outline: "none",
    opacity: { default: 1, "[data-starting-style]": 0, "[data-ending-style]": 0 },
    transform: {
      default: "none",
      "[data-starting-style]": `translateY(${motion.enterDistance}) scale(${motion.enterScale})`,
      "[data-ending-style]": `translateY(${motion.enterDistance}) scale(${motion.enterScale})`,
    },
    transitionProperty: "opacity, transform",
    transitionDuration: {
      default: motion.durationNormal,
      "[data-ending-style]": motion.durationFast,
    },
    transitionTimingFunction: motion.easeOut,
  },
  header: {
    display: "flex",
    alignItems: "flex-start",
    gap: space.s3,
    paddingTop: space.s4,
    paddingInlineEnd: space.s4,
    paddingInlineStart: space.s5,
  },
  heading: {
    display: "flex",
    flex: 1,
    flexDirection: "column",
    gap: space.s1,
    minWidth: 0,
    paddingTop: space.s1,
  },
  title: { textWrap: "balance" },
  description: {
    color: color.textSecondary,
    lineHeight: leading.snug,
    textWrap: "pretty",
  },
  close: {
    marginTop: `calc(${space.s0_5} * -1)`,
  },
  body: {
    paddingTop: space.s4,
    paddingInline: space.s5,
    overflowY: "auto",
    overscrollBehavior: "contain",
  },
  footer: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: space.s2,
    padding: space.s4,
    paddingInline: space.s5,
    marginTop: space.s2,
  },
  // Without a footer, the body still needs room at the bottom.
  bodyLast: { paddingBottom: space.s5 },
  headerLast: { paddingBottom: space.s5 },
})

const sizes = stylex.create({
  sm: { width: "min(24rem, 100%)" },
  md: { width: "min(28rem, 100%)" },
  lg: { width: "min(40rem, 100%)" },
})

/**
 * A modal dialog: focus is trapped inside, Escape and the backdrop close it, and focus returns to
 * the trigger afterwards.
 */
export function Dialog({
  title,
  description,
  children,
  footer,
  trigger,
  open,
  defaultOpen,
  onOpenChange,
  size = "md",
}: DialogProps) {
  const hasBody = children != null && children !== false
  return (
    <BaseDialog.Root
      {...(open !== undefined && { open })}
      {...(defaultOpen !== undefined && { defaultOpen })}
      {...(onOpenChange && { onOpenChange: (next: boolean) => onOpenChange(next) })}
    >
      {trigger && <BaseDialog.Trigger render={trigger} />}
      <BaseDialog.Portal>
        <BaseDialog.Backdrop {...stylex.props(styles.backdrop)} />
        <BaseDialog.Viewport {...stylex.props(styles.viewport)}>
          <BaseDialog.Popup {...stylex.props(styles.popup, sizes[size])}>
            <div {...stylex.props(styles.header, !hasBody && !footer && styles.headerLast)}>
              <div {...stylex.props(styles.heading)}>
                <BaseDialog.Title {...stylex.props(textRole.title, styles.title)}>
                  {title}
                </BaseDialog.Title>
                {description && (
                  <BaseDialog.Description {...stylex.props(styles.description)}>
                    {description}
                  </BaseDialog.Description>
                )}
              </div>
              {/* No tooltip: focus can land here as the dialog opens, and it would pop up at once. */}
              <BaseDialog.Close
                render={
                  <IconButton label="Close" size="sm" noTooltip sx={styles.close}>
                    <CloseIcon />
                  </IconButton>
                }
              />
            </div>
            {hasBody && (
              <div {...stylex.props(styles.body, !footer && styles.bodyLast)}>{children}</div>
            )}
            {footer && <div {...stylex.props(styles.footer)}>{footer}</div>}
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}

export interface DialogCloseProps {
  children: ReactNode
  intent?: ButtonIntent
}

/** A Button that closes the dialog it's in; "Cancel" by convention. */
export function DialogClose({ children, intent = "secondary" }: DialogCloseProps) {
  return <BaseDialog.Close render={<Button intent={intent} />}>{children}</BaseDialog.Close>
}
