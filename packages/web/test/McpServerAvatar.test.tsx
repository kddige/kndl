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
  test("is the Hub's route for the MCP server, its id encoded, with the hash to bust the cache, or none", () => {
    expect(mcpServerIconUrl({ id: McpServerId.make("hub:docs-search"), iconHash: "abc123" })).toBe(
      "/mcp/hub%3Adocs-search/icon?v=abc123",
    )
    expect(mcpServerIconUrl({ id: McpServerId.make("@acme/linear-mcp"), iconHash: "f00" })).toBe(
      "/mcp/%40acme%2Flinear-mcp/icon?v=f00",
    )
    // No icon, no route.
    expect(mcpServerIconUrl({ id: McpServerId.make("hub:docs") })).toBeUndefined()
  })
})

describe("McpServerAvatar", () => {
  test("shows the first letter of the name, in capitals, when the MCP server has no icon", async () => {
    const { container, unmount } = await render(
      <McpServerAvatar mcpServer={{ id: McpServerId.make("hub:docs"), name: "docs search" }} />,
    )
    cleanup = unmount
    await settle(20)
    expect(container.querySelector("img")).toBeNull()
    expect(container.textContent).toBe("D")

    // A name that starts with an emoji or a space: its first letter.
    await unmount()
    const emoji = await render(
      <McpServerAvatar mcpServer={{ id: McpServerId.make("hub:x"), name: "  🚀 Rocket" }} />,
    )
    cleanup = emoji.unmount
    await settle(20)
    expect(emoji.container.textContent).toBe("🚀")
  })

  test("shows the Hub's icon once it loads, described by nothing: the name is on the card", async () => {
    const { container, unmount } = await render(
      <McpServerAvatar
        mcpServer={{ id: McpServerId.make("hub:docs"), name: "Docs", iconHash: "abc" }}
      />,
    )
    cleanup = unmount
    await settle(20)
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
    // The fallback waits 300 ms for the icon before it shows.
    await settle(400)
    expect(container.querySelector("img")).toBeNull()
    expect(container.textContent).toBe("D")
  })
})
