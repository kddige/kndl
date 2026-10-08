// The Plugins page (ADR 0020) against the fake Hub: the Plugins and their Installations, adding
// and editing them, and the Hub's refusals shown where they were made.

import { afterEach, expect, test } from "bun:test"
import { installDom } from "./dom.ts"
import { button, render, settle, step } from "./render.ts"

let cleanup: (() => Promise<void>) | undefined
installDom(() => cleanup?.())
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

// Loaded after installDom() and the StyleX compiler, so components see the DOM and compile.
const { createMemoryHistory, RouterProvider } = await import("@tanstack/react-router")
const { HubProvider } = await import("../src/app/hub.tsx")
const { HubClient } = await import("../src/hub/client.ts")
const { FakeHub } = await import("../src/hub/fake/FakeHub.ts")
const { createAppRouter } = await import("../src/router.tsx")

async function eventually(check: () => void, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      check()
      return
    } catch (error) {
      if (Date.now() > deadline) throw error
      await settle(10)
    }
  }
}

const dialog = () => document.querySelector('[role="dialog"]')
const plugin = (name: string) => document.querySelector(`[aria-label="Plugin ${name}"]`)
const pluginsLink = () =>
  [...document.querySelectorAll("a")].find((a) => a.textContent?.trim() === "Plugins")

/** Types `value` into `field`, as a browser would, so React sees it. */
async function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await step(() => {
    const prototype = Object.getPrototypeOf(field) as object
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value)
    field.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

async function openPlugins() {
  const hub = new FakeHub({ stepMs: 2, autoplay: false })
  const client = new HubClient(hub, { retryDelay: () => 1 })
  const router = createAppRouter(createMemoryHistory({ initialEntries: ["/plugins"] }))
  const view = await render(
    <HubProvider client={client}>
      <RouterProvider router={router} />
    </HubProvider>,
  )
  cleanup = async () => {
    await view.unmount()
    client.stop()
    hub.dispose()
  }
  await eventually(() => expect(document.querySelector("h1")?.textContent).toBe("Plugins"))
  await eventually(() => expect(plugin("Docs search")).not.toBeNull())
  return { hub, client }
}

test("lists the Plugins and their Installations, not naming Repos out of reach", async () => {
  await openPlugins()
  const docs = plugin("Docs search")?.textContent
  expect(docs).toContain("hub:docs-search")
  expect(docs).toContain("https://docs-mcp.example.com/mcp")
  expect(docs).toContain("Docs")
  expect(docs).toContain("kddige/kndl")
  expect(plugin("Linear")?.textContent).toContain("No Installations")

  const sentry = plugin("Sentry")?.textContent
  expect(sentry).toContain("and 1 Repo you have no access to")
  expect(sentry).not.toContain("kddige/secret")
  // Changing it needs access to every Repo it is on in.
  expect(button("Edit Installation Sentry").disabled).toBe(true)
  expect(button("Delete Installation Sentry").disabled).toBe(true)
  expect(pluginsLink()?.getAttribute("aria-current")).toBe("page")
})

test("adds a Plugin, by name and URL, with a hub: id", async () => {
  const { hub } = await openPlugins()
  await step(() => button("Add Plugin").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Add Plugin"))
  const [name, url] = [...(dialog()?.querySelectorAll("input") ?? [])] as [
    HTMLInputElement,
    HTMLInputElement,
  ]
  await type(name, "Acme docs")
  await type(url, "ftp://nope")
  await step(() => button("Add").click())
  expect(dialog()?.textContent).toContain("must start with https://")
  expect(hub.received.some((m) => m._tag === "CreatePlugin")).toBe(false)

  await type(url, "https://mcp.acme.example/mcp")
  await step(() => button("Add").click())
  await eventually(() => expect(plugin("Acme docs")?.textContent).toContain("hub:acme-docs"))
})

test("adds an Installation on Repos, and shows why a second one on a Repo is refused", async () => {
  const { hub } = await openPlugins()
  await step(() => button("Add Installation of Linear").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Add an Installation of Linear"))
  const name = dialog()?.querySelector("input") as HTMLInputElement
  expect(name.value).toBe("Linear")
  const repos = dialog()?.querySelector("textarea") as HTMLTextAreaElement
  await type(repos, "kddige/kndl\nkddige/dotfiles\n")
  await step(() => button("Add").click())
  await eventually(() => expect(plugin("Linear")?.textContent).toContain("kddige/dotfiles"))
  expect(hub.received.find((m) => m._tag === "CreateInstallation")).toMatchObject({
    name: "Linear",
    repos: ["kddige/kndl", "kddige/dotfiles"],
  })

  await settle(300)
  await step(() => button("Add Installation of Docs search").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Add an Installation of Docs"))
  await type(dialog()?.querySelector("textarea") as HTMLTextAreaElement, "kddige/kndl")
  await step(() => button("Add").click())
  await eventually(() =>
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain(
      "kddige/kndl already has Docs, an Installation of Docs search",
    ),
  )
})

test("deleting a Plugin with Installations is refused, saying why", async () => {
  await openPlugins()
  await step(() => button("Delete Plugin Docs search").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Delete Docs search?"))
  await step(() => button("Delete").click())
  await eventually(() =>
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(
      "Docs search has an Installation: delete it first.",
    ),
  )
})
