import type { ReactNode } from "react"
import { ToastProvider } from "./Toast.tsx"
import { TooltipProvider } from "./Tooltip.tsx"

/** What the components need above them: the toast viewport and shared tooltip timing. Mount once. */
export function UIProvider({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <TooltipProvider>{children}</TooltipProvider>
    </ToastProvider>
  )
}
