// Plugins on the Hub (#221, ADR 0020): remote MCP servers, the Installations that put them on
// Repos, and each Repo's log of its Plugin changes.
//
// - A Plugin is Hub-only so far: made in the web UI, with the id `hub:<slug>`, which no npm
//   package's name can be. Any Member may create one. One with Installations can't be deleted.
// - An Installation is Repo-scoped so far: on in the Repos it lists. A Repo has at most one
//   Installation of each Plugin, by any spelling of its name (#197): the second is refused,
//   naming the first. Who may create or change one is the relay's to decide (PluginRelay.ts):
//   this store checks only what holds whoever asks.
// - A Plugin may declare header secrets (#215), and each Installation holds a value for each,
//   encrypted with the secrets key (ADR 0009) and bound to its Installation and key. A Session
//   keeps the values its Installations held when it started, which the Gateway uses until its next
//   wake or Restart. A Plugin's URL moved to another origin clears every value its Installations
//   and their Sessions hold, so none goes to a server it wasn't entered for; a header secret
//   removed, or given another key or header, clears theirs for it.
// - Each Repo's log records who created, renamed, added, removed or deleted an Installation on it,
//   edited its Plugin, or set or cleared its values, and when, with the names as they were: a
//   value's header secret by its title, never the value. Nothing here is an Environment version:
//   Sessions pick the change up on their next wake or Restart.

import {
  clearedHeaderSecrets,
  type HeaderSecret,
  type HeaderValueInput,
  type HeaderValueSet,
  headerSecretsOf,
  headerValue,
  headerValueProblem,
  HubPluginPrefix,
  type Installation,
  InstallationId,
  installationReposProblem,
  mcpServerNames,
  type Participant,
  ParticipantId,
  type Plugin,
  PluginAuth,
  type PluginChange,
  PluginChange as PluginChangeSchema,
  PluginId,
  type PluginLogEntry,
  pluginAuthProblem,
  pluginInUseRefusal,
  pluginNameProblem,
  pluginSlug,
  pluginUrlProblem,
  RepoName,
  repoKey,
  type SessionId,
  type SessionInstallation,
  sameRepo,
  secondInstallationRefusal,
  valueNeededRefusal,
} from "@kndl/protocol"
import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import type { Fragment } from "effect/sql/Statement"
import { Secrets, type SecretsUnavailable } from "./Secrets.ts"
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

/**
 * Where the Gateway sends a Session's request through an Installation: the Plugin's URL as it is
 * now, with the headers its header secrets make from the values the Session started with; or why
 * it can't, as it answers the request.
 */
export type GatewayTarget =
  | {
      readonly _tag: "Ready"
      readonly url: string
      readonly headers: ReadonlyArray<{
        readonly header: string
        readonly value: Redacted.Redacted<string>
      }>
    }
  | { readonly _tag: "NeedsValue"; readonly message: string }

/** Refuses a Plugin's name, URL or header secrets that break the rules the web UI shows. */
const checkPlugin = (input: {
  readonly name: string
  readonly url: string
  readonly auth: PluginAuth
}) => {
  const problem =
    pluginNameProblem(input.name) ?? pluginUrlProblem(input.url) ?? pluginAuthProblem(input.auth)
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

/** A value to save, with the header secret it is for. */
interface ValueToSave {
  readonly secret: HeaderSecret
  readonly value: Redacted.Redacted<string>
}

/**
 * The header secrets of the Plugin that `values` set, each with its value, or a refusal of a
 * value that breaks the rules the web UI shows, naming its header secret by title only. One set
 * twice is set to the last.
 */
const checkValues = (target: Plugin, values: ReadonlyArray<HeaderValueInput>) => {
  const declared = headerSecretsOf(target.auth)
  const set = new Map<string, ValueToSave>()
  for (const input of values) {
    const secret = declared.find((one) => one.key === input.key)
    if (secret === undefined) return refuse(`${target.name} has no header secret ${input.key}.`)
    const problem = headerValueProblem(secret.title, Redacted.value(input.value))
    if (problem !== undefined) return refuse(problem)
    set.set(secret.key, { secret, value: input.value })
  }
  return Effect.succeed([...set.values()])
}

/** A Plugin's auth as it is kept: titles trimmed. */
const normalizedAuth = (auth: PluginAuth): PluginAuth =>
  auth._tag === "None"
    ? auth
    : {
        _tag: "Headers",
        headers: auth.headers.map((secret) => ({ ...secret, title: secret.title.trim() })),
      }

/** What an Installation's value of a header secret is bound to, encrypted. */
const valueContext = (installation: string, key: string) =>
  `installation-value:${installation}:${key}`

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
const AuthJson = Schema.fromJsonString(PluginAuth)
const encodeAuth = Schema.encodeSync(AuthJson)
const decodeAuth = Schema.decodeUnknownOption(AuthJson)
const TitlesJson = Schema.fromJsonString(Schema.Array(Schema.String))
const encodeTitles = Schema.encodeSync(TitlesJson)
const decodeTitles = Schema.decodeUnknownOption(TitlesJson)

/** A stored auth; none should it not decode, when the Gateway adds no header. */
const authOf = (stored: string): PluginAuth =>
  Option.getOrElse(decodeAuth(stored), (): PluginAuth => ({ _tag: "None" }))

/** The Repos of `after` not in `before`, by any spelling. */
const missingFrom = (before: ReadonlyArray<string>, after: ReadonlyArray<RepoName>) =>
  after.filter((repo) => !before.some((other) => sameRepo(other, repo)))

/** A log entry to record: a change on a Repo, with the titles of the values it set or cleared. */
interface Entry {
  readonly repo: string
  readonly change: PluginChange
  readonly secrets?: ReadonlyArray<string>
}

/** The entries for each Repo, with one more for the values set or cleared, if any were. */
const withValues = (
  repos: ReadonlyArray<string>,
  change: PluginChange,
  values: { readonly change: PluginChange; readonly secrets: ReadonlyArray<string> },
): Array<Entry> =>
  repos.flatMap((repo) => [
    { repo, change },
    ...(values.secrets.length > 0 ? [{ repo, ...values }] : []),
  ])

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
      input: { readonly name: string; readonly url: string; readonly auth: PluginAuth },
      by: ParticipantId,
    ) => Effect.Effect<Plugin, PluginRefused | SqlError>
    /**
     * Changes a Plugin, clearing the values the change leaves no use for, on its Installations and
     * their Sessions: {@link clearedHeaderSecrets}.
     */
    readonly editPlugin: (
      id: PluginId,
      input: { readonly name: string; readonly url: string; readonly auth: PluginAuth },
      by: ParticipantId,
    ) => Effect.Effect<PluginsChanged, PluginRefused | SqlError>
    readonly deletePlugin: (id: PluginId) => Effect.Effect<void, PluginRefused | SqlError>
    /**
     * Creates an Installation on the Repos listed, which the caller spelled as the Hub keeps them,
     * with the values given for its Plugin's header secrets.
     */
    readonly createInstallation: (
      input: {
        readonly pluginId: PluginId
        readonly name: string
        readonly repos: ReadonlyArray<RepoName>
        readonly values?: ReadonlyArray<HeaderValueInput>
      },
      by: ParticipantId,
    ) => Effect.Effect<StoredInstallation & PluginsChanged, PluginRefused | SqlError>
    /**
     * Renames an Installation, sets its whole list of Repos, and sets the values given for its
     * Plugin's header secrets, keeping the others.
     */
    readonly editInstallation: (
      id: InstallationId,
      input: {
        readonly name: string
        readonly repos: ReadonlyArray<RepoName>
        readonly values?: ReadonlyArray<HeaderValueInput>
      },
      by: ParticipantId,
    ) => Effect.Effect<PluginsChanged, PluginRefused | SqlError>
    readonly deleteInstallation: (
      id: InstallationId,
      by: ParticipantId,
    ) => Effect.Effect<PluginsChanged, PluginRefused | SqlError>
    /**
     * The Installations on for the Repo, by any spelling, oldest first, as the Session starting
     * now runs with them: each with its MCP server's name, unique among them. The values they hold
     * now become the Session's, which the Gateway uses until it starts again.
     */
    readonly forSession: (
      sessionId: SessionId,
      repo: string,
    ) => Effect.Effect<Array<SessionInstallation>, SqlError>
    /**
     * Where the Gateway sends the Session's request through the Installation, if it is on for the
     * Session's Repo: see {@link GatewayTarget}.
     */
    readonly gatewayTarget: (
      id: InstallationId,
      session: { readonly id: SessionId; readonly repo: string },
    ) => Effect.Effect<Option.Option<GatewayTarget>, SecretsUnavailable | SqlError>
    /**
     * Every value of a header secret the Repo's Sessions may meet, to redact from what they
     * print: those of the Installations on for it, by any spelling, and those its Sessions
     * started with.
     */
    readonly valuesOn: (
      repo: string,
    ) => Effect.Effect<ReadonlyArray<Redacted.Redacted<string>>, SecretsUnavailable | SqlError>
    /** The Repo's Plugin change log, newest first, by any spelling of its name. */
    readonly log: (repo: string) => Effect.Effect<ReadonlyArray<PluginLogEntry>, SqlError>
  }
>()("@kndl/hub/Plugins") {
  static readonly layer = Layer.effect(
    Plugins,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const secrets = yield* Secrets

      const pluginRows = (where: Fragment) =>
        sql<{
          readonly id: string
          readonly name: string
          readonly url: string
          readonly auth: string
          readonly createdAt: number
          readonly byId: string
          readonly byLogin: string
          readonly byName: string
          readonly byAvatarUrl: string | null
        }>`
          SELECT g.id, g.name, g.url, g.auth, g.created_at AS createdAt, p.id AS byId,
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
              auth: authOf(row.auth),
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
        const ids = rows.map((row) => row.id)
        const repos = yield* sql<{ readonly installationId: string; readonly repo: string }>`
          SELECT installation_id AS installationId, repo FROM installation_repos
          WHERE installation_id IN ${sql.in(ids)}
          ORDER BY repo COLLATE NOCASE
        `
        // Which values are set, by whom and when: never the values.
        const values = yield* sql<{
          readonly installationId: string
          readonly key: string
          readonly setAt: number
          readonly byId: string
          readonly byLogin: string
          readonly byName: string
          readonly byAvatarUrl: string | null
        }>`
          SELECT v.installation_id AS installationId, v.key, v.set_at AS setAt, p.id AS byId,
            p.login AS byLogin, p.name AS byName, p.avatar_url AS byAvatarUrl
          FROM installation_values v JOIN participants p ON p.id = v.set_by
          WHERE v.installation_id IN ${sql.in(ids)}
          ORDER BY v.key
        `
        return rows.map((row): StoredInstallation => ({
          id: InstallationId.make(row.id),
          pluginId: PluginId.make(row.pluginId),
          name: row.name,
          repos: repos
            .filter((repo) => repo.installationId === row.id)
            .map((repo) => RepoName.make(repo.repo)),
          values: values
            .filter((value) => value.installationId === row.id)
            .map((value): HeaderValueSet => ({
              key: value.key,
              setBy: toParticipant(value),
              setAt: value.setAt,
            })),
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
        entries: ReadonlyArray<Entry>,
        about: {
          readonly plugin: { readonly id: string; readonly name: string }
          readonly installation: { readonly id: string; readonly name: string }
        },
        by: ParticipantId,
        at: number,
      ) {
        for (const { repo, change, secrets: titles } of entries) {
          yield* sql`
            INSERT INTO plugin_log (
              repo, at, by, change, plugin_id, plugin_name, installation_id, installation_name,
              secrets
            ) VALUES (
              ${repo}, ${at}, ${by}, ${change}, ${about.plugin.id}, ${about.plugin.name},
              ${about.installation.id}, ${about.installation.name},
              ${titles === undefined ? null : encodeTitles(titles)}
            )
          `
        }
      })

      /** Saves the values for the Installation, encrypted, over any it held for the same keys. */
      const saveValues = Effect.fn("Plugins.saveValues")(function* (
        id: InstallationId,
        values: ReadonlyArray<ValueToSave>,
        by: ParticipantId,
        at: number,
      ) {
        for (const { secret, value } of values) {
          const stored = yield* secrets
            .encrypt(value, valueContext(id, secret.key))
            .pipe(Effect.mapError((error) => new PluginRefused({ message: error.message })))
          yield* sql`
            INSERT INTO installation_values (installation_id, key, value, set_by, set_at)
            VALUES (${id}, ${secret.key}, ${stored}, ${by}, ${at})
            ON CONFLICT (installation_id, key) DO UPDATE SET
              value = excluded.value, set_by = excluded.set_by, set_at = excluded.set_at
          `
        }
      })

      const createPlugin = Effect.fn("Plugins.createPlugin")(
        function* (
          input: { readonly name: string; readonly url: string; readonly auth: PluginAuth },
          by: ParticipantId,
        ) {
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
          const auth = encodeAuth(normalizedAuth(input.auth))
          yield* sql`
            INSERT INTO plugins (id, name, url, auth, created_by, created_at)
            VALUES (${id}, ${name}, ${input.url}, ${auth}, ${by}, ${yield* Clock.currentTimeMillis})
          `
          return Option.getOrThrow(yield* plugin(PluginId.make(id)))
        },
        (effect) => sql.withTransaction(effect),
      )

      const editPlugin = Effect.fn("Plugins.editPlugin")(
        function* (
          id: PluginId,
          input: { readonly name: string; readonly url: string; readonly auth: PluginAuth },
          by: ParticipantId,
        ) {
          const existing = yield* plugin(id)
          if (Option.isNone(existing)) return yield* refuse("There is no such Plugin.")
          yield* checkPlugin(input)
          const name = input.name.trim()
          const auth = encodeAuth(normalizedAuth(input.auth))
          if (
            name === existing.value.name &&
            input.url === existing.value.url &&
            auth === encodeAuth(existing.value.auth)
          ) {
            return { repos: [] }
          }
          const cleared = clearedHeaderSecrets(existing.value, input)
          const installed = yield* installationRows(sql`WHERE i.plugin_id = ${id}`)
          yield* sql`
            UPDATE plugins SET name = ${name}, url = ${input.url}, auth = ${auth} WHERE id = ${id}
          `
          if (cleared.length > 0) {
            const keys = cleared.map((secret) => secret.key)
            const ofPlugin = sql`
              installation_id IN (SELECT id FROM installations WHERE plugin_id = ${id})
                AND key IN ${sql.in(keys)}
            `
            yield* sql`DELETE FROM installation_values WHERE ${ofPlugin}`
            yield* sql`DELETE FROM session_installation_values WHERE ${ofPlugin}`
          }
          const at = yield* Clock.currentTimeMillis
          const repos: Array<RepoName> = []
          for (const one of installed) {
            const lost = cleared
              .filter((secret) => one.values.some((value) => value.key === secret.key))
              .map((secret) => secret.title)
            yield* record(
              withValues(one.repos, "PluginEdited", { change: "ValuesCleared", secrets: lost }),
              { plugin: { id, name }, installation: one },
              by,
              at,
            )
            repos.push(...one.repos)
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
            readonly values?: ReadonlyArray<HeaderValueInput>
          },
          by: ParticipantId,
        ) {
          const target = yield* plugin(input.pluginId)
          if (Option.isNone(target)) return yield* refuse("There is no such Plugin.")
          yield* checkInstallation(input)
          const values = yield* checkValues(target.value, input.values ?? [])
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
          yield* saveValues(id, values, by, at)
          yield* record(
            withValues(input.repos, "Created", {
              change: "ValuesSet",
              secrets: values.map(({ secret }) => secret.title),
            }),
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
          input: {
            readonly name: string
            readonly repos: ReadonlyArray<RepoName>
            readonly values?: ReadonlyArray<HeaderValueInput>
          },
          by: ParticipantId,
        ) {
          const existing = yield* installation(id)
          if (Option.isNone(existing)) return yield* refuse("There is no such Installation.")
          const before = existing.value
          const target = Option.getOrThrow(yield* plugin(before.pluginId))
          yield* checkInstallation(input)
          const values = yield* checkValues(target, input.values ?? [])
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
          yield* saveValues(id, values, by, at)
          const titles = values.map(({ secret }) => secret.title)
          yield* record(
            [
              ...(renamed ? kept.map((repo) => ({ repo, change: "Renamed" as const })) : []),
              ...added.map((repo) => ({ repo, change: "Added" as const })),
              ...removed.map((repo) => ({ repo, change: "Removed" as const })),
              // A Repo it was added to has its values from the start: Added says so.
              ...(titles.length > 0
                ? kept.map((repo) => ({ repo, change: "ValuesSet" as const, secrets: titles }))
                : []),
            ],
            { plugin: target, installation: { id, name } },
            by,
            at,
          )
          return {
            repos:
              renamed || titles.length > 0 ? [...before.repos, ...added] : [...added, ...removed],
          }
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

      const forSession = Effect.fn("Plugins.forSession")(
        function* (sessionId: SessionId, repo: string) {
          const installations = (yield* installationsOn(sql, [repo])).get(repoKey(repo)) ?? []
          yield* sql`DELETE FROM session_installation_values WHERE session_id = ${sessionId}`
          if (installations.length > 0) {
            yield* sql`
              INSERT INTO session_installation_values (
                session_id, installation_id, key, value, set_at
              )
              SELECT ${sessionId}, installation_id, key, value, set_at FROM installation_values
              WHERE installation_id IN ${sql.in(installations.map((one) => one.id))}
            `
          }
          return installations
        },
        (effect) => sql.withTransaction(effect),
      )

      const gatewayTarget = Effect.fn("Plugins.gatewayTarget")(function* (
        id: InstallationId,
        session: { readonly id: SessionId; readonly repo: string },
      ) {
        const rows = yield* sql<{
          readonly url: string
          readonly auth: string
          readonly name: string
        }>`
          SELECT g.url, g.auth, i.name FROM installation_repos r
            JOIN plugins g ON g.id = r.plugin_id JOIN installations i ON i.id = r.installation_id
          WHERE r.installation_id = ${id} AND r.repo = ${session.repo} COLLATE NOCASE
          LIMIT 1
        `
        const row = rows[0]
        if (row === undefined) return Option.none<GatewayTarget>()
        const declared = headerSecretsOf(authOf(row.auth))
        const held =
          declared.length === 0
            ? []
            : yield* sql<{ readonly key: string; readonly value: string }>`
                SELECT key, value FROM session_installation_values
                WHERE session_id = ${session.id} AND installation_id = ${id}
              `
        const headers: Array<{ header: string; value: Redacted.Redacted<string> }> = []
        for (const secret of declared) {
          const stored = held.find((one) => one.key === secret.key)
          if (stored === undefined) {
            return Option.some<GatewayTarget>({
              _tag: "NeedsValue",
              message: valueNeededRefusal(row.name, secret.title),
            })
          }
          const value = yield* secrets.decrypt(stored.value, valueContext(id, secret.key))
          headers.push({
            header: secret.header,
            value: Redacted.make(headerValue(secret, Redacted.value(value))),
          })
        }
        return Option.some<GatewayTarget>({ _tag: "Ready", url: row.url, headers })
      })

      const valuesOn = Effect.fn("Plugins.valuesOn")(function* (repo: string) {
        const rows = yield* sql<{
          readonly installationId: string
          readonly key: string
          readonly value: string
        }>`
          SELECT v.installation_id AS installationId, v.key, v.value
          FROM installation_values v
            JOIN installation_repos r ON r.installation_id = v.installation_id
          WHERE r.repo = ${repo} COLLATE NOCASE
          UNION
          SELECT v.installation_id AS installationId, v.key, v.value
          FROM session_installation_values v JOIN sessions s ON s.id = v.session_id
          WHERE s.repo = ${repo} COLLATE NOCASE
        `
        return yield* Effect.forEach(rows, (row) =>
          secrets.decrypt(row.value, valueContext(row.installationId, row.key)),
        )
      })

      const log = Effect.fn("Plugins.log")(function* (repo: string) {
        const rows = yield* sql<{
          readonly at: number
          readonly change: string
          readonly pluginId: string
          readonly pluginName: string
          readonly installationId: string
          readonly installationName: string
          readonly secrets: string | null
          readonly byId: string
          readonly byLogin: string
          readonly byName: string
          readonly byAvatarUrl: string | null
        }>`
          SELECT l.at, l.change, l.plugin_id AS pluginId, l.plugin_name AS pluginName,
            l.installation_id AS installationId, l.installation_name AS installationName,
            l.secrets, p.id AS byId, p.login AS byLogin, p.name AS byName,
            p.avatar_url AS byAvatarUrl
          FROM plugin_log l JOIN participants p ON p.id = l.by
          WHERE l.repo = ${repo} COLLATE NOCASE
          ORDER BY l.at DESC, l.id DESC
          LIMIT ${logLimit}
        `
        return rows.map((row): PluginLogEntry => {
          const titles = row.secrets === null ? Option.none() : decodeTitles(row.secrets)
          return {
            at: row.at,
            by: toParticipant(row),
            change: decodeChange(row.change),
            pluginId: PluginId.make(row.pluginId),
            pluginName: row.pluginName,
            installationId: InstallationId.make(row.installationId),
            installationName: row.installationName,
            ...(Option.isSome(titles) && { secrets: titles.value }),
          }
        })
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
        valuesOn,
        log,
      })
    }),
  )
}

/**
 * The Installations on for each of the Repos, by any spelling, as a Session starting now runs
 * with them: by {@link repoKey}, oldest first, each with its MCP server's name, unique in its Repo,
 * and when each value it holds was set.
 */
export const installationsOn = Effect.fn("Plugins.installationsOn")(function* (
  sql: SqlClient.SqlClient,
  repos: ReadonlyArray<string>,
) {
  const byRepo = new Map<string, Array<SessionInstallation>>()
  if (repos.length === 0) return byRepo
  const rows = yield* sql<{
    readonly repo: string
    readonly id: string
    readonly name: string
    readonly pluginId: string
    readonly pluginName: string
  }>`
    SELECT r.repo, i.id, i.name, g.id AS pluginId, g.name AS pluginName
    FROM installation_repos r JOIN installations i ON i.id = r.installation_id
      JOIN plugins g ON g.id = i.plugin_id
    WHERE r.repo COLLATE NOCASE IN ${sql.in(repos)}
    ORDER BY i.created_at, i.id
  `
  const values =
    rows.length === 0
      ? []
      : yield* sql<{
          readonly installationId: string
          readonly key: string
          readonly setAt: number
        }>`
          SELECT installation_id AS installationId, key, set_at AS setAt FROM installation_values
          WHERE installation_id IN ${sql.in([...new Set(rows.map((row) => row.id))])}
          ORDER BY key
        `
  for (const row of rows) {
    const installations = byRepo.get(repoKey(row.repo)) ?? []
    const held = values
      .filter((value) => value.installationId === row.id)
      .map((value) => ({ key: value.key, setAt: value.setAt }))
    installations.push({
      id: InstallationId.make(row.id),
      name: row.name,
      pluginId: PluginId.make(row.pluginId),
      pluginName: row.pluginName,
      server: "",
      ...(held.length > 0 && { values: held }),
    })
    byRepo.set(repoKey(row.repo), installations)
  }
  for (const [key, installations] of byRepo) {
    const servers = mcpServerNames(installations.map((installation) => installation.name))
    byRepo.set(
      key,
      installations.map((installation, index) => ({
        ...installation,
        server: servers[index] ?? "",
      })),
    )
  }
  return byRepo
})

/** What of an Installation a Session runs with: its names, and when its values were set. */
const runsWith = (installation: SessionInstallation) =>
  JSON.stringify([
    installation.id,
    installation.name,
    installation.pluginName,
    installation.server,
    (installation.values ?? []).map((value) => [value.key, value.setAt]),
  ])

/** Whether two lists of a Session's Installations differ, in what it runs with. */
export const installationsDiffer = (
  a: ReadonlyArray<SessionInstallation>,
  b: ReadonlyArray<SessionInstallation>,
) => {
  const left = a.map(runsWith).toSorted()
  const right = b.map(runsWith).toSorted()
  return left.length !== right.length || left.some((entry, index) => entry !== right[index])
}
