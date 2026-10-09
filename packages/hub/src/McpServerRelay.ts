// What the Session relay does with MCP server messages (#221, ADR 0020): the web UI's commands to
// create, edit and delete MCP servers and their Installations, and to read a Repo's MCP server
// change log.
//
// - Any Member may create an MCP server, and delete one with no Installations.
// - An Installation's Repos are its gate: creating, editing or deleting one needs access to every
//   Repo it lists, before and after, as Sessions check it (ADR 0003). So does editing an
//   MCP server, for every Repo its Installations list: its URL is where their Sessions' MCP traffic
//   goes. Access is asked off the lock, since it may wait on GitHub, and the change is made under
//   it, refused if the Installation lists a Repo meanwhile that wasn't asked about.
// - A refusal names only a Repo the person typed, in words alike whether it exists or not; the
//   Repos of an Installation they can't see are never named, only counted.
// - Each web client is sent the Installations with only the Repos its person has access to, as
//   last asked. When that changes, so does what it is sent.
// - A global Installation (#219) lists no Repo, so it needs no access to create, edit or delete:
//   only that its person be the Owner, which the store checks. Turning one off for a Repo, or back
//   on, needs access to that Repo alone.
// - A change tells the changed Repos' Sessions, which then show that a Restart applies it. A change
//   to every Repo, a global Installation's or its MCP server's, tells every Session, and sends each
//   client the log of every Repo it is known to have access to.
// - A packaged MCP server (#220) is read first, from git or an upload, off the lock: a fetch may
//   take a while. The read is kept for its person, to add or upgrade to by its id once they
//   confirm, so what they confirm is what they saw. An Upgrade is refused if the MCP server changed
//   since.
// - Connecting an OAuth Installation (#217), or disconnecting it, needs access to every Repo it
//   lists, as editing it does, and for a global one, that its person be the Owner: every Session
//   on the Hub acts as its account. Connecting begins under the lock, then finds the authorization
//   server off it, and answers where to send the browser; it comes back to the Hub's callback
//   (McpServerOAuthRoutes.ts), which trades the code off the lock and keeps the tokens under it,
//   refused if the Installation lists another Repo by then, or its MCP server changed. Where the
//   authorization server offers no Dynamic Client Registration, it answers that a client must be
//   entered instead (#218), which the person sends with the command again: the same people set the
//   client as connect, and it is kept as the tokens are.

import {
  type CheckMcpServerUpgrade,
  CommandFailed,
  HubToWeb,
  type Installation,
  type InstallationId,
  type PackagedMcpServer,
  type Participant,
  type ParticipantId,
  type McpServerCommand,
  type McpServerId,
  type McpServerPackageFrom,
  McpServerPackageReadTtlMs,
  type McpServersState,
  type ReadMcpServerPackage,
  RepoName,
  sameRepo,
  sameSource,
  type WebToHub,
} from "@kndl/protocol"
import { Clock, Effect, Option } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { McpServerIcons, type IconSearch } from "./McpServerIcons.ts"
import { type BeginInput, connectionBasis, McpServerOAuth } from "./McpServerOAuth.ts"
import {
  McpServerRefused,
  McpServers,
  type McpServersChanged,
  mcpServerTakenRefusal,
  type StoredInstallation,
} from "./McpServers.ts"
import { McpServerSources } from "./McpServerSources.ts"
import { RepoAccess } from "./RepoAccess.ts"
import type { Peer } from "./SessionRelay.ts"
import { randomId } from "./Tokens.ts"

const webTags = [
  "GetMcpServers",
  "CreateMcpServer",
  "EditMcpServer",
  "DeleteMcpServer",
  "ReadMcpServerPackage",
  "CheckMcpServerUpgrade",
  "AddMcpServerPackage",
  "UpgradeMcpServer",
  "CreateInstallation",
  "EditInstallation",
  "DeleteInstallation",
  "TurnGlobalInstallation",
  "ConnectInstallation",
  "DisconnectInstallation",
  "GetMcpServerLog",
] as const satisfies ReadonlyArray<McpServerCommand["_tag"]>

export const isMcpServerCommand = (message: WebToHub): message is McpServerCommand =>
  (webTags as ReadonlyArray<string>).includes(message._tag)

/** A web connection, as the relay knows it. */
export interface McpServerWebClient {
  readonly you: Participant
  readonly peer: Peer<HubToWeb>
  /** Whether its person has access to each Repo, as last asked (ADR 0003). */
  readonly repos: ReadonlyMap<string, boolean>
}

/** What the MCP server relay needs of the Session relay. */
export interface McpServerRelayHost {
  readonly webClients: () => Iterable<McpServerWebClient>
  /** Runs `effect` under the relay's lock. */
  readonly serialized: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  /** Records what GitHub said of a person's access to a Repo; under the lock. */
  readonly accessKnown: (
    who: Participant,
    repo: string,
    allowed: boolean,
  ) => Effect.Effect<void, SqlError>
  /** Tells web clients the Repo's Sessions changed; under the lock. */
  readonly repoSessionsUpdated: (repo: string) => Effect.Effect<void, SqlError>
  /** Tells web clients every Session changed, as by a global Installation's change; under the lock. */
  readonly everySessionUpdated: () => Effect.Effect<void, SqlError>
  /** Says Installations' header secret values may have changed, so what to redact did. */
  readonly headerValuesChanged: () => void
  /** The one spelling the Hub keeps of a Repo's name (#197). */
  readonly respell: (repo: RepoName) => Effect.Effect<RepoName, SqlError>
}

/** Why a command about a Repo the person typed is refused: alike whether it exists or not. */
const noRepoAccess = (repo: string) =>
  `You have no access to ${repo} on GitHub, or the GitHub App isn't installed on it.`

/** Why a change to an Installation on Repos the person can't see is refused, naming none. */
const hiddenRepos =
  "This Installation is on in Repos you have no access to, so you can't change it."

/** Why adding or upgrading by a read the Hub no longer keeps for the person is refused. */
const staleRead = "That package read has expired; read it again."

/** The package reads kept, at most; past it, the oldest is dropped. */
const maxReads = 100

/** A package the Hub read for a person, kept until they add or upgrade to it. */
interface KeptRead {
  readonly by: ParticipantId
  readonly read: PackagedMcpServer
  /** The bytes of the file in the package that its manifest's `icon` names, if it names one. */
  readonly iconFile?: Uint8Array
  /** The MCP server it upgrades, from the same source. */
  readonly upgrades?: McpServerId
  /** That MCP server's package when read, which it must still be to upgrade. */
  readonly basis?: string
  readonly at: number
}

/** What to find an added or upgraded package's icon from. */
const packageIconSearch = (kept: KeptRead): IconSearch => ({
  url: kept.read.url,
  ...(kept.read.icon !== undefined && { manifestIcon: kept.read.icon }),
  ...(kept.iconFile !== undefined && { iconFile: kept.iconFile }),
})

/** A command about MCP servers that changes them, or asks about them: not a read of a package. */
type StoreCommand = Exclude<McpServerCommand, ReadMcpServerPackage | CheckMcpServerUpgrade>

/** What to begin connecting an OAuth Installation with, once its Repos are checked (#217). */
type Connecting = BeginInput

/**
 * An Installation as the person may see it: only the Repos they have access to, of those it lists
 * and those that turned it off.
 */
const seenBy = (client: McpServerWebClient, installation: StoredInstallation): Installation => {
  const { off: turnedOff, ...rest } = installation
  const repos = installation.repos.filter((repo) => client.repos.get(repo) === true)
  const otherRepos = installation.repos.length - repos.length
  const off = (turnedOff ?? []).filter((repo) => client.repos.get(repo) === true)
  return {
    ...rest,
    repos,
    ...(otherRepos > 0 && { otherRepos }),
    ...(off.length > 0 && { off }),
  }
}

export const makeMcpServerRelay = Effect.fnUntraced(function* (host: McpServerRelayHost) {
  const mcpServers = yield* McpServers
  const access = yield* RepoAccess
  const sources = yield* McpServerSources
  const icons = yield* McpServerIcons
  const oauth = yield* McpServerOAuth
  const scope = yield* Effect.scope
  /** The connections that asked for MCP servers, which are sent them again as they change. */
  const asked = new WeakSet<Peer<HubToWeb>>()
  /** The package reads kept, by id, oldest first. */
  const reads = new Map<string, KeptRead>()

  /** The read the Hub keeps for the person by that id, if it hasn't expired. */
  const keptRead = Effect.fn("McpServerRelay.keptRead")(function* (
    by: ParticipantId,
    readId: string,
  ) {
    const now = yield* Clock.currentTimeMillis
    for (const [id, kept] of reads) {
      if (now - kept.at > McpServerPackageReadTtlMs) reads.delete(id)
    }
    const kept = reads.get(readId)
    return kept?.by === by ? kept : yield* new McpServerRefused({ message: staleRead })
  })

  /**
   * Finds the MCP server's icon after it is saved, off the lock and off the command, so saving
   * never waits on it, and sends the web the MCP servers again when it is kept (#230). A search
   * whose MCP server has since changed its URL is dropped. Where nothing is found, `keepOld` leaves
   * the MCP server's icon as it was; otherwise it is cleared.
   */
  const findIcon = (id: McpServerId, search: IconSearch, keepOld: boolean) =>
    Effect.gen(function* () {
      const found = Option.getOrUndefined(yield* icons.find(search))
      if (found === undefined && keepOld) return
      yield* host.serialized(
        Effect.gen(function* () {
          if (yield* mcpServers.setIcon(id, search.url, found)) yield* toOthers(undefined)
        }),
      )
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Could not keep an MCP server's icon", cause)),
      Effect.forkIn(scope),
      Effect.asVoid,
    )

  /** Where to read a packaged MCP server again, at the ref it was added from: only from git. */
  const gitSourceOf = Effect.fn("McpServerRelay.gitSourceOf")(function* (id: McpServerId) {
    const mcpServer = Option.getOrUndefined(yield* mcpServers.mcpServer(id))
    if (mcpServer?.package === undefined) {
      return yield* new McpServerRefused({ message: "There is no such packaged MCP server." })
    }
    const { source } = mcpServer.package
    if (source._tag === "Upload") {
      return yield* new McpServerRefused({
        message: `${mcpServer.name} was uploaded: upload its new version to upgrade it.`,
      })
    }
    const from: McpServerPackageFrom = { ...source, _tag: "Git" }
    return { from, mcpServer: mcpServer.id }
  })

  /**
   * Reads a package for the person, off the lock, and keeps it for them to add, or to upgrade an
   * MCP server from the same source to. Refused if an MCP server from another source has its name.
   */
  const readPackage = Effect.fn("McpServerRelay.readPackage")(function* (
    client: McpServerWebClient,
    message: ReadMcpServerPackage | CheckMcpServerUpgrade,
  ) {
    const checked =
      message._tag === "CheckMcpServerUpgrade"
        ? yield* gitSourceOf(message.mcpServerId)
        : { from: message.from, mcpServer: undefined }
    const { mcpServer: read, iconFile } = yield* sources.readWithIcon(checked.from)
    if (checked.mcpServer !== undefined && read.id !== checked.mcpServer) {
      return yield* new McpServerRefused({
        message: `The package there is now named ${read.id}, not ${checked.mcpServer}: add it as an MCP server of its own.`,
      })
    }
    const existing = Option.getOrUndefined(yield* mcpServers.mcpServer(read.id))
    if (existing !== undefined) {
      if (
        existing.package === undefined ||
        !sameSource(existing.package.source, read.package.source)
      ) {
        return yield* new McpServerRefused({ message: mcpServerTakenRefusal(read.id) })
      }
    }
    const readId = randomId()
    reads.set(readId, {
      by: client.you.id,
      read,
      ...(iconFile !== undefined && { iconFile }),
      ...(existing !== undefined && {
        upgrades: existing.id,
        basis: JSON.stringify(existing.package),
      }),
      at: yield* Clock.currentTimeMillis,
    })
    for (const id of reads.keys()) {
      if (reads.size <= maxReads) break
      reads.delete(id)
    }
    client.peer.send(
      HubToWeb.cases.McpServerPackageRead.make({
        requestId: message.requestId,
        readId,
        read,
        ...(existing !== undefined && { upgrades: existing.id }),
      }),
    )
  })

  const stateFor = (
    client: McpServerWebClient,
    listed: Effect.Success<typeof mcpServers.list>,
  ): McpServersState =>
    HubToWeb.cases.McpServersState.make({
      mcpServers: listed.mcpServers,
      installations: listed.installations.map((installation) => seenBy(client, installation)),
    })

  /**
   * Asks GitHub, off the lock, for the person's access to each Repo: whether they have access to
   * all of them, with what to record, under the lock, of what GitHub said.
   */
  const ask = Effect.fn("McpServerRelay.ask")(function* (
    you: Participant,
    repos: ReadonlyArray<string>,
  ) {
    const answers = yield* Effect.forEach(
      repos,
      (repo) =>
        access.check(you, RepoName.make(repo)).pipe(
          Effect.map((allowed) => ({ repo, allowed })),
          Effect.catchTag("RepoAccessUnknown", (error) =>
            Effect.as(Effect.logWarning(error.message), { repo, unknown: error.message }),
          ),
        ),
      { concurrency: 8 },
    )
    const learned: Array<{ readonly repo: string; readonly allowed: boolean }> = []
    let unknown: string | undefined
    for (const answer of answers) {
      if ("allowed" in answer) learned.push(answer)
      else unknown ??= answer.unknown
    }
    return { learned, unknown }
  })

  /** Sends every client but `except` that asked for MCP servers the MCP servers as they are now. */
  const toOthers = Effect.fn("McpServerRelay.toOthers")(function* (
    except: Peer<HubToWeb> | undefined,
  ) {
    const listed = yield* mcpServers.list
    for (const client of host.webClients()) {
      if (client.peer !== except && asked.has(client.peer)) {
        client.peer.send(stateFor(client, listed))
      }
    }
  })

  /**
   * Tells the Repos' Sessions and their log's readers of a change. One to every Repo (#219) tells
   * every Session, and sends each client the log of every Repo it is known to have access to.
   */
  const changed = Effect.fn("McpServerRelay.changed")(function* (change: McpServersChanged) {
    host.headerValuesChanged()
    const every = change.everyRepo === true
    const unique: Array<string> = []
    const add = (repo: string) => {
      if (!unique.some((other) => sameRepo(other, repo))) unique.push(repo)
    }
    for (const repo of change.repos) add(repo)
    if (every) {
      for (const client of host.webClients()) {
        for (const [repo, allowed] of client.repos) if (allowed) add(repo)
      }
    }
    for (const repo of unique) {
      const entries = yield* mcpServers.log(repo)
      for (const client of host.webClients()) {
        if (client.repos.get(repo) === true) {
          client.peer.send(HubToWeb.cases.McpServerLog.make({ repo: RepoName.make(repo), entries }))
        }
      }
      if (!every) yield* host.repoSessionsUpdated(repo)
    }
    if (every) yield* host.everySessionUpdated()
  })

  /**
   * The Repos a command needs access to, off the lock: those it names, which a refusal may name,
   * and those of what it changes now, which a refusal never names.
   */
  const reposOf = Effect.fn("McpServerRelay.reposOf")(function* (message: StoreCommand) {
    switch (message._tag) {
      case "GetMcpServers":
      case "CreateMcpServer":
      case "DeleteMcpServer":
      case "AddMcpServerPackage":
        return { named: [], hidden: [] }
      case "GetMcpServerLog":
      case "TurnGlobalInstallation":
        return { named: [message.repo], hidden: [] }
      case "EditMcpServer":
      case "UpgradeMcpServer":
        return { named: [], hidden: yield* mcpServers.mcpServerRepos(message.mcpServerId) }
      case "CreateInstallation":
        return { named: message.repos, hidden: [] }
      case "EditInstallation":
      case "DeleteInstallation":
      case "ConnectInstallation":
      case "DisconnectInstallation": {
        const installation = yield* mcpServers.installation(message.installationId)
        const named = message._tag === "EditInstallation" ? message.repos : []
        return {
          named,
          hidden: Option.match(installation, {
            onNone: () => [],
            onSome: (found) =>
              found.repos.filter((repo) => !named.some((other) => sameRepo(other, repo))),
          }),
        }
      }
    }
  })

  /**
   * Handles a command whose Repos the person has access to, under the lock: for a connection, what
   * to begin it with, off the lock.
   */
  const handle = Effect.fn("McpServerRelay.handle")(function* (
    client: McpServerWebClient,
    message: StoreCommand,
    checked: ReadonlyArray<string>,
  ): Effect.fn.Return<Connecting | void, McpServerRefused | SqlError> {
    const { you, peer } = client
    const { requestId } = message
    const answer = Effect.gen(function* () {
      peer.send({ ...stateFor(client, yield* mcpServers.list), requestId })
    })
    /** Refuses a change to an Installation that lists a Repo meanwhile that wasn't asked about. */
    const stillChecked = Effect.fn(function* (repos: ReadonlyArray<string>) {
      if (repos.some((repo) => !checked.some((other) => sameRepo(other, repo)))) {
        return yield* new McpServerRefused({
          message: "The Installation changed meanwhile; try again.",
        })
      }
    })
    switch (message._tag) {
      case "GetMcpServers":
        asked.add(peer)
        return yield* answer

      case "GetMcpServerLog":
        return peer.send(
          HubToWeb.cases.McpServerLog.make({
            requestId,
            repo: message.repo,
            entries: yield* mcpServers.log(message.repo),
          }),
        )

      case "CreateMcpServer":
        const made = yield* mcpServers.createMcpServer(message, you.id)
        asked.add(peer)
        yield* answer
        yield* toOthers(peer)
        return yield* findIcon(made.id, { url: made.url }, true)

      case "EditMcpServer": {
        yield* stillChecked(yield* mcpServers.mcpServerRepos(message.mcpServerId))
        const before = Option.getOrUndefined(yield* mcpServers.mcpServer(message.mcpServerId))
        const change = yield* mcpServers.editMcpServer(message.mcpServerId, message, you.id)
        asked.add(peer)
        yield* answer
        yield* toOthers(peer)
        yield* changed(change)
        // Only a new URL has a new icon; if the new one has none, the old one goes.
        const after = Option.getOrUndefined(yield* mcpServers.mcpServer(message.mcpServerId))
        if (after !== undefined && before !== undefined && after.url !== before.url) {
          yield* findIcon(after.id, { url: after.url }, false)
        }
        return
      }

      case "DeleteMcpServer":
        yield* mcpServers.deleteMcpServer(message.mcpServerId, you.id)
        asked.add(peer)
        yield* answer
        return yield* toOthers(peer)

      case "AddMcpServerPackage": {
        const kept = yield* keptRead(you.id, message.readId)
        if (kept.upgrades !== undefined) {
          return yield* new McpServerRefused({
            message: `An MCP server named ${kept.upgrades} is already on the Hub, from this source: upgrade it instead.`,
          })
        }
        yield* mcpServers.addPackage(kept.read, you.id)
        reads.delete(message.readId)
        asked.add(peer)
        yield* answer
        yield* toOthers(peer)
        return yield* findIcon(kept.read.id, packageIconSearch(kept), true)
      }

      case "UpgradeMcpServer": {
        const kept = yield* keptRead(you.id, message.readId)
        if (kept.upgrades !== message.mcpServerId) {
          return yield* new McpServerRefused({ message: staleRead })
        }
        const now = Option.getOrUndefined(yield* mcpServers.mcpServer(message.mcpServerId))
        if (now === undefined || JSON.stringify(now.package) !== kept.basis) {
          return yield* new McpServerRefused({
            message: `${now?.name ?? "The MCP server"} changed since that read; check for an upgrade again.`,
          })
        }
        yield* stillChecked(yield* mcpServers.mcpServerRepos(message.mcpServerId))
        const change = yield* mcpServers.upgradeMcpServer(kept.read, you.id)
        reads.delete(message.readId)
        asked.add(peer)
        yield* answer
        yield* toOthers(peer)
        yield* changed(change)
        return yield* findIcon(kept.read.id, packageIconSearch(kept), now.url === kept.read.url)
      }

      case "CreateInstallation": {
        const change = yield* mcpServers.createInstallation(message, you.id)
        asked.add(peer)
        yield* answer
        yield* toOthers(peer)
        return yield* changed(change)
      }

      case "EditInstallation":
      case "DeleteInstallation": {
        const before = yield* mcpServers.installation(message.installationId)
        if (Option.isSome(before)) yield* stillChecked(before.value.repos)
        const change =
          message._tag === "EditInstallation"
            ? yield* mcpServers.editInstallation(message.installationId, message, you.id)
            : yield* mcpServers.deleteInstallation(message.installationId, you.id)
        asked.add(peer)
        yield* answer
        yield* toOthers(peer)
        return yield* changed(change)
      }

      // Anyone with access to the Repo turns a global Installation off for it, or back on (#219).
      case "TurnGlobalInstallation": {
        const change = yield* mcpServers.turnGlobalInstallation(
          message.installationId,
          message.repo,
          message.on,
          you.id,
        )
        asked.add(peer)
        yield* answer
        yield* toOthers(peer)
        return yield* changed(change)
      }

      case "ConnectInstallation": {
        const installation = Option.getOrUndefined(
          yield* mcpServers.installation(message.installationId),
        )
        if (installation === undefined) {
          return yield* new McpServerRefused({ message: "There is no such Installation." })
        }
        yield* stillChecked(installation.repos)
        yield* mcpServers.checkConnector(installation, you.id)
        const target = Option.getOrThrow(yield* mcpServers.mcpServer(installation.mcpServerId))
        if (target.auth._tag !== "OAuth") {
          return yield* new McpServerRefused({
            message: `${target.name} doesn't use OAuth: there is no account to connect.`,
          })
        }
        return {
          installationId: installation.id,
          url: target.url,
          ...(target.auth.scopes !== undefined && { scopes: target.auth.scopes }),
          basis: connectionBasis(target),
          global: installation.global === true,
          repos: installation.repos,
          by: you.id,
          ...(message.client !== undefined && {
            client: {
              clientId: message.client.clientId,
              ...(message.client.clientSecret !== undefined && {
                clientSecret: message.client.clientSecret,
              }),
            },
          }),
          ...(message.changeClient === true && { changeClient: true }),
        } satisfies Connecting
      }

      case "DisconnectInstallation": {
        const before = yield* mcpServers.installation(message.installationId)
        if (Option.isSome(before)) yield* stillChecked(before.value.repos)
        const change = yield* mcpServers.disconnectInstallation(message.installationId, you.id)
        asked.add(peer)
        yield* answer
        yield* toOthers(peer)
        return yield* changed(change)
      }
    }
  })

  /** Handles a web command about MCP servers, answering a refusal with CommandFailed. */
  const receiveWeb = Effect.fn("McpServerRelay.receiveWeb")(
    function* (client: McpServerWebClient, message: McpServerCommand) {
      const { you } = client
      if (message._tag === "ReadMcpServerPackage" || message._tag === "CheckMcpServerUpgrade") {
        return yield* readPackage(client, message)
      }
      // The Repos it names, under the one spelling the Hub keeps of each (#197).
      const command: StoreCommand =
        message._tag === "CreateInstallation" || message._tag === "EditInstallation"
          ? { ...message, repos: yield* Effect.forEach(message.repos, host.respell) }
          : message._tag === "TurnGlobalInstallation"
            ? { ...message, repo: yield* host.respell(message.repo) }
            : message
      const repos = yield* reposOf(command)
      // GetMcpServers also asks about every Repo listed that the person's access to isn't known, to
      // show them those they have access to.
      const unknown =
        command._tag === "GetMcpServers"
          ? (yield* mcpServers.list).installations
              .flatMap((installation) => [...installation.repos, ...(installation.off ?? [])])
              .filter((repo) => client.repos.get(repo) === undefined)
          : []
      const named = yield* ask(you, repos.named)
      const hidden = yield* ask(you, [...repos.hidden, ...unknown])
      const connecting = yield* host.serialized(
        Effect.gen(function* () {
          for (const { repo, allowed } of [...named.learned, ...hidden.learned]) {
            yield* host.accessKnown(you, repo, allowed)
          }
          const refused = named.learned.find((answer) => !answer.allowed)
          if (refused !== undefined) {
            return yield* new McpServerRefused({ message: noRepoAccess(refused.repo) })
          }
          if (named.unknown !== undefined) {
            return yield* new McpServerRefused({ message: named.unknown })
          }
          if (command._tag !== "GetMcpServers") {
            if (hidden.unknown !== undefined || hidden.learned.some((answer) => !answer.allowed)) {
              return yield* new McpServerRefused({
                message:
                  command._tag === "EditMcpServer" || command._tag === "UpgradeMcpServer"
                    ? `This MCP server has Installations on Repos you have no access to, so you can't ${command._tag === "EditMcpServer" ? "edit" : "upgrade"} it.`
                    : hiddenRepos,
              })
            }
          }
          return yield* handle(client, command, [...repos.named, ...repos.hidden])
        }),
      )
      if (connecting && command._tag === "ConnectInstallation") {
        // Off the lock: it fetches from the MCP server and its authorization server.
        const begun = yield* oauth.begin(connecting).pipe(
          Effect.catchTags({
            OAuthRefused: (refused) =>
              Effect.fail(new McpServerRefused({ message: refused.message })),
            SecretsUnavailable: (error) =>
              Effect.fail(new McpServerRefused({ message: error.message })),
          }),
        )
        client.peer.send(
          begun._tag === "Authorize"
            ? HubToWeb.cases.InstallationAuthorizing.make({
                requestId: command.requestId,
                installationId: command.installationId,
                url: begun.url,
              })
            : HubToWeb.cases.InstallationNeedsClient.make({
                requestId: command.requestId,
                installationId: command.installationId,
                issuer: begun.issuer,
                callbackUrl: begun.callbackUrl,
                publicClient: begun.publicClient,
                ...(begun.reason !== undefined && { reason: begun.reason }),
              }),
        )
      }
    },
    (effect, client, message) =>
      effect.pipe(
        Effect.catchTag("McpServerRefused", (refused) =>
          Effect.sync(() =>
            client.peer.send(
              CommandFailed.make({
                command: message._tag,
                requestId: message.requestId,
                message: refused.message,
              }),
            ),
          ),
        ),
        Effect.catchTag("SqlError", (error) =>
          Effect.logError("An MCP server command failed", error).pipe(
            Effect.andThen(
              Effect.sync(() =>
                client.peer.send(
                  CommandFailed.make({
                    command: message._tag,
                    requestId: message.requestId,
                    message: "The Hub could not do that; try again.",
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
  )

  /**
   * Sends the client the MCP servers again when what its person has access to changed, if it asked
   * for them; under the lock.
   */
  const accessChanged = Effect.fn("McpServerRelay.accessChanged")(function* (
    client: McpServerWebClient,
  ) {
    if (!asked.has(client.peer)) return
    client.peer.send(stateFor(client, yield* mcpServers.list))
  })

  /**
   * Finishes a connection the person began, as the authorization server sent their browser back
   * with `response`: the Installation it was for, and why it failed, if it did. Every client that
   * asked for MCP servers is sent them, and the Installation's Repos' log readers its entries.
   */
  const finishConnect = Effect.fn("McpServerRelay.finishConnect")(function* (
    you: Participant,
    response: {
      readonly state: string
      readonly code?: string
      readonly error?: string
      readonly errorDescription?: string
      readonly iss?: string
    },
  ) {
    const claimed = yield* oauth.claim(response.state, you.id).pipe(Effect.result)
    if (claimed._tag === "Failure") return { error: claimed.failure.message }
    const pending = claimed.success
    const failed = yield* Effect.gen(function* () {
      if (response.error !== undefined || response.code === undefined) {
        return yield* new McpServerRefused({
          message:
            response.error === "access_denied"
              ? "The connection wasn't allowed at the authorization server."
              : `The authorization server refused the connection: ${(response.errorDescription ?? response.error ?? "it sent no code").slice(0, 200)}.`,
        })
      }
      const granted = yield* oauth
        .exchange(pending, {
          code: response.code,
          ...(response.iss !== undefined && { iss: response.iss }),
        })
        .pipe(
          Effect.catchTag("OAuthRefused", (refused) =>
            Effect.fail(new McpServerRefused({ message: refused.message })),
          ),
        )
      yield* host.serialized(
        Effect.gen(function* () {
          const change = yield* mcpServers.connectInstallation(pending, granted, you.id)
          yield* toOthers(undefined)
          yield* changed(change)
        }),
      )
    }).pipe(
      Effect.as<string | undefined>(undefined),
      Effect.catchTag("McpServerRefused", (refused) => Effect.succeed(refused.message)),
      Effect.catchTag("SqlError", (error) =>
        Effect.as(
          Effect.logError("Could not keep an OAuth Installation's connection", error),
          "The Hub could not keep the connection; try again.",
        ),
      ),
    )
    return {
      installationId: pending.installationId,
      ...(failed !== undefined && { error: failed }),
    } satisfies { readonly installationId?: InstallationId; readonly error?: string }
  })

  /**
   * Sends every client that asked for MCP servers them again, as when an OAuth Installation's
   * connection was lost; under the lock.
   */
  const connectionsChanged = toOthers(undefined)

  return { receiveWeb, accessChanged, finishConnect, connectionsChanged }
})

export type McpServerRelay = Effect.Success<ReturnType<typeof makeMcpServerRelay>>
