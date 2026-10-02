import { afterEach, describe, expect, test } from "bun:test"
import { installDom } from "./dom.ts"
import { render, settle } from "./render.ts"

installDom()
const { Avatar, AvatarStack } = await import("../src/ui/index.ts")

// Stands in for the browser's image loader: a URL containing "broken" fails, any other loads.
class FakeImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  referrerPolicy = ""
  crossOrigin: string | null = null
  set src(url: string) {
    setTimeout(() => (url.includes("broken") ? this.onerror?.() : this.onload?.()), 0)
  }
}
// @ts-expect-error -- a stand-in with the few members Base UI uses
window.Image = FakeImage

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

const goodUrl = "https://avatars.githubusercontent.com/u/1?v=4"
const brokenUrl = "https://avatars.githubusercontent.com/broken"

describe("Avatar", () => {
  test("shows the initials when there is no picture", async () => {
    const { container, unmount } = await render(<Avatar name="Ada Lovelace" />)
    cleanup = unmount
    await settle(400)

    expect(container.querySelector("img")).toBeNull()
    expect(container.textContent).toBe("AL")
  })

  test("shows the picture once it loads", async () => {
    const { container, unmount } = await render(<Avatar name="Ada Lovelace" src={goodUrl} />)
    cleanup = unmount
    await settle(400)

    expect(container.querySelector("img")?.getAttribute("src")).toBe(goodUrl)
    expect(container.textContent).toBe("")
  })

  test("falls back to the initials when the picture fails to load", async () => {
    const { container, unmount } = await render(<Avatar name="Ada Lovelace" src={brokenUrl} />)
    cleanup = unmount
    await settle(400)

    expect(container.querySelector("img")).toBeNull()
    expect(container.textContent).toBe("AL")
  })

  test("keeps the name for screen readers whichever shows", async () => {
    const { container, unmount } = await render(<Avatar name="Ada Lovelace" src={brokenUrl} />)
    cleanup = unmount
    await settle(400)

    expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Ada Lovelace")
  })
})

describe("AvatarStack", () => {
  test("shows each person's picture, or their initials when they have none", async () => {
    const { container, unmount } = await render(
      <AvatarStack
        label="Participants"
        people={[
          { id: "1", name: "Ada Lovelace", src: goodUrl },
          { id: "2", name: "Grace Hopper" },
        ]}
      />,
    )
    cleanup = unmount
    await settle(400)

    expect(container.querySelectorAll("img")).toHaveLength(1)
    expect(container.textContent).toBe("GH")
  })
})
