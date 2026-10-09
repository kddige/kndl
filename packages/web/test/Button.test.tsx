import { afterEach, describe, expect, mock, test } from "bun:test"
import { installDom } from "./dom.ts"
import { button, render, step } from "./render.ts"

installDom()
const { Button } = await import("../src/ui/index.ts")

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

describe("Button", () => {
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
})
