import { beforeAll, describe, expect, test } from "bun:test"
import { installDom } from "./dom.ts"
import { render, settle, step } from "./render.ts"

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
  test("showing an open id replaces it instead of stacking, and closing the id closes it", async () => {
    await step(() => {
      toast.show({ id: "sync", title: "Syncing…" })
    })
    await step(() => {
      toast.show({ id: "sync", title: "Synced", description: "Up to date." })
    })
    expect(findToast("Synced")?.textContent).toContain("Up to date.")
    expect(findToast("Syncing…")).toBeUndefined()

    await step(() => toast.close("sync"))
    await settle()
    expect(findToast("Synced")).toBeUndefined()
  })
})
