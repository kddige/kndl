// An MCP server's icon on the MCP page (#230, ADR 0021): the Hub finds it after an MCP server is
// added, its URL edited or it is Upgraded, keeps it, and serves it at `/mcp/<id>/icon` to people
// signed in. A real Hub and web client over WebSockets; what the Hub fetches is a fake internet.

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { McpServerId } from "@kndl/protocol"
import { Effect } from "effect"
import { type Icon, McpServerIcons } from "./McpServerIcons.ts"
import { McpServers } from "./McpServers.ts"
import { McpServerSources } from "./McpServerSources.ts"
import { type Connection, openWeb, stopAll, type Web } from "./testChannels.ts"
import { manifest, packageJson, mcpServerRepo, removeMcpServerRepos } from "./testMcpServerRepo.ts"
import { startHub } from "./testSupport.ts"

afterEach(stopAll)
afterAll(removeMcpServerRepos)

const svg = (name: string) =>
  new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg"><title>${name}</title></svg>`)
const none = { _tag: "None" }

/** What the Hub finds, by the URL it was asked about, and every search it made. */
function internet(found: Record<string, Uint8Array | string>) {
  const layer = McpServerIcons.layerWith({
    fetch: async (url) => {
      const bytes = found[url]
      return bytes === undefined ? new Response("no", { status: 404 }) : new Response(bytes)
    },
  })
  return { layer }
}

async function iconHub(found: Record<string, Uint8Array | string>) {
  const fake = internet(found)
  const hub = await startHub({
    config: { devLogin: true },
    mcpServerSources: McpServerSources.layerWith({ protocols: ["https", "file"] }),
    mcpServerIcons: fake.layer,
  })
  return { hub, web: await openWeb(hub, "alice"), fake }
}

let requests = 0
async function ask(web: Connection<Web>, command: Record<string, unknown> & { _tag: string }) {
  const requestId = `i-${++requests}`
  web.send({ ...command, requestId })
  return web.takeWhere(
    (message): message is Web => "requestId" in message && message.requestId === requestId,
    `answer to ${command._tag}`,
  )
}

function mcpServers(answer: Web) {
  if (answer._tag !== "McpServersState")
    throw new Error(`Not McpServersState: ${JSON.stringify(answer)}`)
  return answer.mcpServers
}

/** The next McpServersState in which the MCP server's icon hash is `present` or not. */
const sentWith = (web: Connection<Web>, id: string, present: boolean) =>
  web
    .take(
      "McpServersState",
      (message) =>
        (message.mcpServers.find((mcpServer) => mcpServer.id === id)?.iconHash !== undefined) ===
        present,
    )
    .then((message) => message.mcpServers.find((mcpServer) => mcpServer.id === id))

const iconOf = (hub: { url: string }, web: { cookie: string }, id: string) =>
  fetch(`${hub.url}/mcp/${encodeURIComponent(id)}/icon`, { headers: { cookie: web.cookie } })

const create = (web: Connection<Web>, url: string, name = "Docs") =>
  ask(web, { _tag: "CreateMcpServer", auth: none, name, url })

describe("a Hub-only MCP server's icon", () => {
  test("is found after it is created, without making the save wait, and sent to the web", async () => {
    const { hub, web } = await iconHub({ "https://acme.test/favicon.ico": svg("acme") })
    const created = mcpServers(await create(web, "https://acme.test/mcp"))
    expect(created[0]?.iconHash).toBeUndefined()

    const sent = await sentWith(web, "hub:docs", true)
    expect(sent?.iconHash).toMatch(/^[0-9a-f]{16}$/)

    const response = await iconOf(hub, web, "hub:docs")
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("image/svg+xml")
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(svg("acme"))
  })

  test("is served only to those signed in, with its type pinned and sandboxed", async () => {
    const { hub, web } = await iconHub({ "https://acme.test/favicon.ico": svg("acme") })
    await create(web, "https://acme.test/mcp")
    await sentWith(web, "hub:docs", true)

    const response = await iconOf(hub, web, "hub:docs")
    expect(response.headers.get("content-security-policy")).toBe("sandbox")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect((await fetch(`${hub.url}/mcp/hub%3Adocs/icon`)).status).toBe(401)
  })

  test("is a 404 for an MCP server with none, or none at all", async () => {
    const { hub, web } = await iconHub({})
    await create(web, "https://acme.test/mcp")
    expect((await iconOf(hub, web, "hub:docs")).status).toBe(404)
    expect((await iconOf(hub, web, "hub:nothing")).status).toBe(404)
  })

  test("is found again when its URL is edited, and gone if the new URL has none", async () => {
    const { hub, web } = await iconHub({
      "https://acme.test/favicon.ico": svg("acme"),
      "https://beta.test/favicon.ico": svg("beta"),
    })
    await create(web, "https://acme.test/mcp")
    const first = await sentWith(web, "hub:docs", true)

    await ask(web, {
      _tag: "EditMcpServer",
      mcpServerId: "hub:docs",
      name: "Docs",
      auth: none,
      url: "https://beta.test/mcp",
    })
    const second = await web.take(
      "McpServersState",
      (message) =>
        message.mcpServers[0]?.iconHash !== undefined &&
        message.mcpServers[0].iconHash !== first?.iconHash,
    )
    expect(second.mcpServers[0]?.iconHash).not.toBe(first?.iconHash)
    expect(new Uint8Array(await (await iconOf(hub, web, "hub:docs")).arrayBuffer())).toEqual(
      svg("beta"),
    )

    await ask(web, {
      _tag: "EditMcpServer",
      mcpServerId: "hub:docs",
      name: "Docs",
      auth: none,
      url: "https://gone.test/mcp",
    })
    await sentWith(web, "hub:docs", false)
    expect((await iconOf(hub, web, "hub:docs")).status).toBe(404)
  })

  test("is kept when only its name is edited", async () => {
    const { hub, web } = await iconHub({ "https://acme.test/favicon.ico": svg("acme") })
    await create(web, "https://acme.test/mcp")
    const first = await sentWith(web, "hub:docs", true)
    const edited = mcpServers(
      await ask(web, {
        _tag: "EditMcpServer",
        mcpServerId: "hub:docs",
        name: "Docs 2",
        auth: none,
        url: "https://acme.test/mcp",
      }),
    )
    expect(edited[0]?.iconHash).toBe(first?.iconHash)
    expect((await iconOf(hub, web, "hub:docs")).status).toBe(200)
  })

  test("is gone with the MCP server", async () => {
    const { hub, web } = await iconHub({ "https://acme.test/favicon.ico": svg("acme") })
    await create(web, "https://acme.test/mcp")
    await sentWith(web, "hub:docs", true)
    await ask(web, { _tag: "DeleteMcpServer", mcpServerId: "hub:docs" })
    expect((await iconOf(hub, web, "hub:docs")).status).toBe(404)
  })

  test("is not kept from a search for a URL the MCP server no longer has", async () => {
    const { hub, web } = await iconHub({})
    await create(web, "https://new.test/mcp")
    const stored: Icon = { bytes: svg("old"), contentType: "image/svg+xml" }
    const kept = await hub.run(
      Effect.gen(function* () {
        const store = yield* McpServers
        const id = McpServerId.make("hub:docs")
        const late = yield* store.setIcon(id, "https://old.test/mcp", stored)
        const now = yield* store.setIcon(id, "https://new.test/mcp", stored)
        return { late, now }
      }),
    )
    expect(kept).toEqual({ late: false, now: true })
    expect((await iconOf(hub, web, "hub:docs")).status).toBe(200)
  })
})

const readOf = async (web: Connection<Web>, from: Record<string, unknown>) => {
  const answer = await ask(web, { _tag: "ReadMcpServerPackage", from })
  if (answer._tag !== "McpServerPackageRead") throw new Error(JSON.stringify(answer))
  return answer
}

describe("a packaged MCP server's icon", () => {
  test("is a file in the package, read from git, before any favicon", async () => {
    const { hub, web } = await iconHub({ "https://mcp.linear.app/favicon.ico": svg("favicon") })
    const repo = mcpServerRepo({
      "package.json": packageJson("1.0.0"),
      "kndl.json": manifest("https://mcp.linear.app/mcp", { icon: "assets/logo.svg" }),
      "assets/logo.svg": new TextDecoder().decode(svg("package")),
    })
    const { readId } = await readOf(web, { _tag: "Git", url: repo.url })
    await ask(web, { _tag: "AddMcpServerPackage", readId })
    await sentWith(web, "@acme/linear-mcp", true)
    const response = await iconOf(hub, web, "@acme/linear-mcp")
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(svg("package"))
  })

  test("is the manifest's https URL, from an uploaded folder", async () => {
    const { hub, web } = await iconHub({ "https://cdn.acme.test/logo.svg": svg("cdn") })
    const { readId } = await readOf(web, {
      _tag: "Folder",
      folderName: "linear",
      packageJson: packageJson("1.0.0"),
      manifest: manifest("https://mcp.linear.app/mcp", { icon: "https://cdn.acme.test/logo.svg" }),
    })
    await ask(web, { _tag: "AddMcpServerPackage", readId })
    await sentWith(web, "@acme/linear-mcp", true)
    const response = await iconOf(hub, web, "@acme/linear-mcp")
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(svg("cdn"))
  })

  test("is the URL's favicon when the manifest's is broken, which never blocks adding", async () => {
    const { hub, web } = await iconHub({ "https://mcp.linear.app/favicon.ico": svg("favicon") })
    const repo = mcpServerRepo({
      "package.json": packageJson("1.0.0"),
      "kndl.json": manifest("https://mcp.linear.app/mcp", { icon: "missing/logo.svg" }),
    })
    const { readId } = await readOf(web, { _tag: "Git", url: repo.url })
    const added = mcpServers(await ask(web, { _tag: "AddMcpServerPackage", readId }))
    expect(added).toHaveLength(1)
    await sentWith(web, "@acme/linear-mcp", true)
    expect(
      new Uint8Array(await (await iconOf(hub, web, "@acme/linear-mcp")).arrayBuffer()),
    ).toEqual(svg("favicon"))
  })

  test("is found again when the MCP server is Upgraded", async () => {
    const { hub, web } = await iconHub({})
    const repo = mcpServerRepo({
      "package.json": packageJson("1.0.0"),
      "kndl.json": manifest("https://mcp.linear.app/mcp", { icon: "logo.svg" }),
      "logo.svg": new TextDecoder().decode(svg("one")),
    })
    const first = await readOf(web, { _tag: "Git", url: repo.url })
    await ask(web, { _tag: "AddMcpServerPackage", readId: first.readId })
    const before = await sentWith(web, "@acme/linear-mcp", true)

    repo.commit({
      "package.json": packageJson("1.1.0"),
      "logo.svg": new TextDecoder().decode(svg("two")),
    })
    const check = await ask(web, { _tag: "CheckMcpServerUpgrade", mcpServerId: "@acme/linear-mcp" })
    if (check._tag !== "McpServerPackageRead") throw new Error(JSON.stringify(check))
    await ask(web, {
      _tag: "UpgradeMcpServer",
      mcpServerId: "@acme/linear-mcp",
      readId: check.readId,
    })
    await web.take(
      "McpServersState",
      (message) =>
        message.mcpServers[0]?.iconHash !== undefined &&
        message.mcpServers[0].iconHash !== before?.iconHash,
    )
    expect(
      new Uint8Array(await (await iconOf(hub, web, "@acme/linear-mcp")).arrayBuffer()),
    ).toEqual(svg("two"))
  })
})
