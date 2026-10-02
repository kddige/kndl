import { beforeAll, describe, expect, mock, test } from "bun:test"
import { installDom } from "./dom.ts"
import { button, render, settle, step } from "./render.ts"

let unmount: (() => Promise<void>) | undefined
installDom(async () => {
  await step(() => toast.close())
  await unmount?.()
})
const { toast, UIProvider } = await import("../src/ui/index.ts")

beforeAll(async () => {
  ;({ unmount } = await render(
    <UIProvider>
      <p>page</p>
    </UIProvider>,
  ))
})

/** The open toast whose text includes `title`. Closing toasts are already gone from this list. */
function findToast(title: string): HTMLElement | undefined {
  // A toast is a non-modal dialog; a danger toast an alertdialog.
  const roots = document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')
  return [...roots].find(
    (el) => !el.hasAttribute("data-ending-style") && el.textContent?.includes(title),
  )
}

describe("toast", () => {
  test("shows a title and description, and closes by id", async () => {
    let id = ""
    await step(() => {
      id = toast.show({ title: "Link copied", description: "Paste it anywhere." })
    })
    const el = findToast("Link copied")
    expect(el?.textContent).toContain("Paste it anywhere.")

    await step(() => toast.close(id))
    await settle()
    expect(findToast("Link copied")).toBeUndefined()
  })

  test("the action runs once and closes the toast (Undo)", async () => {
    const onUndo = mock(() => {})
    await step(() => {
      toast.show({ title: "Session archived", action: { label: "Undo", onAction: onUndo } })
    })
    const el = findToast("Session archived")
    if (!el) throw new Error("toast not shown")
    await step(() => button("Undo", el).click())
    expect(onUndo).toHaveBeenCalledTimes(1)
    await settle()
    expect(findToast("Session archived")).toBeUndefined()
  })

  test("Dismiss closes it", async () => {
    await step(() => {
      toast.show({ title: "Runner connected", intent: "success" })
    })
    const el = findToast("Runner connected")
    if (!el) throw new Error("toast not shown")
    await step(() => button("Dismiss", el).click())
    await settle()
    expect(findToast("Runner connected")).toBeUndefined()
  })

  test("showing an open id replaces it instead of stacking", async () => {
    await step(() => {
      toast.show({ id: "sync", title: "Syncing…" })
    })
    await step(() => {
      toast.show({ id: "sync", title: "Synced" })
    })
    expect(findToast("Synced")).toBeDefined()
    expect(findToast("Syncing…")).toBeUndefined()
  })
})
