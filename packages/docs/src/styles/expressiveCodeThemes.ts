// The code block themes for Expressive Code, in the docs' Paper palette (see theme.css): the
// brand's logs and flame on the page's own surfaces, in place of Starlight's Night Owl. Every
// syntax colour is at least 5.5:1 on its code background, so Expressive Code's contrast
// correction (minSyntaxHighlightingColorContrast, 5.5 by default) leaves them as written.
import type { ExpressiveCodeThemeInput } from "@astrojs/starlight/expressive-code"

type Roles = {
  /** Plain text and arguments. */
  text: string
  /** Commands, functions, operators, properties. */
  call: string
  /** Strings and numbers. */
  literal: string
  /** Keywords, storage, variables, types. */
  keyword: string
  punctuation: string
  comment: string
  deleted: string
}

type Surfaces = {
  code: string
  bar: string
  border: string
  barText: string
  activeTab: string
  selection: string
  lineNumber: string
  focus: string
  scrollbar: string
  scrollbarHover: string
  mark: string
}

function scopes(scope: string[], foreground: string, fontStyle?: string) {
  return { scope, settings: fontStyle ? { foreground, fontStyle } : { foreground } }
}

function paperTheme(
  name: string,
  type: "dark" | "light",
  s: Surfaces,
  c: Roles,
): ExpressiveCodeThemeInput {
  return {
    name,
    type,
    colors: {
      foreground: c.text,
      focusBorder: s.focus,
      "editor.background": s.code,
      "editor.foreground": c.text,
      "editor.selectionBackground": s.selection,
      "editorLineNumber.foreground": s.lineNumber,
      "editorGroupHeader.tabsBackground": s.bar,
      "editorGroupHeader.tabsBorder": s.border,
      "tab.activeBackground": s.code,
      "tab.activeForeground": s.barText,
      "tab.activeBorder": "#00000000",
      "tab.activeBorderTop": s.activeTab,
      "titleBar.activeBackground": s.bar,
      "titleBar.activeForeground": s.barText,
      "titleBar.border": s.border,
      "terminal.background": s.code,
      "scrollbarSlider.background": s.scrollbar,
      "scrollbarSlider.hoverBackground": s.scrollbarHover,
    },
    tokenColors: [
      { settings: { foreground: c.text } },
      scopes(["comment", "punctuation.definition.comment"], c.comment),
      scopes(["string", "constant.numeric", "constant.character", "markup.inline.raw"], c.literal),
      scopes(
        [
          "keyword",
          "storage",
          "storage.type",
          "storage.modifier",
          "variable",
          "support.type",
          "support.class",
          "entity.name.type",
          "entity.name.class",
          "entity.other.attribute-name",
          "entity.other.inherited-class",
        ],
        c.keyword,
      ),
      scopes(
        [
          "entity.name.function",
          "support.function",
          "variable.function",
          "meta.function-call",
          "keyword.control",
          "keyword.operator",
          "keyword.other.special-method",
          "constant.language",
          "constant.other",
          "variable.other.constant",
          "variable.other.property",
          "variable.language",
          "support.type.property-name",
          "entity.name.tag",
          "markup.heading",
          "markup.underline.link",
          "markup.inserted",
        ],
        c.call,
      ),
      scopes(["punctuation", "meta.brace", "punctuation.definition.string"], c.punctuation),
      scopes(["markup.deleted", "invalid"], c.deleted),
      scopes(["markup.bold"], c.text, "bold"),
      scopes(["markup.italic"], c.text, "italic"),
    ],
    styleOverrides: {
      frames: {
        frameBoxShadowCssValue: "none",
        terminalTitlebarDotsForeground: s.border,
        terminalTitlebarDotsOpacity: "0.75",
        inlineButtonForeground: s.barText,
      },
      textMarkers: { markBackground: s.mark, markBorderColor: s.lineNumber },
    },
  }
}

export const paperDark = paperTheme(
  "kndl-paper-dark",
  "dark",
  {
    code: "#221e2a",
    bar: "#1b1823",
    border: "#332d3b",
    barText: "#d8cfc2",
    activeTab: "#c98a5e",
    selection: "#4a362b",
    lineNumber: "#6c6474",
    focus: "#f6c445",
    scrollbar: "#ffffff17",
    scrollbarHover: "#ffffff40",
    mark: "#ffffff17",
  },
  {
    text: "#e2d9cb",
    call: "#f0c27a",
    literal: "#e7c9a9",
    keyword: "#d6b89c",
    punctuation: "#a59dab",
    comment: "#a199a7",
    deleted: "#f59c8b",
  },
)

export const paperLight = paperTheme(
  "kndl-paper-light",
  "light",
  {
    code: "#f6eedd",
    bar: "#eee3cd",
    border: "#e0d2b8",
    barText: "#3f332d",
    activeTab: "#8c5f47",
    selection: "#f1dca8",
    lineNumber: "#a39181",
    focus: "#e3b032",
    scrollbar: "#0000001a",
    scrollbarHover: "#00000055",
    mark: "#0000001a",
  },
  {
    text: "#3a2e28",
    call: "#7a4f38",
    literal: "#5a3b2c",
    keyword: "#7d5128",
    punctuation: "#6b5c51",
    comment: "#685a4f",
    deleted: "#8a2f22",
  },
)
