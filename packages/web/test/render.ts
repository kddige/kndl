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
      // The toast manager is one for the whole process, so a toast left open outlives the test,
      // and slows the tests after it enough that they miss short-lived states they wait for.
      const { toast } = await import("../src/ui/Toast.tsx")
      await act(async () => toast.close())
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

/**
 * The open dialog, never a toast. Base UI renders each toast as a `role="dialog"` with a
 * `data-type`, so a toast shown after a save would otherwise be found first, and stand in for the
 * dialog until it times out.
 */
export function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="dialog"]:not([data-type])')
}

/**
 * Opens the menu behind the button named `trigger`, such as a row's "Actions for studio", and
 * chooses its item named `item`. Throws if the menu has no such item, or it's disabled.
 */
export async function menuItem(
  trigger: string,
  item: string,
  within: ParentNode = document,
): Promise<void> {
  await step(() => button(trigger, within).click())
  await settle(10)
  const found = menuItems().find((el) => el.textContent?.trim() === item)
  if (found === undefined) {
    const names = menuItems().map((el) => el.textContent?.trim())
    throw new Error(`no "${item}" in the menu of "${trigger}": ${names.join(", ")}`)
  }
  if (found.hasAttribute("data-disabled")) throw new Error(`"${item}" is disabled`)
  await step(() => found.click())
  await settle(10)
}

/** The items of the menu that's open, by their text. */
export function menuItems(): Array<HTMLElement> {
  return [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')]
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

/** The Session view's ⋯ menu's item named `name`, opening the menu; undefined if it has none. */
export async function sessionMenuItem(
  name: string,
  within: ParentNode = document,
): Promise<HTMLElement | undefined> {
  if (!document.querySelector('[role="menu"]')) {
    await step(() => button("Session actions", within).click())
    await settle(20)
  }
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent?.trim() === name,
  )
}

/** Whether the Session view's ⋯ menu offers `name`, enabled; closes the menu again. */
export async function sessionOffers(name: string, within: ParentNode = document): Promise<boolean> {
  const item = await sessionMenuItem(name, within)
  const enabled = item !== undefined && !item.hasAttribute("data-disabled")
  await step(() => button("Session actions", within).click())
  await settle(50)
  return enabled
}

/** Chooses `name` from the Session view's ⋯ menu. */
export async function chooseSessionAction(
  name: string,
  within: ParentNode = document,
): Promise<void> {
  const item = await sessionMenuItem(name, within)
  if (!item) throw new Error(`no "${name}" in the Session's menu`)
  await step(() => item.click())
  await settle(50)
}
