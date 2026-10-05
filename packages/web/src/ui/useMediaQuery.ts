import { useSyncExternalStore } from "react"

/**
 * From this width the sidebar stays in view, and a submenu opens beside its menu; below it, the
 * sidebar is a drawer behind a menu button, and a submenu is a second panel in its menu.
 */
export const WIDE = "(min-width: 48rem)"

/** Whether a media query matches, following it as it changes. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query)
      list.addEventListener("change", onChange)
      return () => list.removeEventListener("change", onChange)
    },
    () => window.matchMedia(query).matches,
  )
}
