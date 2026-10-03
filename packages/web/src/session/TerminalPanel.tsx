// The terminal mirror: the Session's Claude Code terminal, live, in xterm.js. Everyone watching
// sees the same screen and can type into it, as the escape hatch for whatever the chat can't do.
//
// One terminal, one size: the Runner's tmux pane. Whoever last typed into it or resized it sets
// that size, fitted to their panel; everyone else draws it at that size, scaled down to fit
// theirs. Typing claims it, and so does the Fit button; after that, resizing your window
// refits it while it's still yours, until someone else claims it.
//
// What the terminal prints goes to xterm only, which draws it as text: never as HTML.

import type { SessionId, SessionSummary, TerminalFrame, TerminalSize } from "@claude-hub/protocol"
import * as stylex from "@stylexjs/stylex"
import { FitAddon } from "@xterm/addon-fit"
import { type ITheme, Terminal } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"
import { useEffect, useRef, useState } from "react"
import { useHub, useHubState } from "../app/hub.tsx"
import { Button, Spinner, toast } from "../ui/index.ts"
import { color, font, radius, space, terminal, text } from "../ui/tokens.stylex.ts"

const styles = stylex.create({
  panel: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    minHeight: 0,
    padding: space.s3,
    gap: space.s2,
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: space.s2,
    minHeight: "1.5rem",
    color: color.textMuted,
    fontSize: text.sm,
  },
  note: { flex: 1, minWidth: 0 },
  size: { fontFamily: font.mono, fontSize: text.xs, color: color.textSubtle },
  frame: {
    position: "relative",
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
    padding: space.s2,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.lg,
    backgroundColor: terminal.background,
  },
  // Fills the frame, so the fit addon measures the frame; a terminal sized by someone else is
  // scaled down from its top left corner to fit.
  host: {
    width: "100%",
    height: "100%",
    transformOrigin: "0 0",
  },
  overlay: {
    position: "absolute",
    inset: 0,
    display: "grid",
    placeItems: "center",
    padding: space.s4,
    backgroundColor: terminal.background,
    color: terminal.foreground,
    fontSize: text.sm,
    textAlign: "center",
  },
  overlayCopy: { maxWidth: "28rem", opacity: 0.8 },
})

/** What the panel says over the terminal when it can't show it. */
function overlayFor(state: SessionSummary["state"]): string | null {
  switch (state) {
    case "Active":
      return null
    case "Asleep":
      return "The Session is Asleep, so Claude Code isn't running. Wake it, or send a prompt, to start its terminal again."
    case "Frozen":
      return "The Session is Frozen: its Runner is offline. The terminal comes back with it."
    case "Archived":
      return "The Session is Archived: its terminal is gone."
  }
}

export function TerminalPanel({ session }: { session: SessionSummary }) {
  const hub = useHub()
  const sessionId = session.id
  const status = useHubState((state) => state.terminals[sessionId]?.status)
  const size = useHubState((state) => state.terminals[sessionId]?.size ?? null)
  const running = session.state === "Active"
  const frameRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const mirror = useRef<Mirror | null>(null)
  const [scaled, setScaled] = useState(false)

  useEffect(() => {
    const frame = frameRef.current
    const host = hostRef.current
    if (!frame || !host) return
    const created = new Mirror(hub, sessionId, frame, host, setScaled)
    mirror.current = created
    return () => {
      created.dispose()
      mirror.current = null
    }
  }, [hub, sessionId])

  useEffect(() => {
    mirror.current?.setRunning(running)
  }, [running])

  const overlay = overlayFor(session.state)
  return (
    <div {...stylex.props(styles.panel)}>
      <div {...stylex.props(styles.toolbar)}>
        <span {...stylex.props(styles.note)}>
          {scaled
            ? "Sized for another viewer's window, so it's scaled down. Type into it, or fit it, to size it for yours."
            : "Claude Code's own terminal, shared with everyone here. Type into it for anything the chat can't do."}
        </span>
        {size && (
          <span {...stylex.props(styles.size)} aria-label="Terminal size">
            {size.cols}×{size.rows}
          </span>
        )}
        <Button
          size="sm"
          intent="secondary"
          disabled={!running || status !== "live"}
          onClick={() => {
            if (!mirror.current?.claim(true)) {
              toast.show({ title: "Not connected to the Hub", intent: "warning" })
            }
          }}
        >
          Fit to my window
        </Button>
      </div>
      <div ref={frameRef} {...stylex.props(styles.frame)}>
        <div
          ref={hostRef}
          role="group"
          aria-label="Claude Code terminal"
          {...stylex.props(styles.host)}
        />
        {overlay !== null ? (
          <div {...stylex.props(styles.overlay)}>
            <p {...stylex.props(styles.overlayCopy)}>{overlay}</p>
          </div>
        ) : (
          status !== "live" && (
            <div {...stylex.props(styles.overlay)}>
              <Spinner label="Connecting to the terminal" />
            </div>
          )
        )}
      </div>
    </div>
  )
}

type HubClient = ReturnType<typeof useHub>

/** One xterm, mirroring one Session's terminal: frames in, keystrokes and resizes out. */
class Mirror {
  readonly #term: Terminal
  readonly #fit = new FitAddon()
  readonly #closeTerminal: () => void
  readonly #cleanups: Array<() => void> = []
  /** The size this viewer last set; while the terminal is still at it, it's theirs. */
  #claimed: TerminalSize | null = null
  /** The terminal's size, from its latest frame. */
  #size: TerminalSize | null = null

  constructor(
    private readonly hub: HubClient,
    private readonly sessionId: SessionId,
    private readonly frame: HTMLElement,
    private readonly host: HTMLElement,
    private readonly onScaled: (scaled: boolean) => void,
  ) {
    this.#term = new Terminal({
      fontFamily: cssValue(frame, font.mono) || "ui-monospace, Menlo, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5_000,
      theme: readTheme(frame),
    })
    this.#term.loadAddon(this.#fit)
    this.#term.open(host)

    const typing = this.#term.onData((data) => {
      // Typing claims the size: fit the terminal to this viewer first, then send the keys.
      this.claim(false)
      this.hub.sendTerminalInput(this.sessionId, data)
    })
    this.#cleanups.push(() => typing.dispose())

    this.#closeTerminal = hub.openTerminal(sessionId, (next) => this.#draw(next))

    const observer = new ResizeObserver(() => this.#layout())
    observer.observe(frame)
    // The drawn screen changes size too, when the font loads: rescale then.
    const screen = host.querySelector(".xterm-screen")
    if (screen) observer.observe(screen)
    this.#cleanups.push(() => observer.disconnect())

    // Follow the theme: a forced one changes <html>'s class, the system one the media query.
    const retheme = () => {
      this.#term.options.theme = readTheme(frame)
    }
    const themeObserver = new MutationObserver(retheme)
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    })
    this.#cleanups.push(() => themeObserver.disconnect())
    const dark = window.matchMedia?.("(prefers-color-scheme: dark)")
    dark?.addEventListener("change", retheme)
    this.#cleanups.push(() => dark?.removeEventListener("change", retheme))
  }

  setRunning(running: boolean): void {
    this.#term.options.disableStdin = !running
    if (!running) this.#term.blur()
  }

  /**
   * Sizes the terminal for this viewer's panel, if it isn't already. `force` claims it even at
   * the same size, so the Runner redraws. False if it couldn't be sent.
   */
  claim(force: boolean): boolean {
    const fitted = this.#fitted()
    if (!fitted) return true
    if (!force && this.#size && sameSize(fitted, this.#size)) {
      this.#claimed = fitted
      return true
    }
    this.#claimed = fitted
    return this.hub.resizeTerminal(this.sessionId, fitted)
  }

  dispose(): void {
    this.#closeTerminal()
    for (const cleanup of this.#cleanups.splice(0)) cleanup()
    this.#term.dispose()
  }

  #draw(frame: TerminalFrame): void {
    const resized = !this.#size || !sameSize(this.#size, frame.size)
    this.#size = frame.size
    if (frame.kind === "Snapshot") {
      // The whole screen: start over, so nothing drawn before shows twice.
      this.#term.reset()
    }
    if (resized) this.#term.resize(frame.size.cols, frame.size.rows)
    this.#term.write(frame.data)
    if (resized) this.#layout()
  }

  /** The panel or the terminal changed size: refit if the size is this viewer's, and rescale. */
  #layout(): void {
    const fitted = this.#fitted()
    if (
      fitted &&
      this.#claimed &&
      this.#size &&
      sameSize(this.#claimed, this.#size) &&
      !sameSize(fitted, this.#size)
    ) {
      this.#claimed = fitted
      this.hub.resizeTerminal(this.sessionId, fitted)
    }
    this.#rescale()
  }

  /** Scales a terminal bigger than the panel down to fit it. */
  #rescale(): void {
    const screen = this.host.querySelector<HTMLElement>(".xterm-screen")
    const width = screen?.offsetWidth ?? 0
    const height = screen?.offsetHeight ?? 0
    // The host's own layout size: its bounding rect is already scaled.
    const roomWidth = this.host.clientWidth
    const roomHeight = this.host.clientHeight
    if (width === 0 || height === 0 || roomWidth === 0) return
    const scale = Math.min(1, roomWidth / width, roomHeight / height)
    this.host.style.transform = scale < 1 ? `scale(${scale})` : ""
    this.onScaled(scale < 0.995)
  }

  /** The size that fits this viewer's panel, unless the panel is hidden or not measurable. */
  #fitted(): TerminalSize | null {
    const proposed = this.#fit.proposeDimensions()
    if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return null
    const cols = Math.max(20, Math.floor(proposed.cols))
    const rows = Math.max(5, Math.floor(proposed.rows))
    return { cols, rows }
  }
}

function sameSize(a: TerminalSize, b: TerminalSize): boolean {
  return a.cols === b.cols && a.rows === b.rows
}

/**
 * A StyleX variable's value where `element` is: the theme in effect there. StyleX compiles a
 * variable to `var(--name)`; xterm needs the colour itself.
 */
function cssValue(element: Element, variable: string): string {
  const name = /^var\((--[^,)]+)/.exec(variable)?.[1]
  if (!name) return variable
  return getComputedStyle(element).getPropertyValue(name).trim()
}

const ansi = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const

/** The terminal palette from the StyleX theme where the terminal is. */
function readTheme(element: Element): ITheme {
  const theme: Record<string, string> = {}
  const set = (key: string, variable: string) => {
    const value = cssValue(element, variable)
    // Unresolved (no stylesheet, as in tests): leave xterm's default.
    if (value !== "" && !value.startsWith("var(")) theme[key] = value
  }
  set("background", terminal.background)
  set("foreground", terminal.foreground)
  set("cursor", terminal.cursor)
  set("cursorAccent", terminal.background)
  set("selectionBackground", terminal.selection)
  for (const name of ansi) set(name, terminal[name])
  return theme
}
