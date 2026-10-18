import { type KeyboardEvent, useCallback, useEffect } from "react"

/**
 * Makes a list of rows one Tab stop (#400). A row is a link in an `li`, or any element marked
 * `data-roving-row`, such as a group's ⋯ menu. Tab enters at the row last focused, or the
 * current one, or the first; ↑ ↓ move between rows, Home and End jump; → opens a row's nested list
 * and moves into it, ← folds it or moves out to its parent row. A nested list's toggle is a button
 * with `aria-expanded` beside the row's link, in the same `li`; it leaves the Tab order too.
 *
 * Takes the list's container, from a callback ref kept in state so this runs again when it mounts,
 * and returns the keydown handler for it.
 */
export function useRovingRows(root: HTMLElement | null) {
  useEffect(() => {
    if (!root) return
    const apply = () => {
      const links = rows(root)
      const focused = links.find((link) => link === document.activeElement)
      const active =
        focused ??
        links.find((link) => link.dataset["rovingActive"] === "") ??
        links.find((link) => link.getAttribute("aria-current") === "page") ??
        links[0]
      for (const link of links) link.tabIndex = link === active ? 0 : -1
      for (const toggle of root.querySelectorAll<HTMLElement>(
        "li button[aria-expanded]:not([aria-haspopup])",
      ))
        toggle.tabIndex = -1
    }
    apply()
    const observer = new MutationObserver(apply)
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-current", "hidden"],
    })
    const remember = (event: FocusEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      if (!target || !rows(root).includes(target)) return
      for (const link of rows(root)) delete link.dataset["rovingActive"]
      target.dataset["rovingActive"] = ""
      apply()
    }
    root.addEventListener("focusin", remember)
    return () => {
      observer.disconnect()
      root.removeEventListener("focusin", remember)
    }
  }, [root])

  return useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const link = event.target instanceof HTMLElement ? event.target : null
      if (!root || !link || event.altKey || event.ctrlKey || event.metaKey) return
      const links = rows(root)
      const at = links.indexOf(link)
      if (at === -1) return
      const item = link.closest("li")
      const toggle = item?.querySelector<HTMLButtonElement>(
        ":scope > div button[aria-expanded]:not([aria-haspopup])",
      )
      const go = (target: HTMLElement | undefined) => {
        if (!target) return
        event.preventDefault()
        target.focus()
      }
      switch (event.key) {
        case "ArrowDown":
          return go(links[at + 1])
        case "ArrowUp":
          return go(links[at - 1])
        case "Home":
          return go(links[0])
        case "End":
          return go(links.at(-1))
        case "ArrowRight":
          if (!toggle) return
          event.preventDefault()
          if (toggle.getAttribute("aria-expanded") === "false") toggle.click()
          else go(item?.querySelector<HTMLAnchorElement>(":scope > ul a") ?? undefined)
          return
        case "ArrowLeft": {
          if (toggle?.getAttribute("aria-expanded") === "true") {
            event.preventDefault()
            toggle.click()
            return
          }
          const parent = item?.parentElement?.closest("li")
          go(parent?.querySelector<HTMLAnchorElement>(":scope > div a") ?? undefined)
          return
        }
      }
    },
    [root],
  )
}

/** The rows, in order, skipping those in a folded list. */
function rows(root: HTMLElement): Array<HTMLElement> {
  return [...root.querySelectorAll<HTMLElement>("li a[href], [data-roving-row]")].filter(
    (link) => link.closest("[hidden]") === null,
  )
}
