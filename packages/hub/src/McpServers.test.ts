// MCP servers and their Installations (#221, ADR 0020): any Member creates an MCP server; an
// Installation needs access to every Repo it lists, as Sessions check it (ADR 0003); a Repo has one
// Installation of each MCP server; each Repo logs its MCP server changes; and a packaged
// MCP server, read from git or an upload, is pinned until upgraded (#220). A real Hub and web
// clients over WebSockets, against the stand-in GitHub API and local git repos.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import {
  globalOwnerOnlyRefusal,
  globalMcpServerRefusal,
  globalReposRefusal,
  InstallationId,
  installationsDiffer,
  notGlobalRefusal,
  Participant,
  ParticipantId,
  repoKey,
  secondGlobalRefusal,
  SessionId,
} from "@kndl/protocol"
import { Effect, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { signInCookie } from "./Auth.ts"
import { McpServers } from "./McpServers.ts"
import { McpServerSources } from "./McpServerSources.ts"
import { generateSecretsKey } from "./Secrets.ts"
import { SignIns } from "./SignIns.ts"
import { type Connection, openWeb, stopAll, type Web } from "./testChannels.ts"
import { appId, appKeyPair, StandInGitHub } from "./testGitHubApi.ts"
import { manifest, packageJson, mcpServerRepo, removeMcpServerRepos } from "./testMcpServerRepo.ts"
import { startHub, type TestHub } from "./testSupport.ts"

afterEach(stopAll)
afterAll(removeMcpServerRepos)

const keys = appKeyPair()
let github: StandInGitHub
beforeAll(() => {
  github = StandInGitHub.start(keys.publicKey)
})
afterAll(() => github.stop())

const repo = "kddige/kndl"
const secret = "kddige/secret"
const missing = "kddige/no-such-repo"
const octocat = { id: "github:1", login: "octocat", name: "octocat" }
const url = "https://mcp.example.com/mcp"
const none = { _tag: "None" }

/**
 * A Hub with the GitHub App on `repo` and `secret`, octocat a collaborator on `repo` only, which
 * fetches MCP server packages from local git repos too.
 */
async function accessHub() {
  github.reset()
  github.installedOn.add(repo)
  github.installedOn.add(secret)
  github.grant(repo, "octocat")
  return startHub({
    config: {
      devLogin: true,
      githubAppId: Option.some(appId),
      githubAppPrivateKey: Option.some(Redacted.make(keys.privateKeyPem)),
      githubApiUrl: github.url,
      secretsKey: Option.some(Redacted.make(generateSecretsKey())),
    },
    mcpServerSources: McpServerSources.layerWith({ protocols: ["https", "file"] }),
  })
}

/** A web client signed in with GitHub as octocat. */
async function openOctocat(hub: TestHub) {
  const { token } = await hub.run(
    Effect.gen(function* () {
      const signIns = yield* SignIns
      return yield* signIns.signIn(
        Participant.make({ ...octocat, id: ParticipantId.make(octocat.id) }),
      )
    }),
  )
  return openWeb(hub, octocat.login, `${signInCookie}=${token}`)
}

let requests = 0

/** Every row of every table in the Hub's database, as text. */
const databaseText = (hub: TestHub) =>
  hub.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table'
      `
      const rows: Array<unknown> = []
      for (const { name } of tables) rows.push(yield* sql.unsafe(`SELECT * FROM "${name}"`))
      return JSON.stringify(rows)
    }),
  )

/** Sends `command` with a fresh request id, and returns the Hub's answer to it. */
async function ask(web: Connection<Web>, command: Record<string, unknown> & { _tag: string }) {
  const requestId = `q-${++requests}`
  web.send({ ...command, requestId })
  return web.takeWhere(
    (message): message is Web => "requestId" in message && message.requestId === requestId,
    `answer to ${command._tag}`,
  )
}

/** The MCP servers and Installations in an answer. */
function state(answer: Web) {
  if (answer._tag !== "McpServersState")
    throw new Error(`Not McpServersState: ${JSON.stringify(answer)}`)
  return answer
}

const refused = (command: string, message: string) => ({
  _tag: "CommandFailed" as const,
  command,
  requestId: expect.any(String),
  message,
})

const noAccess = (command: string, about: string) =>
  refused(
    command,
    `You have no access to ${about} on GitHub, or the GitHub App isn't installed on it.`,
  )

/** alice creates an MCP server named `name`, and returns its id. */
async function createMcpServer(web: Connection<Web>, name = "Docs Search") {
  const answer = state(await ask(web, { _tag: "CreateMcpServer", auth: none, name, url }))
  const mcpServer = answer.mcpServers.find((found) => found.name === name)
  if (mcpServer === undefined) throw new Error("No MCP server created")
  return mcpServer.id
}

/** Creates an Installation of the MCP server on the Repos, and returns its id. */
async function install(
  web: Connection<Web>,
  mcpServerId: string,
  repos: ReadonlyArray<string>,
  name = "Docs",
) {
  const answer = state(await ask(web, { _tag: "CreateInstallation", mcpServerId, name, repos }))
  const installation = answer.installations.find(
    (found) => found.mcpServerId === mcpServerId && found.name === name,
  )
  if (installation === undefined) throw new Error("No Installation created")
  return installation.id
}

describe("a Hub-only MCP server", () => {
  test("any Member creates, edits and deletes one, its id hub: and a slug of its name", async () => {
    const hub = await accessHub()
    const web = await openOctocat(hub)
    const id = await createMcpServer(web, "Docs Search")
    expect(id).toBe("hub:docs-search")
    // The same name again gets an id of its own.
    expect(await createMcpServer(web, "Docs  search")).toBe("hub:docs-search-2")

    const edited = state(
      await ask(web, {
        _tag: "EditMcpServer",
        auth: none,
        mcpServerId: id,
        name: "Docs",
        url: "https://docs.example.com/mcp",
      }),
    )
    expect(edited.mcpServers.find((mcpServer) => mcpServer.id === id)).toMatchObject({
      id,
      name: "Docs",
      url: "https://docs.example.com/mcp",
      createdBy: { login: "octocat" },
    })

    const deleted = state(await ask(web, { _tag: "DeleteMcpServer", mcpServerId: id }))
    expect(deleted.mcpServers.map((mcpServer) => mcpServer.id)).toEqual(["hub:docs-search-2"])
  })

  test("is refused a name or URL that breaks the rules", async () => {
    const hub = await accessHub()
    const web = await openWeb(hub, "alice")
    expect(await ask(web, { _tag: "CreateMcpServer", auth: none, name: " ", url })).toEqual(
      refused("CreateMcpServer", "An MCP server needs a name."),
    )
    expect(
      await ask(web, {
        _tag: "CreateMcpServer",
        auth: none,
        name: "Docs",
        url: "https://me:pw@example.com",
      }),
    ).toMatchObject({ _tag: "CommandFailed", command: "CreateMcpServer" })
  })

  test("with Installations can't be deleted", async () => {
    const hub = await accessHub()
    const web = await openWeb(hub, "alice")
    const mcpServerId = await createMcpServer(web)
    const installationId = await install(web, mcpServerId, [repo])
    expect(await ask(web, { _tag: "DeleteMcpServer", mcpServerId })).toEqual(
      refused("DeleteMcpServer", "Docs Search has an Installation: delete it first."),
    )
    await ask(web, { _tag: "DeleteInstallation", installationId })
    expect(state(await ask(web, { _tag: "DeleteMcpServer", mcpServerId })).mcpServers).toEqual([])
  })

  test("is sent to every web client that asked for MCP servers", async () => {
    const hub = await accessHub()
    const alice = await openWeb(hub, "alice")
    const bob = await openWeb(hub, "bob")
    state(await ask(bob, { _tag: "GetMcpServers" }))
    await createMcpServer(alice)
    expect((await bob.take("McpServersState")).mcpServers.map((mcpServer) => mcpServer.id)).toEqual(
      ["hub:docs-search"],
    )
  })
})

describe("an Installation", () => {
  test("is on in the Repos it lists, which can be added and removed", async () => {
    const hub = await accessHub()
    const web = await openWeb(hub, "alice")
    const mcpServerId = await createMcpServer(web)
    const id = await install(web, mcpServerId, [repo])
    const edited = state(
      await ask(web, {
        _tag: "EditInstallation",
        installationId: id,
        name: "Docs",
        repos: [repo, secret],
      }),
    )
    expect(edited.installations).toMatchObject([{ id, mcpServerId, repos: [repo, secret] }])
    const removed = state(
      await ask(web, {
        _tag: "EditInstallation",
        installationId: id,
        name: "Docs",
        repos: [secret],
      }),
    )
    expect(removed.installations).toMatchObject([{ id, repos: [secret] }])
  })

  test("a second one of the same MCP server on a Repo is refused, naming the first", async () => {
    const hub = await accessHub()
    const web = await openWeb(hub, "alice")
    const mcpServerId = await createMcpServer(web)
    await install(web, mcpServerId, [repo], "Team docs")
    const message =
      "kddige/kndl already has Team docs, an Installation of Docs Search: a Repo has at most one Installation of each MCP server."
    expect(
      await ask(web, {
        _tag: "CreateInstallation",
        mcpServerId,
        name: "More docs",
        repos: [secret, "KDDIGE/KNDL"],
      }),
    ).toEqual(refused("CreateInstallation", message))
    // Nor by adding the Repo to another Installation of it.
    const other = await install(web, mcpServerId, [secret], "More docs")
    expect(
      await ask(web, {
        _tag: "EditInstallation",
        installationId: other,
        name: "More docs",
        repos: [secret, repo],
      }),
    ).toEqual(refused("EditInstallation", message))
    // An Installation of another MCP server is welcome.
    const linear = await createMcpServer(web, "Linear")
    await install(web, linear, [repo], "Linear")
  })

  test("needs access to every Repo it lists, alike whether a Repo exists or not", async () => {
    const hub = await accessHub()
    const web = await openOctocat(hub)
    const mcpServerId = await createMcpServer(web)
    for (const about of [secret, missing]) {
      expect(
        await ask(web, {
          _tag: "CreateInstallation",
          mcpServerId,
          name: "Docs",
          repos: [repo, about],
        }),
      ).toEqual(noAccess("CreateInstallation", about))
    }
    const id = await install(web, mcpServerId, [repo])
    expect(
      await ask(web, {
        _tag: "EditInstallation",
        installationId: id,
        name: "Docs",
        repos: [repo, secret],
      }),
    ).toEqual(noAccess("EditInstallation", secret))
    expect(state(await ask(web, { _tag: "GetMcpServers" })).installations).toMatchObject([
      { id, repos: [repo] },
    ])
  })

  test("on a Repo out of reach can't be changed, and its Repos aren't named", async () => {
    const hub = await accessHub()
    const alice = await openWeb(hub, "alice")
    const mcpServerId = await createMcpServer(alice)
    const id = await install(alice, mcpServerId, [repo, secret])
    const web = await openOctocat(hub)

    // octocat sees the Repo they have access to, and how many others there are.
    expect(state(await ask(web, { _tag: "GetMcpServers" })).installations).toEqual([
      expect.objectContaining({ id, repos: [repo], otherRepos: 1 }),
    ])
    const message =
      "This Installation is on in Repos you have no access to, so you can't change it."
    expect(
      await ask(web, { _tag: "EditInstallation", installationId: id, name: "Docs", repos: [repo] }),
    ).toEqual(refused("EditInstallation", message))
    expect(await ask(web, { _tag: "DeleteInstallation", installationId: id })).toEqual(
      refused("DeleteInstallation", message),
    )
    // Nor its account connected or disconnected (#217): its tokens reach every Repo it lists.
    expect(await ask(web, { _tag: "ConnectInstallation", installationId: id })).toEqual(
      refused("ConnectInstallation", message),
    )
    expect(await ask(web, { _tag: "DisconnectInstallation", installationId: id })).toEqual(
      refused("DisconnectInstallation", message),
    )
    // Nor its MCP server edited: its URL is where their MCP traffic goes.
    expect(
      await ask(web, {
        _tag: "EditMcpServer",
        auth: none,
        mcpServerId,
        name: "Docs",
        url: "https://evil.example",
      }),
    ).toEqual(
      refused(
        "EditMcpServer",
        "This MCP server has Installations on Repos you have no access to, so you can't edit it.",
      ),
    )
    expect(JSON.stringify(await web.untaken("McpServersState"))).not.toContain(secret)
  })
})

describe("an Installation's header secret values", () => {
  const value = "sk-live-0123456789"
  const headers = {
    _tag: "Headers" as const,
    headers: [
      { key: "token", title: "API key", header: "Authorization", template: "Bearer {value}" },
    ],
  }

  test("are write-only, encrypted at rest, and logged by title", async () => {
    const hub = await startHub({
      config: { devLogin: true, secretsKey: Option.some(Redacted.make(generateSecretsKey())) },
    })
    const web = await openWeb(hub, "alice")
    const created = state(
      await ask(web, { _tag: "CreateMcpServer", auth: headers, name: "Docs Search", url }),
    )
    const mcpServerId = created.mcpServers[0]?.id
    expect(created.mcpServers[0]?.auth).toEqual(headers)
    const answer = state(
      await ask(web, {
        _tag: "CreateInstallation",
        mcpServerId,
        name: "Docs",
        repos: [repo],
        values: [{ key: "token", value }],
      }),
    )
    expect(answer.installations[0]?.values).toEqual([
      {
        key: "token",
        setBy: expect.objectContaining({ login: "alice" }),
        setAt: expect.any(Number),
      },
    ])
    const log = await ask(web, { _tag: "GetMcpServerLog", repo })
    if (log._tag !== "McpServerLog") throw new Error("No log")
    expect(log.entries.map((entry) => [entry.change, entry.secrets])).toEqual([
      ["ValuesSet", ["API key"]],
      ["Created", undefined],
    ])
    expect(web.texts.join("\n")).not.toContain(value)
    expect(JSON.stringify(log)).not.toContain(value)
    expect(await databaseText(hub)).not.toContain(value)
  })

  test("are refused without a secrets key, and for a key the MCP server doesn't declare", async () => {
    const hub = await startHub({ config: { devLogin: true } })
    const web = await openWeb(hub, "alice")
    const created = state(
      await ask(web, { _tag: "CreateMcpServer", auth: headers, name: "Docs Search", url }),
    )
    const mcpServerId = created.mcpServers[0]?.id
    const create = (values: ReadonlyArray<{ key: string; value: string }>) =>
      ask(web, { _tag: "CreateInstallation", mcpServerId, name: "Docs", repos: [repo], values })
    expect(await create([{ key: "other", value }])).toEqual(
      refused("CreateInstallation", "Docs Search has no header secret other."),
    )
    expect(await create([{ key: "token", value }])).toMatchObject({
      _tag: "CommandFailed",
      command: "CreateInstallation",
    })
    // Without a value, the Installation is made, and needs one.
    expect(state(await create([])).installations[0]?.values).toEqual([])
  })

  test("are redacted on every Repo an Installation could be on in, off or overridden there too", async () => {
    const hub = await startHub({
      config: { devLogin: true, secretsKey: Option.some(Redacted.make(generateSecretsKey())) },
    })
    const web = await openWeb(hub, "alice")
    await makeOwner(hub, "alice")
    const created = state(
      await ask(web, { _tag: "CreateMcpServer", auth: headers, name: "Docs Search", url }),
    )
    const mcpServerId = created.mcpServers[0]?.id
    const installWith = async (name: string, token: string, repos: ReadonlyArray<string>) => {
      const answer = state(
        await ask(web, {
          _tag: "CreateInstallation",
          mcpServerId,
          name,
          repos,
          ...(repos.length === 0 && { global: true }),
          values: [{ key: "token", value: token }],
        }),
      )
      const installation = answer.installations.find((found) => found.name === name)
      if (installation === undefined) throw new Error("No Installation created")
      return installation.id
    }
    const global = await installWith("Docs everywhere", "sk-global-0001", [])
    await installWith("Team docs", "sk-team-0002", [secret])
    await turn(web, global, repo, false)
    const valuesOn = (on: string) =>
      hub.run(
        Effect.gen(function* () {
          const mcpServers = yield* McpServers
          return (yield* mcpServers.valuesOn(on)).map(Redacted.value).toSorted()
        }),
      )
    // Off on one Repo and overridden on the other, the global one's value is redacted on both:
    // a Session that started before may hold it still.
    expect(await valuesOn(repo)).toEqual(["sk-global-0001"])
    expect(await valuesOn("KDDIGE/Secret")).toEqual(["sk-global-0001", "sk-team-0002"])
    expect(await valuesOn("kddige/brand-new")).toEqual(["sk-global-0001"])
  })
})

describe("a Repo's MCP server change log", () => {
  test("says who created, edited, added or removed an Installation on it, and when", async () => {
    const hub = await accessHub()
    const web = await openWeb(hub, "alice")
    const mcpServerId = await createMcpServer(web)
    const id = await install(web, mcpServerId, [repo])
    await ask(web, {
      _tag: "EditInstallation",
      installationId: id,
      name: "Team docs",
      repos: [repo],
    })
    await ask(web, {
      _tag: "EditMcpServer",
      auth: none,
      mcpServerId,
      name: "Docs Search",
      url: `${url}/v2`,
    })
    await ask(web, {
      _tag: "EditInstallation",
      installationId: id,
      name: "Team docs",
      repos: [secret],
    })
    await ask(web, { _tag: "DeleteInstallation", installationId: id })

    const log = await ask(web, { _tag: "GetMcpServerLog", repo: "KDDIGE/kndl" })
    expect(log).toMatchObject({ _tag: "McpServerLog", repo: "KDDIGE/kndl" })
    if (log._tag !== "McpServerLog") throw new Error("No log")
    expect(log.entries.map((entry) => [entry.change, entry.installationName])).toEqual([
      ["Removed", "Team docs"],
      ["McpServerEdited", "Team docs"],
      ["Renamed", "Team docs"],
      ["Created", "Docs"],
    ])
    expect(log.entries[0]).toMatchObject({
      by: { login: "alice" },
      mcpServerId,
      mcpServerName: "Docs Search",
      installationId: id,
      at: expect.any(Number),
    })

    const other = await ask(web, { _tag: "GetMcpServerLog", repo: secret })
    if (other._tag !== "McpServerLog") throw new Error("No log")
    expect(other.entries.map((entry) => entry.change)).toEqual(["Deleted", "Added"])
  })

  test("is sent as it changes to those with access, and refused without", async () => {
    const hub = await accessHub()
    const alice = await openWeb(hub, "alice")
    const web = await openOctocat(hub)
    expect(await ask(web, { _tag: "GetMcpServerLog", repo: secret })).toEqual(
      noAccess("GetMcpServerLog", secret),
    )
    expect(await ask(web, { _tag: "GetMcpServerLog", repo })).toMatchObject({ entries: [] })
    const mcpServerId = await createMcpServer(alice)
    await install(alice, mcpServerId, [repo, secret])
    const sent = await web.take("McpServerLog")
    expect(sent).toMatchObject({ repo, entries: [{ change: "Created" }] })
    expect(await web.untaken("McpServerLog")).toEqual([])
  })
})

/** A package the Hub read, from an answer. */
function packageRead(answer: Web) {
  if (answer._tag !== "McpServerPackageRead") {
    throw new Error(`Not McpServerPackageRead: ${JSON.stringify(answer)}`)
  }
  return answer
}

/** A git repo of the Linear package at 1.0.0. */
const linearRepo = () =>
  mcpServerRepo({
    "package.json": packageJson("1.0.0"),
    "kndl.json": manifest("https://mcp.linear.app/mcp", { description: "Linear's issues." }),
  })

const linear = "@acme/linear-mcp"

/** The Linear package at `version`, uploaded as a folder. */
const folder = (version: string) => ({
  _tag: "Folder",
  folderName: "linear-mcp",
  packageJson: packageJson(version),
  manifest: manifest(),
})

/** Reads the package from git and adds it, returning the MCP server as added. */
async function addFromGit(web: Connection<Web>, gitUrl: string) {
  const read = packageRead(
    await ask(web, { _tag: "ReadMcpServerPackage", from: { _tag: "Git", url: gitUrl } }),
  )
  const added = state(await ask(web, { _tag: "AddMcpServerPackage", readId: read.readId }))
  const mcpServer = added.mcpServers.find((found) => found.id === read.read.id)
  if (mcpServer === undefined) throw new Error("No MCP server added")
  return mcpServer
}

/** The Installations a Session of the Repo starting now runs with. */
const forSession = (hub: TestHub, on: string) =>
  hub.run(
    Effect.gen(function* () {
      const mcpServers = yield* McpServers
      return (yield* mcpServers.installationsOn([on])).get(repoKey(on)) ?? []
    }),
  )

/** A manifest's auth: an API key, and a Team sent as `team`. */
const secrets = (team: string) => ({
  type: "headers",
  headers: [
    { key: "apiKey", title: "API key", header: "Authorization", template: "Bearer {value}" },
    { key: "team", title: "Team", header: team },
  ],
})

describe("a packaged MCP server", () => {
  test("any Member adds one from git, pinned to its version and commit", async () => {
    const hub = await accessHub()
    const web = await openOctocat(hub)
    const pkg = linearRepo()
    const read = packageRead(
      await ask(web, { _tag: "ReadMcpServerPackage", from: { _tag: "Git", url: pkg.url } }),
    )
    expect(read).toEqual({
      _tag: "McpServerPackageRead",
      requestId: expect.any(String),
      readId: expect.any(String),
      read: {
        id: linear,
        name: "Linear",
        description: "Linear's issues.",
        url: "https://mcp.linear.app/mcp",
        auth: { _tag: "None" },
        package: { version: "1.0.0", commit: pkg.first, source: { _tag: "Git", url: pkg.url } },
      },
    })
    // Reading adds nothing; only the person who read it adds it, once.
    expect(state(await ask(web, { _tag: "GetMcpServers" })).mcpServers).toEqual([])
    const alice = await openWeb(hub, "alice")
    const stale = refused("AddMcpServerPackage", "That package read has expired; read it again.")
    expect(await ask(alice, { _tag: "AddMcpServerPackage", readId: read.readId })).toEqual(stale)
    const added = state(await ask(web, { _tag: "AddMcpServerPackage", readId: read.readId }))
    expect(added.mcpServers).toEqual([
      {
        ...read.read,
        createdBy: expect.objectContaining({ login: "octocat" }),
        createdAt: expect.any(Number),
      },
    ])
    expect(await ask(web, { _tag: "AddMcpServerPackage", readId: read.readId })).toEqual(stale)
  })

  test("any Member adds one from an uploaded folder", async () => {
    const hub = await accessHub()
    const web = await openWeb(hub, "alice")
    const read = packageRead(
      await ask(web, { _tag: "ReadMcpServerPackage", from: folder("1.0.0") }),
    )
    const added = state(await ask(web, { _tag: "AddMcpServerPackage", readId: read.readId }))
    expect(added.mcpServers).toMatchObject([
      {
        id: linear,
        package: { version: "1.0.0", source: { _tag: "Upload", fileName: "linear-mcp" } },
      },
    ])
  })

  test("named as an MCP server on the Hub is refused from another source, and offered as an Upgrade from the same", async () => {
    const hub = await accessHub()
    const web = await openWeb(hub, "alice")
    const pkg = linearRepo()
    pkg.tag("v1.0.0")
    await addFromGit(web, pkg.url)

    const fork = linearRepo()
    expect(
      await ask(web, { _tag: "ReadMcpServerPackage", from: { _tag: "Git", url: fork.url } }),
    ).toEqual(
      refused(
        "ReadMcpServerPackage",
        `An MCP server named ${linear} is already on the Hub, from another source: only a package from the same source can upgrade it.`,
      ),
    )
    const again = packageRead(
      await ask(web, {
        _tag: "ReadMcpServerPackage",
        from: { _tag: "Git", url: pkg.url, ref: "v1.0.0" },
      }),
    )
    expect(again.upgrades).toBe(linear)
    expect(await ask(web, { _tag: "AddMcpServerPackage", readId: again.readId })).toEqual(
      refused(
        "AddMcpServerPackage",
        `An MCP server named ${linear} is already on the Hub, from this source: upgrade it instead.`,
      ),
    )
  })

  test("is upgraded only on confirmation, which its Repos log and their Sessions pick up", async () => {
    const hub = await accessHub()
    const web = await openWeb(hub, "alice")
    const pkg = linearRepo()
    const mcpServer = await addFromGit(web, pkg.url)
    const installationId = await install(web, mcpServer.id, [repo], "Linear")
    const before = await forSession(hub, repo)
    expect(before).toMatchObject([{ mcpServerVersion: `1.0.0 (${pkg.first.slice(0, 7)})` }])

    const second = pkg.commit({
      "package.json": packageJson("2.0.0"),
      "kndl.json": manifest("https://mcp.linear.app/v2", {
        auth: {
          type: "headers",
          headers: [
            {
              key: "apiKey",
              title: "API key",
              header: "Authorization",
              template: "Bearer {value}",
            },
          ],
        },
      }),
    })
    const check = packageRead(
      await ask(web, { _tag: "CheckMcpServerUpgrade", mcpServerId: mcpServer.id }),
    )
    expect(check.upgrades).toBe(linear)
    expect(check.read).toMatchObject({
      url: "https://mcp.linear.app/v2",
      package: { version: "2.0.0", commit: second },
    })
    // Checking changes nothing.
    expect(state(await ask(web, { _tag: "GetMcpServers" })).mcpServers).toEqual([mcpServer])

    const upgraded = state(
      await ask(web, { _tag: "UpgradeMcpServer", mcpServerId: mcpServer.id, readId: check.readId }),
    )
    expect(upgraded.mcpServers).toEqual([
      // The manifest no longer has a description, so neither has the MCP server.
      { ...check.read, createdBy: mcpServer.createdBy, createdAt: mcpServer.createdAt },
    ])
    const version = `2.0.0 (${second.slice(0, 7)})`
    const log = await ask(web, { _tag: "GetMcpServerLog", repo })
    if (log._tag !== "McpServerLog") throw new Error("No log")
    expect(log.entries[0]).toMatchObject({
      change: "McpServerUpgraded",
      by: { login: "alice" },
      mcpServerId: mcpServer.id,
      mcpServerVersion: version,
      installationId,
    })
    const after = await forSession(hub, repo)
    expect(after).toMatchObject([{ mcpServerVersion: version }])
    expect(installationsDiffer(before, after)).toBe(true)
  })

  test("an Upgrade clears the values its Installations hold as an edit does", async () => {
    const hub = await accessHub()
    const web = await openWeb(hub, "alice")
    const pkg = mcpServerRepo({
      "package.json": packageJson("1.0.0"),
      "kndl.json": manifest("https://mcp.linear.app/mcp", { auth: secrets("X-Team") }),
    })
    const mcpServer = await addFromGit(web, pkg.url)
    const created = state(
      await ask(web, {
        _tag: "CreateInstallation",
        mcpServerId: mcpServer.id,
        name: "Linear",
        repos: [repo],
        values: [
          { key: "apiKey", value: "lin_api_0123456789" },
          { key: "team", value: "team-0123456789" },
        ],
      }),
    )
    expect(created.installations[0]?.values.map((value) => value.key)).toEqual(["apiKey", "team"])
    const upgrade = async () => {
      const check = packageRead(
        await ask(web, { _tag: "CheckMcpServerUpgrade", mcpServerId: mcpServer.id }),
      )
      return state(
        await ask(web, {
          _tag: "UpgradeMcpServer",
          mcpServerId: mcpServer.id,
          readId: check.readId,
        }),
      )
    }
    const log = async () => {
      const answer = await ask(web, { _tag: "GetMcpServerLog", repo })
      if (answer._tag !== "McpServerLog") throw new Error(answer._tag)
      return answer.entries.map((entry) => [entry.change, entry.secrets, entry.mcpServerVersion])
    }

    // Another header for Team, on another path of the same origin: only Team's value goes.
    const second = pkg.commit({
      "package.json": packageJson("2.0.0"),
      "kndl.json": manifest("https://mcp.linear.app/v2/mcp", { auth: secrets("X-Linear-Team") }),
    })
    const reheadered = await upgrade()
    expect(reheadered.installations[0]?.values.map((value) => value.key)).toEqual(["apiKey"])
    expect((await log()).slice(0, 2)).toEqual([
      ["ValuesCleared", ["Team"], undefined],
      ["McpServerUpgraded", undefined, `2.0.0 (${second.slice(0, 7)})`],
    ])

    // Another origin: every value goes, so none reaches a server it wasn't entered for.
    const third = pkg.commit({
      "package.json": packageJson("3.0.0"),
      "kndl.json": manifest("https://linear.example.com/mcp", { auth: secrets("X-Linear-Team") }),
    })
    const moved = await upgrade()
    expect(moved.installations[0]?.values).toEqual([])
    expect((await log()).slice(0, 2)).toEqual([
      ["ValuesCleared", ["API key"], undefined],
      ["McpServerUpgraded", undefined, `3.0.0 (${third.slice(0, 7)})`],
    ])
  })

  test("an Upgrade is refused if the MCP server changed since its read", async () => {
    const hub = await accessHub()
    const web = await openWeb(hub, "alice")
    const pkg = linearRepo()
    const mcpServer = await addFromGit(web, pkg.url)
    pkg.commit({ "package.json": packageJson("2.0.0") })
    const first = packageRead(
      await ask(web, { _tag: "CheckMcpServerUpgrade", mcpServerId: mcpServer.id }),
    )
    const second = packageRead(
      await ask(web, { _tag: "CheckMcpServerUpgrade", mcpServerId: mcpServer.id }),
    )
    state(
      await ask(web, { _tag: "UpgradeMcpServer", mcpServerId: mcpServer.id, readId: first.readId }),
    )
    expect(
      await ask(web, {
        _tag: "UpgradeMcpServer",
        mcpServerId: mcpServer.id,
        readId: second.readId,
      }),
    ).toEqual(
      refused("UpgradeMcpServer", "Linear changed since that read; check for an upgrade again."),
    )
  })

  test("isn't edited, and is upgraded only with access to every Repo its Installations list", async () => {
    const hub = await accessHub()
    const alice = await openWeb(hub, "alice")
    const pkg = linearRepo()
    const mcpServer = await addFromGit(alice, pkg.url)
    expect(
      await ask(alice, {
        _tag: "EditMcpServer",
        mcpServerId: mcpServer.id,
        name: "Mine",
        url: mcpServer.url,
        auth: mcpServer.auth,
      }),
    ).toEqual(
      refused(
        "EditMcpServer",
        "Linear is a packaged MCP server, pinned to its version: upgrade it to change it.",
      ),
    )
    await install(alice, mcpServer.id, [repo, secret], "Linear")
    pkg.commit({ "package.json": packageJson("2.0.0") })
    const web = await openOctocat(hub)
    const check = packageRead(
      await ask(web, { _tag: "CheckMcpServerUpgrade", mcpServerId: mcpServer.id }),
    )
    expect(
      await ask(web, { _tag: "UpgradeMcpServer", mcpServerId: mcpServer.id, readId: check.readId }),
    ).toEqual(
      refused(
        "UpgradeMcpServer",
        "This MCP server has Installations on Repos you have no access to, so you can't upgrade it.",
      ),
    )
  })

  test("from an upload is upgraded by uploading its new version, not by checking", async () => {
    const hub = await accessHub()
    const web = await openWeb(hub, "alice")
    const read = packageRead(
      await ask(web, { _tag: "ReadMcpServerPackage", from: folder("1.0.0") }),
    )
    await ask(web, { _tag: "AddMcpServerPackage", readId: read.readId })
    expect(await ask(web, { _tag: "CheckMcpServerUpgrade", mcpServerId: linear })).toEqual(
      refused(
        "CheckMcpServerUpgrade",
        "Linear was uploaded: upload its new version to upgrade it.",
      ),
    )
    const next = packageRead(
      await ask(web, { _tag: "ReadMcpServerPackage", from: folder("1.1.0") }),
    )
    expect(next.upgrades).toBe(linear)
    const upgraded = state(
      await ask(web, { _tag: "UpgradeMcpServer", mcpServerId: linear, readId: next.readId }),
    )
    expect(upgraded.mcpServers).toMatchObject([{ id: linear, package: { version: "1.1.0" } }])
  })
})

/** Makes the person signed in as `login` the Hub's Owner, as a Setup link would (#219). */
const makeOwner = (hub: TestHub, login: string) =>
  hub.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE participants SET owner = 1 WHERE login = ${login}`
    }),
  )

/** The Owner creates a global Installation of the MCP server, and returns its id. */
async function installGlobal(web: Connection<Web>, mcpServerId: string, name = "Docs everywhere") {
  const answer = state(
    await ask(web, { _tag: "CreateInstallation", mcpServerId, name, repos: [], global: true }),
  )
  const installation = answer.installations.find((found) => found.name === name)
  if (installation === undefined) throw new Error("No global Installation created")
  expect(installation).toMatchObject({ global: true, repos: [] })
  return installation.id
}

/** The Repo's log, as each change, its Installation's name, and whether it was to a global one. */
async function logOf(web: Connection<Web>, on: string) {
  const log = await ask(web, { _tag: "GetMcpServerLog", repo: on })
  if (log._tag !== "McpServerLog") throw new Error(`No log: ${JSON.stringify(log)}`)
  return log.entries.map((entry) => [entry.change, entry.installationName, entry.global === true])
}

/** Turns the global Installation off for the Repo, or back on. */
const turn = (web: Connection<Web>, installationId: string, on: string, turnOn: boolean) =>
  ask(web, { _tag: "TurnGlobalInstallation", installationId, repo: on, on: turnOn })

describe("a global Installation (#219)", () => {
  test("only the Owner creates, edits or deletes one", async () => {
    const hub = await accessHub()
    const alice = await openWeb(hub, "alice")
    const mcpServerId = await createMcpServer(alice)
    expect(
      await ask(alice, {
        _tag: "CreateInstallation",
        mcpServerId,
        name: "Docs everywhere",
        repos: [],
        global: true,
      }),
    ).toEqual(refused("CreateInstallation", globalOwnerOnlyRefusal))
    // Nor is a Repo-scoped one made global.
    const scoped = await install(alice, mcpServerId, [repo])
    expect(
      await ask(alice, {
        _tag: "EditInstallation",
        installationId: scoped,
        name: "Docs",
        repos: [],
        global: true,
      }),
    ).toEqual(refused("EditInstallation", globalOwnerOnlyRefusal))
    await ask(alice, { _tag: "DeleteInstallation", installationId: scoped })

    await makeOwner(hub, "alice")
    const id = await installGlobal(alice, mcpServerId)
    const web = await openOctocat(hub)
    expect(
      await ask(web, { _tag: "EditInstallation", installationId: id, name: "Mine", repos: [] }),
    ).toEqual(refused("EditInstallation", globalOwnerOnlyRefusal))
    expect(
      await ask(web, {
        _tag: "EditInstallation",
        installationId: id,
        name: "Docs everywhere",
        repos: [],
        global: true,
      }),
    ).toEqual(refused("EditInstallation", globalOwnerOnlyRefusal))
    expect(await ask(web, { _tag: "DeleteInstallation", installationId: id })).toEqual(
      refused("DeleteInstallation", globalOwnerOnlyRefusal),
    )

    // The Owner renames it, makes it Repo-scoped and global again, and deletes it.
    expect(
      state(
        await ask(alice, {
          _tag: "EditInstallation",
          installationId: id,
          name: "Docs here",
          repos: [repo],
        }),
      ).installations,
    ).toMatchObject([{ id, name: "Docs here", repos: [repo] }])
    expect(
      state(
        await ask(alice, {
          _tag: "EditInstallation",
          installationId: id,
          name: "Docs here",
          repos: [],
          global: true,
        }),
      ).installations,
    ).toMatchObject([{ id, global: true, repos: [] }])
    expect(
      state(await ask(alice, { _tag: "DeleteInstallation", installationId: id })).installations,
    ).toEqual([])
  })

  test("makes its MCP server the Owner's alone to edit, upgrade or delete", async () => {
    const hub = await accessHub()
    const alice = await openWeb(hub, "alice")
    await makeOwner(hub, "alice")
    const mcpServerId = await createMcpServer(alice)
    await installGlobal(alice, mcpServerId)
    const web = await openOctocat(hub)
    const refusal = globalMcpServerRefusal("Docs Search")
    expect(
      await ask(web, { _tag: "EditMcpServer", auth: none, mcpServerId, name: "Docs", url }),
    ).toEqual(refused("EditMcpServer", refusal))
    expect(await ask(web, { _tag: "DeleteMcpServer", mcpServerId })).toEqual(
      refused("DeleteMcpServer", refusal),
    )
    expect(
      state(await ask(alice, { _tag: "EditMcpServer", auth: none, mcpServerId, name: "Docs", url }))
        .mcpServers,
    ).toMatchObject([{ id: mcpServerId, name: "Docs" }])

    const pkg = linearRepo()
    const mcpServer = await addFromGit(alice, pkg.url)
    await installGlobal(alice, mcpServer.id, "Linear")
    pkg.commit({ "package.json": packageJson("2.0.0") })
    const check = packageRead(
      await ask(web, { _tag: "CheckMcpServerUpgrade", mcpServerId: mcpServer.id }),
    )
    expect(
      await ask(web, { _tag: "UpgradeMcpServer", mcpServerId: mcpServer.id, readId: check.readId }),
    ).toEqual(refused("UpgradeMcpServer", globalMcpServerRefusal("Linear")))
    const owners = packageRead(
      await ask(alice, { _tag: "CheckMcpServerUpgrade", mcpServerId: mcpServer.id }),
    )
    expect(
      state(
        await ask(alice, {
          _tag: "UpgradeMcpServer",
          mcpServerId: mcpServer.id,
          readId: owners.readId,
        }),
      ).mcpServers,
    ).toMatchObject([{ id: mcpServerId }, { id: mcpServer.id, package: { version: "2.0.0" } }])
  })

  test("is on in every Repo, a new one too, but where a Repo-scoped one of its MCP server is", async () => {
    const hub = await accessHub()
    const alice = await openWeb(hub, "alice")
    await makeOwner(hub, "alice")
    const mcpServerId = await createMcpServer(alice)
    const id = await installGlobal(alice, mcpServerId)
    // A Repo no one has seen yet: no row of its own, the global one on all the same.
    expect(await forSession(hub, "kddige/brand-new")).toMatchObject([
      { id, name: "Docs everywhere", global: true },
    ])
    expect(await forSession(hub, repo)).toMatchObject([{ id, global: true }])

    // One per MCP server: a second global one is refused, as is a global one listing Repos.
    expect(
      await ask(alice, {
        _tag: "CreateInstallation",
        mcpServerId,
        name: "More docs",
        repos: [],
        global: true,
      }),
    ).toEqual(refused("CreateInstallation", secondGlobalRefusal("Docs everywhere", "Docs Search")))
    expect(
      await ask(alice, {
        _tag: "CreateInstallation",
        mcpServerId,
        name: "More docs",
        repos: [repo],
        global: true,
      }),
    ).toEqual(refused("CreateInstallation", globalReposRefusal))

    // Anyone with access to a Repo puts a Repo-scoped one of the MCP server on it, in its place
    // there.
    const web = await openOctocat(hub)
    const scoped = await install(web, mcpServerId, [repo], "Team docs")
    const here = await forSession(hub, repo)
    expect(here.map((installation) => installation.id as string)).toEqual([scoped])
    expect(here[0]?.global).toBeUndefined()
    expect(await forSession(hub, secret)).toMatchObject([{ id, global: true }])
    // But still one Repo-scoped one of an MCP server on a Repo.
    expect(
      await ask(web, { _tag: "CreateInstallation", mcpServerId, name: "More docs", repos: [repo] }),
    ).toEqual(
      refused(
        "CreateInstallation",
        "kddige/kndl already has Team docs, an Installation of Docs Search: a Repo has at most one Installation of each MCP server.",
      ),
    )
    // The global one is back once the Repo-scoped one goes.
    await ask(web, { _tag: "DeleteInstallation", installationId: scoped })
    expect(await forSession(hub, repo)).toMatchObject([{ id, global: true }])
  })

  test("is turned off for a Repo, and back on, by anyone with access to it", async () => {
    const hub = await accessHub()
    const alice = await openWeb(hub, "alice")
    await makeOwner(hub, "alice")
    const mcpServerId = await createMcpServer(alice)
    const id = await installGlobal(alice, mcpServerId)
    const web = await openOctocat(hub)

    expect(state(await turn(web, id, "KDDIGE/kndl", false)).installations).toMatchObject([
      { id, global: true, off: [repo] },
    ])
    expect(await forSession(hub, repo)).toEqual([])
    expect(await forSession(hub, secret)).toMatchObject([{ id }])
    // Turning it off again changes nothing.
    expect(state(await turn(web, id, repo, false)).installations).toMatchObject([
      { id, off: [repo] },
    ])
    // Not for a Repo the person has no access to.
    expect(await turn(web, id, secret, false)).toEqual(noAccess("TurnGlobalInstallation", secret))

    expect(state(await turn(web, id, repo, true)).installations[0]?.off).toBeUndefined()
    expect(await forSession(hub, repo)).toMatchObject([{ id, global: true }])

    // A Repo-scoped one is taken off a Repo instead.
    const other = await createMcpServer(alice, "Linear")
    const scoped = await install(web, other, [repo], "Linear")
    expect(await turn(web, scoped, repo, false)).toEqual(
      refused("TurnGlobalInstallation", notGlobalRefusal("Linear")),
    )
  })

  test("is logged once, in every Repo's log; turning it off, in that Repo's alone", async () => {
    const hub = await accessHub()
    const alice = await openWeb(hub, "alice")
    await makeOwner(hub, "alice")
    const web = await openOctocat(hub)
    expect(await logOf(web, repo)).toEqual([])

    const mcpServerId = await createMcpServer(alice)
    const id = await installGlobal(alice, mcpServerId)
    // Sent to each person for the Repos they have access to.
    expect(await web.take("McpServerLog")).toMatchObject({
      repo,
      entries: [{ change: "Created", global: true }],
    })
    await turn(web, id, repo, false)
    await turn(alice, id, secret, false)
    await turn(alice, id, secret, true)
    await ask(alice, {
      _tag: "EditInstallation",
      installationId: id,
      name: "Docs",
      repos: [],
      global: true,
    })

    expect(await logOf(alice, repo)).toEqual([
      ["Renamed", "Docs", true],
      ["TurnedOff", "Docs everywhere", false],
      ["Created", "Docs everywhere", true],
    ])
    expect(await logOf(alice, secret)).toEqual([
      ["Renamed", "Docs", true],
      ["TurnedOn", "Docs everywhere", false],
      ["TurnedOff", "Docs everywhere", false],
      ["Created", "Docs everywhere", true],
    ])
    // A Repo no one has seen yet has its global changes.
    expect(await logOf(alice, "kddige/brand-new")).toEqual([
      ["Renamed", "Docs", true],
      ["Created", "Docs everywhere", true],
    ])

    await ask(alice, { _tag: "DeleteInstallation", installationId: id })
    expect((await logOf(alice, "kddige/brand-new"))[0]).toEqual(["Deleted", "Docs", true])
  })
})

/** How the Gateway answers a Session of the Repo's request through the Installation. */
const gatewayOn = (hub: TestHub, id: string, on: string) =>
  hub.run(
    Effect.gen(function* () {
      const mcpServers = yield* McpServers
      const target = yield* mcpServers.gatewayTarget(InstallationId.make(id), {
        id: SessionId.make("s-gateway"),
        repo: on,
      })
      return Option.match(target, { onNone: () => "Off", onSome: (found) => found._tag })
    }),
  )

/**
 * How the Gateway answers for each Installation on each Repo, checking it reaches exactly those a
 * Session of the Repo starting now runs with.
 */
const answers = async (hub: TestHub, ids: Record<string, string>, repos: ReadonlyArray<string>) => {
  const out: Record<string, Record<string, string>> = {}
  for (const on of repos) {
    const started = (await forSession(hub, on)).map((installation) => installation.id as string)
    const row: Record<string, string> = {}
    for (const [name, id] of Object.entries(ids)) {
      const answer = await gatewayOn(hub, id, on)
      expect([on, name, answer !== "Off"]).toEqual([on, name, started.includes(id)])
      row[name] = answer
    }
    out[on] = row
  }
  return out
}

describe("the Gateway's check (ADR 0020)", () => {
  test("reaches what a Session starting now runs with: listed, or global unless overridden or off, by any spelling", async () => {
    const hub = await accessHub()
    const alice = await openWeb(hub, "alice")
    await makeOwner(hub, "alice")
    const docs = await createMcpServer(alice)
    const global = await installGlobal(alice, docs)
    const web = await openOctocat(hub)
    const team = await install(web, docs, [repo], "Team docs")
    const tracker = await install(
      alice,
      await createMcpServer(alice, "Tracker"),
      [secret],
      "Tracker",
    )
    const repos = [repo, "KDDIGE/KNDL", secret, "Kddige/Secret", "kddige/brand-new"]

    expect(await answers(hub, { global, team, tracker }, repos)).toEqual({
      [repo]: { global: "Off", team: "Ready", tracker: "Off" },
      "KDDIGE/KNDL": { global: "Off", team: "Ready", tracker: "Off" },
      [secret]: { global: "Ready", team: "Off", tracker: "Ready" },
      "Kddige/Secret": { global: "Ready", team: "Off", tracker: "Ready" },
      "kddige/brand-new": { global: "Ready", team: "Off", tracker: "Off" },
    })

    // Turned off on a Repo by one spelling: off there by every spelling, and there alone. The
    // Repo-scoped one gone, the global one is on in its place.
    await turn(alice, global, "KDDIGE/secret", false)
    await ask(web, { _tag: "DeleteInstallation", installationId: team })
    expect(await answers(hub, { global, tracker }, repos)).toEqual({
      [repo]: { global: "Ready", tracker: "Off" },
      "KDDIGE/KNDL": { global: "Ready", tracker: "Off" },
      [secret]: { global: "Off", tracker: "Ready" },
      "Kddige/Secret": { global: "Off", tracker: "Ready" },
      "kddige/brand-new": { global: "Ready", tracker: "Off" },
    })

    // Turned off where a Repo-scoped one overrides it: still off once that one goes.
    await turn(alice, global, secret, true)
    const scoped = await install(web, docs, [repo], "Team docs")
    await turn(alice, global, repo, false)
    expect(await answers(hub, { global, scoped }, [repo, secret])).toEqual({
      [repo]: { global: "Off", scoped: "Ready" },
      [secret]: { global: "Ready", scoped: "Off" },
    })
    await ask(web, { _tag: "DeleteInstallation", installationId: scoped })
    expect(await answers(hub, { global }, [repo, secret])).toEqual({
      [repo]: { global: "Off" },
      [secret]: { global: "Ready" },
    })

    // Made Repo-scoped, it is on where it lists, the Repos that turned it off forgotten.
    await ask(alice, {
      _tag: "EditInstallation",
      installationId: global,
      name: "Docs everywhere",
      repos: [repo],
    })
    expect(await answers(hub, { global }, [repo, secret])).toEqual({
      [repo]: { global: "Ready" },
      [secret]: { global: "Off" },
    })

    expect(await gatewayOn(hub, "no-such-installation", repo)).toBe("Off")
  })
})
