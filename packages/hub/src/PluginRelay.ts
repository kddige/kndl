// What the Session relay does with Plugin messages (#221, ADR 0020): the web UI's commands to
// create, edit and delete Plugins and their Installations, and to read a Repo's Plugin change log.
//
// - Any Member may create a Plugin, and delete one with no Installations.
// - An Installation's Repos are its gate: creating, editing or deleting one needs access to every
//   Repo it lists, before and after, as Sessions check it (ADR 0003). So does editing a Plugin, for
//   every Repo its Installations list: its URL is where their Sessions' MCP traffic goes. Access is
//   asked off the lock, since it may wait on GitHub, and the change is made under it, refused if
//   the Installation lists a Repo meanwhile that wasn't asked about.
// - A refusal names only a Repo the person typed, in words alike whether it exists or not; the
//   Repos of an Installation they can't see are never named, only counted.
// - Each web client is sent the Installations with only the Repos its person has access to, as
//   last asked. When that changes, so does what it is sent.
// - A global Installation (#219) lists no Repo, so it needs no access to create, edit or delete:
//   only that its person be the Owner, which the store checks. Turning one off for a Repo, or back
//   on, needs access to that Repo alone.
// - A change tells the changed Repos' Sessions, which then show that a Restart applies it. A change
//   to every Repo, a global Installation's or its Plugin's, tells every Session, and sends each
//   client the log of every Repo it is known to have access to.
// - A packaged Plugin (#220) is read first, from git or an upload, off the lock: a fetch may take a
//   while. The read is kept for its person, to add or upgrade to by its id once they confirm, so
//   what they confirm is what they saw. An Upgrade is refused if the Plugin changed since.
// - Connecting an OAuth Installation (#217), or disconnecting it, needs access to every Repo it
//   lists, as editing it does, and for a global one, that its person be the Owner: every Session
//   on the Hub acts as its account. Connecting begins under the lock, then finds the authorization
//   server off it, and answers where to send the browser; it comes back to the Hub's callback
//   (PluginOAuthRoutes.ts), which trades the code off the lock and keeps the tokens under it,
//   refused if the Installation lists another Repo by then, or its Plugin changed. Where the
//   authorization server offers no Dynamic Client Registration, it answers that a client must be
//   entered instead (#218), which the person sends with the command again: the same people set the
//   client as connect, and it is kept as the tokens are.

import {
  type CheckPluginUpgrade,
  CommandFailed,
  HubToWeb,
  type Installation,
  type InstallationId,
  type PackagedPlugin,
  type Participant,
  type ParticipantId,
  type PluginCommand,
  type PluginId,
  type PluginPackageFrom,
  PluginPackageReadTtlMs,
  type PluginsState,
  type ReadPluginPackage,
  RepoName,
  sameRepo,
  sameSource,
  type WebToHub,
} from "@kndl/protocol"
import { Clock, Effect, Option } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { type BeginInput, connectionBasis, PluginOAuth } from "./PluginOAuth.ts"
import {
  PluginRefused,
  Plugins,
  type PluginsChanged,
  pluginTakenRefusal,
  type StoredInstallation,
} from "./Plugins.ts"
import { PluginSources } from "./PluginSources.ts"
import { RepoAccess } from "./RepoAccess.ts"
import type { Peer } from "./SessionRelay.ts"
import { randomId } from "./Tokens.ts"

const webTags = [
  "GetPlugins",
  "CreatePlugin",
  "EditPlugin",
  "DeletePlugin",
  "ReadPluginPackage",
  "CheckPluginUpgrade",
  "AddPluginPackage",
  "UpgradePlugin",
  "CreateInstallation",
  "EditInstallation",
  "DeleteInstallation",
  "TurnGlobalInstallation",
  "ConnectInstallation",
  "DisconnectInstallation",
  "GetPluginLog",
] as const satisfies ReadonlyArray<PluginCommand["_tag"]>

export const isPluginCommand = (message: WebToHub): message is PluginCommand =>
  (webTags as ReadonlyArray<string>).includes(message._tag)

/** A web connection, as the relay knows it. */
export interface PluginWebClient {
  readonly you: Participant
  readonly peer: Peer<HubToWeb>
  /** Whether its person has access to each Repo, as last asked (ADR 0003). */
  readonly repos: ReadonlyMap<string, boolean>
}

/** What the Plugin relay needs of the Session relay. */
export interface PluginRelayHost {
  readonly webClients: () => Iterable<PluginWebClient>
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
  readonly read: PackagedPlugin
  /** The Plugin it upgrades, from the same source. */
  readonly upgrades?: PluginId
  /** That Plugin's package when read, which it must still be to upgrade. */
  readonly basis?: string
  readonly at: number
}

/** A command about Plugins that changes them, or asks about them: not a read of a package. */
type StoreCommand = Exclude<PluginCommand, ReadPluginPackage | CheckPluginUpgrade>

/** What to begin connecting an OAuth Installation with, once its Repos are checked (#217). */
type Connecting = BeginInput

/**
 * An Installation as the person may see it: only the Repos they have access to, of those it lists
 * and those that turned it off.
 */
const seenBy = (client: PluginWebClient, installation: StoredInstallation): Installation => {
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

export const makePluginRelay = Effect.fnUntraced(function* (host: PluginRelayHost) {
  const plugins = yield* Plugins
  const access = yield* RepoAccess
  const sources = yield* PluginSources
  const oauth = yield* PluginOAuth
  /** The connections that asked for Plugins, which are sent them again as they change. */
  const asked = new WeakSet<Peer<HubToWeb>>()
  /** The package reads kept, by id, oldest first. */
  const reads = new Map<string, KeptRead>()

  /** The read the Hub keeps for the person by that id, if it hasn't expired. */
  const keptRead = Effect.fn("PluginRelay.keptRead")(function* (by: ParticipantId, readId: string) {
    const now = yield* Clock.currentTimeMillis
    for (const [id, kept] of reads) {
      if (now - kept.at > PluginPackageReadTtlMs) reads.delete(id)
    }
    const kept = reads.get(readId)
    return kept?.by === by ? kept : yield* new PluginRefused({ message: staleRead })
  })

  /** Where to read a packaged Plugin again, at the ref it was added from: only from git. */
  const gitSourceOf = Effect.fn("PluginRelay.gitSourceOf")(function* (id: PluginId) {
    const plugin = Option.getOrUndefined(yield* plugins.plugin(id))
    if (plugin?.package === undefined) {
      return yield* new PluginRefused({ message: "There is no such packaged Plugin." })
    }
    const { source } = plugin.package
    if (source._tag === "Upload") {
      return yield* new PluginRefused({
        message: `${plugin.name} was uploaded: upload its new version to upgrade it.`,
      })
    }
    const from: PluginPackageFrom = { ...source, _tag: "Git" }
    return { from, plugin: plugin.id }
  })

  /**
   * Reads a package for the person, off the lock, and keeps it for them to add, or to upgrade a
   * Plugin from the same source to. Refused if a Plugin from another source has its name.
   */
  const readPackage = Effect.fn("PluginRelay.readPackage")(function* (
    client: PluginWebClient,
    message: ReadPluginPackage | CheckPluginUpgrade,
  ) {
    const checked =
      message._tag === "CheckPluginUpgrade"
        ? yield* gitSourceOf(message.pluginId)
        : { from: message.from, plugin: undefined }
    const read = yield* sources.read(checked.from)
    if (checked.plugin !== undefined && read.id !== checked.plugin) {
      return yield* new PluginRefused({
        message: `The package there is now named ${read.id}, not ${checked.plugin}: add it as a Plugin of its own.`,
      })
    }
    const existing = Option.getOrUndefined(yield* plugins.plugin(read.id))
    if (existing !== undefined) {
      if (
        existing.package === undefined ||
        !sameSource(existing.package.source, read.package.source)
      ) {
        return yield* new PluginRefused({ message: pluginTakenRefusal(read.id) })
      }
    }
    const readId = randomId()
    reads.set(readId, {
      by: client.you.id,
      read,
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
      HubToWeb.cases.PluginPackageRead.make({
        requestId: message.requestId,
        readId,
        read,
        ...(existing !== undefined && { upgrades: existing.id }),
      }),
    )
  })

  const stateFor = (
    client: PluginWebClient,
    listed: Effect.Success<typeof plugins.list>,
  ): PluginsState =>
    HubToWeb.cases.PluginsState.make({
      plugins: listed.plugins,
      installations: listed.installations.map((installation) => seenBy(client, installation)),
    })

  /**
   * Asks GitHub, off the lock, for the person's access to each Repo: whether they have access to
   * all of them, with what to record, under the lock, of what GitHub said.
   */
  const ask = Effect.fn("PluginRelay.ask")(function* (
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

  /** Sends every client but `except` that asked for Plugins the Plugins as they are now. */
  const toOthers = Effect.fn("PluginRelay.toOthers")(function* (
    except: Peer<HubToWeb> | undefined,
  ) {
    const listed = yield* plugins.list
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
  const changed = Effect.fn("PluginRelay.changed")(function* (change: PluginsChanged) {
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
      const entries = yield* plugins.log(repo)
      for (const client of host.webClients()) {
        if (client.repos.get(repo) === true) {
          client.peer.send(HubToWeb.cases.PluginLog.make({ repo: RepoName.make(repo), entries }))
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
  const reposOf = Effect.fn("PluginRelay.reposOf")(function* (message: StoreCommand) {
    switch (message._tag) {
      case "GetPlugins":
      case "CreatePlugin":
      case "DeletePlugin":
      case "AddPluginPackage":
        return { named: [], hidden: [] }
      case "GetPluginLog":
      case "TurnGlobalInstallation":
        return { named: [message.repo], hidden: [] }
      case "EditPlugin":
      case "UpgradePlugin":
        return { named: [], hidden: yield* plugins.pluginRepos(message.pluginId) }
      case "CreateInstallation":
        return { named: message.repos, hidden: [] }
      case "EditInstallation":
      case "DeleteInstallation":
      case "ConnectInstallation":
      case "DisconnectInstallation": {
        const installation = yield* plugins.installation(message.installationId)
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
  const handle = Effect.fn("PluginRelay.handle")(function* (
    client: PluginWebClient,
    message: StoreCommand,
    checked: ReadonlyArray<string>,
  ): Effect.fn.Return<Connecting | void, PluginRefused | SqlError> {
    const { you, peer } = client
    const { requestId } = message
    const answer = Effect.gen(function* () {
      peer.send({ ...stateFor(client, yield* plugins.list), requestId })
    })
    /** Refuses a change to an Installation that lists a Repo meanwhile that wasn't asked about. */
    const stillChecked = Effect.fn(function* (repos: ReadonlyArray<string>) {
      if (repos.some((repo) => !checked.some((other) => sameRepo(other, repo)))) {
        return yield* new PluginRefused({
          message: "The Installation changed meanwhile; try again.",
        })
      }
    })
    switch (message._tag) {
      case "GetPlugins":
        asked.add(peer)
        return yield* answer

      case "GetPluginLog":
        return peer.send(
          HubToWeb.cases.PluginLog.make({
            requestId,
            repo: message.repo,
            entries: yield* plugins.log(message.repo),
          }),
        )

      case "CreatePlugin":
        yield* plugins.createPlugin(message, you.id)
        asked.add(peer)
        yield* answer
        return yield* toOthers(peer)

      case "EditPlugin": {
        yield* stillChecked(yield* plugins.pluginRepos(message.pluginId))
        const change = yield* plugins.editPlugin(message.pluginId, message, you.id)
        asked.add(peer)
        yield* answer
        yield* toOthers(peer)
        return yield* changed(change)
      }

      case "DeletePlugin":
        yield* plugins.deletePlugin(message.pluginId, you.id)
        asked.add(peer)
        yield* answer
        return yield* toOthers(peer)

      case "AddPluginPackage": {
        const kept = yield* keptRead(you.id, message.readId)
        if (kept.upgrades !== undefined) {
          return yield* new PluginRefused({
            message: `A Plugin named ${kept.upgrades} is already on the Hub, from this source: upgrade it instead.`,
          })
        }
        yield* plugins.addPackage(kept.read, you.id)
        reads.delete(message.readId)
        asked.add(peer)
        yield* answer
        return yield* toOthers(peer)
      }

      case "UpgradePlugin": {
        const kept = yield* keptRead(you.id, message.readId)
        if (kept.upgrades !== message.pluginId) {
          return yield* new PluginRefused({ message: staleRead })
        }
        const now = Option.getOrUndefined(yield* plugins.plugin(message.pluginId))
        if (now === undefined || JSON.stringify(now.package) !== kept.basis) {
          return yield* new PluginRefused({
            message: `${now?.name ?? "The Plugin"} changed since that read; check for an upgrade again.`,
          })
        }
        yield* stillChecked(yield* plugins.pluginRepos(message.pluginId))
        const change = yield* plugins.upgradePlugin(kept.read, you.id)
        reads.delete(message.readId)
        asked.add(peer)
        yield* answer
        yield* toOthers(peer)
        return yield* changed(change)
      }

      case "CreateInstallation": {
        const change = yield* plugins.createInstallation(message, you.id)
        asked.add(peer)
        yield* answer
        yield* toOthers(peer)
        return yield* changed(change)
      }

      case "EditInstallation":
      case "DeleteInstallation": {
        const before = yield* plugins.installation(message.installationId)
        if (Option.isSome(before)) yield* stillChecked(before.value.repos)
        const change =
          message._tag === "EditInstallation"
            ? yield* plugins.editInstallation(message.installationId, message, you.id)
            : yield* plugins.deleteInstallation(message.installationId, you.id)
        asked.add(peer)
        yield* answer
        yield* toOthers(peer)
        return yield* changed(change)
      }

      // Anyone with access to the Repo turns a global Installation off for it, or back on (#219).
      case "TurnGlobalInstallation": {
        const change = yield* plugins.turnGlobalInstallation(
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
          yield* plugins.installation(message.installationId),
        )
        if (installation === undefined) {
          return yield* new PluginRefused({ message: "There is no such Installation." })
        }
        yield* stillChecked(installation.repos)
        yield* plugins.checkConnector(installation, you.id)
        const target = Option.getOrThrow(yield* plugins.plugin(installation.pluginId))
        if (target.auth._tag !== "OAuth") {
          return yield* new PluginRefused({
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
        const before = yield* plugins.installation(message.installationId)
        if (Option.isSome(before)) yield* stillChecked(before.value.repos)
        const change = yield* plugins.disconnectInstallation(message.installationId, you.id)
        asked.add(peer)
        yield* answer
        yield* toOthers(peer)
        return yield* changed(change)
      }
    }
  })

  /** Handles a web command about Plugins, answering a refusal with CommandFailed. */
  const receiveWeb = Effect.fn("PluginRelay.receiveWeb")(
    function* (client: PluginWebClient, message: PluginCommand) {
      const { you } = client
      if (message._tag === "ReadPluginPackage" || message._tag === "CheckPluginUpgrade") {
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
      // GetPlugins also asks about every Repo listed that the person's access to isn't known, to
      // show them those they have access to.
      const unknown =
        command._tag === "GetPlugins"
          ? (yield* plugins.list).installations
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
            return yield* new PluginRefused({ message: noRepoAccess(refused.repo) })
          }
          if (named.unknown !== undefined) {
            return yield* new PluginRefused({ message: named.unknown })
          }
          if (command._tag !== "GetPlugins") {
            if (hidden.unknown !== undefined || hidden.learned.some((answer) => !answer.allowed)) {
              return yield* new PluginRefused({
                message:
                  command._tag === "EditPlugin" || command._tag === "UpgradePlugin"
                    ? `This Plugin has Installations on Repos you have no access to, so you can't ${command._tag === "EditPlugin" ? "edit" : "upgrade"} it.`
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
            OAuthRefused: (refused) => Effect.fail(new PluginRefused({ message: refused.message })),
            SecretsUnavailable: (error) =>
              Effect.fail(new PluginRefused({ message: error.message })),
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
        Effect.catchTag("PluginRefused", (refused) =>
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
          Effect.logError("A Plugin command failed", error).pipe(
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
   * Sends the client the Plugins again when what its person has access to changed, if it asked for
   * them; under the lock.
   */
  const accessChanged = Effect.fn("PluginRelay.accessChanged")(function* (client: PluginWebClient) {
    if (!asked.has(client.peer)) return
    client.peer.send(stateFor(client, yield* plugins.list))
  })

  /**
   * Finishes a connection the person began, as the authorization server sent their browser back
   * with `response`: the Installation it was for, and why it failed, if it did. Every client that
   * asked for Plugins is sent them, and the Installation's Repos' log readers its entries.
   */
  const finishConnect = Effect.fn("PluginRelay.finishConnect")(function* (
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
        return yield* new PluginRefused({
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
            Effect.fail(new PluginRefused({ message: refused.message })),
          ),
        )
      yield* host.serialized(
        Effect.gen(function* () {
          const change = yield* plugins.connectInstallation(pending, granted, you.id)
          yield* toOthers(undefined)
          yield* changed(change)
        }),
      )
    }).pipe(
      Effect.as<string | undefined>(undefined),
      Effect.catchTag("PluginRefused", (refused) => Effect.succeed(refused.message)),
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
   * Sends every client that asked for Plugins them again, as when an OAuth Installation's
   * connection was lost; under the lock.
   */
  const connectionsChanged = toOthers(undefined)

  return { receiveWeb, accessChanged, finishConnect, connectionsChanged }
})

export type PluginRelay = Effect.Success<ReturnType<typeof makePluginRelay>>
