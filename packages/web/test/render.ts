import { act, type ReactNode } from "react"
import type { Root } from "react-dom/client"

declare global {
  // Tells React that act() is in use, so it doesn't warn about un-awaited updates.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

/** Renders into a fresh container on document.body; call `unmount()` when done. */
export async function render(
  ui: ReactNode,
): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  // Loaded here rather than imported, so React DOM loads after installDom() and sees the DOM.
  const { createRoot } = await import("react-dom/client")
  const container = document.createElement("div")
  document.body.append(container)
  let root: Root | undefined
  await act(async () => {
    root = createRoot(container)
    root.render(ui)
  })
  return {
    container,
    unmount: async () => {
      await act(async () => root?.unmount())
      container.remove()
    },
  }
}

/** Runs `fn` (a click, a toast.show) and lets React flush what it causes. */
export async function step(fn: () => unknown): Promise<void> {
  await act(async () => {
    fn()
  })
}

/** Lets exit animations and their timers finish. */
export async function settle(ms = 50): Promise<void> {
  await act(async () => {
    await Bun.sleep(ms)
  })
}

/** Finds the one button whose accessible name (text or aria-label) is `name`. */
export function button(name: string, within: ParentNode = document): HTMLButtonElement {
  const matches = [...within.querySelectorAll("button")].filter(
    (el) => (el.getAttribute("aria-label") ?? el.textContent?.trim()) === name,
  )
  if (matches.length !== 1)
    throw new Error(`expected one "${name}" button, found ${matches.length}`)
  return matches[0] as HTMLButtonElement
}
