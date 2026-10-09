// The MCP page (ADR 0020) against the fake Hub: the MCP servers and their Installations, adding
// and editing them, and the Hub's refusals shown where they were made.

import { afterEach, expect, test } from "bun:test"
import { hubMcpServerId, RequestId } from "@kndl/protocol"
import { installDom } from "./dom.ts"
import { button, dialog, render, settle, step } from "./render.ts"

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

const mcpServer = (name: string) => document.querySelector(`[aria-label="MCP server ${name}"]`)
const mcpServersLink = () =>
  [...document.querySelectorAll("a")].find((a) => a.textContent?.trim() === "MCP")

/** Types `value` into `field`, as a browser would, so React sees it. */
async function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await step(() => {
    const prototype = Object.getPrototypeOf(field) as object
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(field, value)
    field.dispatchEvent(new Event("input", { bubbles: true }))
  })
}

async function openMcpServers(owner = true) {
  const hub = new FakeHub({ stepMs: 2, autoplay: false, owner })
  const client = new HubClient(hub, { retryDelay: () => 1 })
  const router = createAppRouter(createMemoryHistory({ initialEntries: ["/mcp"] }))
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
  await eventually(() => expect(document.querySelector("h1")?.textContent).toBe("MCP"))
  await eventually(() => expect(mcpServer("Docs search")).not.toBeNull())
  return { hub, client }
}

test("lists the MCP servers and their Installations, not naming Repos out of reach", async () => {
  await openMcpServers()
  const docs = mcpServer("Docs search")?.textContent
  expect(docs).toContain("hub:docs-search")
  expect(docs).toContain("https://docs-mcp.example.com/mcp")
  expect(docs).toContain("Docs")
  expect(docs).toContain("kddige/kndl")
  expect(mcpServer("Linear")?.textContent).toContain("No Installations")

  const sentry = mcpServer("Sentry")?.textContent
  expect(sentry).toContain("and 1 Repo you have no access to")
  expect(sentry).not.toContain("kddige/secret")
  // Changing it needs access to every Repo it is on in.
  expect(button("Edit Installation Sentry").disabled).toBe(true)
  expect(button("Delete Installation Sentry").disabled).toBe(true)
  expect(mcpServersLink()?.getAttribute("aria-current")).toBe("page")
})

test("adds an MCP server, by name and URL, with a hub: id", async () => {
  const { hub } = await openMcpServers()
  await step(() => button("Add MCP server").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Add MCP server"))
  const [name, url] = [...(dialog()?.querySelectorAll("input") ?? [])] as [
    HTMLInputElement,
    HTMLInputElement,
  ]
  await type(name, "Acme docs")
  await type(url, "ftp://nope")
  await step(() => button("Add").click())
  expect(dialog()?.textContent).toContain("must start with https://")
  expect(hub.received.some((m) => m._tag === "CreateMcpServer")).toBe(false)

  await type(url, "https://mcp.acme.example/mcp")
  await step(() => button("Add").click())
  await eventually(() => expect(mcpServer("Acme docs")?.textContent).toContain("hub:acme-docs"))
})

test("adds an Installation on Repos, and shows why a second one on a Repo is refused", async () => {
  const { hub } = await openMcpServers()
  await step(() => button("Add Installation of Linear").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Add an Installation of Linear"))
  const name = dialog()?.querySelector("input") as HTMLInputElement
  expect(name.value).toBe("Linear")
  const repos = dialog()?.querySelector("textarea") as HTMLTextAreaElement
  await type(repos, "kddige/kndl\nkddige/dotfiles\n")
  await step(() => button("Add").click())
  await eventually(() => expect(mcpServer("Linear")?.textContent).toContain("kddige/dotfiles"))
  expect(hub.received.find((m) => m._tag === "CreateInstallation")).toMatchObject({
    name: "Linear",
    repos: ["kddige/kndl", "kddige/dotfiles"],
  })

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
  const { hub } = await openMcpServers()
  await step(() => button("Add Installation of Linear").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Add an Installation of Linear"))
  expect(dialog()?.textContent).toContain("Global")
  // Its box, as Base UI renders it.
  const global = dialog()?.querySelector('input[type="checkbox"]') as HTMLInputElement
  await step(() => global.click())
  // A global one lists no Repos.
  await eventually(() => expect(dialog()?.querySelector("textarea")).toBeNull())
  await step(() => button("Add").click())
  await eventually(() => expect(mcpServer("Linear")?.textContent).toContain("On in every Repo"))
  expect(mcpServer("Linear")?.textContent).toContain("Global")
  expect(hub.received.find((m) => m._tag === "CreateInstallation")).toMatchObject({
    name: "Linear",
    global: true,
    repos: [],
  })
})

test("only the Owner changes a global Installation, or its MCP server (#219)", async () => {
  const { hub } = await openMcpServers(false)
  await step(() =>
    hub.mcpServers.change(
      {
        _tag: "CreateInstallation",
        requestId: RequestId.make("seed"),
        mcpServerId: hubMcpServerId("linear"),
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
  // A Repo-scoped one of its MCP server takes the global's place on its Repo.
  await eventually(() => expect(mcpServer("Linear")?.textContent).toContain("kddige/kndl"))
  expect(mcpServer("Linear")?.textContent).toContain("Only the Hub's Owner can edit or delete it.")
  expect(mcpServer("Linear")?.textContent).toContain(
    "It has a global Installation, on in every Repo: only the Hub's Owner can edit or delete it.",
  )
  expect(button("Edit MCP server Linear").disabled).toBe(true)
  expect(button("Delete MCP server Linear").disabled).toBe(true)
  expect(button("Edit Installation Linear").disabled).toBe(true)
  expect(button("Delete Installation Linear").disabled).toBe(true)
  expect(button("Edit Installation Linear here").disabled).toBe(false)
})

test("deleting an MCP server with Installations is refused, saying why", async () => {
  await openMcpServers()
  await step(() => button("Delete MCP server Docs search").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Delete Docs search?"))
  await step(() => button("Delete").click())
  await eventually(() =>
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(
      "Docs search has an Installation: delete it first.",
    ),
  )
})

test("declares a header secret on a new MCP server, its key following its title", async () => {
  const { hub } = await openMcpServers()
  await step(() => button("Add MCP server").click())
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
  expect(hub.received.some((m) => m._tag === "CreateMcpServer")).toBe(false)

  await type(template, "Bearer {value}")
  await step(() => button("Add").click())
  await eventually(() => expect(mcpServer("Acme")?.textContent).toContain("hub:acme"))
  expect(hub.received.find((m) => m._tag === "CreateMcpServer")).toMatchObject({
    auth: {
      _tag: "Headers",
      headers: [
        { key: "api_key", title: "API key", header: "Authorization", template: "Bearer {value}" },
      ],
    },
  })
})

test("an Installation's header secret values are write-only: entered, never shown", async () => {
  const { hub } = await openMcpServers()
  // Who set Sentry's, and when; never the value.
  const sentry = mcpServer("Sentry")?.querySelector('[aria-label="Header secrets of Sentry"]')
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
      mcpServer("Linear")?.querySelector('[aria-label="Header secrets of Linear"]')?.textContent,
    ).toContain("set by"),
  )
  expect(hub.received.find((m) => m._tag === "CreateInstallation")).toMatchObject({
    values: [{ key: "api_key" }],
  })
  expect(document.body.textContent).not.toContain("made-up-linear-key")

  // Saved again with the value left empty: it keeps the one it has, sending none.
  await step(() => button("Edit Installation Linear").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Edit"))
  const again = dialog()?.querySelector('input[type="password"]') as HTMLInputElement
  expect(again.value).toBe("")
  expect(again.placeholder).toContain("type to replace it")
  await step(() => button("Save").click())
  await eventually(() => expect(hub.received.some((m) => m._tag === "EditInstallation")).toBe(true))
  expect(hub.received.find((m) => m._tag === "EditInstallation")).not.toHaveProperty("values")
})

test("says whose values an edit to an MCP server clears, before saving it", async () => {
  const { hub } = await openMcpServers()
  await step(() => button("Add Installation of Linear").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Add an Installation of Linear"))
  await type(dialog()?.querySelector("textarea") as HTMLTextAreaElement, "kddige/kndl")
  await type(dialog()?.querySelector('input[type="password"]') as HTMLInputElement, "made-up")
  await step(() => button("Add").click())
  await eventually(() => expect(mcpServer("Linear")?.textContent).toContain("set by"))

  await step(() => button("Edit MCP server Linear").click())
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
  await eventually(() => expect(mcpServer("Linear")?.textContent).toContain("needs a value"))
  expect(hub.received.find((m) => m._tag === "EditMcpServer")).toMatchObject({
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

test("adds an MCP server package from git, once what the Hub read is confirmed", async () => {
  const { hub } = await openMcpServers()
  await step(() => button("Add package").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Add an MCP server package"))
  await type(dialogInput("Git repo URL"), "git@github.com:acme/notion-mcp.git")
  await step(() => button("Read package").click())
  expect(dialog()?.textContent).toContain("The git URL isn't a URL")
  expect(hub.received.some((m) => m._tag === "ReadMcpServerPackage")).toBe(false)

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
  expect(mcpServer("Notion")).toBeNull()

  await step(() => button("Add").click())
  await eventually(() => expect(mcpServer("Notion")?.textContent).toContain("@acme/notion-mcp"))
  expect(mcpServer("Notion")?.textContent).toContain("0.3.0 (51c0a7e)")
  expect(mcpServer("Notion")?.textContent).toContain("https://github.com/acme/notion-mcp")
  expect(hub.received.some((m) => m._tag === "AddMcpServerPackage")).toBe(true)
})

/** What the open Upgrade dialog says upgrading changes. */
const upgradeTable = () => dialog()?.querySelector('[aria-label="What upgrading changes"]')

test("upgrades a packaged MCP server from git only once its changes are confirmed", async () => {
  const { hub } = await openMcpServers()
  // Pinned: only an Upgrade changes it.
  expect(mcpServer("Asana")?.textContent).toContain("1.0.0 (3f2c9a1)")
  expect(() => button("Edit MCP server Asana")).toThrow()
  await step(() => button("Add Installation of Asana").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Add an Installation of Asana"))
  await type(dialog()?.querySelector("textarea") as HTMLTextAreaElement, "kddige/kndl")
  await type(dialog()?.querySelector('input[type="password"]') as HTMLInputElement, "made-up")
  await step(() => button("Add").click())
  await eventually(() => expect(mcpServer("Asana")?.textContent).toContain("set by"))

  await step(() => button("Upgrade MCP server Asana").click())
  await eventually(() => expect(upgradeTable()).not.toBeNull())
  const changes = upgradeTable()?.textContent
  expect(changes).toContain("1.0.0")
  expect(changes).toContain("1.1.0")
  expect(changes).toContain("https://mcp.asana.example/v2/mcp")
  expect(changes).toContain("Header secrets: API key (Authorization: Bearer {value})")
  expect(dialog()?.textContent).toContain("It asks for new header secrets")
  // Its Token is gone from the package: the value entered for it is cleared, as an edit would.
  expect(dialog()?.textContent).toContain("Upgrading clears header secret values")
  expect(dialog()?.textContent).toContain("Asana: Token")
  expect(mcpServer("Asana")?.textContent).toContain("https://mcp.asana.example/mcp")

  await step(() => button("Upgrade").click())
  await eventually(() => expect(mcpServer("Asana")?.textContent).toContain("1.1.0 (9b41e07)"))
  expect(mcpServer("Asana")?.textContent).toContain("https://mcp.asana.example/v2/mcp")
  expect(mcpServer("Asana")?.textContent).toContain("needs a value")
  expect(hub.received.find((m) => m._tag === "UpgradeMcpServer")).toMatchObject({
    mcpServerId: "@acme/asana-mcp",
  })

  await step(() => button("Upgrade MCP server Asana").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Asana is up to date: 1.1.0"))
  expect(() => button("Upgrade", dialog() ?? document)).toThrow()
})

test("adds an uploaded folder, and refuses a name an MCP server from another source has", async () => {
  await openMcpServers()
  await step(() => button("Add package").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Add an MCP server package"))
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
  await eventually(() => expect(mcpServer("Jira")?.textContent).toContain("@acme/jira-mcp"))
  expect(mcpServer("Jira")?.textContent).toContain("Uploaded jira")
})

/** The warning that what goes to the MCP server is unencrypted (#255), if one is shown. */
const unencrypted = () =>
  [...(dialog()?.querySelectorAll('[role="status"]') ?? [])].find((banner) =>
    banner.textContent?.includes("unencrypted"),
  )

test("warns, as the URL is typed, that plain http to another machine is unencrypted, and still saves it (#255)", async () => {
  const { hub } = await openMcpServers()
  await step(() => button("Add MCP server").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Add MCP server"))
  const [name, url] = [...(dialog()?.querySelectorAll("input") ?? [])] as [
    HTMLInputElement,
    HTMLInputElement,
  ]
  await type(name, "NAS tools")
  await type(url, "http://192.168.1.40:8931/mcp")
  expect(unencrypted()?.textContent).toContain("anyone on the network path")
  await type(url, "https://mcp.acme.example/mcp")
  expect(unencrypted()).toBeUndefined()
  await type(url, "http://localhost:8931/mcp")
  expect(unencrypted()).toBeUndefined()
  await type(url, "http://[::1]:8931/mcp")
  expect(unencrypted()).toBeUndefined()

  await type(url, "http://10.0.0.7/mcp")
  expect(unencrypted()).toBeDefined()
  await step(() => button("Add").click())
  await eventually(() => expect(mcpServer("NAS tools")?.textContent).toContain("hub:nas-tools"))
  expect(hub.received.find((m) => m._tag === "CreateMcpServer")).toMatchObject({
    url: "http://10.0.0.7/mcp",
  })
})

test("marks an MCP server at plain http to another machine as unencrypted (#255)", async () => {
  await openMcpServers()
  expect(mcpServer("Home Assistant")?.textContent).toContain("http://192.168.1.20:8123/mcp")
  expect(mcpServer("Home Assistant")?.textContent).toContain("Unencrypted http")
  expect(mcpServer("Docs search")?.textContent).not.toContain("Unencrypted")
})

test("warns most clearly where a header secret would be sent unencrypted (#255)", async () => {
  await openMcpServers()
  await step(() => button("Add Installation of Home Assistant").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Add an Installation of Home"))
  expect(unencrypted()?.textContent).toContain("Header secret values are sent unencrypted")
  expect(unencrypted()?.textContent).toContain("Home Assistant is at an http URL")
  await step(() => button("Cancel").click())
  await eventually(() => expect(dialog()).toBeNull())

  await step(() => button("Add Installation of Linear").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Add an Installation of Linear"))
  expect(dialog()?.textContent).toContain("Sent as Authorization")
  expect(unencrypted()).toBeUndefined()
})

test("warns where an OAuth token would be sent unencrypted, and not over https (#255)", async () => {
  await openMcpServers()
  await step(() => button("Edit Installation GitHub").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Edit GitHub"))
  expect(dialog()?.textContent).toContain("Reconnect")
  expect(unencrypted()).toBeUndefined()
  await step(() => button("Cancel").click())
  await eventually(() => expect(dialog()).toBeNull())

  await step(() => button("Edit MCP server GitHub").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Edit GitHub"))
  const url = [...(dialog()?.querySelectorAll("input") ?? [])][1] as HTMLInputElement
  await type(url, "http://10.0.0.9/mcp/")
  await step(() => button("Save and disconnect").click())
  await eventually(() => expect(mcpServer("GitHub")?.textContent).toContain("Unencrypted http"))

  await step(() => button("Edit Installation GitHub").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Edit GitHub"))
  expect(unencrypted()?.textContent).toContain("The account's token is sent unencrypted")
})

/** What an OAuth Installation's client line says (#218). */
const clientLine = (name: string) =>
  document.querySelector(`[aria-label="Client of ${name}"]`)?.textContent ?? ""

test("asks for a client entered by hand where the server registers none, showing the callback URL (#218)", async () => {
  const { hub } = await openMcpServers()
  // GitHub's has one, whose secret the page never sees.
  await eventually(() => expect(clientLine("GitHub")).toContain("Ov23liKndlBot0a1b2c3"))
  expect(clientLine("GitHub")).toContain("with a secret")

  await step(() => button("Change client of GitHub").click())
  await eventually(() => expect(dialog()?.textContent).toContain("Enter a client for GitHub"))
  expect(dialog()?.querySelector('[aria-label="Callback URL"]')?.textContent).toEndWith(
    "/auth/mcp/callback",
  )
  expect(() => button("Copy the callback URL", dialog() ?? document)).not.toThrow()
  // Its authorization server takes no public client: the secret is needed too.
  await step(() => button("Connect", dialog() ?? document).click())
  await eventually(() => expect(dialog()?.textContent).toContain("Enter the client ID."))
  await type(dialogInput("Client ID"), "Ov23liNewClient9z8y7")
  await step(() => button("Connect", dialog() ?? document).click())
  await eventually(() =>
    expect(dialog()?.textContent).toContain("the authorization server takes no public client"),
  )
  await type(dialogInput("Client secret"), "made-up-github-secret")
  await step(() => button("Connect", dialog() ?? document).click())
  await eventually(() => expect(clientLine("GitHub")).toContain("Ov23liNewClient9z8y7"))
  expect(hub.received.filter((m) => m._tag === "ConnectInstallation")).toMatchObject([
    { changeClient: true },
    { client: { clientId: "Ov23liNewClient9z8y7" } },
  ])
  expect(document.body.textContent).not.toContain("made-up-github-secret")
})
