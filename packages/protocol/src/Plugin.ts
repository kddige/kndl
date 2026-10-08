import { Schema } from "effect"
import { MinSensitiveValueLength, SecretValue } from "./Environment.ts"
import { InstallationId, PluginId, RequestId } from "./Ids.ts"
import { EpochMillis, Participant, RepoName, repoKey } from "./Session.ts"

// Plugins (ADR 0020): remote MCP servers the Hub adds to Sessions. A Plugin is the server's
// definition; an Installation is a named copy of one, global or on in the Repos it lists. Claude
// Code in a Session gets one MCP server per Installation on for its Repo, which it reaches through
// the Runner's relay and the Hub's Gateway: `/gateway/<installationId>`, authenticated by the
// Session token, as `/mod/*` is (ADR 0013).
//
// A Plugin may declare header secrets (#215): headers, such as `Authorization: Bearer <api key>`,
// that the Gateway adds to each request, each from a value its Installation holds. The values are
// write-only, like Sensitive Variables: the web is told only which are set, by whom and when.
//
// A Plugin may instead use OAuth (#217): each Installation is connected to one account on its MCP
// server's authorization server, by someone who may edit it, and every Session on its Repos acts
// as that account. The Hub registers itself there as a client by Dynamic Client Registration; where
// the server offers none, the person connecting enters a client they registered by hand (#218),
// whose secret is write-only. Only the Hub holds the tokens, and refreshes them; the web is told
// only whether it is connected, by whom, and the account, if the server says; and for a client
// entered, its id and whether it has a secret. Claude Code never runs OAuth itself: the Gateway
// answers it.
//
// A Plugin is Hub-only, made in the web UI, or packaged: read from a git repo or an upload, pinned
// to its version and changed only by an Upgrade (see PluginPackage.ts).
//
// An Installation is global (#219), on in every Repo, existing and new, or Repo-scoped, on in the
// Repos it lists. On a Repo with a Repo-scoped Installation of a global one's Plugin, that one
// takes the global's place; a Repo can also turn a global Installation off, and back on. Only the
// Hub's Owner creates, edits or deletes a global Installation, connects or disconnects it, or
// edits, upgrades or deletes its Plugin: every Sandbox on the Hub can use it. See
// `installationsFor`.

// ── Plugins and Installations ──────────────────────────────────────────────

/** The prefix of a Hub-only Plugin's id: npm names can't hold a colon, so it never clashes. */
export const HubPluginPrefix = "hub:"

/** A Plugin's or Installation's name, as typed, at most this long. */
export const MaxPluginNameLength = 80

/** A Plugin's URL, at most this long. */
export const MaxPluginUrlLength = 2048

/** The Repos one Installation lists, at most. */
export const MaxInstallationRepos = 100

/**
 * The slug of a name, for an id or an MCP server's name: lowercase letters, digits and single
 * hyphens, at most 40 characters, or `plugin` for a name with none of them.
 */
export function pluginSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "")
  return slug === "" ? "plugin" : slug
}

/** A Hub-only Plugin's id: `hub:<slug>`. */
export const hubPluginId = (slug: string): PluginId => PluginId.make(`${HubPluginPrefix}${slug}`)

/** The text of a header secret's template that its value takes the place of. */
export const ValuePlaceholder = "{value}"

/** The header secrets one Plugin declares, at most. */
export const MaxHeaderSecrets = 10

/** A header secret's value, at most this long. */
export const MaxHeaderValueLength = 4096

/**
 * A header the Gateway adds to each request to a Plugin's MCP server, from a value each
 * Installation holds: `template` with its value in place of `{value}`, such as `Bearer {value}`.
 */
export const HeaderSecret = Schema.Struct({
  /** Its identifier, unique in the Plugin, which its Installations' values are kept under. */
  key: Schema.String,
  /** What the web UI calls it, such as "API key". */
  title: Schema.String,
  /** The HTTP header's name, unique in the Plugin by any case. */
  header: Schema.String,
  /** The header's value, holding `{value}` exactly once. */
  template: Schema.String,
})
export type HeaderSecret = typeof HeaderSecret.Type

/** The OAuth scopes one Plugin asks for, at most. */
export const MaxOAuthScopes = 20

/**
 * The auth a Plugin's MCP server needs: none; header secrets; or OAuth (#217), each Installation
 * connected to an account on the server's authorization server, asking for `scopes` when listed,
 * else for those the server says it needs.
 */
export const PluginAuth = Schema.Union([
  Schema.TaggedStruct("None", {}),
  Schema.TaggedStruct("Headers", { headers: Schema.Array(HeaderSecret) }),
  Schema.TaggedStruct("OAuth", { scopes: Schema.optionalKey(Schema.Array(Schema.String)) }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type PluginAuth = typeof PluginAuth.Type

/** The header secrets `auth` declares; none for other auth. */
export const headerSecretsOf = (auth: PluginAuth): ReadonlyArray<HeaderSecret> =>
  auth._tag === "Headers" ? auth.headers : []

// ── Packages ───────────────────────────────────────────────────────────────

/**
 * Where a packaged Plugin came from: a git repo over HTTPS, at a ref (its default branch when
 * absent) and in a subfolder (its root when absent); or an upload, by its file or folder name.
 */
export const PluginSource = Schema.Union([
  Schema.TaggedStruct("Git", {
    url: Schema.String,
    ref: Schema.optionalKey(Schema.String),
    path: Schema.optionalKey(Schema.String),
  }),
  Schema.TaggedStruct("Upload", { fileName: Schema.String }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type PluginSource = typeof PluginSource.Type

/**
 * What a packaged Plugin is pinned to: its `package.json` version and, from git, the exact commit,
 * with where it came from. Only an Upgrade moves it.
 */
export const PluginPackage = Schema.Struct({
  version: Schema.String,
  /** The commit it was read at, from git. */
  commit: Schema.optionalKey(Schema.String),
  source: PluginSource,
})
export type PluginPackage = typeof PluginPackage.Type

/** A remote MCP server, as the Hub adds it to Sessions. */
export const Plugin = Schema.Struct({
  /** `hub:<slug>` for a Hub-only Plugin; a package's `package.json` name. */
  id: PluginId,
  /** Its display name. */
  name: Schema.String,
  /** What it does, from a package's manifest. */
  description: Schema.optionalKey(Schema.String),
  /** Its MCP server's URL, which only the Hub reaches (Streamable HTTP). */
  url: Schema.String,
  auth: PluginAuth,
  /** What a packaged Plugin is pinned to; absent for a Hub-only one. */
  package: Schema.optionalKey(PluginPackage),
  createdBy: Participant,
  createdAt: EpochMillis,
})
export type Plugin = typeof Plugin.Type

/** That an Installation holds a value for one of its Plugin's header secrets: never the value. */
export const HeaderValueSet = Schema.Struct({
  /** The header secret's key. */
  key: Schema.String,
  setBy: Participant,
  setAt: EpochMillis,
})
export type HeaderValueSet = typeof HeaderValueSet.Type

/**
 * An OAuth Installation's connection to its account (#217): who connected it and when, and the
 * account, if the server said which. `lostAt` says when the Hub found it no longer works, as when
 * the authorization server refused to refresh it: then it needs reconnecting. Never a token.
 */
export const InstallationConnection = Schema.Struct({
  connectedBy: Participant,
  connectedAt: EpochMillis,
  /** The account, as the server's OpenID Connect claims name it: an email or user name. */
  account: Schema.optionalKey(Schema.String),
  lostAt: Schema.optionalKey(EpochMillis),
})
export type InstallationConnection = typeof InstallationConnection.Type

/**
 * The OAuth client someone entered for an Installation whose authorization server offers no
 * Dynamic Client Registration (#218): its id, whether it has a secret, and who set it when. Never
 * the secret.
 */
export const InstallationClient = Schema.Struct({
  clientId: Schema.String,
  /** Whether it has a client secret: a public client has none. */
  secret: Schema.Boolean,
  setBy: Participant,
  setAt: EpochMillis,
})
export type InstallationClient = typeof InstallationClient.Type

/**
 * A named copy of a Plugin, global or on in the Repos it lists. A web client is sent only the
 * Repos its person has access to: `otherRepos` counts the rest, without naming them.
 */
export const Installation = Schema.Struct({
  id: InstallationId,
  pluginId: PluginId,
  name: Schema.String,
  /** Whether it is global (#219): on in every Repo, listing none. Absent for Repo-scoped. */
  global: Schema.optionalKey(Schema.Boolean),
  /** The Repos it lists, for a Repo-scoped one; none for a global one. */
  repos: Schema.Array(RepoName),
  /** How many Repos it lists that the person has no access to; absent for none. */
  otherRepos: Schema.optionalKey(Schema.Int),
  /**
   * For a global one, the Repos that turned it off (#219), of those the person has access to;
   * absent for none.
   */
  off: Schema.optionalKey(Schema.Array(RepoName)),
  /**
   * The header secrets of its Plugin it holds a value for. One its Plugin declares that isn't
   * here needs a value.
   */
  values: Schema.Array(HeaderValueSet),
  /** For an OAuth Plugin: its connection, absent while it was never connected or is disconnected. */
  connection: Schema.optionalKey(InstallationConnection),
  /**
   * For an OAuth Plugin: the client entered for it (#218), kept when it is disconnected; absent
   * for one the Hub registered itself, or none yet.
   */
  client: Schema.optionalKey(InstallationClient),
  createdBy: Participant,
  createdAt: EpochMillis,
})
export type Installation = typeof Installation.Type

/** Whether an Installation is connected to its OAuth account, and the connection still works. */
export const isConnected = (installation: { readonly connection?: InstallationConnection }) =>
  installation.connection !== undefined && installation.connection.lostAt === undefined

/** A value for one of a Plugin's header secrets, as the web UI sends it: write-only. */
export const HeaderValueInput = Schema.Struct({
  key: Schema.String,
  value: SecretValue,
})
export type HeaderValueInput = typeof HeaderValueInput.Type

/** What a Repo's Plugin change log records. */
export const PluginChange = Schema.Literals([
  /** An Installation was created on the Repo. */
  "Created",
  /** An existing Installation was put on the Repo. */
  "Added",
  /** An Installation on the Repo was renamed. */
  "Renamed",
  /** An Installation was taken off the Repo. */
  "Removed",
  /** An Installation on the Repo was deleted. */
  "Deleted",
  /** The Plugin of an Installation on the Repo was edited: its name, URL or header secrets. */
  "PluginEdited",
  /** Values of an Installation on the Repo were set: `secrets` names which. */
  "ValuesSet",
  /**
   * Values of an Installation on the Repo were cleared, as its Plugin's URL moved to another
   * origin or its header secrets changed: `secrets` names which.
   */
  "ValuesCleared",
  /** The packaged Plugin of an Installation on the Repo was upgraded to another version. */
  "PluginUpgraded",
  /** A Repo-scoped Installation was made global (#219): on in every Repo. */
  "MadeGlobal",
  /** A global Installation was made Repo-scoped (#219): on in only the Repos it lists. */
  "MadeRepoScoped",
  /** A global Installation was turned off for the Repo (#219). */
  "TurnedOff",
  /** A global Installation turned off for the Repo was turned back on (#219). */
  "TurnedOn",
  /** An OAuth Installation on the Repo was connected to its account (#217). */
  "Connected",
  /**
   * An OAuth Installation on the Repo was given another client entered by hand (#218), as it was
   * connected with it: never its secret.
   */
  "ClientSet",
  /** An OAuth Installation on the Repo was connected again, as to replace a lost connection. */
  "Reconnected",
  /**
   * An OAuth Installation on the Repo was disconnected: by someone, or as its Plugin's URL moved to
   * another origin or its Plugin stopped using OAuth, so no token goes to a server it wasn't for.
   */
  "Disconnected",
])
export type PluginChange = typeof PluginChange.Type

/**
 * One entry of a Repo's Plugin change log, with the names as they were then. A change to a global
 * Installation is in every Repo's log, once (#219): `global` says so.
 */
export const PluginLogEntry = Schema.Struct({
  at: EpochMillis,
  by: Participant,
  change: PluginChange,
  /** Whether it is a change to a global Installation, in every Repo's log; absent if not. */
  global: Schema.optionalKey(Schema.Boolean),
  pluginId: PluginId,
  pluginName: Schema.String,
  installationId: InstallationId,
  installationName: Schema.String,
  /** The titles of the header secrets whose values were set or cleared; never a value. */
  secrets: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The version a packaged Plugin was upgraded to, for PluginUpgraded. */
  pluginVersion: Schema.optionalKey(Schema.String),
})
export type PluginLogEntry = typeof PluginLogEntry.Type

/**
 * A package as the Hub read it, from git or an upload, not yet added: the Plugin it would be, or
 * upgrade one to.
 */
export const PackagedPlugin = Schema.Struct({
  /** Its `package.json` name. */
  id: PluginId,
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  url: Schema.String,
  auth: PluginAuth,
  package: PluginPackage,
})
export type PackagedPlugin = typeof PackagedPlugin.Type

// ── Hub to Runner ──────────────────────────────────────────────────────────

/**
 * An MCP server a Session's Claude Code gets, as StartSession gives it: its name, unique in the
 * Session, and the Installation the Gateway reaches with it. No credential: Claude Code reaches it
 * with the Session token, through the Runner's relay.
 */
export const GatewayServer = Schema.Struct({
  installationId: InstallationId,
  /** Its name in Claude Code: a slug of the Installation's name. */
  server: Schema.String.check(Schema.isPattern(/^[a-z0-9](?:-?[a-z0-9])*$/)),
})
export type GatewayServer = typeof GatewayServer.Type

/**
 * The names of a Session's MCP servers, one per Installation, in order: each the slug of the
 * Installation's name, with a number added to any that an earlier one took.
 */
export function mcpServerNames(names: ReadonlyArray<string>): Array<string> {
  const taken = new Set<string>()
  return names.map((name) => {
    const slug = pluginSlug(name)
    let server = slug
    for (let n = 2; taken.has(server); n++) server = `${slug}-${n}`
    taken.add(server)
    return server
  })
}

/** The Runner relay's and the Hub's path to an Installation's MCP server. */
export const gatewayPath = (installationId: string) =>
  `/gateway/${encodeURIComponent(installationId)}`

// ── Web to Hub ─────────────────────────────────────────────────────────────

/** Ask for every Plugin and Installation. Answered with {@link PluginsState}. */
export const GetPlugins = Schema.TaggedStruct("GetPlugins", {
  requestId: RequestId,
})
export type GetPlugins = typeof GetPlugins.Type

/**
 * Create a Hub-only Plugin; any Member may. Its id is `hub:` and the slug of its name, with a
 * number added when that is taken. Answered with {@link PluginsState}.
 */
export const CreatePlugin = Schema.TaggedStruct("CreatePlugin", {
  requestId: RequestId,
  name: Schema.String,
  url: Schema.String,
  auth: PluginAuth,
})
export type CreatePlugin = typeof CreatePlugin.Type

/**
 * Change a Hub-only Plugin's name, URL or header secrets. Its Installations' Sessions show a new
 * name from their next wake or Restart; the Gateway uses the rest at once. A URL on another origin
 * clears every value its Installations hold, and a header secret removed, or given another key or
 * header, clears theirs for it: {@link clearedHeaderSecrets}. Refused unless the person has access
 * to every Repo its Installations list, for a packaged Plugin, which changes only by an Upgrade,
 * and unless the person is the Owner, for a Plugin with a global Installation (#219). Answered with
 * {@link PluginsState}.
 */
export const EditPlugin = Schema.TaggedStruct("EditPlugin", {
  requestId: RequestId,
  pluginId: PluginId,
  name: Schema.String,
  url: Schema.String,
  auth: PluginAuth,
})
export type EditPlugin = typeof EditPlugin.Type

/**
 * Delete a Plugin with no Installations. Unless the person is the Owner, refused for one with a
 * global Installation (#219), first. Answered with {@link PluginsState}.
 */
export const DeletePlugin = Schema.TaggedStruct("DeletePlugin", {
  requestId: RequestId,
  pluginId: PluginId,
})
export type DeletePlugin = typeof DeletePlugin.Type

/** An uploaded archive, at most this many bytes. */
export const MaxPluginArchiveBytes = 4 * 1024 * 1024

/** A package's `package.json` or manifest, at most this many bytes. */
export const MaxPluginPackageFileBytes = 64 * 1024

/**
 * Where the Hub reads a package from: a git repo; an uploaded `.tgz` or `.zip` archive, base64,
 * of which it reads only `package.json` and `kndl.json`; or those two files of an uploaded folder.
 */
export const PluginPackageFrom = Schema.Union([
  Schema.TaggedStruct("Git", {
    url: Schema.String,
    ref: Schema.optionalKey(Schema.String),
    path: Schema.optionalKey(Schema.String),
  }),
  Schema.TaggedStruct("Archive", {
    fileName: Schema.String,
    data: Schema.String.check(Schema.isMaxLength(Math.ceil(MaxPluginArchiveBytes / 3) * 4)),
  }),
  Schema.TaggedStruct("Folder", {
    folderName: Schema.String,
    packageJson: Schema.String.check(Schema.isMaxLength(MaxPluginPackageFileBytes)),
    manifest: Schema.String.check(Schema.isMaxLength(MaxPluginPackageFileBytes)),
  }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type PluginPackageFrom = typeof PluginPackageFrom.Type

/**
 * Read a package, to add it or upgrade a Plugin to it; any Member may. Refused when its name is a
 * Plugin's from another source; offered as an Upgrade of one from the same source. Answered with
 * {@link PluginPackageRead}.
 */
export const ReadPluginPackage = Schema.TaggedStruct("ReadPluginPackage", {
  requestId: RequestId,
  from: PluginPackageFrom,
})
export type ReadPluginPackage = typeof ReadPluginPackage.Type

/**
 * Read a packaged Plugin's git source again, at the ref it was added from, for an Upgrade.
 * Answered with {@link PluginPackageRead}.
 */
export const CheckPluginUpgrade = Schema.TaggedStruct("CheckPluginUpgrade", {
  requestId: RequestId,
  pluginId: PluginId,
})
export type CheckPluginUpgrade = typeof CheckPluginUpgrade.Type

/**
 * Add the package the person read, by its {@link PluginPackageRead}'s `readId`; any Member may.
 * Answered with {@link PluginsState}.
 */
export const AddPluginPackage = Schema.TaggedStruct("AddPluginPackage", {
  requestId: RequestId,
  readId: Schema.String,
})
export type AddPluginPackage = typeof AddPluginPackage.Type

/**
 * Upgrade a packaged Plugin to the package the person read, which its Installations' Sessions pick
 * up on their next wake or Restart. It clears Installations' values as {@link EditPlugin} does:
 * {@link clearedHeaderSecrets}. Refused unless the person has access to every Repo its
 * Installations list, if the Plugin changed since the read, and unless the person is the Owner,
 * for a Plugin with a global Installation (#219). Answered with {@link PluginsState}.
 */
export const UpgradePlugin = Schema.TaggedStruct("UpgradePlugin", {
  requestId: RequestId,
  pluginId: PluginId,
  readId: Schema.String,
})
export type UpgradePlugin = typeof UpgradePlugin.Type

/**
 * Create an Installation of a Plugin: Repo-scoped, on the Repos listed, refused unless the person
 * has access to every one, and for a Repo that already has a Repo-scoped Installation of the
 * Plugin; or global (#219), listing none, refused unless the person is the Owner, and for a Plugin
 * that already has a global Installation. Answered with {@link PluginsState}.
 */
export const CreateInstallation = Schema.TaggedStruct("CreateInstallation", {
  requestId: RequestId,
  pluginId: PluginId,
  name: Schema.String,
  /** Whether it is global; absent for Repo-scoped. */
  global: Schema.optionalKey(Schema.Boolean),
  /** The Repos it is on in, for a Repo-scoped one; none for a global one. */
  repos: Schema.Array(RepoName),
  /** Values for its Plugin's header secrets; one left out needs a value. */
  values: Schema.optionalKey(Schema.Array(HeaderValueInput)),
})
export type CreateInstallation = typeof CreateInstallation.Type

/**
 * Rename an Installation, set whether it is global and the Repos it is on in, and set values for
 * its Plugin's header secrets: `global` and `repos` as the whole new setting, and `values` only
 * those to set, the others kept. A Session uses a new value from its next wake or Restart. Refused
 * unless the person has access to every Repo it lists, before and after, and unless the person is
 * the Owner, if it is global before or after (#219). Answered with {@link PluginsState}.
 */
export const EditInstallation = Schema.TaggedStruct("EditInstallation", {
  requestId: RequestId,
  installationId: InstallationId,
  name: Schema.String,
  /** Whether it is global; absent for Repo-scoped. */
  global: Schema.optionalKey(Schema.Boolean),
  repos: Schema.Array(RepoName),
  values: Schema.optionalKey(Schema.Array(HeaderValueInput)),
})
export type EditInstallation = typeof EditInstallation.Type

/**
 * Delete an Installation, taking it off every Repo it is on in. Refused unless the person has
 * access to every Repo it lists, and unless the person is the Owner, for a global one (#219).
 * Answered with {@link PluginsState}.
 */
export const DeleteInstallation = Schema.TaggedStruct("DeleteInstallation", {
  requestId: RequestId,
  installationId: InstallationId,
})
export type DeleteInstallation = typeof DeleteInstallation.Type

/**
 * Turn a global Installation off for a Repo, or back on (#219). Anyone with access to the Repo
 * may. Refused for a Repo-scoped Installation: take the Repo off it instead. Its Sessions pick the
 * change up on their next wake or Restart. Answered with {@link PluginsState}.
 */
export const TurnGlobalInstallation = Schema.TaggedStruct("TurnGlobalInstallation", {
  requestId: RequestId,
  installationId: InstallationId,
  repo: RepoName,
  on: Schema.Boolean,
})
export type TurnGlobalInstallation = typeof TurnGlobalInstallation.Type

/**
 * A client registered by hand with an authorization server that offers no Dynamic Client
 * Registration (#218), as the web UI sends it: the secret is write-only. None for a public client.
 */
export const OAuthClientInput = Schema.Struct({
  clientId: Schema.String,
  clientSecret: Schema.optionalKey(SecretValue),
})
export type OAuthClientInput = typeof OAuthClientInput.Type

/**
 * Connect an OAuth Installation to an account (#217), or reconnect it: the Hub finds the MCP
 * server's authorization server, registers itself there unless it did, and answers with where to
 * send the browser, to sign in and consent. The authorization server sends it back to the Hub,
 * which keeps the tokens and sends it on to the Plugins page. Refused unless the person has access
 * to every Repo the Installation lists, and unless the person is the Owner, for a global one
 * (#219). Answered with {@link InstallationAuthorizing}; or, where the authorization server offers
 * no Dynamic Client Registration and the Installation has no client entered that still fits, or
 * `changeClient` asks for another, with {@link InstallationNeedsClient} (#218).
 */
export const ConnectInstallation = Schema.TaggedStruct("ConnectInstallation", {
  requestId: RequestId,
  installationId: InstallationId,
  /**
   * The client to connect with, registered by hand (#218): kept, replacing the one before, once
   * the connection is made.
   */
  client: Schema.optionalKey(OAuthClientInput),
  /** Ask for another client to be entered, even if the Installation has one that fits (#218). */
  changeClient: Schema.optionalKey(Schema.Boolean),
})
export type ConnectInstallation = typeof ConnectInstallation.Type

/**
 * Disconnect an OAuth Installation, so the Hub forgets its tokens: its Sessions' requests are
 * refused from now on, and they don't start until it is connected again. Refused unless the person
 * has access to every Repo it lists, and unless the person is the Owner, for a global one (#219).
 * Answered with {@link PluginsState}.
 */
export const DisconnectInstallation = Schema.TaggedStruct("DisconnectInstallation", {
  requestId: RequestId,
  installationId: InstallationId,
})
export type DisconnectInstallation = typeof DisconnectInstallation.Type

/** Ask for a Repo's Plugin change log. Answered with {@link PluginLog}. */
export const GetPluginLog = Schema.TaggedStruct("GetPluginLog", {
  requestId: RequestId,
  repo: RepoName,
})
export type GetPluginLog = typeof GetPluginLog.Type

/** Every Plugin command a web client sends: one member of WebToHub, so its union stays shallow. */
export const PluginCommand = Schema.Union([
  GetPlugins,
  CreatePlugin,
  EditPlugin,
  DeletePlugin,
  ReadPluginPackage,
  CheckPluginUpgrade,
  AddPluginPackage,
  UpgradePlugin,
  CreateInstallation,
  EditInstallation,
  DeleteInstallation,
  TurnGlobalInstallation,
  ConnectInstallation,
  DisconnectInstallation,
  GetPluginLog,
])
export type PluginCommand = typeof PluginCommand.Type

// ── Hub to web ─────────────────────────────────────────────────────────────

/**
 * Every Plugin and Installation, oldest first, each Installation with only the Repos the person
 * has access to. Answers the commands above with their `requestId`; sent to every other client
 * without one when something changes.
 */
export const PluginsState = Schema.TaggedStruct("PluginsState", {
  requestId: Schema.optionalKey(RequestId),
  plugins: Schema.Array(Plugin),
  installations: Schema.Array(Installation),
})
export type PluginsState = typeof PluginsState.Type

/**
 * A Repo's Plugin change log, newest first. Answers {@link GetPluginLog} with its `requestId`;
 * sent without one to every client with access to the Repo when it changes.
 */
export const PluginLog = Schema.TaggedStruct("PluginLog", {
  requestId: Schema.optionalKey(RequestId),
  repo: RepoName,
  entries: Schema.Array(PluginLogEntry),
})
export type PluginLog = typeof PluginLog.Type

/**
 * A package the Hub read for the person, which they add or upgrade a Plugin to by its `readId`
 * within {@link PluginPackageReadTtlMs}. Answers {@link ReadPluginPackage} and
 * {@link CheckPluginUpgrade}.
 */
export const PluginPackageRead = Schema.TaggedStruct("PluginPackageRead", {
  requestId: RequestId,
  readId: Schema.String,
  read: PackagedPlugin,
  /** The Plugin it would upgrade, which came from the same source; absent for a new one. */
  upgrades: Schema.optionalKey(PluginId),
})
export type PluginPackageRead = typeof PluginPackageRead.Type

/**
 * Where to send the browser to connect the Installation (#217): its authorization server's page to
 * sign in and consent, which sends it back to the Hub within {@link OAuthConnectTtlMs}. Answers
 * {@link ConnectInstallation}.
 */
export const InstallationAuthorizing = Schema.TaggedStruct("InstallationAuthorizing", {
  requestId: RequestId,
  installationId: InstallationId,
  url: Schema.String,
})
export type InstallationAuthorizing = typeof InstallationAuthorizing.Type

/**
 * The Installation's authorization server offers no Dynamic Client Registration (#218): connecting
 * needs a client registered with it by hand, with `callbackUrl` as its redirect URI, which
 * {@link ConnectInstallation} sends. Answers {@link ConnectInstallation}.
 */
export const InstallationNeedsClient = Schema.TaggedStruct("InstallationNeedsClient", {
  requestId: RequestId,
  installationId: InstallationId,
  /** The authorization server to register with: its issuer. */
  issuer: Schema.String,
  /** The Hub's callback, to register as the client's redirect (callback) URL. */
  callbackUrl: Schema.String,
  /** Whether the server takes a public client, with no secret; else a secret is needed. */
  publicClient: Schema.Boolean,
  /** Why it asks again, as when the client kept is for another authorization server. */
  reason: Schema.optionalKey(Schema.String),
})
export type InstallationNeedsClient = typeof InstallationNeedsClient.Type

/** How long a connection the Hub began waits for the authorization server to send the browser back. */
export const OAuthConnectTtlMs = 10 * 60_000

/** How long the Hub keeps a package it read for adding or upgrading. */
export const PluginPackageReadTtlMs = 30 * 60_000

// ── Rules, shared with the web UI ──────────────────────────────────────────

/** Why a Plugin's or Installation's name is refused, if it is. */
export function pluginNameProblem(name: string, what = "A Plugin"): string | undefined {
  if (name.trim() === "") return `${what} needs a name.`
  if (name.length > MaxPluginNameLength) {
    return `${what}'s name is longer than ${MaxPluginNameLength} characters.`
  }
  // oxlint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return `${what}'s name must be one line.`
  return undefined
}

/** Why a Plugin's MCP server URL is refused, if it is. */
export function pluginUrlProblem(url: string): string | undefined {
  if (url.length > MaxPluginUrlLength) {
    return `The URL is longer than ${MaxPluginUrlLength} characters.`
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return "The URL isn't a URL, such as https://mcp.example.com/mcp."
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return "The URL must start with https:// (or http://)."
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return "The URL can't hold a user name or password."
  }
  if (parsed.hash !== "") return "The URL can't have a #fragment."
  return undefined
}

/** Why an Installation's list of Repos is refused, if it is. */
export function installationReposProblem(repos: ReadonlyArray<string>): string | undefined {
  if (repos.length === 0) return "An Installation needs at least one Repo."
  if (repos.length > MaxInstallationRepos) {
    return `An Installation lists at most ${MaxInstallationRepos} Repos.`
  }
  const seen = new Set<string>()
  for (const repo of repos) {
    if (seen.has(repoKey(repo))) return `${repo} is listed twice.`
    seen.add(repoKey(repo))
  }
  return undefined
}

/** A header secret's key: letters, digits and underscores, starting with a letter. */
const headerKeyPattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

/** An HTTP header's name: a token (RFC 9110). */
const headerNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/

/** One line of printable ASCII, tabs allowed: what a header's value may hold. */
const plainLine = /^[\t -~]*$/

/**
 * Headers a header secret can't be: those of the connection and its framing, which the Gateway
 * sets itself, and those MCP's Streamable HTTP uses.
 */
const reservedHeaders = new Map(
  [
    "Connection",
    "Content-Encoding",
    "Content-Length",
    "Content-Type",
    "Accept",
    "Host",
    "Keep-Alive",
    "Last-Event-ID",
    "Mcp-Protocol-Version",
    "Mcp-Session-Id",
    "Proxy-Authorization",
    "Proxy-Connection",
    "TE",
    "Trailer",
    "Transfer-Encoding",
    "Upgrade",
  ].map((name) => [name.toLowerCase(), name]),
)

/** How many times `{value}` is in a template. */
const placeholders = (template: string) => template.split(ValuePlaceholder).length - 1

/** An OAuth scope: printable ASCII but space, `"` and `\` (RFC 6749). */
const scopePattern = /^[!#-[\]-~]{1,200}$/

/**
 * Why a Plugin's auth is refused, if it is: the header secrets it declares break a rule, or the
 * OAuth scopes it asks for.
 */
export function pluginAuthProblem(auth: PluginAuth): string | undefined {
  if (auth._tag === "None") return undefined
  if (auth._tag === "OAuth") {
    const scopes = auth.scopes ?? []
    if (scopes.length > MaxOAuthScopes) return `A Plugin asks for at most ${MaxOAuthScopes} scopes.`
    const bad = scopes.find((scope) => !scopePattern.test(scope))
    if (bad !== undefined) return `"${bad}" isn't an OAuth scope: one word, without quotes.`
    return undefined
  }
  const { headers } = auth
  if (headers.length === 0) return "Declare at least one header secret, or none."
  if (headers.length > MaxHeaderSecrets) {
    return `A Plugin declares at most ${MaxHeaderSecrets} header secrets.`
  }
  const keys = new Set<string>()
  const names = new Set<string>()
  for (const secret of headers) {
    if (!headerKeyPattern.test(secret.key)) {
      return `"${secret.key}" isn't a key: use letters, digits and underscores, starting with a letter.`
    }
    const titleProblem = pluginNameProblem(secret.title, "A header secret")
    if (titleProblem !== undefined) {
      return titleProblem === "A header secret needs a name."
        ? "A header secret needs a title."
        : titleProblem.replace("'s name", "'s title")
    }
    if (!headerNamePattern.test(secret.header)) return `"${secret.header}" isn't a header name.`
    const reserved = reservedHeaders.get(secret.header.toLowerCase())
    if (reserved !== undefined) return `The Gateway sets ${reserved} itself: use another header.`
    if (secret.template.length > 1024 || !plainLine.test(secret.template)) {
      return `${secret.title}'s template must be one line of plain characters.`
    }
    if (placeholders(secret.template) !== 1) {
      return `${secret.title}'s template must hold ${ValuePlaceholder} exactly once, as in Bearer ${ValuePlaceholder}.`
    }
    if (keys.has(secret.key)) return `The key ${secret.key} is declared twice.`
    if (names.has(secret.header.toLowerCase())) {
      return `The header ${secret.header} is declared twice.`
    }
    keys.add(secret.key)
    names.add(secret.header.toLowerCase())
  }
  return undefined
}

/** Why a value for the header secret titled `title` is refused, if it is; never naming it. */
export function headerValueProblem(title: string, value: string): string | undefined {
  if (value.length > MaxHeaderValueLength || !plainLine.test(value)) {
    return `The value of ${title} must be one line of plain characters.`
  }
  if (value.trim().length < MinSensitiveValueLength) {
    return `The value of ${title} is under ${MinSensitiveValueLength} characters: too short to redact from output.`
  }
  return undefined
}

/** The longest OAuth client id or secret entered by hand (#218). */
export const MaxOAuthClientLength = 1000

/**
 * Why a client entered by hand for an OAuth Installation is refused (#218), if it is: its id and
 * secret must each be one line of plain characters. Never says the secret.
 */
export function oauthClientProblem(clientId: string, clientSecret?: string): string | undefined {
  if (clientId.trim() === "") return "Enter the client ID."
  if (clientId.length > MaxOAuthClientLength || !/^[!-~]+$/.test(clientId)) {
    return "The client ID must be one word of plain characters, with no spaces."
  }
  if (clientSecret === undefined) return undefined
  if (clientSecret.length > MaxOAuthClientLength || !/^[!-~]+$/.test(clientSecret)) {
    return "The client secret must be one word of plain characters, with no spaces."
  }
  if (clientSecret.length < MinSensitiveValueLength) {
    return `The client secret is under ${MinSensitiveValueLength} characters: too short to redact from output.`
  }
  return undefined
}

/** A header secret's header value: its template with `value` in place of `{value}`. */
export const headerValue = (secret: HeaderSecret, value: string) =>
  secret.template.split(ValuePlaceholder).join(value)

/** A URL's origin, its scheme, host and port; or the URL itself, if it isn't one. */
const originOf = (url: string) => {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

/**
 * The header secrets of `before` whose values an edit to `after` clears on every Installation,
 * as the Hub clears them: all of them when the URL moves to another origin (scheme, host or port),
 * so no value goes to a server it wasn't entered for; else each whose key is gone, or whose header
 * is another. A new path, title or template keeps them.
 */
export function clearedHeaderSecrets(
  before: { readonly url: string; readonly auth: PluginAuth },
  after: { readonly url: string; readonly auth: PluginAuth },
): ReadonlyArray<HeaderSecret> {
  const declared = headerSecretsOf(before.auth)
  if (originOf(before.url) !== originOf(after.url)) return declared
  const now = headerSecretsOf(after.auth)
  return declared.filter((secret) => {
    const kept = now.find((other) => other.key === secret.key)
    return kept === undefined || kept.header.toLowerCase() !== secret.header.toLowerCase()
  })
}

/**
 * Whether an edit or Upgrade of a Plugin from `before` to `after` disconnects its OAuth
 * Installations (#217), as the Hub does: when its URL moves to another origin, so no token goes to
 * a server it wasn't issued for, or it stops using OAuth. It forgets their clients too, the Hub's
 * own and those entered by hand (#218).
 */
export const clearsConnections = (
  before: { readonly url: string; readonly auth: PluginAuth },
  after: { readonly url: string; readonly auth: PluginAuth },
) =>
  before.auth._tag === "OAuth" &&
  (after.auth._tag !== "OAuth" || originOf(before.url) !== originOf(after.url))

/**
 * What the Gateway answers a request through an Installation that has no value for one of its
 * Plugin's header secrets, as the Session started with them.
 */
export const valueNeededRefusal = (installation: string, title: string) =>
  `${installation} needs a value for ${title}: enter it on the Plugins page, then Restart the Session.`

// ── An Installation that fails a Session (#216) ─────────────────────────────

/**
 * Why an Installation failed its Session, as the Hub found at its start or the Gateway since:
 *
 * - `ValueNeeded`: a header secret of its Plugin has no value.
 * - `Rejected`: its MCP server answered 401 or 403, refusing the credential.
 * - `Unreadable`: the Hub could not decrypt its values, as when HUB_SECRETS_KEY changed.
 * - `Unreachable`: its MCP server could not be reached, or didn't answer in time.
 * - `Errored`: its MCP server answered another error.
 * - `NotConnected`: it uses OAuth, and isn't connected to its account, or the connection was lost
 *   (#217): someone must Reconnect it.
 */
export const InstallationFailureReason = Schema.Literals([
  "ValueNeeded",
  "Rejected",
  "Unreadable",
  "Unreachable",
  "Errored",
  "NotConnected",
])
export type InstallationFailureReason = typeof InstallationFailureReason.Type

/** An Installation that failed its Session: which, and why. Never a value. */
export const InstallationFailure = Schema.Struct({
  installationId: InstallationId,
  /** The Installation's name, as the Session started with it. */
  installation: Schema.String,
  reason: InstallationFailureReason,
  /** For `ValueNeeded`: the titles of the header secrets without a value. */
  secrets: Schema.optionalKey(Schema.Array(Schema.String)),
  /** For `Rejected` and `Errored`: the status its MCP server answered. */
  status: Schema.optionalKey(Schema.Int),
  /** Whether the Installation is global (#219), which a Repo turns off rather than leaves. */
  global: Schema.optionalKey(Schema.Boolean),
})
export type InstallationFailure = typeof InstallationFailure.Type

/** "API key", "API key and Team", "API key, Team and Region". */
const listed = (titles: ReadonlyArray<string>) =>
  titles.length <= 1
    ? (titles[0] ?? "a header secret")
    : `${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}`

/** What went wrong with the Installation, as one sentence. */
export const installationFailureText = (failure: Omit<InstallationFailure, "installationId">) => {
  const { installation } = failure
  switch (failure.reason) {
    case "ValueNeeded":
      return `${installation} needs a value for ${listed(failure.secrets ?? [])}.`
    case "Rejected":
      return `${installation}'s MCP server refused its credential (${failure.status ?? 401}).`
    case "Unreadable":
      return `The Hub could not read ${installation}'s header secret values: check HUB_SECRETS_KEY.`
    case "Unreachable":
      return `${installation}'s MCP server could not be reached.`
    case "Errored":
      return `${installation}'s MCP server answered ${failure.status ?? "an error"}.`
    case "NotConnected":
      return `${installation} isn't connected to its account.`
  }
}

/**
 * Whether the failure keeps a Session from starting: only when the Installation surely can't work
 * until someone fixes it. A server that is down or slow may be back in a moment, and shouldn't
 * block work: the Session starts, with a warning.
 */
export const failureBlocksStart = (failure: InstallationFailure) =>
  failure.reason === "ValueNeeded" ||
  failure.reason === "Rejected" ||
  failure.reason === "Unreadable" ||
  failure.reason === "NotConnected"

/**
 * Why a Session in `repo` didn't start, for the Installations that kept it from starting (#216),
 * and the way out, as its SessionStateChanged says after "Claude Code could not start: ".
 */
export const installationsCantStartText = (
  repo: string,
  failures: ReadonlyArray<Omit<InstallationFailure, "installationId">>,
) => {
  const one = failures.length === 1
  return `${failures.map(installationFailureText).join(" ")} Fix the ${one ? "Installation" : "Installations"} on the Plugins page, or ${leaveText(repo, failures)}, then wake the Session.`
}

/**
 * How `repo` does without the Installations that fail it: it is taken off a Repo-scoped one, and
 * turns a global one off (#219).
 */
export const leaveText = (
  repo: string,
  failures: ReadonlyArray<{ readonly global?: boolean | undefined }>,
) => {
  const them = failures.length === 1 ? "it" : "them"
  if (failures.every((failure) => failure.global === true)) return `turn ${them} off for ${repo}`
  if (failures.some((failure) => failure.global === true)) {
    return `take ${repo} off ${them} or turn ${them} off for it`
  }
  return `take ${repo} off ${them}`
}

/** Why a second Installation of a Plugin on a Repo is refused, as the Hub says it. */
export const secondInstallationRefusal = (repo: string, existing: string, plugin: string) =>
  `${repo} already has ${existing}, an Installation of ${plugin}: a Repo has at most one Installation of each Plugin.`

/** Why a second global Installation of a Plugin is refused, as the Hub says it (#219). */
export const secondGlobalRefusal = (existing: string, plugin: string) =>
  `${existing} is already a global Installation of ${plugin}: a Plugin has at most one global Installation.`

/** Why anyone but the Owner is refused a change to a global Installation (#219). */
export const globalOwnerOnlyRefusal =
  "Only the Hub's Owner can create, edit or delete a global Installation: every Sandbox on the Hub can use it."

/** Why anyone but the Owner is refused a change to a Plugin with a global Installation (#219). */
export const globalPluginRefusal = (plugin: string) =>
  `${plugin} has a global Installation, on in every Repo: only the Hub's Owner can edit, upgrade or delete it.`

/**
 * Why anyone but the Owner is refused connecting or disconnecting a global OAuth Installation
 * (#217, #219): every Session on the Hub acts as its account.
 */
export const globalConnectRefusal =
  "Only the Hub's Owner can connect or disconnect a global Installation: every Session on the Hub acts as its account."

/** Why turning a Repo-scoped Installation off for a Repo is refused (#219). */
export const notGlobalRefusal = (installation: string) =>
  `${installation} isn't global: take the Repo off it instead.`

/** Why a global Installation that lists Repos is refused (#219). */
export const globalReposRefusal = "A global Installation is on in every Repo: it lists none."

/** Where an Installation on a Repo comes from, as the Repo shows it (#219). */
export type InstallationSource =
  /** Repo-scoped, listing the Repo: on. */
  | "Repo"
  /** Global: on. */
  | "Global"
  /** Global, but a Repo-scoped Installation of its Plugin lists the Repo, and is on instead. */
  | "Overridden"
  /** Global, but the Repo turned it off. */
  | "Off"

/** What {@link installationsFor} needs of an Installation. */
export interface ResolvableInstallation {
  readonly pluginId: string
  readonly global?: boolean | undefined
  readonly repos: ReadonlyArray<string>
  readonly off?: ReadonlyArray<string> | undefined
}

/**
 * The Installations that are, or would be, on for `repo`, by any spelling, in the order given,
 * each with where it comes from (#219): every Repo-scoped one that lists it, and every global one,
 * which is on unless a Repo-scoped Installation of its Plugin lists the Repo (overridden) or the
 * Repo turned it off. The Hub resolves a Session's Installations, and the Gateway its requests,
 * the same way.
 */
export const installationsFor = <I extends ResolvableInstallation>(
  installations: ReadonlyArray<I>,
  repo: string,
): Array<{ readonly installation: I; readonly source: InstallationSource }> => {
  const key = repoKey(repo)
  const lists = (one: ResolvableInstallation) => one.repos.some((name) => repoKey(name) === key)
  const resolved: Array<{ readonly installation: I; readonly source: InstallationSource }> = []
  for (const installation of installations) {
    if (installation.global === true) {
      const overridden = installations.some(
        (other) =>
          other.global !== true && other.pluginId === installation.pluginId && lists(other),
      )
      const off = (installation.off ?? []).some((name) => repoKey(name) === key)
      resolved.push({
        installation,
        source: overridden ? "Overridden" : off ? "Off" : "Global",
      })
    } else if (lists(installation)) {
      resolved.push({ installation, source: "Repo" })
    }
  }
  return resolved
}

/** Whether an Installation from that source is on for the Repo. */
export const isOn = (source: InstallationSource) => source === "Repo" || source === "Global"

/** Why deleting a Plugin with Installations is refused, as the Hub says it. */
export const pluginInUseRefusal = (plugin: string, installations: number) =>
  `${plugin} has ${installations === 1 ? "an Installation" : `${installations} Installations`}: delete ${installations === 1 ? "it" : "them"} first.`
