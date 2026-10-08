// The Plugins page (ADR 0020) against the fake Hub: the Plugins and their Installations, adding
// and editing them, and the Hub's refusals shown where they were made.

import { afterEach, expect, test } from "bun:test"
import { hubPluginId, RequestId } from "@kndl/protocol"
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
const { you } = await import("../src/hub/fake/script.ts")
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

async function openPlugins(owner = true) {
  const hub = new FakeHub({ stepMs: 2, autoplay: false, owner })
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

test("the Owner makes an Installation global, on in every Repo (#219)", async () => {
  const { hub } = await openPlugins()
  await step(() => button("Add Installation of Linear").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Add an Installation of Linear"))
  expect(dialog()?.textContent).toContain("Global")
  // Its box, as Base UI renders it.
  const global = dialog()?.querySelector('input[type="checkbox"]') as HTMLInputElement
  await step(() => global.click())
  // A global one lists no Repos.
  await eventually(() => expect(dialog()?.querySelector("textarea")).toBeNull())
  await step(() => button("Add").click())
  await eventually(() => expect(plugin("Linear")?.textContent).toContain("On in every Repo"))
  expect(plugin("Linear")?.textContent).toContain("Global")
  expect(hub.received.find((m) => m._tag === "CreateInstallation")).toMatchObject({
    name: "Linear",
    global: true,
    repos: [],
  })
})

test("only the Owner changes a global Installation, or its Plugin (#219)", async () => {
  const { hub } = await openPlugins(false)
  await step(() =>
    hub.plugins.change(
      {
        _tag: "CreateInstallation",
        requestId: RequestId.make("seed"),
        pluginId: hubPluginId("linear"),
        name: "Linear",
        global: true,
        repos: [],
      },
      you,
      () => true,
      true,
    ),
  )
  // Seen once the page asks again.
  await step(() => button("Add Installation of Linear").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Add an Installation of Linear"))
  // No one but the Owner is offered a global one.
  expect(dialog()?.querySelector('[role="checkbox"]')).toBeNull()
  await type(dialog()?.querySelector("input") as HTMLInputElement, "Linear here")
  await type(dialog()?.querySelector("textarea") as HTMLTextAreaElement, "kddige/kndl")
  await step(() => button("Add").click())
  // A Repo-scoped one of its Plugin takes the global's place on its Repo.
  await eventually(() => expect(plugin("Linear")?.textContent).toContain("kddige/kndl"))
  expect(plugin("Linear")?.textContent).toContain("Only the Hub's Owner can edit or delete it.")
  expect(plugin("Linear")?.textContent).toContain(
    "It has a global Installation, on in every Repo: only the Hub's Owner can edit or delete it.",
  )
  expect(button("Edit Plugin Linear").disabled).toBe(true)
  expect(button("Delete Plugin Linear").disabled).toBe(true)
  expect(button("Edit Installation Linear").disabled).toBe(true)
  expect(button("Delete Installation Linear").disabled).toBe(true)
  expect(button("Edit Installation Linear here").disabled).toBe(false)
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

test("declares a header secret on a new Plugin, its key following its title", async () => {
  const { hub } = await openPlugins()
  await step(() => button("Add Plugin").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Header secrets"))
  const [name, url] = [...(dialog()?.querySelectorAll("input") ?? [])] as [
    HTMLInputElement,
    HTMLInputElement,
  ]
  await type(name, "Acme")
  await type(url, "https://mcp.acme.example/mcp")
  await step(() => button("Add header secret").click())
  const [title, header, template, key] = [
    ...(document.querySelector('[aria-label="Header secret 1"]')?.querySelectorAll("input") ?? []),
  ] as [HTMLInputElement, HTMLInputElement, HTMLInputElement, HTMLInputElement]
  expect(header.value).toBe("Authorization")
  expect(template.value).toBe("Bearer {value}")
  await type(title, "API key")
  expect(key.value).toBe("api_key")

  await type(template, "Bearer")
  await step(() => button("Add").click())
  expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain("{value}")
  expect(hub.received.some((m) => m._tag === "CreatePlugin")).toBe(false)

  await type(template, "Bearer {value}")
  await step(() => button("Add").click())
  await eventually(() => expect(plugin("Acme")?.textContent).toContain("hub:acme"))
  expect(hub.received.find((m) => m._tag === "CreatePlugin")).toMatchObject({
    auth: {
      _tag: "Headers",
      headers: [
        { key: "api_key", title: "API key", header: "Authorization", template: "Bearer {value}" },
      ],
    },
  })
})

test("an Installation's header secret values are write-only: entered, never shown", async () => {
  const { hub } = await openPlugins()
  // Who set Sentry's, and when; never the value.
  const sentry = plugin("Sentry")?.querySelector('[aria-label="Header secrets of Sentry"]')
  expect(sentry?.textContent).toContain("Auth token")
  expect(sentry?.textContent).toContain("set by")

  await step(() => button("Add Installation of Linear").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Add an Installation of Linear"))
  expect(dialog()?.textContent).toContain("Sent as Authorization: Bearer {value}")
  expect(dialog()?.textContent).toContain("needs a value")
  await type(dialog()?.querySelector("textarea") as HTMLTextAreaElement, "kddige/kndl")
  const value = dialog()?.querySelector('input[type="password"]') as HTMLInputElement
  await type(value, "made-up-linear-key")
  await step(() => button("Add").click())
  await eventually(() =>
    expect(
      plugin("Linear")?.querySelector('[aria-label="Header secrets of Linear"]')?.textContent,
    ).toContain("set by"),
  )
  expect(hub.received.find((m) => m._tag === "CreateInstallation")).toMatchObject({
    values: [{ key: "api_key" }],
  })
  expect(document.body.textContent).not.toContain("made-up-linear-key")

  // Saved again with the value left empty: it keeps the one it has, sending none.
  await settle(300)
  await step(() => button("Edit Installation Linear").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Edit"))
  const again = dialog()?.querySelector('input[type="password"]') as HTMLInputElement
  expect(again.value).toBe("")
  expect(again.placeholder).toContain("type to replace it")
  await step(() => button("Save").click())
  await eventually(() => expect(hub.received.some((m) => m._tag === "EditInstallation")).toBe(true))
  expect(hub.received.find((m) => m._tag === "EditInstallation")).not.toHaveProperty("values")
})

test("says whose values an edit to a Plugin clears, before saving it", async () => {
  const { hub } = await openPlugins()
  await step(() => button("Add Installation of Linear").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Add an Installation of Linear"))
  await type(dialog()?.querySelector("textarea") as HTMLTextAreaElement, "kddige/kndl")
  await type(dialog()?.querySelector('input[type="password"]') as HTMLInputElement, "made-up")
  await step(() => button("Add").click())
  await eventually(() => expect(plugin("Linear")?.textContent).toContain("set by"))

  await settle(300)
  await step(() => button("Edit Plugin Linear").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Header secrets"))
  const url = [...(dialog()?.querySelectorAll("input") ?? [])][1] as HTMLInputElement
  // Another path on the same server keeps them.
  await type(url, "https://mcp.linear.example/v2")
  expect(dialog()?.textContent).not.toContain("Saving clears header secret values")
  expect(button("Save").textContent).toBe("Save")

  await type(url, "https://linear.example/mcp")
  expect(dialog()?.textContent).toContain("Saving clears header secret values")
  expect(dialog()?.textContent).toContain("Linear: API key")
  await step(() => button("Save and clear values").click())
  await eventually(() => expect(plugin("Linear")?.textContent).toContain("needs a value"))
  expect(hub.received.find((m) => m._tag === "EditPlugin")).toMatchObject({
    url: "https://linear.example/mcp",
  })
})

const dialogInput = (label: string) =>
  [...(dialog()?.querySelectorAll("label") ?? [])]
    .find((one) => one.textContent?.startsWith(label))
    ?.parentElement?.querySelector("input") as HTMLInputElement

const folder = () =>
  dialog()?.querySelector('input[aria-label="The package\'s folder"]') as HTMLInputElement

/** Chooses `files` in a file input, as a browser would, each named from its folder as given. */
async function chooseFiles(input: HTMLInputElement, files: Record<string, string>) {
  const chosen = Object.entries(files).map(([path, content]) => {
    const file = new File([content], path.split("/").at(-1) ?? path)
    Object.defineProperty(file, "webkitRelativePath", { value: path })
    return file
  })
  await step(() => {
    Object.defineProperty(input, "files", { value: chosen, configurable: true })
    input.dispatchEvent(new Event("change", { bubbles: true }))
  })
  await settle(20)
}

test("adds a Plugin package from git, once what the Hub read is confirmed", async () => {
  const { hub } = await openPlugins()
  await step(() => button("Add package").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Add a Plugin package"))
  await type(dialogInput("Git repo URL"), "git@github.com:acme/notion-mcp.git")
  await step(() => button("Read package").click())
  expect(dialog()?.textContent).toContain("The git URL isn't a URL")
  expect(hub.received.some((m) => m._tag === "ReadPluginPackage")).toBe(false)

  await type(dialogInput("Git repo URL"), "https://github.com/acme/notion-mcp")
  await type(dialogInput("Folder"), "../elsewhere")
  await step(() => button("Read package").click())
  expect(dialog()?.textContent).toContain("isn't a folder inside the repo")
  await type(dialogInput("Folder"), "")
  await step(() => button("Read package").click())
  // What the Hub read, before anything is added.
  await eventually(() => expect(dialog()?.textContent).toContain("@acme/notion-mcp"))
  const read = dialog()?.querySelector('[aria-label="The package"]')?.textContent
  expect(read).toContain("Notion")
  expect(read).toContain("0.3.0 (51c0a7e)")
  expect(read).toContain("https://mcp.notion.example/mcp")
  expect(plugin("Notion")).toBeNull()

  await step(() => button("Add").click())
  await eventually(() => expect(plugin("Notion")?.textContent).toContain("@acme/notion-mcp"))
  expect(plugin("Notion")?.textContent).toContain("0.3.0 (51c0a7e)")
  expect(plugin("Notion")?.textContent).toContain("https://github.com/acme/notion-mcp")
  expect(hub.received.some((m) => m._tag === "AddPluginPackage")).toBe(true)
})

test("upgrades a packaged Plugin from git only once its changes are confirmed", async () => {
  const { hub } = await openPlugins()
  // Pinned: only an Upgrade changes it.
  expect(plugin("Asana")?.textContent).toContain("1.0.0 (3f2c9a1)")
  expect(() => button("Edit Plugin Asana")).toThrow()
  await step(() => button("Add Installation of Asana").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Add an Installation of Asana"))
  await type(dialog()?.querySelector("textarea") as HTMLTextAreaElement, "kddige/kndl")
  await type(dialog()?.querySelector('input[type="password"]') as HTMLInputElement, "made-up")
  await step(() => button("Add").click())
  await eventually(() => expect(plugin("Asana")?.textContent).toContain("set by"))

  await settle(300)
  await step(() => button("Upgrade Plugin Asana").click())
  const table = () => dialog()?.querySelector('[aria-label="What upgrading changes"]')
  await eventually(() => expect(table()).not.toBeNull())
  const changes = table()?.textContent
  expect(changes).toContain("1.0.0")
  expect(changes).toContain("1.1.0")
  expect(changes).toContain("https://mcp.asana.example/v2/mcp")
  expect(changes).toContain("Header secrets: API key (Authorization: Bearer {value})")
  expect(dialog()?.textContent).toContain("It asks for new header secrets")
  // Its Token is gone from the package: the value entered for it is cleared, as an edit would.
  expect(dialog()?.textContent).toContain("Upgrading clears header secret values")
  expect(dialog()?.textContent).toContain("Asana: Token")
  expect(plugin("Asana")?.textContent).toContain("https://mcp.asana.example/mcp")

  await step(() => button("Upgrade").click())
  await eventually(() => expect(plugin("Asana")?.textContent).toContain("1.1.0 (9b41e07)"))
  expect(plugin("Asana")?.textContent).toContain("https://mcp.asana.example/v2/mcp")
  expect(plugin("Asana")?.textContent).toContain("needs a value")
  expect(hub.received.find((m) => m._tag === "UpgradePlugin")).toMatchObject({
    pluginId: "@acme/asana-mcp",
  })

  await settle(300)
  await step(() => button("Upgrade Plugin Asana").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Asana is up to date: 1.1.0"))
  expect(() => button("Upgrade", dialog() ?? document)).toThrow()
})

test("adds an uploaded folder, and refuses a name a Plugin from another source has", async () => {
  await openPlugins()
  await step(() => button("Add package").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Add a Plugin package"))
  await step(() => button("Upload").click())
  await chooseFiles(folder(), {
    "asana/package.json": JSON.stringify({ name: "@acme/asana-mcp", version: "2.0.0" }),
    "asana/kndl.json": JSON.stringify({
      displayName: "Asana",
      mcp: { url: "https://x.dev/mcp" },
    }),
  })
  await step(() => button("Read package").click())
  await eventually(() =>
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain(
      "@acme/asana-mcp is already on the Hub, from another source",
    ),
  )

  await chooseFiles(folder(), {
    "jira/package.json": JSON.stringify({ name: "@acme/jira-mcp", version: "1.0.0" }),
    "jira/kndl.json": JSON.stringify({ displayName: "Jira", mcp: { url: "https://jira.dev/mcp" } }),
    "jira/src/kndl.json": "not the manifest",
  })
  await step(() => button("Read package").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Uploaded jira"))
  await step(() => button("Add").click())
  await eventually(() => expect(plugin("Jira")?.textContent).toContain("@acme/jira-mcp"))
  expect(plugin("Jira")?.textContent).toContain("Uploaded jira")
})
