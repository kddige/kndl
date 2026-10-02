import { afterEach, describe, expect, mock, test } from "bun:test"
import { installDom } from "./dom.ts"
import { button, render, step } from "./render.ts"

installDom()
const { Button, IconButton, UIProvider } = await import("../src/ui/index.ts")

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

describe("Button", () => {
  test("is a native button that runs onClick", async () => {
    const onClick = mock(() => {})
    const { unmount } = await render(
      <Button intent="primary" onClick={onClick}>
        Start Session
      </Button>,
    )
    cleanup = unmount
    const el = button("Start Session")
    expect(el.type).toBe("button")
    expect(el.dataset["intent"]).toBe("primary")
    // StyleX compiled the styles into class names.
    expect(el.className).not.toBe("")
    await step(() => el.click())
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  test("defaults to the secondary intent", async () => {
    const { unmount } = await render(<Button>Cancel</Button>)
    cleanup = unmount
    expect(button("Cancel").dataset["intent"]).toBe("secondary")
  })

  test("while loading: busy, ignores clicks, stays focusable and keeps its label", async () => {
    const onClick = mock(() => {})
    const { unmount } = await render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    )
    cleanup = unmount
    const el = button("Save")
    expect(el.getAttribute("aria-busy")).toBe("true")
    expect(el.getAttribute("aria-disabled")).toBe("true")
    expect(el.disabled).toBe(false)
    el.focus()
    expect(document.activeElement).toBe(el)
    await step(() => el.click())
    expect(onClick).not.toHaveBeenCalled()
  })

  test("disabled leaves the tab order", async () => {
    const { unmount } = await render(<Button disabled>Delete</Button>)
    cleanup = unmount
    expect(button("Delete").disabled).toBe(true)
  })

  test("IconButton is named by its label", async () => {
    const { unmount } = await render(
      <UIProvider>
        <IconButton label="New Session">+</IconButton>
      </UIProvider>,
    )
    cleanup = unmount
    expect(button("New Session").getAttribute("aria-label")).toBe("New Session")
  })
})
