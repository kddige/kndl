// The fake Hub's MCP servers (ADR 0020): Hub-only MCP servers, their Repo-scoped Installations, and
// each Repo's MCP server change log. It refuses what the real Hub refuses, with its words: a second
// Installation of an MCP server on a Repo, deleting an MCP server with Installations, and any
// change that needs access to a Repo the person lacks. A Repo is the same however its name is
// spelled (#197). Header secret values (#215) are taken as the Hub takes them, and kept as the Hub
// shows them: who set each and when, never the value.
//
// Packaged MCP servers (#220) are read from a folder upload, as the Hub reads them, or from one of
// the fake's git repos, below, whichever ref is asked for; it doesn't unpack archives. Asana starts
// packaged, a version behind its repo, so the Upgrade flow has something to show.
//
// Global Installations (#219) are on in every Repo, but where a Repo-scoped one of their MCP server
// is on, or a Repo turned them off. Only the Owner creates, edits or deletes one, or edits,
// upgrades or deletes an MCP server with one; their changes are logged once, and shown in every
// Repo's log.
//
// OAuth Installations (#217) connect at once: there is no authorization server, so Connect sends
// the browser straight back to the MCP page, connected to a made-up account. GitHub starts
// connected; Disconnect it to see a Session kept from starting. Only the Owner connects or
// disconnects a global one.
//
// GitHub's authorization server, as the fake plays it, offers no Dynamic Client Registration
// (#218): a new GitHub Installation asks for a client ID and secret first, which the fake takes
// as the Hub would, keeping only who set it, when, and whether it has a secret.

import {
  type CheckMcpServerUpgrade,
  clearedHeaderSecrets,
  clearsConnections,
  gitRefProblem,
  gitUrlProblem,
  globalConnectRefusal,
  globalOwnerOnlyRefusal,
  globalMcpServerRefusal,
  globalReposRefusal,
  type HeaderValueInput,
  headerSecretsOf,
  headerValueProblem,
  hubMcpServerId,
  installationReposProblem,
  installationsFor,
  isOn,
  mcpServerNames,
  notGlobalRefusal,
  oauthClientProblem,
  type PackagedMcpServer,
  packagePath,
  packagePathProblem,
  type McpServerAuth,
  mcpServerAuthProblem,
  type McpServerCommand,
  type McpServerPackageFrom,
  type McpServerSource,
  packageVersion,
  mcpServerInUseRefusal,
  mcpServerNameProblem,
  mcpServerSlug,
  mcpServerUrlProblem,
  type ReadMcpServerPackage,
  readMcpServerPackage,
  repoKey,
  sameRepo,
  sameSource,
  secondGlobalRefusal,
  secondInstallationRefusal,
} from "@kndl/protocol"
import { Redacted, Result } from "effect"
import { bob, you } from "./script.ts"
import type {
  HeaderValueSetWire,
  HubMessage,
  InstallationFailureWire,
  InstallationWire,
  ParticipantWire,
  McpServerLogEntryWire,
  McpServerWire,
  SessionInstallationWire,
} from "./wire.ts"

/** The fake's git repos of MCP server packages, each at its default branch's head. */
const gitRepos: Record<string, { packageJson: string; manifest: string; commit: string }> = {
  "https://github.com/acme/asana-mcp": {
    packageJson: JSON.stringify({ name: "@acme/asana-mcp", version: "1.1.0" }),
    manifest: JSON.stringify({
      displayName: "Asana",
      description: "Asana's tasks and projects.",
      mcp: { url: "https://mcp.asana.example/v2/mcp" },
      auth: {
        type: "headers",
        headers: [
          { key: "apiKey", title: "API key", header: "Authorization", template: "Bearer {value}" },
        ],
      },
    }),
    commit: "9b41e07c2d5a8f3e1b6c4d7a0e9f2b5c8d1a4e7f",
  },
  "https://github.com/acme/notion-mcp": {
    packageJson: JSON.stringify({ name: "@acme/notion-mcp", version: "0.3.0" }),
    manifest: JSON.stringify({
      displayName: "Notion",
      description: "Search and read the team's Notion pages.",
      mcp: { url: "https://mcp.notion.example/mcp" },
    }),
    commit: "51c0a7e3f9b2d84c6e1a0f7b3d5c9e2a8b4f6d10",
  },
}

/** A package the fake read for someone, kept until they add or upgrade to it. */
interface KeptRead {
  readonly by: string
  readonly read: PackagedMcpServer
  readonly upgrades?: string
  readonly basis?: string
}

/** A command that reads a package, rather than changing the MCP servers. */
type ReadCommand = ReadMcpServerPackage | CheckMcpServerUpgrade

/** A command that changes the MCP servers. */
export type McpServerChangeCommand = Exclude<
  McpServerCommand,
  { _tag: "GetMcpServers" | "GetMcpServerLog" } | ReadCommand
>

/** An Installation as the fake keeps it: every Repo it lists, whoever asks. */
interface FakeInstallation {
  readonly id: string
  readonly mcpServerId: string
  name: string
  /** On in every Repo, listing none (#219). */
  global: boolean
  repos: Array<string>
  /** The Repos that turned a global one off. */
  off: Array<string>
  /** Who set each header secret value, and when; the values themselves the fake drops. */
  values: Array<HeaderValueSetWire>
  /** Its account, for an OAuth Installation connected (#217). */
  connection?: NonNullable<InstallationWire["connection"]>
  /** The client entered by hand (#218), without its secret. */
  client?: NonNullable<InstallationWire["client"]>
  readonly createdBy: ParticipantWire
  readonly createdAt: number
}

type McpServerChangeWire = McpServerLogEntryWire["change"]

/** A header secret a change sets a value for. */
interface SetValue {
  readonly key: string
  readonly title: string
}

/**
 * What a change did: the Repos whose Installations changed, and whether every Repo's did (#219),
 * or why it was refused; for a Connect, where to send the browser (#217), or the client it needs
 * entered first (#218).
 */
export type McpServerOutcome =
  | { readonly refused: string }
  | {
      readonly repos: ReadonlyArray<string>
      readonly everyRepo?: boolean
      readonly authorizing?: string
    }
  | { readonly needsClient: NeedsClient }

/** What a Connect needs entered first: a client registered by hand with `issuer` (#218). */
export interface NeedsClient {
  readonly issuer: string
  readonly publicClient: boolean
  readonly reason?: string
}

/** The fake's authorization servers that offer no Dynamic Client Registration, by MCP host. */
const withoutRegistration: Record<string, string> = {
  "api.githubcopilot.example": "https://github.example/login/oauth",
}

/** Where a change to a global Installation is logged: once, for every Repo. */
const everyRepo = "*"

/** The Repos to log a change to the Installation on. */
const logRepos = (installation: FakeInstallation) =>
  installation.global ? [everyRepo] : installation.repos

const noRepoAccess = (repo: string) =>
  `You have no access to ${repo} on GitHub, or the GitHub App isn't installed on it.`
const hiddenRepos =
  "This Installation is on in Repos you have no access to, so you can't change it."

/** The Repos of `repos` that `from` doesn't list. */
const missingFrom = (from: ReadonlyArray<string>, repos: ReadonlyArray<string>) =>
  repos.filter((repo) => !from.some((other) => sameRepo(other, repo)))

/** An MCP server's auth as the Hub keeps it: titles trimmed. */
const normalizedAuth = (auth: McpServerAuth): McpServerAuth =>
  auth._tag === "Headers"
    ? {
        _tag: "Headers",
        headers: auth.headers.map((secret) => ({ ...secret, title: secret.title.trim() })),
      }
    : auth

const sameAuth = (a: McpServerAuth, b: McpServerAuth) => JSON.stringify(a) === JSON.stringify(b)

/** The package `from` holds, as the Hub would read it; the fake reads no archives. */
function readFrom(from: McpServerPackageFrom): Result.Result<PackagedMcpServer, string> {
  switch (from._tag) {
    case "Folder":
      return readMcpServerPackage(from, { _tag: "Upload", fileName: from.folderName })
    case "Archive":
      return Result.fail("The fake Hub doesn't unpack archives: upload the folder instead.")
    case "Git": {
      const problem =
        gitUrlProblem(from.url) ??
        (from.ref === undefined ? undefined : gitRefProblem(from.ref)) ??
        (from.path === undefined ? undefined : packagePathProblem(from.path))
      if (problem !== undefined) return Result.fail(problem)
      const repo = gitRepos[from.url.replace(/\.git$/, "").replace(/\/+$/, "")]
      if (repo === undefined || packagePath(from.path ?? "") !== "") {
        return Result.fail(`There is no package at ${from.url}.`)
      }
      const source = {
        _tag: "Git",
        url: from.url,
        ...(from.ref !== undefined && { ref: from.ref }),
      }
      return readMcpServerPackage(repo, source as McpServerSource, repo.commit)
    }
  }
}

const minute = 60_000
const day = 24 * 60 * minute

export class FakeMcpServers {
  readonly #mcpServers: Array<McpServerWire> = []
  readonly #installations: Array<FakeInstallation> = []
  /** Each Repo's log, newest first, by repoKey. */
  readonly #logs = new Map<string, Array<McpServerLogEntryWire>>()
  #ids = 0
  readonly #reads = new Map<string, KeptRead>()

  constructor(now = Date.now()) {
    const docs = this.#mcpServer(
      "Docs search",
      "https://docs-mcp.example.com/mcp",
      bob,
      now - 9 * day,
    )
    // With a header secret, and no Installations yet.
    this.#mcpServer("Linear", "https://mcp.linear.example/mcp", you, now - 2 * day, {
      _tag: "Headers",
      headers: [
        { key: "api_key", title: "API key", header: "Authorization", template: "Bearer {value}" },
      ],
    })
    const sentry = this.#mcpServer("Sentry", "https://mcp.sentry.example/mcp", bob, now - 6 * day, {
      _tag: "Headers",
      headers: [
        { key: "token", title: "Auth token", header: "X-Sentry-Token", template: "{value}" },
      ],
    })
    // On a LAN, over plain http: the page warns that what is sent to it is unencrypted (#255).
    this.#mcpServer("Home Assistant", "http://192.168.1.20:8123/mcp", you, now - day, {
      _tag: "Headers",
      headers: [
        {
          key: "access_token",
          title: "Access token",
          header: "Authorization",
          template: "Bearer {value}",
        },
      ],
    })
    // Packaged, a version behind its git repo.
    this.#mcpServers.push({
      id: "@acme/asana-mcp",
      name: "Asana",
      description: "Asana's tasks and projects.",
      url: "https://mcp.asana.example/mcp",
      auth: {
        _tag: "Headers",
        headers: [{ key: "token", title: "Token", header: "X-Asana-Token", template: "{value}" }],
      },
      package: {
        version: "1.0.0",
        commit: "3f2c9a14b8e7d6c5a4f3e2d1c0b9a8f7e6d5c4b3",
        source: { _tag: "Git", url: "https://github.com/acme/asana-mcp" },
      },
      createdBy: you,
      createdAt: now - 2 * day,
    })
    this.#install(docs, "Docs", ["kddige/kndl"], bob, now - 8 * day)
    // On a Repo Alice can't see too: she sees it, but can't change it.
    const team = this.#install(
      sentry,
      "Sentry",
      ["kddige/kndl", "kddige/secret"],
      bob,
      now - 5 * day,
    )
    team.values = [{ key: "token", setBy: bob, setAt: now - 5 * day }]
    // OAuth (#217), connected to a shared account.
    const github = this.#mcpServer(
      "GitHub",
      "https://api.githubcopilot.example/mcp/",
      you,
      now - 3 * day,
      { _tag: "OAuth", scopes: ["repo"] },
    )
    const connected = this.#install(github, "GitHub", ["kddige/website"], you, now - 3 * day)
    connected.connection = {
      connectedBy: you,
      connectedAt: now - 3 * day,
      account: "kndl-bot@example.com",
    }
    // Its authorization server offers no Dynamic Client Registration: a client entered (#218).
    connected.client = {
      clientId: "Ov23liKndlBot0a1b2c3",
      secret: true,
      setBy: you,
      setAt: now - 3 * day,
    }
  }

  /**
   * Every MCP server and Installation, each Installation with only the Repos `allowed` lets
   * through.
   */
  state(allowed: (repo: string) => boolean): Extract<HubMessage, { _tag: "McpServersState" }> {
    return {
      _tag: "McpServersState",
      mcpServers: [...this.#mcpServers],
      installations: this.#installations.map(({ global, off: allOff, ...installation }) => {
        const repos = installation.repos.filter(allowed)
        const otherRepos = installation.repos.length - repos.length
        const off = allOff.filter(allowed)
        return {
          ...installation,
          ...(global && { global }),
          repos,
          ...(otherRepos > 0 && { otherRepos }),
          ...(off.length > 0 && { off }),
        }
      }),
    }
  }

  /**
   * A Repo's MCP server change log, newest first: its own, and every global Installation's (#219).
   */
  log(repo: string): ReadonlyArray<McpServerLogEntryWire> {
    const own = this.#logs.get(repoKey(repo)) ?? []
    const every = (this.#logs.get(everyRepo) ?? []).map((entry) => ({ ...entry, global: true }))
    return [...own, ...every].toSorted((a, b) => b.at - a.at)
  }

  /** The Installations on for a Repo, with a global one's place taken or turned off (#219). */
  #on(repo: string): Array<FakeInstallation> {
    return installationsFor(this.#installations, repo)
      .filter(({ source }) => isOn(source))
      .map(({ installation }) => installation)
  }

  /** The Installations on for a Repo, as a Session starting there runs with them. */
  forSession(repo: string): Array<SessionInstallationWire> {
    const on = this.#on(repo)
    const servers = mcpServerNames(on.map((installation) => installation.name))
    return on.map((installation, index) => {
      const mcpServer = this.#find(installation.mcpServerId)
      return {
        id: installation.id,
        name: installation.name,
        mcpServerId: installation.mcpServerId,
        mcpServerName: mcpServer?.name ?? "",
        ...(mcpServer?.package && { mcpServerVersion: packageVersion(mcpServer.package) }),
        ...(installation.global && { global: true }),
        server: servers[index] ?? "",
        ...(installation.values.length > 0 && {
          values: installation.values.map(({ key, setAt }) => ({ key, setAt })),
        }),
      }
    })
  }

  /**
   * Reads a package for `by`, as the Hub does: what it would add, or upgrade an MCP server from the
   * same source to, kept by the read's id; or why it is refused.
   */
  read(
    command: ReadCommand,
    by: ParticipantWire,
  ): { readonly refused: string } | Extract<HubMessage, { _tag: "McpServerPackageRead" }> {
    let from: McpServerPackageFrom
    if (command._tag === "CheckMcpServerUpgrade") {
      const mcpServer = this.#find(command.mcpServerId)
      if (mcpServer?.package === undefined)
        return { refused: "There is no such packaged MCP server." }
      const { source } = mcpServer.package
      if (source._tag === "Upload") {
        return { refused: `${mcpServer.name} was uploaded: upload its new version to upgrade it.` }
      }
      from = { ...source, _tag: "Git" }
    } else {
      from = command.from
    }
    const read = readFrom(from)
    if (Result.isFailure(read)) return { refused: read.failure }
    const existing = this.#find(read.success.id)
    if (
      existing &&
      (!existing.package || !sameSource(existing.package.source, read.success.package.source))
    ) {
      return {
        refused: `An MCP server named ${read.success.id} is already on the Hub, from another source: only a package from the same source can upgrade it.`,
      }
    }
    const readId = `read-${++this.#ids}`
    this.#reads.set(readId, {
      by: by.id,
      read: read.success,
      ...(existing && { upgrades: existing.id, basis: JSON.stringify(existing.package) }),
    })
    return {
      _tag: "McpServerPackageRead",
      requestId: command.requestId,
      readId,
      read: read.success,
      ...(existing && { upgrades: existing.id }),
    }
  }

  /**
   * The Installations on for a Repo that keep its Sessions from starting (#216): as the Hub, one
   * without a value for a header secret, or an OAuth one not connected (#217). The fake has no
   * server to ask.
   */
  failing(repo: string): Array<InstallationFailureWire> {
    return this.#on(repo).flatMap((installation): Array<InstallationFailureWire> => {
      const mcpServer = this.#find(installation.mcpServerId)
      if (mcpServer === undefined) return []
      const connected =
        installation.connection !== undefined && installation.connection.lostAt === undefined
      if (mcpServer.auth._tag === "OAuth" && !connected) {
        return [
          {
            installationId: installation.id,
            installation: installation.name,
            ...(installation.global && { global: true }),
            reason: "NotConnected",
          },
        ]
      }
      const missing = headerSecretsOf(mcpServer.auth).filter(
        (secret) => !installation.values.some((value) => value.key === secret.key),
      )
      if (missing.length === 0) return []
      return [
        {
          installationId: installation.id,
          installation: installation.name,
          ...(installation.global && { global: true }),
          reason: "ValueNeeded",
          secrets: missing.map((secret) => secret.title),
        },
      ]
    })
  }

  /**
   * Applies a change by `by`, who has access to the Repos `allowed` lets through, and is the
   * Hub's Owner if `owner`.
   */
  change(
    command: McpServerChangeCommand,
    by: ParticipantWire,
    allowed: (repo: string) => boolean,
    owner: boolean,
  ): McpServerOutcome {
    const at = Date.now()
    /** Why `by` can't change an MCP server with a global Installation, unless the Owner (#219). */
    const globalMcpServer = (mcpServer: McpServerWire) =>
      !owner && this.#installations.some((one) => one.mcpServerId === mcpServer.id && one.global)
        ? { refused: globalMcpServerRefusal(mcpServer.name) }
        : undefined
    switch (command._tag) {
      case "AddMcpServerPackage": {
        const kept = this.#reads.get(command.readId)
        if (kept?.by !== by.id) return { refused: "That package read has expired; read it again." }
        if (kept.upgrades !== undefined) {
          return {
            refused: `An MCP server named ${kept.upgrades} is already on the Hub, from this source: upgrade it instead.`,
          }
        }
        this.#reads.delete(command.readId)
        this.#mcpServers.push({ ...kept.read, createdBy: by, createdAt: at })
        return { repos: [] }
      }
      case "UpgradeMcpServer": {
        const kept = this.#reads.get(command.readId)
        if (kept?.by !== by.id || kept.upgrades !== command.mcpServerId) {
          return { refused: "That package read has expired; read it again." }
        }
        const mcpServer = this.#find(command.mcpServerId)
        if (mcpServer === undefined || JSON.stringify(mcpServer.package) !== kept.basis) {
          return {
            refused: `${mcpServer?.name ?? "The MCP server"} changed since that read; check for an upgrade again.`,
          }
        }
        const installed = this.#installations.filter((one) => one.mcpServerId === mcpServer.id)
        if (installed.some((one) => !one.repos.every(allowed))) {
          return {
            refused:
              "This MCP server has Installations on Repos you have no access to, so you can't upgrade it.",
          }
        }
        const ownerOnly = globalMcpServer(mcpServer)
        if (ownerOnly !== undefined) return ownerOnly
        this.#reads.delete(command.readId)
        // As an edit does: values entered for another server, or another header, are cleared.
        const cleared = clearedHeaderSecrets(mcpServer, kept.read)
        const disconnects = clearsConnections(mcpServer, kept.read)
        const { description: _, ...rest } = mcpServer
        this.#mcpServers[this.#mcpServers.indexOf(mcpServer)] = { ...rest, ...kept.read }
        for (const one of installed) {
          const lost = cleared.filter((secret) => one.values.some(({ key }) => key === secret.key))
          one.values = one.values.filter(({ key }) => !lost.some((secret) => secret.key === key))
          this.#record(logRepos(one), "McpServerUpgraded", one, by, at)
          if (lost.length > 0) {
            const titles = lost.map((secret) => secret.title)
            this.#record(logRepos(one), "ValuesCleared", one, by, at, titles)
          }
          if (disconnects) this.#disconnect(one, by, at, true)
        }
        return {
          repos: installed.flatMap((one) => one.repos),
          ...(installed.some((one) => one.global) && { everyRepo: true }),
        }
      }
      case "CreateMcpServer": {
        const problem =
          mcpServerNameProblem(command.name) ??
          mcpServerUrlProblem(command.url) ??
          mcpServerAuthProblem(command.auth)
        if (problem !== undefined) return { refused: problem }
        this.#mcpServer(command.name.trim(), command.url, by, at, normalizedAuth(command.auth))
        return { repos: [] }
      }
      case "EditMcpServer": {
        const mcpServer = this.#find(command.mcpServerId)
        if (mcpServer === undefined) return { refused: "There is no such MCP server." }
        const installed = this.#installations.filter((one) => one.mcpServerId === mcpServer.id)
        if (installed.some((one) => !one.repos.every(allowed))) {
          return {
            refused:
              "This MCP server has Installations on Repos you have no access to, so you can't edit it.",
          }
        }
        if (mcpServer.package) {
          return {
            refused: `${mcpServer.name} is a packaged MCP server, pinned to its version: upgrade it to change it.`,
          }
        }
        const problem =
          mcpServerNameProblem(command.name) ??
          mcpServerUrlProblem(command.url) ??
          mcpServerAuthProblem(command.auth)
        if (problem !== undefined) return { refused: problem }
        const name = command.name.trim()
        const auth = normalizedAuth(command.auth)
        if (
          name === mcpServer.name &&
          command.url === mcpServer.url &&
          sameAuth(auth, mcpServer.auth)
        ) {
          return { repos: [] }
        }
        const ownerOnly = globalMcpServer(mcpServer)
        if (ownerOnly !== undefined) return ownerOnly
        const cleared = clearedHeaderSecrets(mcpServer, { url: command.url, auth })
        // Another origin could take the tokens (#217).
        const disconnects = clearsConnections(mcpServer, { url: command.url, auth })
        this.#mcpServers[this.#mcpServers.indexOf(mcpServer)] = {
          ...mcpServer,
          name,
          url: command.url,
          auth,
        }
        for (const one of installed) {
          const lost = cleared.filter((secret) => one.values.some(({ key }) => key === secret.key))
          one.values = one.values.filter(({ key }) => !lost.some((secret) => secret.key === key))
          this.#record(logRepos(one), "McpServerEdited", one, by, at)
          if (lost.length > 0) {
            const titles = lost.map((secret) => secret.title)
            this.#record(logRepos(one), "ValuesCleared", one, by, at, titles)
          }
          if (disconnects) this.#disconnect(one, by, at, true)
        }
        return {
          repos: installed.flatMap((one) => one.repos),
          ...(installed.some((one) => one.global) && { everyRepo: true }),
        }
      }
      case "DeleteMcpServer": {
        const mcpServer = this.#find(command.mcpServerId)
        if (mcpServer === undefined) return { refused: "There is no such MCP server." }
        const ownerOnly = globalMcpServer(mcpServer)
        if (ownerOnly !== undefined) return ownerOnly
        const count = this.#installations.filter((one) => one.mcpServerId === mcpServer.id).length
        if (count > 0) return { refused: mcpServerInUseRefusal(mcpServer.name, count) }
        this.#mcpServers.splice(this.#mcpServers.indexOf(mcpServer), 1)
        return { repos: [] }
      }
      case "CreateInstallation": {
        const refusedRepo = command.repos.find((repo) => !allowed(repo))
        if (refusedRepo !== undefined) return { refused: noRepoAccess(refusedRepo) }
        const global = command.global === true
        if (global && !owner) return { refused: globalOwnerOnlyRefusal }
        const mcpServer = this.#find(command.mcpServerId)
        if (mcpServer === undefined) return { refused: "There is no such MCP server." }
        const problem =
          mcpServerNameProblem(command.name, "An Installation") ??
          (global
            ? command.repos.length > 0
              ? globalReposRefusal
              : undefined
            : installationReposProblem(command.repos))
        if (problem !== undefined) return { refused: problem }
        const values = this.#values(mcpServer, command.values ?? [])
        if ("refused" in values) return values
        const second = global
          ? this.#secondGlobal(mcpServer, null)
          : this.#second(mcpServer, command.repos, null)
        if (second !== undefined) return { refused: second }
        const name = command.name.trim()
        const installation = this.#install(mcpServer, name, command.repos, by, at, global)
        this.#set(installation, values.set, logRepos(installation), by, at)
        return { repos: installation.repos, ...(global && { everyRepo: true }) }
      }
      case "ConnectInstallation":
      case "DisconnectInstallation": {
        const installation = this.#installations.find((one) => one.id === command.installationId)
        if (installation === undefined) return { refused: "There is no such Installation." }
        if (!installation.repos.every(allowed)) return { refused: hiddenRepos }
        if (installation.global && !owner) return { refused: globalConnectRefusal }
        const mcpServer = this.#find(installation.mcpServerId)
        const every = installation.global && { everyRepo: true }
        if (command._tag === "DisconnectInstallation") {
          if (installation.connection === undefined) {
            return { refused: `${installation.name} isn't connected.` }
          }
          this.#disconnect(installation, by, at)
          return { repos: installation.repos, ...every }
        }
        if (mcpServer?.auth._tag !== "OAuth") {
          return {
            refused: `${installation.name} doesn't use OAuth: there is no account to connect.`,
          }
        }
        // A server without Dynamic Client Registration needs a client entered (#218).
        const issuer = withoutRegistration[new URL(mcpServer.url).hostname]
        const entered = command.client
        if (entered !== undefined) {
          const clientId = entered.clientId.trim()
          const secret =
            entered.clientSecret === undefined ? undefined : Redacted.value(entered.clientSecret)
          const problem = oauthClientProblem(clientId, secret)
          if (problem !== undefined) return { refused: problem }
          // The fake's servers take confidential clients only.
          if (secret === undefined) {
            return {
              refused: `The authorization server ${issuer ?? new URL(mcpServer.url).origin} takes no public client: enter the client's secret too.`,
            }
          }
        } else if (
          issuer !== undefined &&
          (command.changeClient === true || !installation.client)
        ) {
          return { needsClient: { issuer, publicClient: false } }
        } else if (command.changeClient === true) {
          return { needsClient: { issuer: new URL(mcpServer.url).origin, publicClient: false } }
        }
        // No authorization server: the person "consents" at once.
        const reconnected = installation.connection !== undefined
        installation.connection = {
          connectedBy: by,
          connectedAt: at,
          account: `${by.login}@${new URL(mcpServer.url).hostname}`,
        }
        if (entered !== undefined) {
          // Keeping no secret to compare, the fake logs every client entered as set.
          installation.client = {
            clientId: entered.clientId.trim(),
            secret: entered.clientSecret !== undefined,
            setBy: by,
            setAt: at,
          }
          this.#record(logRepos(installation), "ClientSet", installation, by, at)
        }
        this.#record(
          logRepos(installation),
          reconnected ? "Reconnected" : "Connected",
          installation,
          by,
          at,
        )
        return {
          repos: installation.repos,
          ...every,
          authorizing: `/mcp?installation=${encodeURIComponent(installation.id)}&connected=1`,
        }
      }
      case "EditInstallation":
      case "DeleteInstallation": {
        const named = command._tag === "EditInstallation" ? command.repos : []
        const refusedRepo = named.find((repo) => !allowed(repo))
        if (refusedRepo !== undefined) return { refused: noRepoAccess(refusedRepo) }
        const installation = this.#installations.find((one) => one.id === command.installationId)
        if (installation === undefined) return { refused: "There is no such Installation." }
        if (!installation.repos.every(allowed)) return { refused: hiddenRepos }
        const wasGlobal = installation.global
        const global = command._tag === "EditInstallation" && command.global === true
        if ((wasGlobal || global) && !owner) return { refused: globalOwnerOnlyRefusal }
        if (command._tag === "DeleteInstallation") {
          this.#installations.splice(this.#installations.indexOf(installation), 1)
          this.#record(logRepos(installation), "Deleted", installation, by, at)
          return { repos: installation.repos, ...(wasGlobal && { everyRepo: true }) }
        }
        const problem =
          mcpServerNameProblem(command.name, "An Installation") ??
          (global
            ? command.repos.length > 0
              ? globalReposRefusal
              : undefined
            : installationReposProblem(command.repos))
        if (problem !== undefined) return { refused: problem }
        const mcpServer = this.#find(installation.mcpServerId)
        const values = mcpServer ? this.#values(mcpServer, command.values ?? []) : { set: [] }
        if ("refused" in values) return values
        const added = missingFrom(installation.repos, command.repos)
        const removed = missingFrom(command.repos, installation.repos)
        const kept = installation.repos.filter((repo) => !removed.includes(repo))
        const name = command.name.trim()
        const renamed = name !== installation.name
        const rescoped = global !== wasGlobal
        const second =
          mcpServer &&
          ((global && !wasGlobal ? this.#secondGlobal(mcpServer, installation.id) : undefined) ??
            this.#second(mcpServer, added, installation.id))
        if (second !== undefined) return { refused: second }
        installation.name = name
        installation.repos = [...kept, ...added]
        if (wasGlobal || global) {
          // A change to every Repo, logged once.
          installation.global = global
          if (!global) installation.off = []
          if (renamed) this.#record([everyRepo], "Renamed", installation, by, at)
          if (rescoped) {
            const change = global ? "MadeGlobal" : "MadeRepoScoped"
            this.#record([everyRepo], change, installation, by, at)
          }
          this.#set(installation, values.set, [everyRepo], by, at)
          const changed = renamed || rescoped || values.set.length > 0
          return { repos: [...kept, ...added, ...removed], ...(changed && { everyRepo: true }) }
        }
        if (renamed) this.#record(kept, "Renamed", installation, by, at)
        this.#record(added, "Added", installation, by, at)
        this.#record(removed, "Removed", installation, by, at)
        // A Repo it was added to has its values from the start: Added says so.
        this.#set(installation, values.set, kept, by, at)
        return {
          repos:
            renamed || values.set.length > 0
              ? [...kept, ...added, ...removed]
              : [...added, ...removed],
        }
      }
      case "TurnGlobalInstallation": {
        if (!allowed(command.repo)) return { refused: noRepoAccess(command.repo) }
        const installation = this.#installations.find((one) => one.id === command.installationId)
        if (installation === undefined) return { refused: "There is no such Installation." }
        if (!installation.global) return { refused: notGlobalRefusal(installation.name) }
        const wasOff = installation.off.some((repo) => sameRepo(repo, command.repo))
        if (wasOff !== command.on) return { repos: [] }
        installation.off = command.on
          ? installation.off.filter((repo) => !sameRepo(repo, command.repo))
          : [...installation.off, command.repo]
        const change = command.on ? "TurnedOn" : "TurnedOff"
        this.#record([command.repo], change, installation, by, at)
        return { repos: [command.repo] }
      }
    }
  }

  /**
   * Forgets an Installation's account, if it had one, and logs it; on an origin change, the client
   * entered for it too (#218).
   */
  #disconnect(
    installation: FakeInstallation,
    by: ParticipantWire,
    at: number,
    forgetClient = false,
  ): void {
    if (forgetClient) delete installation.client
    if (installation.connection === undefined) return
    delete installation.connection
    this.#record(logRepos(installation), "Disconnected", installation, by, at)
  }

  #find(id: string): McpServerWire | undefined {
    return this.#mcpServers.find((mcpServer) => mcpServer.id === id)
  }

  /** The header secrets `values` set, by title, or why one is refused, as the Hub says it. */
  #values(
    mcpServer: McpServerWire,
    values: ReadonlyArray<HeaderValueInput>,
  ): { readonly refused: string } | { readonly set: ReadonlyArray<SetValue> } {
    const declared = headerSecretsOf(mcpServer.auth)
    const set = new Map<string, SetValue>()
    for (const input of values) {
      const secret = declared.find((one) => one.key === input.key)
      if (secret === undefined) {
        return { refused: `${mcpServer.name} has no header secret ${input.key}.` }
      }
      const problem = headerValueProblem(secret.title, Redacted.value(input.value))
      if (problem !== undefined) return { refused: problem }
      set.set(secret.key, { key: secret.key, title: secret.title })
    }
    return { set: [...set.values()] }
  }

  /** Stamps the values set on `installation`, and logs them on `repos` by title. */
  #set(
    installation: FakeInstallation,
    set: ReadonlyArray<SetValue>,
    repos: ReadonlyArray<string>,
    by: ParticipantWire,
    at: number,
  ): void {
    if (set.length === 0) return
    installation.values = [
      ...installation.values.filter(({ key }) => !set.some((one) => one.key === key)),
      ...set.map(({ key }) => ({ key, setBy: by, setAt: at })),
    ]
    const titles = set.map(({ title }) => title)
    this.#record(repos, "ValuesSet", installation, by, at, titles)
  }

  #mcpServer(
    name: string,
    url: string,
    by: ParticipantWire,
    at: number,
    auth: McpServerAuth = { _tag: "None" },
  ): McpServerWire {
    const slug = mcpServerSlug(name)
    let id: string = hubMcpServerId(slug)
    for (let n = 2; this.#find(id) !== undefined; n++) id = hubMcpServerId(`${slug}-${n}`)
    const mcpServer: McpServerWire = { id, name, url, auth, createdBy: by, createdAt: at }
    this.#mcpServers.push(mcpServer)
    return mcpServer
  }

  #install(
    mcpServer: McpServerWire,
    name: string,
    repos: ReadonlyArray<string>,
    by: ParticipantWire,
    at: number,
    global = false,
  ): FakeInstallation {
    const installation: FakeInstallation = {
      id: `inst-${++this.#ids}`,
      mcpServerId: mcpServer.id,
      name,
      global,
      repos: [...repos],
      off: [],
      values: [],
      createdBy: by,
      createdAt: at,
    }
    this.#installations.push(installation)
    this.#record(logRepos(installation), "Created", installation, by, at)
    return installation
  }

  /** Why a second global Installation of `mcpServer` is refused (#219). */
  #secondGlobal(mcpServer: McpServerWire, except: string | null): string | undefined {
    const existing = this.#installations.find(
      (one) => one.mcpServerId === mcpServer.id && one.global && one.id !== except,
    )
    return existing && secondGlobalRefusal(existing.name, mcpServer.name)
  }

  /** Why an Installation of `mcpServer` on one of `repos` is refused: another is on there. */
  #second(
    mcpServer: McpServerWire,
    repos: ReadonlyArray<string>,
    except: string | null,
  ): string | undefined {
    for (const repo of repos) {
      const existing = this.#installations.find(
        (one) =>
          one.mcpServerId === mcpServer.id &&
          one.id !== except &&
          one.repos.some((listed) => sameRepo(listed, repo)),
      )
      if (existing) return secondInstallationRefusal(repo, existing.name, mcpServer.name)
    }
    return undefined
  }

  #record(
    repos: ReadonlyArray<string>,
    change: McpServerChangeWire,
    installation: FakeInstallation,
    by: ParticipantWire,
    at: number,
    secrets?: ReadonlyArray<string>,
  ): void {
    const mcpServer = this.#find(installation.mcpServerId)
    for (const repo of repos) {
      const log = this.#logs.get(repoKey(repo)) ?? []
      log.unshift({
        at,
        by,
        change,
        mcpServerId: installation.mcpServerId,
        mcpServerName: mcpServer?.name ?? "",
        ...(change === "McpServerUpgraded" &&
          mcpServer?.package && { mcpServerVersion: packageVersion(mcpServer.package) }),
        installationId: installation.id,
        installationName: installation.name,
        ...(secrets !== undefined && { secrets: [...secrets] }),
      })
      this.#logs.set(repoKey(repo), log)
    }
  }
}
