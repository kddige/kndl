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
  root.className =
    stylex.props(
      styles.root,
      mode === "light" && [themes.light, styles.light],
      mode === "dark" && [themes.dark, styles.dark],
    ).className ?? ""
  root.dataset["theme"] = mode
  document.body.className = stylex.props(styles.body).className ?? ""
}
