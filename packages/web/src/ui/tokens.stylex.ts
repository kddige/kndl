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
  bg: "oklch(97.9% 0.009 85)",
  surface: "oklch(99.5% 0.004 85)",
  surfaceMuted: "oklch(96.3% 0.01 82)",
  surfaceHover: "oklch(94.7% 0.012 80)",
  surfaceActive: "oklch(92.3% 0.015 78)",
  surfaceInverse: "oklch(25% 0.018 48)",
  overlay: "oklch(22% 0.02 45 / 0.32)",

  // Text
  text: "oklch(24% 0.018 47)",
  textSecondary: "oklch(47% 0.024 55)",
  textTertiary: "oklch(53.5% 0.022 60)",
  textInverse: "oklch(97.5% 0.012 85)",

  // Lines
  border: "oklch(89.2% 0.015 80)",
  borderStrong: "oklch(83.5% 0.021 78)",
  focus: "oklch(60% 0.125 85)",

  // Intents: `{intent}` is the solid, then `{intent}Hover`, `on{Intent}` for text on the solid,
  // `{intent}Tint` for a tinted background, and `{intent}Text`, valid on the tint, `surface` and `bg`
  accent: "oklch(41% 0.07 50)",
  accentHover: "oklch(36% 0.062 48)",
  onAccent: "oklch(98.5% 0.012 85)",
  accentTint: "oklch(92.6% 0.03 72)",
  accentText: "oklch(38% 0.065 45)",

  danger: "oklch(56.5% 0.175 30)",
  dangerHover: "oklch(51% 0.17 29)",
  onDanger: "oklch(98.5% 0.012 85)",
  dangerTint: "oklch(95.2% 0.028 15)",
  dangerText: "oklch(52% 0.17 34)",

  warning: "oklch(72.5% 0.15 68)",
  warningTint: "oklch(95.8% 0.048 92)",
  warningText: "oklch(45% 0.095 65)",

  success: "oklch(61% 0.145 150)",
  successTint: "oklch(95.8% 0.03 150)",
  successText: "oklch(42% 0.105 152)",

  // Session states (GLOSSARY.md), in the same shape: a dot colour, its tint, and its text
  sessionActive: "oklch(61% 0.145 150)",
  sessionActiveTint: "oklch(95.8% 0.03 150)",
  sessionActiveText: "oklch(42% 0.105 152)",
  sessionAsleep: "oklch(60% 0.065 295)",
  sessionAsleepTint: "oklch(95.6% 0.016 300)",
  sessionAsleepText: "oklch(44% 0.065 295)",
  sessionFrozen: "oklch(65% 0.11 225)",
  sessionFrozenTint: "oklch(95.8% 0.022 225)",
  sessionFrozenText: "oklch(43% 0.09 230)",
  sessionArchived: "oklch(68% 0.014 70)",
  sessionArchivedTint: "oklch(96.3% 0.01 82)",
  sessionArchivedText: "oklch(47% 0.024 55)",

  // A chart's one series (#356): a cool blue that reads apart from the warm accent and the warning
  // amber a chart draws thresholds in, checked against the surface with the dataviz validator
  chartSeries: "oklch(52% 0.13 250)",

  // Avatars: each person gets a hue; lightness and chroma of the fill and the initials come from here
  avatarBgLightness: "90%",
  avatarBgChroma: "0.045",
  avatarFgLightness: "38%",
  avatarFgChroma: "0.09",
}

const darkColor: typeof lightColor = {
  bg: "oklch(18% 0.014 298)",
  surface: "oklch(20.8% 0.016 300)",
  surfaceMuted: "oklch(23.4% 0.017 300)",
  surfaceHover: "oklch(26% 0.018 302)",
  surfaceActive: "oklch(29.5% 0.02 302)",
  surfaceInverse: "oklch(93% 0.014 80)",
  overlay: "oklch(8% 0.02 300 / 0.6)",

  text: "oklch(93% 0.016 80)",
  textSecondary: "oklch(74% 0.018 305)",
  textTertiary: "oklch(63.5% 0.02 305)",
  textInverse: "oklch(21% 0.02 298)",

  border: "oklch(30.5% 0.018 302)",
  borderStrong: "oklch(36.5% 0.022 303)",
  focus: "oklch(85% 0.15 92)",

  accent: "oklch(64% 0.09 52)",
  accentHover: "oklch(69% 0.088 55)",
  onAccent: "oklch(20% 0.02 298)",
  accentTint: "oklch(33% 0.04 56)",
  accentText: "oklch(86% 0.06 68)",

  danger: "oklch(54% 0.2 28)",
  dangerHover: "oklch(50% 0.195 27)",
  onDanger: "oklch(98.5% 0.012 85)",
  dangerTint: "oklch(29.5% 0.075 18)",
  dangerText: "oklch(79% 0.11 20)",

  warning: "oklch(77% 0.145 68)",
  warningTint: "oklch(31% 0.055 92)",
  warningText: "oklch(87% 0.1 90)",

  success: "oklch(74% 0.15 150)",
  successTint: "oklch(29.5% 0.045 155)",
  successText: "oklch(85% 0.105 152)",

  sessionActive: "oklch(74% 0.15 150)",
  sessionActiveTint: "oklch(29.5% 0.045 155)",
  sessionActiveText: "oklch(85% 0.105 152)",
  sessionAsleep: "oklch(68% 0.065 295)",
  sessionAsleepTint: "oklch(29.5% 0.035 298)",
  sessionAsleepText: "oklch(84% 0.045 295)",
  sessionFrozen: "oklch(75% 0.1 225)",
  sessionFrozenTint: "oklch(29.5% 0.04 230)",
  sessionFrozenText: "oklch(85% 0.07 225)",
  sessionArchived: "oklch(56% 0.014 300)",
  sessionArchivedTint: "oklch(23.4% 0.017 300)",
  sessionArchivedText: "oklch(74% 0.018 305)",

  chartSeries: "oklch(66% 0.11 240)",

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
  textSecondary: { default: lightColor.textSecondary, [DARK]: darkColor.textSecondary },
  textTertiary: { default: lightColor.textTertiary, [DARK]: darkColor.textTertiary },
  textInverse: { default: lightColor.textInverse, [DARK]: darkColor.textInverse },

  border: { default: lightColor.border, [DARK]: darkColor.border },
  borderStrong: { default: lightColor.borderStrong, [DARK]: darkColor.borderStrong },
  focus: { default: lightColor.focus, [DARK]: darkColor.focus },

  accent: { default: lightColor.accent, [DARK]: darkColor.accent },
  accentHover: { default: lightColor.accentHover, [DARK]: darkColor.accentHover },
  onAccent: { default: lightColor.onAccent, [DARK]: darkColor.onAccent },
  accentTint: { default: lightColor.accentTint, [DARK]: darkColor.accentTint },
  accentText: { default: lightColor.accentText, [DARK]: darkColor.accentText },

  danger: { default: lightColor.danger, [DARK]: darkColor.danger },
  dangerHover: { default: lightColor.dangerHover, [DARK]: darkColor.dangerHover },
  onDanger: { default: lightColor.onDanger, [DARK]: darkColor.onDanger },
  dangerTint: { default: lightColor.dangerTint, [DARK]: darkColor.dangerTint },
  dangerText: { default: lightColor.dangerText, [DARK]: darkColor.dangerText },

  warning: { default: lightColor.warning, [DARK]: darkColor.warning },
  warningTint: { default: lightColor.warningTint, [DARK]: darkColor.warningTint },
  warningText: {
    default: lightColor.warningText,
    [DARK]: darkColor.warningText,
  },

  success: { default: lightColor.success, [DARK]: darkColor.success },
  successTint: { default: lightColor.successTint, [DARK]: darkColor.successTint },
  successText: {
    default: lightColor.successText,
    [DARK]: darkColor.successText,
  },

  sessionActive: { default: lightColor.sessionActive, [DARK]: darkColor.sessionActive },
  sessionActiveTint: {
    default: lightColor.sessionActiveTint,
    [DARK]: darkColor.sessionActiveTint,
  },
  sessionActiveText: {
    default: lightColor.sessionActiveText,
    [DARK]: darkColor.sessionActiveText,
  },
  sessionAsleep: { default: lightColor.sessionAsleep, [DARK]: darkColor.sessionAsleep },
  sessionAsleepTint: {
    default: lightColor.sessionAsleepTint,
    [DARK]: darkColor.sessionAsleepTint,
  },
  sessionAsleepText: {
    default: lightColor.sessionAsleepText,
    [DARK]: darkColor.sessionAsleepText,
  },
  sessionFrozen: { default: lightColor.sessionFrozen, [DARK]: darkColor.sessionFrozen },
  sessionFrozenTint: {
    default: lightColor.sessionFrozenTint,
    [DARK]: darkColor.sessionFrozenTint,
  },
  sessionFrozenText: {
    default: lightColor.sessionFrozenText,
    [DARK]: darkColor.sessionFrozenText,
  },
  sessionArchived: { default: lightColor.sessionArchived, [DARK]: darkColor.sessionArchived },
  sessionArchivedTint: {
    default: lightColor.sessionArchivedTint,
    [DARK]: darkColor.sessionArchivedTint,
  },
  sessionArchivedText: {
    default: lightColor.sessionArchivedText,
    [DARK]: darkColor.sessionArchivedText,
  },

  chartSeries: { default: lightColor.chartSeries, [DARK]: darkColor.chartSeries },

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
  sm: "0 1px 2px oklch(25% 0.025 50 / 0.06)",
  md: "0 4px 12px -2px oklch(25% 0.025 50 / 0.1), 0 1px 3px oklch(25% 0.025 50 / 0.06)",
  lg: "0 16px 40px -8px oklch(25% 0.025 50 / 0.18), 0 2px 6px oklch(25% 0.025 50 / 0.06)",
}

const darkShadow: typeof lightShadow = {
  sm: "0 1px 2px oklch(5% 0.015 300 / 0.3)",
  md: "0 4px 12px -2px oklch(5% 0.015 300 / 0.45), 0 0 0 1px oklch(95% 0.02 80 / 0.04)",
  lg: "0 16px 40px -8px oklch(5% 0.015 300 / 0.6), 0 0 0 1px oklch(95% 0.02 80 / 0.05)",
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
  background: "#fffdfa",
  foreground: "#271d18",
  cursor: "#693e26",
  selection: "#efd5c1",
  black: "#302722",
  red: "#cf222e",
  green: "#116329",
  yellow: "#7d4e00",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#7c726b",
  brightBlack: "#60564f",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#633c01",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#958e86",
}

const darkTerminal: typeof lightTerminal = {
  background: "#19161e",
  foreground: "#eee7dc",
  cursor: "#b87c58",
  selection: "#573927",
  black: "#514d59",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#c2bdb4",
  brightBlack: "#7c7885",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f7f3eb",
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
  // Inter Variable is bundled (fonts.css); the system stack is its fallback while it loads.
  sans: '"Inter Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  mono: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, "Liberation Mono", monospace',
})

/**
 * The type scale. Dense on purpose: 13px body, like the tools this sits next to. Components set
 * text through the roles in type.ts, which pair a size with its weight and line height.
 */
export const text = stylex.defineVars({
  xs: "0.6875rem", // 11px: badges, counts, overlines
  sm: "0.75rem", // 12px: metadata
  base: "0.8125rem", // 13px: body and controls
  md: "0.875rem", // 14px: section headings
  lg: "1rem", // 16px: page and dialog titles
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
  wide: "0.05em",
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

/**
 * Under reduced motion nothing moves, but things still fade: popups, Dialogs and Toasts keep their
 * durations while enterScale and enterDistance go flat, and what only moves takes durationMove.
 * Exits are shorter than enters, and every one eases out.
 */
export const motion = stylex.defineVars({
  durationFast: "100ms",
  durationNormal: "150ms",
  durationSlow: "250ms",
  /** For a transition that moves something: a thumb, an indicator, a chevron, a height. */
  durationMove: { default: "150ms", [REDUCED_MOTION]: "0ms" },
  easeStandard: "cubic-bezier(0.2, 0, 0, 1)",
  easeOut: "cubic-bezier(0.16, 1, 0.3, 1)",
  /** A pressed Button's scale. */
  pressScale: "0.96",
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

/** An icon's stroke: 1.5px beside regular text, thicker beside the 500–600 labels of Buttons and Tabs. */
export const icon = stylex.defineVars({
  stroke: "1.5px",
})
