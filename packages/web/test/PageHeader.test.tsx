import { afterEach, describe, expect, test } from "bun:test"
import { installDom } from "./dom.ts"
import { button, render } from "./render.ts"

installDom()
const { Badge, Button, PageHeader } = await import("../src/ui/index.ts")

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

describe("PageHeader", () => {
  test("heads the page: the title is its h1, beside its badge, over its description", async () => {
    const { container, unmount } = await render(
      <PageHeader
        title="kddige/kndl"
        badge={<Badge>Version 3</Badge>}
        description="What every Sandbox of this Repo is built from."
        actions={<Button size="sm">Shared variables</Button>}
      />,
    )
    cleanup = unmount
    const header = container.querySelector("header")
    const h1 = header?.querySelector("h1")
    expect(h1?.textContent).toBe("kddige/kndl")
    // StyleX compiled the styles into class names.
    expect(h1?.className).not.toBe("")
    // The badge sits in the title's row, not in its name.
    expect(h1?.parentElement?.textContent).toBe("kddige/kndlVersion 3")
    expect(header?.querySelector("p")?.textContent).toBe(
      "What every Sandbox of this Repo is built from.",
    )
    expect(header?.contains(button("Shared variables"))).toBe(true)
  })

  test("a string title is its own tooltip, for when it's cut short", async () => {
    const { container, unmount } = await render(
      <PageHeader title="claude/a-very-long-work-branch-name" />,
    )
    cleanup = unmount
    expect(container.querySelector("h1")?.title).toBe("claude/a-very-long-work-branch-name")
  })

  test("leaves out what it isn't given", async () => {
    const { container, unmount } = await render(
      <PageHeader
        title={
          <>
            Shared <em>variables</em>
          </>
        }
      />,
    )
    cleanup = unmount
    const header = container.querySelector("header")
    expect(header?.querySelector("h1")?.hasAttribute("title")).toBe(false)
    expect(header?.querySelector("p")).toBeNull()
    expect(header?.textContent).toBe("Shared variables")
  })
})
