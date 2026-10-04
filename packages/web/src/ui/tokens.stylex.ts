/**
 * Design tokens, declared once with `defineVars` and compiled to CSS custom properties.
 * Components use these, never raw values.
 *
 * Theme-dependent groups (`color`, `shadow`) default to light and switch to dark when the OS
 * prefers it. `lightTheme` and `darkTheme` (see theme.ts) force one or the other on a subtree,
 * whatever the OS says.
 */
import * as stylex from "@stylexjs/stylex"

const DARK = "@media (prefers-color-scheme: dark)"
const REDUCED_MOTION = "@media (prefers-reduced-motion: reduce)"

const lightColor = {
  // Surfaces
  bg: "oklch(98.6% 0.002 265)",
  surface: "oklch(100% 0 0)",
  surfaceMuted: "oklch(96.6% 0.003 265)",
  surfaceHover: "oklch(95% 0.004 265)",
  surfaceActive: "oklch(92.6% 0.005 265)",
  surfaceInverse: "oklch(25% 0.012 265)",
  overlay: "oklch(20% 0.01 265 / 0.32)",

  // Text
  text: "oklch(23% 0.012 265)",
  textMuted: "oklch(48% 0.014 265)",
  textSubtle: "oklch(60% 0.012 265)",
  textInverse: "oklch(98% 0.002 265)",

  // Lines
  border: "oklch(91.6% 0.005 265)",
  borderStrong: "oklch(85.5% 0.007 265)",
  focus: "oklch(58% 0.17 268)",

  // Intents: a solid fill, its hover, the text on it, and a subtle tint with its text
  accent: "oklch(52% 0.18 268)",
  accentHover: "oklch(47% 0.18 268)",
  onAccent: "oklch(99% 0 0)",
  accentSubtle: "oklch(95.6% 0.022 268)",
  accentSubtleText: "oklch(45% 0.16 268)",

  danger: "oklch(53% 0.19 25)",
  dangerHover: "oklch(48% 0.18 25)",
  onDanger: "oklch(99% 0 0)",
  dangerSubtle: "oklch(96% 0.018 25)",
  dangerSubtleText: "oklch(47% 0.17 25)",

  warning: "oklch(73% 0.15 70)",
  warningSubtle: "oklch(96.5% 0.035 85)",
  warningSubtleText: "oklch(47% 0.1 60)",

  success: "oklch(62% 0.15 152)",
  successSubtle: "oklch(96.2% 0.028 155)",
  successSubtleText: "oklch(43% 0.11 155)",

  // Session states (GLOSSARY.md): a dot colour, a tint, and the text on the tint
  sessionActive: "oklch(62% 0.15 152)",
  sessionActiveSubtle: "oklch(96.2% 0.028 155)",
  sessionActiveText: "oklch(43% 0.11 155)",
  sessionAsleep: "oklch(62% 0.06 285)",
  sessionAsleepSubtle: "oklch(96.2% 0.012 285)",
  sessionAsleepText: "oklch(45% 0.06 285)",
  sessionFrozen: "oklch(66% 0.11 225)",
  sessionFrozenSubtle: "oklch(96.2% 0.022 225)",
  sessionFrozenText: "oklch(44% 0.09 230)",
  sessionArchived: "oklch(70% 0.006 265)",
  sessionArchivedSubtle: "oklch(96.6% 0.003 265)",
  sessionArchivedText: "oklch(48% 0.014 265)",

  // Avatars: each person gets a hue; lightness and chroma of the fill and the initials come from here
  avatarBgLightness: "90%",
  avatarBgChroma: "0.045",
  avatarFgLightness: "38%",
  avatarFgChroma: "0.09",
}

const darkColor: typeof lightColor = {
  bg: "oklch(16.5% 0.006 265)",
  surface: "oklch(19.5% 0.007 265)",
  surfaceMuted: "oklch(22.5% 0.008 265)",
  surfaceHover: "oklch(25% 0.009 265)",
  surfaceActive: "oklch(28.5% 0.01 265)",
  surfaceInverse: "oklch(93% 0.004 265)",
  overlay: "oklch(5% 0 0 / 0.6)",

  text: "oklch(93.5% 0.005 265)",
  textMuted: "oklch(72% 0.01 265)",
  textSubtle: "oklch(58% 0.012 265)",
  textInverse: "oklch(20% 0.01 265)",

  border: "oklch(28.5% 0.009 265)",
  borderStrong: "oklch(35% 0.011 265)",
  focus: "oklch(68% 0.15 268)",

  accent: "oklch(55% 0.18 268)",
  accentHover: "oklch(60% 0.17 268)",
  onAccent: "oklch(99% 0 0)",
  accentSubtle: "oklch(29% 0.06 268)",
  accentSubtleText: "oklch(82% 0.09 268)",

  danger: "oklch(55% 0.19 25)",
  dangerHover: "oklch(60% 0.19 25)",
  onDanger: "oklch(99% 0 0)",
  dangerSubtle: "oklch(29% 0.06 25)",
  dangerSubtleText: "oklch(82% 0.09 25)",

  warning: "oklch(78% 0.14 75)",
  warningSubtle: "oklch(30% 0.045 75)",
  warningSubtleText: "oklch(86% 0.1 85)",

  success: "oklch(70% 0.15 152)",
  successSubtle: "oklch(29% 0.045 155)",
  successSubtleText: "oklch(84% 0.11 155)",

  sessionActive: "oklch(70% 0.15 152)",
  sessionActiveSubtle: "oklch(29% 0.045 155)",
  sessionActiveText: "oklch(84% 0.11 155)",
  sessionAsleep: "oklch(68% 0.06 285)",
  sessionAsleepSubtle: "oklch(28% 0.03 285)",
  sessionAsleepText: "oklch(83% 0.04 285)",
  sessionFrozen: "oklch(75% 0.1 225)",
  sessionFrozenSubtle: "oklch(29% 0.04 230)",
  sessionFrozenText: "oklch(85% 0.07 225)",
  sessionArchived: "oklch(55% 0.008 265)",
  sessionArchivedSubtle: "oklch(22.5% 0.008 265)",
  sessionArchivedText: "oklch(72% 0.01 265)",

  avatarBgLightness: "34%",
  avatarBgChroma: "0.05",
  avatarFgLightness: "88%",
  avatarFgChroma: "0.06",
}

export const color = stylex.defineVars({
  bg: { default: lightColor.bg, [DARK]: darkColor.bg },
  surface: { default: lightColor.surface, [DARK]: darkColor.surface },
  surfaceMuted: { default: lightColor.surfaceMuted, [DARK]: darkColor.surfaceMuted },
  surfaceHover: { default: lightColor.surfaceHover, [DARK]: darkColor.surfaceHover },
  surfaceActive: { default: lightColor.surfaceActive, [DARK]: darkColor.surfaceActive },
  surfaceInverse: { default: lightColor.surfaceInverse, [DARK]: darkColor.surfaceInverse },
  overlay: { default: lightColor.overlay, [DARK]: darkColor.overlay },

  text: { default: lightColor.text, [DARK]: darkColor.text },
  textMuted: { default: lightColor.textMuted, [DARK]: darkColor.textMuted },
  textSubtle: { default: lightColor.textSubtle, [DARK]: darkColor.textSubtle },
  textInverse: { default: lightColor.textInverse, [DARK]: darkColor.textInverse },

  border: { default: lightColor.border, [DARK]: darkColor.border },
  borderStrong: { default: lightColor.borderStrong, [DARK]: darkColor.borderStrong },
  focus: { default: lightColor.focus, [DARK]: darkColor.focus },

  accent: { default: lightColor.accent, [DARK]: darkColor.accent },
  accentHover: { default: lightColor.accentHover, [DARK]: darkColor.accentHover },
  onAccent: { default: lightColor.onAccent, [DARK]: darkColor.onAccent },
  accentSubtle: { default: lightColor.accentSubtle, [DARK]: darkColor.accentSubtle },
  accentSubtleText: { default: lightColor.accentSubtleText, [DARK]: darkColor.accentSubtleText },

  danger: { default: lightColor.danger, [DARK]: darkColor.danger },
  dangerHover: { default: lightColor.dangerHover, [DARK]: darkColor.dangerHover },
  onDanger: { default: lightColor.onDanger, [DARK]: darkColor.onDanger },
  dangerSubtle: { default: lightColor.dangerSubtle, [DARK]: darkColor.dangerSubtle },
  dangerSubtleText: { default: lightColor.dangerSubtleText, [DARK]: darkColor.dangerSubtleText },

  warning: { default: lightColor.warning, [DARK]: darkColor.warning },
  warningSubtle: { default: lightColor.warningSubtle, [DARK]: darkColor.warningSubtle },
  warningSubtleText: {
    default: lightColor.warningSubtleText,
    [DARK]: darkColor.warningSubtleText,
  },

  success: { default: lightColor.success, [DARK]: darkColor.success },
  successSubtle: { default: lightColor.successSubtle, [DARK]: darkColor.successSubtle },
  successSubtleText: {
    default: lightColor.successSubtleText,
    [DARK]: darkColor.successSubtleText,
  },

  sessionActive: { default: lightColor.sessionActive, [DARK]: darkColor.sessionActive },
  sessionActiveSubtle: {
    default: lightColor.sessionActiveSubtle,
    [DARK]: darkColor.sessionActiveSubtle,
  },
  sessionActiveText: {
    default: lightColor.sessionActiveText,
    [DARK]: darkColor.sessionActiveText,
  },
  sessionAsleep: { default: lightColor.sessionAsleep, [DARK]: darkColor.sessionAsleep },
  sessionAsleepSubtle: {
    default: lightColor.sessionAsleepSubtle,
    [DARK]: darkColor.sessionAsleepSubtle,
  },
  sessionAsleepText: {
    default: lightColor.sessionAsleepText,
    [DARK]: darkColor.sessionAsleepText,
  },
  sessionFrozen: { default: lightColor.sessionFrozen, [DARK]: darkColor.sessionFrozen },
  sessionFrozenSubtle: {
    default: lightColor.sessionFrozenSubtle,
    [DARK]: darkColor.sessionFrozenSubtle,
  },
  sessionFrozenText: {
    default: lightColor.sessionFrozenText,
    [DARK]: darkColor.sessionFrozenText,
  },
  sessionArchived: { default: lightColor.sessionArchived, [DARK]: darkColor.sessionArchived },
  sessionArchivedSubtle: {
    default: lightColor.sessionArchivedSubtle,
    [DARK]: darkColor.sessionArchivedSubtle,
  },
  sessionArchivedText: {
    default: lightColor.sessionArchivedText,
    [DARK]: darkColor.sessionArchivedText,
  },

  avatarBgLightness: {
    default: lightColor.avatarBgLightness,
    [DARK]: darkColor.avatarBgLightness,
  },
  avatarBgChroma: { default: lightColor.avatarBgChroma, [DARK]: darkColor.avatarBgChroma },
  avatarFgLightness: {
    default: lightColor.avatarFgLightness,
    [DARK]: darkColor.avatarFgLightness,
  },
  avatarFgChroma: { default: lightColor.avatarFgChroma, [DARK]: darkColor.avatarFgChroma },
})

const lightShadow = {
  sm: "0 1px 2px oklch(20% 0.01 265 / 0.06)",
  md: "0 4px 12px -2px oklch(20% 0.01 265 / 0.1), 0 1px 3px oklch(20% 0.01 265 / 0.06)",
  lg: "0 16px 40px -8px oklch(20% 0.01 265 / 0.18), 0 2px 6px oklch(20% 0.01 265 / 0.06)",
}

const darkShadow: typeof lightShadow = {
  sm: "0 1px 2px oklch(0% 0 0 / 0.3)",
  md: "0 4px 12px -2px oklch(0% 0 0 / 0.45), 0 0 0 1px oklch(100% 0 0 / 0.04)",
  lg: "0 16px 40px -8px oklch(0% 0 0 / 0.6), 0 0 0 1px oklch(100% 0 0 / 0.05)",
}

export const shadow = stylex.defineVars({
  sm: { default: lightShadow.sm, [DARK]: darkShadow.sm },
  md: { default: lightShadow.md, [DARK]: darkShadow.md },
  lg: { default: lightShadow.lg, [DARK]: darkShadow.lg },
})

/** Forces the light palette on a subtree, whatever the OS prefers. */
export const lightColorTheme = stylex.createTheme(color, lightColor)
export const lightShadowTheme = stylex.createTheme(shadow, lightShadow)
/** Forces the dark palette on a subtree, whatever the OS prefers. */
export const darkColorTheme = stylex.createTheme(color, darkColor)
export const darkShadowTheme = stylex.createTheme(shadow, darkShadow)

// The terminal mirror's palette: its ground and text match the surface it sits on, and the 16
// ANSI colours are picked to read on it. In hex, because xterm.js draws with these and parses
// only hex and rgb() without a canvas.
const lightTerminal = {
  background: "#ffffff",
  foreground: "#1a1d23",
  cursor: "#3d5dcf",
  selection: "#d7def7",
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#7d4e00",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#633c01",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
}

const darkTerminal: typeof lightTerminal = {
  background: "#131518",
  foreground: "#e8e9ed",
  cursor: "#7192f4",
  selection: "#2c3a66",
  black: "#484f58",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
}

export const terminal = stylex.defineVars({
  background: { default: lightTerminal.background, [DARK]: darkTerminal.background },
  foreground: { default: lightTerminal.foreground, [DARK]: darkTerminal.foreground },
  cursor: { default: lightTerminal.cursor, [DARK]: darkTerminal.cursor },
  selection: { default: lightTerminal.selection, [DARK]: darkTerminal.selection },
  black: { default: lightTerminal.black, [DARK]: darkTerminal.black },
  red: { default: lightTerminal.red, [DARK]: darkTerminal.red },
  green: { default: lightTerminal.green, [DARK]: darkTerminal.green },
  yellow: { default: lightTerminal.yellow, [DARK]: darkTerminal.yellow },
  blue: { default: lightTerminal.blue, [DARK]: darkTerminal.blue },
  magenta: { default: lightTerminal.magenta, [DARK]: darkTerminal.magenta },
  cyan: { default: lightTerminal.cyan, [DARK]: darkTerminal.cyan },
  white: { default: lightTerminal.white, [DARK]: darkTerminal.white },
  brightBlack: { default: lightTerminal.brightBlack, [DARK]: darkTerminal.brightBlack },
  brightRed: { default: lightTerminal.brightRed, [DARK]: darkTerminal.brightRed },
  brightGreen: { default: lightTerminal.brightGreen, [DARK]: darkTerminal.brightGreen },
  brightYellow: { default: lightTerminal.brightYellow, [DARK]: darkTerminal.brightYellow },
  brightBlue: { default: lightTerminal.brightBlue, [DARK]: darkTerminal.brightBlue },
  brightMagenta: { default: lightTerminal.brightMagenta, [DARK]: darkTerminal.brightMagenta },
  brightCyan: { default: lightTerminal.brightCyan, [DARK]: darkTerminal.brightCyan },
  brightWhite: { default: lightTerminal.brightWhite, [DARK]: darkTerminal.brightWhite },
})

export const lightTerminalTheme = stylex.createTheme(terminal, lightTerminal)
export const darkTerminalTheme = stylex.createTheme(terminal, darkTerminal)

export const font = stylex.defineVars({
  sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  mono: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace',
})

/** The type scale. Dense on purpose: 13px body, like the tools this sits next to. */
export const text = stylex.defineVars({
  xs: "0.6875rem", // 11px: badges, counts
  sm: "0.75rem", // 12px: secondary text, descriptions
  base: "0.8125rem", // 13px: body and controls
  md: "0.875rem", // 14px: emphasised body
  lg: "1rem", // 16px: dialog titles
  xl: "1.25rem", // 20px: page titles
  xxl: "1.5rem", // 24px: rare
})

export const leading = stylex.defineVars({
  tight: "1.25",
  snug: "1.4",
  normal: "1.55",
})

export const weight = stylex.defineVars({
  normal: "400",
  medium: "500",
  semibold: "600",
})

export const tracking = stylex.defineVars({
  tight: "-0.011em",
})

/** Spacing on a 4px grid. Keys are multiples of 4px: `s3` is 12px, `s0_5` is 2px. */
export const space = stylex.defineVars({
  s0_5: "0.125rem",
  s1: "0.25rem",
  s1_5: "0.375rem",
  s2: "0.5rem",
  s2_5: "0.625rem",
  s3: "0.75rem",
  s4: "1rem",
  s5: "1.25rem",
  s6: "1.5rem",
  s8: "2rem",
  s10: "2.5rem",
  s12: "3rem",
  s16: "4rem",
})

/** Control heights, shared by buttons, inputs and selects so they line up in a row. */
export const control = stylex.defineVars({
  sm: "1.5rem",
  md: "2rem",
  lg: "2.5rem",
})

/**
 * The app's chrome. The Sidebar's header, the top bar on narrow screens and a PageHeader's title
 * row share one height, so the page's title sits level with the brand beside it.
 */
export const chrome = stylex.defineVars({
  barHeight: "2.75rem",
})

export const radius = stylex.defineVars({
  sm: "4px",
  md: "6px",
  lg: "8px",
  xl: "12px",
  full: "9999px",
})

/** Durations collapse to zero, and entering popups stop moving, under reduced motion. */
export const motion = stylex.defineVars({
  durationFast: { default: "100ms", [REDUCED_MOTION]: "0ms" },
  durationNormal: { default: "150ms", [REDUCED_MOTION]: "0ms" },
  durationSlow: { default: "250ms", [REDUCED_MOTION]: "0ms" },
  easeStandard: "cubic-bezier(0.2, 0, 0, 1)",
  easeOut: "cubic-bezier(0.16, 1, 0.3, 1)",
  easeIn: "cubic-bezier(0.4, 0, 1, 1)",
  /** How much popups scale and travel as they enter and leave. */
  enterScale: { default: "0.97", [REDUCED_MOTION]: "1" },
  enterDistance: { default: "4px", [REDUCED_MOTION]: "0px" },
})

/**
 * Stacking order for the portaled layers. Popovers (menus, selects, popovers) sit above dialogs:
 * a popover is anchored to something already on screen, often inside a dialog, so it must never
 * open underneath it.
 */
export const layer = stylex.defineVars({
  dialog: "100",
  popover: "150",
  toast: "200",
  tooltip: "300",
})
