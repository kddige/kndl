import * as stylex from "@stylexjs/stylex"
import {
  color,
  darkColorTheme,
  darkShadowTheme,
  darkTerminalTheme,
  font,
  leading,
  lightColorTheme,
  lightShadowTheme,
  lightTerminalTheme,
  text,
} from "./tokens.stylex.ts"

/** `system` follows the OS; `light` and `dark` force a palette. */
export type ThemeMode = "system" | "light" | "dark"

/**
 * The theme overrides, for forcing a palette on a subtree: `{...stylex.props(themes.dark)}`.
 * Popups portal to <body>, so they follow the page's theme, not the subtree's.
 */
export const themes = {
  light: [lightColorTheme, lightShadowTheme, lightTerminalTheme],
  dark: [darkColorTheme, darkShadowTheme, darkTerminalTheme],
} as const

const styles = stylex.create({
  // Page defaults, applied to <html> so portaled popups inherit them too.
  root: {
    colorScheme: "light dark",
    backgroundColor: color.bg,
    color: color.text,
    fontFamily: font.sans,
    lineHeight: leading.normal,
    WebkitFontSmoothing: "antialiased",
    MozOsxFontSmoothing: "grayscale",
  },
  // The base size goes on <body>, not <html>: the type scale is in rem, and a font-size on <html>
  // would redefine the rem and shrink every token with it. Popups portal into <body>.
  body: {
    fontSize: text.base,
  },
  light: { colorScheme: "light" },
  dark: { colorScheme: "dark" },
})

/** Applies a theme to the whole page. Call once at startup and again when the user switches. */
export function setTheme(mode: ThemeMode): void {
  const root = document.documentElement
  withoutTransitions(() => {
    root.className =
      stylex.props(
        styles.root,
        mode === "light" && [themes.light, styles.light],
        mode === "dark" && [themes.dark, styles.dark],
      ).className ?? ""
    root.dataset["theme"] = mode
    document.body.className = stylex.props(styles.body).className ?? ""
  })
  followSystemScheme()
}

let following = false

/** In `system` mode the OS can switch the scheme under the page: switch it without a smear too. */
function followSystemScheme(): void {
  if (following || typeof matchMedia !== "function") return
  following = true
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (document.documentElement.dataset["theme"] === "system") withoutTransitions(() => {})
  })
}

/**
 * Runs a theme swap with every transition off, so controls that fade their colours don't smear
 * while the rest of the page snaps. The pause outlasts the swap's style recalculation.
 */
function withoutTransitions(swap: () => void): void {
  const pause = document.createElement("style")
  pause.textContent = "*,*::before,*::after{transition:none!important}"
  document.head.append(pause)
  swap()
  void document.body.offsetHeight
  requestAnimationFrame(() => requestAnimationFrame(() => pause.remove()))
}
