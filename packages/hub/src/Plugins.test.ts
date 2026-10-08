// Plugins and their Installations (#221, ADR 0020): any Member creates a Plugin; an Installation
// needs access to every Repo it lists, as Sessions check it (ADR 0003); a Repo has one
// Installation of each Plugin; each Repo logs its Plugin changes; and a packaged Plugin, read from
// git or an upload, is pinned until upgraded (#220). A real Hub and web clients over WebSockets,
// against the stand-in GitHub API and local git repos.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { Participant, ParticipantId, repoKey } from "@kndl/protocol"
import { Effect, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { signInCookie } from "./Auth.ts"
import { installationsDiffer, installationsOn } from "./Plugins.ts"
import { PluginSources } from "./PluginSources.ts"
import { generateSecretsKey } from "./Secrets.ts"
import { SignIns } from "./SignIns.ts"
import { type Connection, openWeb, stopAll, type Web } from "./testChannels.ts"
import { appId, appKeyPair, StandInGitHub } from "./testGitHubApi.ts"
import { manifest, packageJson, pluginRepo, removePluginRepos } from "./testPluginRepo.ts"
import { startHub, type TestHub } from "./testSupport.ts"

afterEach(stopAll)
afterAll(removePluginRepos)

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
 * fetches Plugin packages from local git repos too.
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
    pluginSources: PluginSources.layerWith({ protocols: ["https", "file"] }),
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

/** The Plugins and Installations in an answer. */
function state(answer: Web) {
  if (answer._tag !== "PluginsState") throw new Error(`Not PluginsState: ${JSON.stringify(answer)}`)
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

/** alice creates a Plugin named `name`, and returns its id. */
async function createPlugin(web: Connection<Web>, name = "Docs Search") {
  const answer = state(await ask(web, { _tag: "CreatePlugin", auth: none, name, url }))
  const plugin = answer.plugins.find((found) => found.name === name)
  if (plugin === undefined) throw new Error("No Plugin created")
  return plugin.id
}

/** Creates an Installation of the Plugin on the Repos, and returns its id. */
async function install(
  web: Connection<Web>,
  pluginId: string,
  repos: ReadonlyArray<string>,
  name = "Docs",
) {
  const answer = state(await ask(web, { _tag: "CreateInstallation", pluginId, name, repos }))
  const installation = answer.installations.find(
    (found) => found.pluginId === pluginId && found.name === name,
  )
  if (installation === undefined) throw new Error("No Installation created")
  return installation.id
}

describe("a Hub-only Plugin", () => {
  test("any Member creates, edits and deletes one, its id hub: and a slug of its name", async () => {
    const hub = await accessHub()
    const web = await openOctocat(hub)
    const id = await createPlugin(web, "Docs Search")
    expect(id).toBe("hub:docs-search")
    // The same name again gets an id of its own.
    expect(await createPlugin(web, "Docs  search")).toBe("hub:docs-search-2")

    const edited = state(
      await ask(web, {
        _tag: "EditPlugin",
        auth: none,
        pluginId: id,
        name: "Docs",
        url: "https://docs.example.com/mcp",
      }),
    )
    expect(edited.plugins.find((plugin) => plugin.id === id)).toMatchObject({
      id,
      name: "Docs",
      url: "https://docs.example.com/mcp",
      createdBy: { login: "octocat" },
    })

    const deleted = state(await ask(web, { _tag: "DeletePlugin", pluginId: id }))
    expect(deleted.plugins.map((plugin) => plugin.id)).toEqual(["hub:docs-search-2"])
  })

  test("is refused a name or URL that breaks the rules", async () => {
    const hub = await accessHub()
    const web = await openWeb(hub, "alice")
    expect(await ask(web, { _tag: "CreatePlugin", auth: none, name: " ", url })).toEqual(
      refused("CreatePlugin", "A Plugin needs a name."),
    )
    expect(
      await ask(web, {
        _tag: "CreatePlugin",
        auth: none,
        name: "Docs",
        url: "https://me:pw@example.com",
      }),
    ).toMatchObject({ _tag: "CommandFailed", command: "CreatePlugin" })
  })

  test("with Installations can't be deleted", async () => {
    const hub = await accessHub()
    const web = await openWeb(hub, "alice")
    const pluginId = await createPlugin(web)
    const installationId = await install(web, pluginId, [repo])
    expect(await ask(web, { _tag: "DeletePlugin", pluginId })).toEqual(
      refused("DeletePlugin", "Docs Search has an Installation: delete it first."),
    )
    await ask(web, { _tag: "DeleteInstallation", installationId })
    expect(state(await ask(web, { _tag: "DeletePlugin", pluginId })).plugins).toEqual([])
  })

  test("is sent to every web client that asked for Plugins", async () => {
    const hub = await accessHub()
    const alice = await openWeb(hub, "alice")
    const bob = await openWeb(hub, "bob")
    state(await ask(bob, { _tag: "GetPlugins" }))
    await createPlugin(alice)
    expect((await bob.take("PluginsState")).plugins.map((plugin) => plugin.id)).toEqual([
      "hub:docs-search",
    ])
  })
})

describe("an Installation", () => {
  test("is on in the Repos it lists, which can be added and removed", async () => {
    const hub = await accessHub()
    const web = await openWeb(hub, "alice")
    const pluginId = await createPlugin(web)
    const id = await install(web, pluginId, [repo])
    const edited = state(
      await ask(web, {
        _tag: "EditInstallation",
        installationId: id,
        name: "Docs",
        repos: [repo, secret],
      }),
    )
    expect(edited.installations).toMatchObject([{ id, pluginId, repos: [repo, secret] }])
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

  test("a second one of the same Plugin on a Repo is refused, naming the first", async () => {
    const hub = await accessHub()
    const web = await openWeb(hub, "alice")
    const pluginId = await createPlugin(web)
    await install(web, pluginId, [repo], "Team docs")
    const message =
      "kddige/kndl already has Team docs, an Installation of Docs Search: a Repo has at most one Installation of each Plugin."
    expect(
      await ask(web, {
        _tag: "CreateInstallation",
        pluginId,
        name: "More docs",
        repos: [secret, "KDDIGE/KNDL"],
      }),
    ).toEqual(refused("CreateInstallation", message))
    // Nor by adding the Repo to another Installation of it.
    const other = await install(web, pluginId, [secret], "More docs")
    expect(
      await ask(web, {
        _tag: "EditInstallation",
        installationId: other,
        name: "More docs",
        repos: [secret, repo],
      }),
    ).toEqual(refused("EditInstallation", message))
    // An Installation of another Plugin is welcome.
    const linear = await createPlugin(web, "Linear")
    await install(web, linear, [repo], "Linear")
  })

  test("needs access to every Repo it lists, alike whether a Repo exists or not", async () => {
    const hub = await accessHub()
    const web = await openOctocat(hub)
    const pluginId = await createPlugin(web)
    for (const about of [secret, missing]) {
      expect(
        await ask(web, {
          _tag: "CreateInstallation",
          pluginId,
          name: "Docs",
          repos: [repo, about],
        }),
      ).toEqual(noAccess("CreateInstallation", about))
    }
    const id = await install(web, pluginId, [repo])
    expect(
      await ask(web, {
        _tag: "EditInstallation",
        installationId: id,
        name: "Docs",
        repos: [repo, secret],
      }),
    ).toEqual(noAccess("EditInstallation", secret))
    expect(state(await ask(web, { _tag: "GetPlugins" })).installations).toMatchObject([
      { id, repos: [repo] },
    ])
  })

  test("on a Repo out of reach can't be changed, and its Repos aren't named", async () => {
    const hub = await accessHub()
    const alice = await openWeb(hub, "alice")
    const pluginId = await createPlugin(alice)
    const id = await install(alice, pluginId, [repo, secret])
    const web = await openOctocat(hub)

    // octocat sees the Repo they have access to, and how many others there are.
    expect(state(await ask(web, { _tag: "GetPlugins" })).installations).toEqual([
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
    // Nor its Plugin edited: its URL is where their MCP traffic goes.
    expect(
      await ask(web, {
        _tag: "EditPlugin",
        auth: none,
        pluginId,
        name: "Docs",
        url: "https://evil.example",
      }),
    ).toEqual(
      refused(
        "EditPlugin",
        "This Plugin has Installations on Repos you have no access to, so you can't edit it.",
      ),
    )
    expect(JSON.stringify(await web.untaken("PluginsState"))).not.toContain(secret)
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
      await ask(web, { _tag: "CreatePlugin", auth: headers, name: "Docs Search", url }),
    )
    const pluginId = created.plugins[0]?.id
    expect(created.plugins[0]?.auth).toEqual(headers)
    const answer = state(
      await ask(web, {
        _tag: "CreateInstallation",
        pluginId,
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
    const log = await ask(web, { _tag: "GetPluginLog", repo })
    if (log._tag !== "PluginLog") throw new Error("No log")
    expect(log.entries.map((entry) => [entry.change, entry.secrets])).toEqual([
      ["ValuesSet", ["API key"]],
      ["Created", undefined],
    ])
    expect(web.texts.join("\n")).not.toContain(value)
    expect(JSON.stringify(log)).not.toContain(value)
    expect(await databaseText(hub)).not.toContain(value)
  })

  test("are refused without a secrets key, and for a key the Plugin doesn't declare", async () => {
    const hub = await startHub({ config: { devLogin: true } })
    const web = await openWeb(hub, "alice")
    const created = state(
      await ask(web, { _tag: "CreatePlugin", auth: headers, name: "Docs Search", url }),
    )
    const pluginId = created.plugins[0]?.id
    const create = (values: ReadonlyArray<{ key: string; value: string }>) =>
      ask(web, { _tag: "CreateInstallation", pluginId, name: "Docs", repos: [repo], values })
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
})

describe("a Repo's Plugin change log", () => {
  test("says who created, edited, added or removed an Installation on it, and when", async () => {
    const hub = await accessHub()
    const web = await openWeb(hub, "alice")
    const pluginId = await createPlugin(web)
    const id = await install(web, pluginId, [repo])
    await ask(web, {
      _tag: "EditInstallation",
      installationId: id,
      name: "Team docs",
      repos: [repo],
    })
    await ask(web, {
      _tag: "EditPlugin",
      auth: none,
      pluginId,
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

    const log = await ask(web, { _tag: "GetPluginLog", repo: "KDDIGE/kndl" })
    expect(log).toMatchObject({ _tag: "PluginLog", repo: "KDDIGE/kndl" })
    if (log._tag !== "PluginLog") throw new Error("No log")
    expect(log.entries.map((entry) => [entry.change, entry.installationName])).toEqual([
      ["Removed", "Team docs"],
      ["PluginEdited", "Team docs"],
      ["Renamed", "Team docs"],
      ["Created", "Docs"],
    ])
    expect(log.entries[0]).toMatchObject({
      by: { login: "alice" },
      pluginId,
      pluginName: "Docs Search",
      installationId: id,
      at: expect.any(Number),
    })

    const other = await ask(web, { _tag: "GetPluginLog", repo: secret })
    if (other._tag !== "PluginLog") throw new Error("No log")
    expect(other.entries.map((entry) => entry.change)).toEqual(["Deleted", "Added"])
  })

  test("is sent as it changes to those with access, and refused without", async () => {
    const hub = await accessHub()
    const alice = await openWeb(hub, "alice")
    const web = await openOctocat(hub)
    expect(await ask(web, { _tag: "GetPluginLog", repo: secret })).toEqual(
      noAccess("GetPluginLog", secret),
    )
    expect(await ask(web, { _tag: "GetPluginLog", repo })).toMatchObject({ entries: [] })
    const pluginId = await createPlugin(alice)
    await install(alice, pluginId, [repo, secret])
    const sent = await web.take("PluginLog")
    expect(sent).toMatchObject({ repo, entries: [{ change: "Created" }] })
    expect(await web.untaken("PluginLog")).toEqual([])
  })
})

/** A package the Hub read, from an answer. */
function packageRead(answer: Web) {
  if (answer._tag !== "PluginPackageRead") {
    throw new Error(`Not PluginPackageRead: ${JSON.stringify(answer)}`)
  }
  return answer
}

/** A git repo of the Linear package at 1.0.0. */
const linearRepo = () =>
  pluginRepo({
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

/** Reads the package from git and adds it, returning the Plugin as added. */
async function addFromGit(web: Connection<Web>, gitUrl: string) {
  const read = packageRead(
    await ask(web, { _tag: "ReadPluginPackage", from: { _tag: "Git", url: gitUrl } }),
  )
  const added = state(await ask(web, { _tag: "AddPluginPackage", readId: read.readId }))
  const plugin = added.plugins.find((found) => found.id === read.read.id)
  if (plugin === undefined) throw new Error("No Plugin added")
  return plugin
}

/** The Installations a Session of the Repo starting now runs with. */
const forSession = (hub: TestHub, on: string) =>
  hub.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return (yield* installationsOn(sql, [on])).get(repoKey(on)) ?? []
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

describe("a packaged Plugin", () => {
  test("any Member adds one from git, pinned to its version and commit", async () => {
    const hub = await accessHub()
    const web = await openOctocat(hub)
    const pkg = linearRepo()
    const read = packageRead(
      await ask(web, { _tag: "ReadPluginPackage", from: { _tag: "Git", url: pkg.url } }),
    )
    expect(read).toEqual({
      _tag: "PluginPackageRead",
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
    expect(state(await ask(web, { _tag: "GetPlugins" })).plugins).toEqual([])
    const alice = await openWeb(hub, "alice")
    const stale = refused("AddPluginPackage", "That package read has expired; read it again.")
    expect(await ask(alice, { _tag: "AddPluginPackage", readId: read.readId })).toEqual(stale)
    const added = state(await ask(web, { _tag: "AddPluginPackage", readId: read.readId }))
    expect(added.plugins).toEqual([
      {
        ...read.read,
        createdBy: expect.objectContaining({ login: "octocat" }),
        createdAt: expect.any(Number),
      },
    ])
    expect(await ask(web, { _tag: "AddPluginPackage", readId: read.readId })).toEqual(stale)
  })

  test("any Member adds one from an uploaded folder", async () => {
    const hub = await accessHub()
    const web = await openWeb(hub, "alice")
    const read = packageRead(await ask(web, { _tag: "ReadPluginPackage", from: folder("1.0.0") }))
    const added = state(await ask(web, { _tag: "AddPluginPackage", readId: read.readId }))
    expect(added.plugins).toMatchObject([
      {
        id: linear,
        package: { version: "1.0.0", source: { _tag: "Upload", fileName: "linear-mcp" } },
      },
    ])
  })

  test("named as a Plugin on the Hub is refused from another source, and offered as an Upgrade from the same", async () => {
    const hub = await accessHub()
    const web = await openWeb(hub, "alice")
    const pkg = linearRepo()
    pkg.tag("v1.0.0")
    await addFromGit(web, pkg.url)

    const fork = linearRepo()
    expect(
      await ask(web, { _tag: "ReadPluginPackage", from: { _tag: "Git", url: fork.url } }),
    ).toEqual(
      refused(
        "ReadPluginPackage",
        `A Plugin named ${linear} is already on the Hub, from another source: only a package from the same source can upgrade it.`,
      ),
    )
    const again = packageRead(
      await ask(web, {
        _tag: "ReadPluginPackage",
        from: { _tag: "Git", url: pkg.url, ref: "v1.0.0" },
      }),
    )
    expect(again.upgrades).toBe(linear)
    expect(await ask(web, { _tag: "AddPluginPackage", readId: again.readId })).toEqual(
      refused(
        "AddPluginPackage",
        `A Plugin named ${linear} is already on the Hub, from this source: upgrade it instead.`,
      ),
    )
  })

  test("is upgraded only on confirmation, which its Repos log and their Sessions pick up", async () => {
    const hub = await accessHub()
    const web = await openWeb(hub, "alice")
    const pkg = linearRepo()
    const plugin = await addFromGit(web, pkg.url)
    const installationId = await install(web, plugin.id, [repo], "Linear")
    const before = await forSession(hub, repo)
    expect(before).toMatchObject([{ pluginVersion: `1.0.0 (${pkg.first.slice(0, 7)})` }])

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
    const check = packageRead(await ask(web, { _tag: "CheckPluginUpgrade", pluginId: plugin.id }))
    expect(check.upgrades).toBe(linear)
    expect(check.read).toMatchObject({
      url: "https://mcp.linear.app/v2",
      package: { version: "2.0.0", commit: second },
    })
    // Checking changes nothing.
    expect(state(await ask(web, { _tag: "GetPlugins" })).plugins).toEqual([plugin])

    const upgraded = state(
      await ask(web, { _tag: "UpgradePlugin", pluginId: plugin.id, readId: check.readId }),
    )
    expect(upgraded.plugins).toEqual([
      // The manifest no longer has a description, so neither has the Plugin.
      { ...check.read, createdBy: plugin.createdBy, createdAt: plugin.createdAt },
    ])
    const version = `2.0.0 (${second.slice(0, 7)})`
    const log = await ask(web, { _tag: "GetPluginLog", repo })
    if (log._tag !== "PluginLog") throw new Error("No log")
    expect(log.entries[0]).toMatchObject({
      change: "PluginUpgraded",
      by: { login: "alice" },
      pluginId: plugin.id,
      pluginVersion: version,
      installationId,
    })
    const after = await forSession(hub, repo)
    expect(after).toMatchObject([{ pluginVersion: version }])
    expect(installationsDiffer(before, after)).toBe(true)
  })

  test("an Upgrade clears the values its Installations hold as an edit does", async () => {
    const hub = await accessHub()
    const web = await openWeb(hub, "alice")
    const pkg = pluginRepo({
      "package.json": packageJson("1.0.0"),
      "kndl.json": manifest("https://mcp.linear.app/mcp", { auth: secrets("X-Team") }),
    })
    const plugin = await addFromGit(web, pkg.url)
    const created = state(
      await ask(web, {
        _tag: "CreateInstallation",
        pluginId: plugin.id,
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
      const check = packageRead(await ask(web, { _tag: "CheckPluginUpgrade", pluginId: plugin.id }))
      return state(
        await ask(web, { _tag: "UpgradePlugin", pluginId: plugin.id, readId: check.readId }),
      )
    }
    const log = async () => {
      const answer = await ask(web, { _tag: "GetPluginLog", repo })
      if (answer._tag !== "PluginLog") throw new Error(answer._tag)
      return answer.entries.map((entry) => [entry.change, entry.secrets, entry.pluginVersion])
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
      ["PluginUpgraded", undefined, `2.0.0 (${second.slice(0, 7)})`],
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
      ["PluginUpgraded", undefined, `3.0.0 (${third.slice(0, 7)})`],
    ])
  })

  test("an Upgrade is refused if the Plugin changed since its read", async () => {
    const hub = await accessHub()
    const web = await openWeb(hub, "alice")
    const pkg = linearRepo()
    const plugin = await addFromGit(web, pkg.url)
    pkg.commit({ "package.json": packageJson("2.0.0") })
    const first = packageRead(await ask(web, { _tag: "CheckPluginUpgrade", pluginId: plugin.id }))
    const second = packageRead(await ask(web, { _tag: "CheckPluginUpgrade", pluginId: plugin.id }))
    state(await ask(web, { _tag: "UpgradePlugin", pluginId: plugin.id, readId: first.readId }))
    expect(
      await ask(web, { _tag: "UpgradePlugin", pluginId: plugin.id, readId: second.readId }),
    ).toEqual(
      refused("UpgradePlugin", "Linear changed since that read; check for an upgrade again."),
    )
  })

  test("isn't edited, and is upgraded only with access to every Repo its Installations list", async () => {
    const hub = await accessHub()
    const alice = await openWeb(hub, "alice")
    const pkg = linearRepo()
    const plugin = await addFromGit(alice, pkg.url)
    expect(
      await ask(alice, {
        _tag: "EditPlugin",
        pluginId: plugin.id,
        name: "Mine",
        url: plugin.url,
        auth: plugin.auth,
      }),
    ).toEqual(
      refused(
        "EditPlugin",
        "Linear is a packaged Plugin, pinned to its version: upgrade it to change it.",
      ),
    )
    await install(alice, plugin.id, [repo, secret], "Linear")
    pkg.commit({ "package.json": packageJson("2.0.0") })
    const web = await openOctocat(hub)
    const check = packageRead(await ask(web, { _tag: "CheckPluginUpgrade", pluginId: plugin.id }))
    expect(
      await ask(web, { _tag: "UpgradePlugin", pluginId: plugin.id, readId: check.readId }),
    ).toEqual(
      refused(
        "UpgradePlugin",
        "This Plugin has Installations on Repos you have no access to, so you can't upgrade it.",
      ),
    )
  })

  test("from an upload is upgraded by uploading its new version, not by checking", async () => {
    const hub = await accessHub()
    const web = await openWeb(hub, "alice")
    const read = packageRead(await ask(web, { _tag: "ReadPluginPackage", from: folder("1.0.0") }))
    await ask(web, { _tag: "AddPluginPackage", readId: read.readId })
    expect(await ask(web, { _tag: "CheckPluginUpgrade", pluginId: linear })).toEqual(
      refused("CheckPluginUpgrade", "Linear was uploaded: upload its new version to upgrade it."),
    )
    const next = packageRead(await ask(web, { _tag: "ReadPluginPackage", from: folder("1.1.0") }))
    expect(next.upgrades).toBe(linear)
    const upgraded = state(
      await ask(web, { _tag: "UpgradePlugin", pluginId: linear, readId: next.readId }),
    )
    expect(upgraded.plugins).toMatchObject([{ id: linear, package: { version: "1.1.0" } }])
  })
})
