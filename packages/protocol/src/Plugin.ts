import { Schema } from "effect"
import { InstallationId, PluginId, RequestId } from "./Ids.ts"
import { EpochMillis, Participant, RepoName, repoKey } from "./Session.ts"

// Plugins (ADR 0020): remote MCP servers the Hub adds to Sessions. A Plugin is the server's
// definition; an Installation is a named copy of one, on in the Repos it lists. Claude Code in a
// Session gets one MCP server per Installation on for its Repo, which it reaches through the
// Runner's relay and the Hub's Gateway: `/gateway/<installationId>`, authenticated by the Session
// token, as `/mod/*` is (ADR 0013).
//
// So far a Plugin is Hub-only, made in the web UI, and needs no auth; an Installation is
// Repo-scoped. Header secrets and OAuth (held by the Installation), global Installations and
// packages come later, and slot in here.

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

/** A remote MCP server, as the Hub adds it to Sessions. */
export const Plugin = Schema.Struct({
  id: PluginId,
  /** Its display name. */
  name: Schema.String,
  /** Its MCP server's URL, which only the Hub reaches (Streamable HTTP). */
  url: Schema.String,
  createdBy: Participant,
  createdAt: EpochMillis,
})
export type Plugin = typeof Plugin.Type

/**
 * A named copy of a Plugin, on in the Repos it lists. A web client is sent only the Repos its
 * person has access to: `otherRepos` counts the rest, without naming them.
 */
export const Installation = Schema.Struct({
  id: InstallationId,
  pluginId: PluginId,
  name: Schema.String,
  repos: Schema.Array(RepoName),
  /** How many Repos it lists that the person has no access to; absent for none. */
  otherRepos: Schema.optionalKey(Schema.Int),
  createdBy: Participant,
  createdAt: EpochMillis,
})
export type Installation = typeof Installation.Type

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
  /** The Plugin of an Installation on the Repo was edited: its name or URL. */
  "PluginEdited",
])
export type PluginChange = typeof PluginChange.Type

/** One entry of a Repo's Plugin change log, with the names as they were then. */
export const PluginLogEntry = Schema.Struct({
  at: EpochMillis,
  by: Participant,
  change: PluginChange,
  pluginId: PluginId,
  pluginName: Schema.String,
  installationId: InstallationId,
  installationName: Schema.String,
})
export type PluginLogEntry = typeof PluginLogEntry.Type

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
})
export type CreatePlugin = typeof CreatePlugin.Type

/**
 * Change a Hub-only Plugin's name or URL, which its Installations' Sessions pick up on their next
 * wake or Restart. Refused unless the person has access to every Repo its Installations list.
 * Answered with {@link PluginsState}.
 */
export const EditPlugin = Schema.TaggedStruct("EditPlugin", {
  requestId: RequestId,
  pluginId: PluginId,
  name: Schema.String,
  url: Schema.String,
})
export type EditPlugin = typeof EditPlugin.Type

/** Delete a Plugin with no Installations. Answered with {@link PluginsState}. */
export const DeletePlugin = Schema.TaggedStruct("DeletePlugin", {
  requestId: RequestId,
  pluginId: PluginId,
})
export type DeletePlugin = typeof DeletePlugin.Type

/**
 * Create a Repo-scoped Installation of a Plugin, on the Repos listed. Refused unless the person
 * has access to every one, and for a Repo that already has an Installation of the Plugin.
 * Answered with {@link PluginsState}.
 */
export const CreateInstallation = Schema.TaggedStruct("CreateInstallation", {
  requestId: RequestId,
  pluginId: PluginId,
  name: Schema.String,
  repos: Schema.Array(RepoName),
})
export type CreateInstallation = typeof CreateInstallation.Type

/**
 * Rename an Installation, and set the Repos it is on in: `repos` is the whole new list. Refused
 * unless the person has access to every Repo it lists, before and after. Answered with
 * {@link PluginsState}.
 */
export const EditInstallation = Schema.TaggedStruct("EditInstallation", {
  requestId: RequestId,
  installationId: InstallationId,
  name: Schema.String,
  repos: Schema.Array(RepoName),
})
export type EditInstallation = typeof EditInstallation.Type

/**
 * Delete an Installation, taking it off every Repo it lists. Refused unless the person has access
 * to every one. Answered with {@link PluginsState}.
 */
export const DeleteInstallation = Schema.TaggedStruct("DeleteInstallation", {
  requestId: RequestId,
  installationId: InstallationId,
})
export type DeleteInstallation = typeof DeleteInstallation.Type

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
  CreateInstallation,
  EditInstallation,
  DeleteInstallation,
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

/** Why a second Installation of a Plugin on a Repo is refused, as the Hub says it. */
export const secondInstallationRefusal = (repo: string, existing: string, plugin: string) =>
  `${repo} already has ${existing}, an Installation of ${plugin}: a Repo has at most one Installation of each Plugin.`

/** Why deleting a Plugin with Installations is refused, as the Hub says it. */
export const pluginInUseRefusal = (plugin: string, installations: number) =>
  `${plugin} has ${installations === 1 ? "an Installation" : `${installations} Installations`}: delete ${installations === 1 ? "it" : "them"} first.`
