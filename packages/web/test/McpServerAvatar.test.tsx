// An MCP server's icon on the MCP page (#230, ADR 0021): the Hub's icon, or the first letter of
// the MCP server's name on a colored tile, the color from the MCP server's id.

import { afterEach, describe, expect, test } from "bun:test"
import { McpServerId } from "@kndl/protocol"
import { installDom } from "./dom.ts"
import { render, settle } from "./render.ts"

installDom()
const { McpServerAvatar, mcpServerIconUrl } = await import("../src/mcp/McpServerAvatar.tsx")

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

describe("mcpServerIconUrl", () => {
  test("is the Hub's route for the MCP server, its id encoded, with the hash to bust the cache", () => {
    expect(mcpServerIconUrl({ id: McpServerId.make("hub:docs-search"), iconHash: "abc123" })).toBe(
      "/mcp/hub%3Adocs-search/icon?v=abc123",
    )
    expect(mcpServerIconUrl({ id: McpServerId.make("@acme/linear-mcp"), iconHash: "f00" })).toBe(
      "/mcp/%40acme%2Flinear-mcp/icon?v=f00",
    )
  })

  test("is none for an MCP server with no icon", () => {
    expect(mcpServerIconUrl({ id: McpServerId.make("hub:docs") })).toBeUndefined()
  })
})

/** The classes and style an MCP server id gives its tile. */
const tile = async (id: string) => {
  const view = await render(<McpServerAvatar mcpServer={{ id: McpServerId.make(id), name: "A" }} />)
  cleanup = view.unmount
  const root = view.container.firstElementChild
  const style = `${root?.getAttribute("class")} ${root?.getAttribute("style")}`
  await view.unmount()
  cleanup = undefined
  return style
}

describe("McpServerAvatar", () => {
  test("shows the first letter of the name, in capitals, when the MCP server has no icon", async () => {
    const { container, unmount } = await render(
      <McpServerAvatar mcpServer={{ id: McpServerId.make("hub:docs"), name: "docs search" }} />,
    )
    cleanup = unmount
    await settle(400)
    expect(container.querySelector("img")).toBeNull()
    expect(container.textContent).toBe("D")
  })

  test("takes the first letter of a name that starts with an emoji or a space", async () => {
    const { container, unmount } = await render(
      <McpServerAvatar mcpServer={{ id: McpServerId.make("hub:x"), name: "  🚀 Rocket" }} />,
    )
    cleanup = unmount
    await settle(400)
    expect(container.textContent).toBe("🚀")
  })

  test("keeps one color for an MCP server id, and varies it by id", async () => {
    expect(await tile("hub:a")).toBe(await tile("hub:a"))
    const colors = new Set<string>()
    for (const id of ["hub:a", "hub:b", "hub:c", "hub:d", "@acme/e"]) colors.add(await tile(id))
    expect(colors.size).toBeGreaterThan(1)
  })

  test("shows the Hub's icon once it loads, described by nothing: the name is on the card", async () => {
    const { container, unmount } = await render(
      <McpServerAvatar
        mcpServer={{ id: McpServerId.make("hub:docs"), name: "Docs", iconHash: "abc" }}
      />,
    )
    cleanup = unmount
    await settle(400)
    const image = container.querySelector("img")
    expect(image?.getAttribute("src")).toBe("/mcp/hub%3Adocs/icon?v=abc")
    expect(image?.getAttribute("alt")).toBe("")
  })

  test("falls back to the letter when the icon fails to load", async () => {
    const { container, unmount } = await render(
      <McpServerAvatar
        mcpServer={{ id: McpServerId.make("hub:docs"), name: "Docs", iconHash: "broken" }}
      />,
    )
    cleanup = unmount
    await settle(400)
    expect(container.querySelector("img")).toBeNull()
    expect(container.textContent).toBe("D")
  })
})
