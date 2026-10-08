// Plugins on the Hub (#221, ADR 0020): remote MCP servers, the Installations that put them on
// Repos, and each Repo's log of its Plugin changes.
//
// - A Plugin is Hub-only so far: made in the web UI, with the id `hub:<slug>`, which no npm
//   package's name can be. Any Member may create one. One with Installations can't be deleted.
// - An Installation is Repo-scoped so far: on in the Repos it lists. A Repo has at most one
//   Installation of each Plugin, by any spelling of its name (#197): the second is refused,
//   naming the first. Who may create or change one is the relay's to decide (PluginRelay.ts):
//   this store checks only what holds whoever asks.
// - Each Repo's log records who created, renamed, added, removed or deleted an Installation on it,
//   or edited its Plugin, and when, with the names as they were. Nothing here is an Environment
//   version: Sessions pick the change up on their next wake or Restart.

import {
  HubPluginPrefix,
  type Installation,
  InstallationId,
  installationReposProblem,
  mcpServerNames,
  type Participant,
  ParticipantId,
  type Plugin,
  type PluginChange,
  PluginChange as PluginChangeSchema,
  PluginId,
  type PluginLogEntry,
  pluginInUseRefusal,
  pluginNameProblem,
  pluginSlug,
  pluginUrlProblem,
  RepoName,
  type SessionInstallation,
  sameRepo,
  secondInstallationRefusal,
} from "@kndl/protocol"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import type { Fragment } from "effect/sql/Statement"
import { randomId } from "./Tokens.ts"

/** The Hub refused a change to a Plugin or Installation, saying why. */
// oxlint-disable-next-line unicorn/throw-new-error -- Effect makes error classes with a factory call
export class PluginRefused extends Schema.TaggedError<PluginRefused>()("PluginRefused", {
  message: Schema.String,
}) {}

const refuse = (message: string) => Effect.fail(new PluginRefused({ message }))

/** An Installation as the Hub keeps it: with every Repo it lists. */
export type StoredInstallation = Omit<Installation, "otherRepos">

/** What a change did, for the relay to tell the web and the affected Sessions. */
export interface PluginsChanged {
  /** Every Repo whose Installations or their Plugins changed. */
  readonly repos: ReadonlyArray<RepoName>
}

/** Refuses a Plugin's name or URL that breaks the rules the web UI shows. */
const checkPlugin = (input: { readonly name: string; readonly url: string }) => {
  const problem = pluginNameProblem(input.name) ?? pluginUrlProblem(input.url)
  return problem === undefined ? Effect.void : refuse(problem)
}

/** Refuses an Installation's name or Repos that break the rules the web UI shows. */
const checkInstallation = (input: {
  readonly name: string
  readonly repos: ReadonlyArray<RepoName>
}) => {
  const problem =
    pluginNameProblem(input.name, "An Installation") ?? installationReposProblem(input.repos)
  return problem === undefined ? Effect.void : refuse(problem)
}

/** A Repo's log, at most this many entries, newest first. */
const logLimit = 200

const toParticipant = (row: {
  readonly byId: string
  readonly byLogin: string
  readonly byName: string
  readonly byAvatarUrl: string | null
}): Participant => ({
  id: ParticipantId.make(row.byId),
  login: row.byLogin,
  name: row.byName,
  ...(row.byAvatarUrl !== null && { avatarUrl: row.byAvatarUrl }),
})

const decodeChange = Schema.decodeUnknownSync(PluginChangeSchema)

/** The Repos of `after` not in `before`, by any spelling. */
const missingFrom = (before: ReadonlyArray<string>, after: ReadonlyArray<RepoName>) =>
  after.filter((repo) => !before.some((other) => sameRepo(other, repo)))

export class Plugins extends Context.Service<
  Plugins,
  {
    /** Every Plugin and Installation, oldest first. */
    readonly list: Effect.Effect<
      {
        readonly plugins: ReadonlyArray<Plugin>
        readonly installations: ReadonlyArray<StoredInstallation>
      },
      SqlError
    >
    readonly plugin: (id: PluginId) => Effect.Effect<Option.Option<Plugin>, SqlError>
    readonly installation: (
      id: InstallationId,
    ) => Effect.Effect<Option.Option<StoredInstallation>, SqlError>
    /** The Repos the Plugin's Installations list, each once. */
    readonly pluginRepos: (id: PluginId) => Effect.Effect<ReadonlyArray<RepoName>, SqlError>
    readonly createPlugin: (
      input: { readonly name: string; readonly url: string },
      by: ParticipantId,
    ) => Effect.Effect<Plugin, PluginRefused | SqlError>
    readonly editPlugin: (
      id: PluginId,
      input: { readonly name: string; readonly url: string },
      by: ParticipantId,
    ) => Effect.Effect<PluginsChanged, PluginRefused | SqlError>
    readonly deletePlugin: (id: PluginId) => Effect.Effect<void, PluginRefused | SqlError>
    /** Creates an Installation on the Repos listed, which the caller spelled as the Hub keeps them. */
    readonly createInstallation: (
      input: {
        readonly pluginId: PluginId
        readonly name: string
        readonly repos: ReadonlyArray<RepoName>
      },
      by: ParticipantId,
    ) => Effect.Effect<StoredInstallation & PluginsChanged, PluginRefused | SqlError>
    /** Renames an Installation and sets its whole list of Repos. */
    readonly editInstallation: (
      id: InstallationId,
      input: { readonly name: string; readonly repos: ReadonlyArray<RepoName> },
      by: ParticipantId,
    ) => Effect.Effect<PluginsChanged, PluginRefused | SqlError>
    readonly deleteInstallation: (
      id: InstallationId,
      by: ParticipantId,
    ) => Effect.Effect<PluginsChanged, PluginRefused | SqlError>
    /**
     * The Installations on for the Repo, by any spelling, oldest first, as a Session starting now
     * runs with them: each with its MCP server's name, unique among them.
     */
    readonly forSession: (repo: string) => Effect.Effect<Array<SessionInstallation>, SqlError>
    /** The URL of the Installation's Plugin, if the Installation is on for the Repo. */
    readonly gatewayTarget: (
      id: InstallationId,
      repo: string,
    ) => Effect.Effect<Option.Option<{ readonly url: string }>, SqlError>
    /** The Repo's Plugin change log, newest first, by any spelling of its name. */
    readonly log: (repo: string) => Effect.Effect<ReadonlyArray<PluginLogEntry>, SqlError>
  }
>()("@kndl/hub/Plugins") {
  static readonly layer = Layer.effect(
    Plugins,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const pluginRows = (where: Fragment) =>
        sql<{
          readonly id: string
          readonly name: string
          readonly url: string
          readonly createdAt: number
          readonly byId: string
          readonly byLogin: string
          readonly byName: string
          readonly byAvatarUrl: string | null
        }>`
          SELECT g.id, g.name, g.url, g.created_at AS createdAt, p.id AS byId,
            p.login AS byLogin, p.name AS byName, p.avatar_url AS byAvatarUrl
          FROM plugins g JOIN participants p ON p.id = g.created_by
          ${where}
          ORDER BY g.created_at, g.id
        `.pipe(
          Effect.map((rows) =>
            rows.map((row): Plugin => ({
              id: PluginId.make(row.id),
              name: row.name,
              url: row.url,
              createdBy: toParticipant(row),
              createdAt: row.createdAt,
            })),
          ),
        )

      const installationRows = Effect.fn("Plugins.installationRows")(function* (where: Fragment) {
        const rows = yield* sql<{
          readonly id: string
          readonly pluginId: string
          readonly name: string
          readonly createdAt: number
          readonly byId: string
          readonly byLogin: string
          readonly byName: string
          readonly byAvatarUrl: string | null
        }>`
          SELECT i.id, i.plugin_id AS pluginId, i.name, i.created_at AS createdAt,
            p.id AS byId, p.login AS byLogin, p.name AS byName, p.avatar_url AS byAvatarUrl
          FROM installations i JOIN participants p ON p.id = i.created_by
          ${where}
          ORDER BY i.created_at, i.id
        `
        if (rows.length === 0) return []
        const repos = yield* sql<{ readonly installationId: string; readonly repo: string }>`
          SELECT installation_id AS installationId, repo FROM installation_repos
          WHERE installation_id IN ${sql.in(rows.map((row) => row.id))}
          ORDER BY repo COLLATE NOCASE
        `
        return rows.map((row): StoredInstallation => ({
          id: InstallationId.make(row.id),
          pluginId: PluginId.make(row.pluginId),
          name: row.name,
          repos: repos
            .filter((repo) => repo.installationId === row.id)
            .map((repo) => RepoName.make(repo.repo)),
          createdBy: toParticipant(row),
          createdAt: row.createdAt,
        }))
      })

      const list = Effect.gen(function* () {
        return {
          plugins: yield* pluginRows(sql``),
          installations: yield* installationRows(sql``),
        }
      }).pipe(Effect.withSpan("Plugins.list"))

      const plugin = Effect.fn("Plugins.plugin")(function* (id: PluginId) {
        return Option.fromNullishOr((yield* pluginRows(sql`WHERE g.id = ${id}`))[0])
      })

      const installation = Effect.fn("Plugins.installation")(function* (id: InstallationId) {
        return Option.fromNullishOr((yield* installationRows(sql`WHERE i.id = ${id}`))[0])
      })

      const pluginRepos = Effect.fn("Plugins.pluginRepos")(function* (id: PluginId) {
        const rows = yield* sql<{ readonly repo: string }>`
          SELECT repo FROM installation_repos WHERE plugin_id = ${id} ORDER BY repo COLLATE NOCASE
        `
        const repos: Array<RepoName> = []
        for (const row of rows) {
          if (!repos.some((repo) => sameRepo(repo, row.repo))) repos.push(RepoName.make(row.repo))
        }
        return repos
      })

      const record = Effect.fn("Plugins.record")(function* (
        entries: ReadonlyArray<{ readonly repo: string; readonly change: PluginChange }>,
        about: {
          readonly plugin: { readonly id: string; readonly name: string }
          readonly installation: { readonly id: string; readonly name: string }
        },
        by: ParticipantId,
        at: number,
      ) {
        for (const { repo, change } of entries) {
          yield* sql`
            INSERT INTO plugin_log (
              repo, at, by, change, plugin_id, plugin_name, installation_id, installation_name
            ) VALUES (
              ${repo}, ${at}, ${by}, ${change}, ${about.plugin.id}, ${about.plugin.name},
              ${about.installation.id}, ${about.installation.name}
            )
          `
        }
      })

      const createPlugin = Effect.fn("Plugins.createPlugin")(
        function* (input: { readonly name: string; readonly url: string }, by: ParticipantId) {
          yield* checkPlugin(input)
          const name = input.name.trim()
          const slug = pluginSlug(name)
          const taken = new Set(
            (yield* sql<{ readonly id: string }>`
              SELECT id FROM plugins WHERE id = ${HubPluginPrefix + slug}
                OR id LIKE ${`${HubPluginPrefix}${slug}-%`}
            `).map((row) => row.id),
          )
          let id = `${HubPluginPrefix}${slug}`
          for (let n = 2; taken.has(id); n++) id = `${HubPluginPrefix}${slug}-${n}`
          yield* sql`
            INSERT INTO plugins (id, name, url, created_by, created_at)
            VALUES (${id}, ${name}, ${input.url}, ${by}, ${yield* Clock.currentTimeMillis})
          `
          return Option.getOrThrow(yield* plugin(PluginId.make(id)))
        },
        (effect) => sql.withTransaction(effect),
      )

      const editPlugin = Effect.fn("Plugins.editPlugin")(
        function* (
          id: PluginId,
          input: { readonly name: string; readonly url: string },
          by: ParticipantId,
        ) {
          const existing = yield* plugin(id)
          if (Option.isNone(existing)) return yield* refuse("There is no such Plugin.")
          yield* checkPlugin(input)
          const name = input.name.trim()
          if (name === existing.value.name && input.url === existing.value.url) return { repos: [] }
          yield* sql`UPDATE plugins SET name = ${name}, url = ${input.url} WHERE id = ${id}`
          const at = yield* Clock.currentTimeMillis
          const repos: Array<RepoName> = []
          for (const installed of yield* installationRows(sql`WHERE i.plugin_id = ${id}`)) {
            yield* record(
              installed.repos.map((repo) => ({ repo, change: "PluginEdited" as const })),
              { plugin: { id, name }, installation: installed },
              by,
              at,
            )
            repos.push(...installed.repos)
          }
          return { repos }
        },
        (effect) => sql.withTransaction(effect),
      )

      const deletePlugin = Effect.fn("Plugins.deletePlugin")(
        function* (id: PluginId) {
          const existing = yield* plugin(id)
          if (Option.isNone(existing)) return yield* refuse("There is no such Plugin.")
          const rows = yield* sql<{ readonly count: number }>`
            SELECT count(*) AS count FROM installations WHERE plugin_id = ${id}
          `
          const count = rows[0]?.count ?? 0
          if (count > 0) return yield* refuse(pluginInUseRefusal(existing.value.name, count))
          yield* sql`DELETE FROM plugins WHERE id = ${id}`
        },
        (effect) => sql.withTransaction(effect),
      )

      /** Refuses an Installation of the Plugin on a Repo that has another one. */
      const checkOnePerRepo = Effect.fn("Plugins.checkOnePerRepo")(function* (
        target: Plugin,
        repos: ReadonlyArray<RepoName>,
        except: InstallationId | null,
      ) {
        for (const repo of repos) {
          const rows = yield* sql<{ readonly name: string }>`
            SELECT i.name FROM installation_repos r JOIN installations i ON i.id = r.installation_id
            WHERE r.plugin_id = ${target.id} AND r.repo = ${repo} COLLATE NOCASE
              AND r.installation_id IS NOT ${except}
            LIMIT 1
          `
          if (rows[0] !== undefined) {
            return yield* refuse(secondInstallationRefusal(repo, rows[0].name, target.name))
          }
        }
      })

      const createInstallation = Effect.fn("Plugins.createInstallation")(
        function* (
          input: {
            readonly pluginId: PluginId
            readonly name: string
            readonly repos: ReadonlyArray<RepoName>
          },
          by: ParticipantId,
        ) {
          const target = yield* plugin(input.pluginId)
          if (Option.isNone(target)) return yield* refuse("There is no such Plugin.")
          yield* checkInstallation(input)
          yield* checkOnePerRepo(target.value, input.repos, null)
          const id = InstallationId.make(randomId())
          const name = input.name.trim()
          const at = yield* Clock.currentTimeMillis
          yield* sql`
            INSERT INTO installations (id, plugin_id, name, created_by, created_at)
            VALUES (${id}, ${input.pluginId}, ${name}, ${by}, ${at})
          `
          for (const repo of input.repos) {
            yield* sql`
              INSERT INTO installation_repos (installation_id, plugin_id, repo)
              VALUES (${id}, ${input.pluginId}, ${repo})
            `
          }
          yield* record(
            input.repos.map((repo) => ({ repo, change: "Created" as const })),
            { plugin: target.value, installation: { id, name } },
            by,
            at,
          )
          return Option.getOrThrow(yield* installation(id))
        },
        (effect) => sql.withTransaction(effect),
      )

      const editInstallation = Effect.fn("Plugins.editInstallation")(
        function* (
          id: InstallationId,
          input: { readonly name: string; readonly repos: ReadonlyArray<RepoName> },
          by: ParticipantId,
        ) {
          const existing = yield* installation(id)
          if (Option.isNone(existing)) return yield* refuse("There is no such Installation.")
          const before = existing.value
          const target = Option.getOrThrow(yield* plugin(before.pluginId))
          yield* checkInstallation(input)
          const name = input.name.trim()
          const added = missingFrom(before.repos, input.repos)
          const removed = missingFrom(input.repos, before.repos)
          const kept = before.repos.filter((repo) => !removed.includes(repo))
          const renamed = name !== before.name
          yield* checkOnePerRepo(target, added, id)
          const at = yield* Clock.currentTimeMillis
          if (renamed) yield* sql`UPDATE installations SET name = ${name} WHERE id = ${id}`
          for (const repo of removed) {
            yield* sql`
              DELETE FROM installation_repos WHERE installation_id = ${id} AND repo = ${repo}
            `
          }
          for (const repo of added) {
            yield* sql`
              INSERT INTO installation_repos (installation_id, plugin_id, repo)
              VALUES (${id}, ${before.pluginId}, ${repo})
            `
          }
          const about = { plugin: target, installation: { id, name } }
          yield* record(
            [
              ...(renamed ? kept.map((repo) => ({ repo, change: "Renamed" as const })) : []),
              ...added.map((repo) => ({ repo, change: "Added" as const })),
              ...removed.map((repo) => ({ repo, change: "Removed" as const })),
            ],
            about,
            by,
            at,
          )
          return { repos: renamed ? [...before.repos, ...added] : [...added, ...removed] }
        },
        (effect) => sql.withTransaction(effect),
      )

      const deleteInstallation = Effect.fn("Plugins.deleteInstallation")(
        function* (id: InstallationId, by: ParticipantId) {
          const existing = yield* installation(id)
          if (Option.isNone(existing)) return yield* refuse("There is no such Installation.")
          const target = Option.getOrThrow(yield* plugin(existing.value.pluginId))
          yield* sql`DELETE FROM installations WHERE id = ${id}`
          yield* record(
            existing.value.repos.map((repo) => ({ repo, change: "Deleted" as const })),
            { plugin: target, installation: existing.value },
            by,
            yield* Clock.currentTimeMillis,
          )
          return { repos: existing.value.repos }
        },
        (effect) => sql.withTransaction(effect),
      )

      const forSession = Effect.fn("Plugins.forSession")(function* (repo: string) {
        const rows = yield* sql<{
          readonly id: string
          readonly name: string
          readonly pluginId: string
          readonly pluginName: string
        }>`
          SELECT i.id, i.name, g.id AS pluginId, g.name AS pluginName
          FROM installation_repos r JOIN installations i ON i.id = r.installation_id
            JOIN plugins g ON g.id = i.plugin_id
          WHERE r.repo = ${repo} COLLATE NOCASE
          ORDER BY i.created_at, i.id
        `
        const servers = mcpServerNames(rows.map((row) => row.name))
        return rows.map((row, index): SessionInstallation => ({
          id: InstallationId.make(row.id),
          name: row.name,
          pluginId: PluginId.make(row.pluginId),
          pluginName: row.pluginName,
          server: servers[index] ?? "",
        }))
      })

      const gatewayTarget = Effect.fn("Plugins.gatewayTarget")(function* (
        id: InstallationId,
        repo: string,
      ) {
        const rows = yield* sql<{ readonly url: string }>`
          SELECT g.url FROM installation_repos r JOIN plugins g ON g.id = r.plugin_id
          WHERE r.installation_id = ${id} AND r.repo = ${repo} COLLATE NOCASE
          LIMIT 1
        `
        return Option.fromNullishOr(rows[0])
      })

      const log = Effect.fn("Plugins.log")(function* (repo: string) {
        const rows = yield* sql<{
          readonly at: number
          readonly change: string
          readonly pluginId: string
          readonly pluginName: string
          readonly installationId: string
          readonly installationName: string
          readonly byId: string
          readonly byLogin: string
          readonly byName: string
          readonly byAvatarUrl: string | null
        }>`
          SELECT l.at, l.change, l.plugin_id AS pluginId, l.plugin_name AS pluginName,
            l.installation_id AS installationId, l.installation_name AS installationName,
            p.id AS byId, p.login AS byLogin, p.name AS byName, p.avatar_url AS byAvatarUrl
          FROM plugin_log l JOIN participants p ON p.id = l.by
          WHERE l.repo = ${repo} COLLATE NOCASE
          ORDER BY l.at DESC, l.id DESC
          LIMIT ${logLimit}
        `
        return rows.map((row): PluginLogEntry => ({
          at: row.at,
          by: toParticipant(row),
          change: decodeChange(row.change),
          pluginId: PluginId.make(row.pluginId),
          pluginName: row.pluginName,
          installationId: InstallationId.make(row.installationId),
          installationName: row.installationName,
        }))
      })

      return Plugins.of({
        list,
        plugin,
        installation,
        pluginRepos,
        createPlugin,
        editPlugin,
        deletePlugin,
        createInstallation,
        editInstallation,
        deleteInstallation,
        forSession,
        gatewayTarget,
        log,
      })
    }),
  )
}

/** What of an Installation a Session runs with. */
const runsWith = (installation: SessionInstallation) =>
  JSON.stringify([installation.id, installation.name, installation.pluginName, installation.server])

/** Whether two lists of a Session's Installations differ, in what it runs with. */
export const installationsDiffer = (
  a: ReadonlyArray<SessionInstallation>,
  b: ReadonlyArray<SessionInstallation>,
) => {
  const left = a.map(runsWith).toSorted()
  const right = b.map(runsWith).toSorted()
  return left.length !== right.length || left.some((entry, index) => entry !== right[index])
}
