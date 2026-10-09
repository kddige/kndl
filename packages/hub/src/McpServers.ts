// MCP servers on the Hub (#221, ADR 0020): the remote servers, the Installations that put them on
// Repos, and each Repo's log of its MCP server changes.
//
// - An MCP server is Hub-only, made in the web UI, with the id `hub:<slug>`, which no npm package's
//   name can be; or packaged (#220), read from git or an upload, with its `package.json` name for
//   its id. Any Member may add either. One with Installations can't be deleted.
// - A packaged MCP server is pinned to its version, and its commit from git: only an Upgrade, to a
//   package read again from the same source, changes it. Each Repo with an Installation of it logs
//   the Upgrade, with the version.
// - A Repo-scoped Installation is on in the Repos it lists. A Repo has at most one Repo-scoped
//   Installation of each MCP server, by any spelling of its name (#197): the second is refused,
//   naming the first. Who may create or change one is the relay's to decide (McpServerRelay.ts), by
//   access to its Repos.
// - A global Installation (#219) lists no Repo: it is on in every one, existing and new, unless a
//   Repo-scoped Installation of its MCP server lists the Repo, which takes its place, or the Repo
//   turned it off. An MCP server has at most one. Only the Owner may create, edit or delete one, or
//   edit, upgrade or delete its MCP server: every Sandbox on the Hub can use it. This store checks
//   that itself, in the same transaction as the change. Anyone with access to a Repo may turn a
//   global Installation off for it, and back on.
// - An MCP server may declare header secrets (#215), and each Installation holds a value for each,
//   encrypted with the secrets key (ADR 0009) and bound to its Installation and key. A Session
//   keeps the values its Installations held when it started, which the Gateway uses until its next
//   wake or Restart. An MCP server's URL moved to another origin clears every value its
//   Installations and their Sessions hold, so none goes to a server it wasn't entered for; a header
//   secret removed, or given another key or header, clears theirs for it.
// - An MCP server may use OAuth instead (#217): each Installation is connected to an account, whose
//   tokens McpServerOAuth.ts keeps and refreshes, and the Gateway sends live, not as a Session
//   started with them. An MCP server's URL moved to another origin, or no longer using OAuth,
//   disconnects its Installations, and forgets their clients too, the Hub registered or entered by
//   hand (#218).
// - Each Repo's log records who created, renamed, added, removed or deleted an Installation on it,
//   edited its MCP server, set or cleared its values, set its OAuth client, or connected or
//   disconnected it, and when, with the names as they were: a value's header secret by its title,
//   never the value, nor a client's secret. Nothing here is an Environment version:
//   Sessions pick the change up on their next wake or Restart.
// - A change to a global Installation, or to its MCP server, affects every Repo, and the Hub knows
//   no list of them: a Repo is seen first when someone uses it. So it is logged once, under the
//   Repo `*`, and every Repo's log reads those entries beside its own, a Repo seen later too.
//   Turning one off or on is logged on that Repo alone.

import {
  clearedHeaderSecrets,
  clearsConnections,
  type InstallationClient,
  type InstallationConnection,
  type HeaderSecret,
  type HeaderValueInput,
  type HeaderValueSet,
  headerSecretsOf,
  headerValue,
  headerValueProblem,
  globalConnectRefusal,
  globalOwnerOnlyRefusal,
  globalMcpServerRefusal,
  globalReposRefusal,
  HubMcpServerPrefix,
  type Installation,
  InstallationId,
  installationReposProblem,
  installationsFor,
  isOn,
  mcpServerNames,
  notGlobalRefusal,
  type PackagedMcpServer,
  type Participant,
  ParticipantId,
  type McpServer,
  McpServerAuth,
  type McpServerChange,
  McpServerChange as McpServerChangeSchema,
  McpServerId,
  type McpServerLogEntry,
  mcpServerAuthProblem,
  McpServerPackage,
  packageVersion,
  mcpServerInUseRefusal,
  mcpServerNameProblem,
  mcpServerSlug,
  mcpServerUrlProblem,
  RepoName,
  repoKey,
  type SessionId,
  type SessionInstallation,
  sameRepo,
  secondGlobalRefusal,
  secondInstallationRefusal,
  valueNeededRefusal,
} from "@kndl/protocol"
import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import type { Fragment } from "effect/sql/Statement"
import { type Icon, iconHash } from "./McpServerIcons.ts"
import {
  connectionBasis,
  type Granted,
  type PendingConnection,
  McpServerOAuth,
} from "./McpServerOAuth.ts"
import { Secrets, type SecretsUnavailable } from "./Secrets.ts"
import { randomId } from "./Tokens.ts"

/** The Hub refused a change to an MCP server or Installation, saying why. */
// oxlint-disable-next-line unicorn/throw-new-error -- Effect makes error classes with a factory call
export class McpServerRefused extends Schema.TaggedError<McpServerRefused>()("McpServerRefused", {
  message: Schema.String,
}) {}

const refuse = (message: string) => Effect.fail(new McpServerRefused({ message }))

/** An Installation as the Hub keeps it: with every Repo it lists. */
export type StoredInstallation = Omit<Installation, "otherRepos">

/** What a change did, for the relay to tell the web and the affected Sessions. */
export interface McpServersChanged {
  /** Every Repo whose Installations or their MCP servers changed. */
  readonly repos: ReadonlyArray<RepoName>
  /** Whether every Repo's did, by a change to a global Installation or its MCP server (#219). */
  readonly everyRepo?: boolean
}

/** The Repo a change to every Repo is logged under, once (#219): no Repo's name can be it. */
const everyRepo = "*"

/**
 * Where the Gateway sends a Session's request through an Installation: the MCP server's URL as it
 * is now, with the headers its header secrets make from the values the Session started with, or
 * with its OAuth token as it is now; or why it can't, as it answers the request.
 */
export type GatewayTarget =
  | {
      readonly _tag: "Ready"
      readonly url: string
      readonly headers: ReadonlyArray<{
        readonly header: string
        readonly value: Redacted.Redacted<string>
      }>
      /** For an OAuth Installation (#217): which of its tokens is sent, to say if it's refused. */
      readonly oauth?: { readonly generation: number }
    }
  | {
      readonly _tag: "NeedsValue"
      readonly message: string
      /** The titles of the header secrets without a value (#216). */
      readonly secrets: ReadonlyArray<string>
    }
  /** An OAuth Installation that isn't connected, or whose connection was lost (#217). */
  | { readonly _tag: "NotConnected"; readonly message: string }
  /** An OAuth Installation whose token expired, and couldn't be refreshed just now. */
  | { readonly _tag: "Unavailable"; readonly message: string }

/** What the Gateway answers a request through an OAuth Installation that isn't connected. */
export const notConnectedRefusal = (installation: string) =>
  `${installation} isn't connected to its account: reconnect it on the MCP page.`

/** Refuses an MCP server's name, URL or header secrets that break the rules the web UI shows. */
const checkMcpServer = (input: {
  readonly name: string
  readonly url: string
  readonly auth: McpServerAuth
}) => {
  const problem =
    mcpServerNameProblem(input.name) ??
    mcpServerUrlProblem(input.url) ??
    mcpServerAuthProblem(input.auth)
  return problem === undefined ? Effect.void : refuse(problem)
}

/** Refuses an Installation's name or Repos that break the rules the web UI shows. */
const checkInstallation = (input: {
  readonly name: string
  readonly global?: boolean
  readonly repos: ReadonlyArray<RepoName>
}) => {
  const problem =
    mcpServerNameProblem(input.name, "An Installation") ??
    (input.global === true
      ? input.repos.length > 0
        ? globalReposRefusal
        : undefined
      : installationReposProblem(input.repos))
  return problem === undefined ? Effect.void : refuse(problem)
}

/** The Repos to log a change to the Installation on: every one, once, for a global one. */
const logRepos = (installation: {
  readonly global?: boolean
  readonly repos: ReadonlyArray<string>
}) => (installation.global === true ? [everyRepo] : installation.repos)

/** A value to save, with the header secret it is for. */
interface ValueToSave {
  readonly secret: HeaderSecret
  readonly value: Redacted.Redacted<string>
}

/**
 * The header secrets of the MCP server that `values` set, each with its value, or a refusal of a
 * value that breaks the rules the web UI shows, naming its header secret by title only. One set
 * twice is set to the last.
 */
const checkValues = (target: McpServer, values: ReadonlyArray<HeaderValueInput>) => {
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

/**
 * An MCP server's auth as it is kept: titles trimmed; OAuth's scopes listed only if there are any.
 */
const normalizedAuth = (auth: McpServerAuth): McpServerAuth => {
  switch (auth._tag) {
    case "None":
      return auth
    case "OAuth":
      return auth.scopes === undefined || auth.scopes.length === 0
        ? { _tag: "OAuth" }
        : { _tag: "OAuth", scopes: auth.scopes }
    case "Headers":
      return {
        _tag: "Headers",
        headers: auth.headers.map((secret) => ({ ...secret, title: secret.title.trim() })),
      }
  }
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

const decodeChange = Schema.decodeUnknownSync(McpServerChangeSchema)
const AuthJson = Schema.fromJsonString(McpServerAuth)
const encodeAuth = Schema.encodeSync(AuthJson)
const decodeAuth = Schema.decodeUnknownOption(AuthJson)
const TitlesJson = Schema.fromJsonString(Schema.Array(Schema.String))
const encodeTitles = Schema.encodeSync(TitlesJson)
const decodeTitles = Schema.decodeUnknownOption(TitlesJson)

/** A stored auth; none should it not decode, when the Gateway adds no header. */
const authOf = (stored: string): McpServerAuth =>
  Option.getOrElse(decodeAuth(stored), (): McpServerAuth => ({ _tag: "None" }))

const PackageJson = Schema.fromJsonString(McpServerPackage)
const decodePackage = Schema.decodeUnknownSync(PackageJson)
const encodePackage = Schema.encodeSync(PackageJson)

/** Why a packaged MCP server's edit is refused: it changes only by an Upgrade. */
export const packagedMcpServerRefusal = (mcpServer: string) =>
  `${mcpServer} is a packaged MCP server, pinned to its version: upgrade it to change it.`

/** Why adding a package whose name an MCP server on the Hub has is refused. */
export const mcpServerTakenRefusal = (id: string) =>
  `An MCP server named ${id} is already on the Hub, from another source: only a package from the same source can upgrade it.`

/** The Repos of `after` not in `before`, by any spelling. */
const missingFrom = (before: ReadonlyArray<string>, after: ReadonlyArray<RepoName>) =>
  after.filter((repo) => !before.some((other) => sameRepo(other, repo)))

/** A log entry to record: a change on a Repo, with the titles of the values it set or cleared. */
interface Entry {
  readonly repo: string
  readonly change: McpServerChange
  readonly secrets?: ReadonlyArray<string>
}

/** The entries for each Repo, with one more for the values set or cleared, if any were. */
const withValues = (
  repos: ReadonlyArray<string>,
  change: McpServerChange,
  values: { readonly change: McpServerChange; readonly secrets: ReadonlyArray<string> },
): Array<Entry> =>
  repos.flatMap((repo) => [
    { repo, change },
    ...(values.secrets.length > 0 ? [{ repo, ...values }] : []),
  ])

export class McpServers extends Context.Service<
  McpServers,
  {
    /** Every MCP server and Installation, oldest first. */
    readonly list: Effect.Effect<
      {
        readonly mcpServers: ReadonlyArray<McpServer>
        readonly installations: ReadonlyArray<StoredInstallation>
      },
      SqlError
    >
    readonly mcpServer: (id: McpServerId) => Effect.Effect<Option.Option<McpServer>, SqlError>
    /** The MCP server's icon, if it has one (#230). */
    readonly icon: (id: McpServerId) => Effect.Effect<Option.Option<Icon>, SqlError>
    /**
     * Keeps the icon found for the MCP server, or clears it when `icon` is none; false, changing
     * nothing, if the MCP server is gone or its URL is no longer `forUrl`, which the search was
     * for.
     */
    readonly setIcon: (
      id: McpServerId,
      forUrl: string,
      icon: Icon | undefined,
    ) => Effect.Effect<boolean, SqlError>
    readonly installation: (
      id: InstallationId,
    ) => Effect.Effect<Option.Option<StoredInstallation>, SqlError>
    /** The Repos the MCP server's Installations list, each once. */
    readonly mcpServerRepos: (id: McpServerId) => Effect.Effect<ReadonlyArray<RepoName>, SqlError>
    readonly createMcpServer: (
      input: { readonly name: string; readonly url: string; readonly auth: McpServerAuth },
      by: ParticipantId,
    ) => Effect.Effect<McpServer, McpServerRefused | SqlError>
    /**
     * Changes an MCP server, clearing the values the change leaves no use for, on its Installations
     * and their Sessions: {@link clearedHeaderSecrets}.
     */
    readonly editMcpServer: (
      id: McpServerId,
      input: { readonly name: string; readonly url: string; readonly auth: McpServerAuth },
      by: ParticipantId,
    ) => Effect.Effect<McpServersChanged, McpServerRefused | SqlError>
    /**
     * Deletes an MCP server with no Installations; refused first if one is global and `by` isn't
     * the Owner.
     */
    readonly deleteMcpServer: (
      id: McpServerId,
      by: ParticipantId,
    ) => Effect.Effect<void, McpServerRefused | SqlError>
    /** Adds a packaged MCP server as the Hub read it; refused if an MCP server has its name. */
    readonly addPackage: (
      read: PackagedMcpServer,
      by: ParticipantId,
    ) => Effect.Effect<McpServer, McpServerRefused | SqlError>
    /**
     * Upgrades a packaged MCP server to a package read again from its source, logging the Upgrade
     * on every Repo its Installations list, and clearing values as {@link editMcpServer} does.
     * Whether the package is from the same source is the relay's to check.
     */
    readonly upgradeMcpServer: (
      read: PackagedMcpServer,
      by: ParticipantId,
    ) => Effect.Effect<McpServersChanged, McpServerRefused | SqlError>
    /**
     * Creates an Installation on the Repos listed, which the caller spelled as the Hub keeps them,
     * or a global one, listing none, with the values given for its MCP server's header secrets.
     */
    readonly createInstallation: (
      input: {
        readonly mcpServerId: McpServerId
        readonly name: string
        readonly global?: boolean
        readonly repos: ReadonlyArray<RepoName>
        readonly values?: ReadonlyArray<HeaderValueInput>
      },
      by: ParticipantId,
    ) => Effect.Effect<StoredInstallation & McpServersChanged, McpServerRefused | SqlError>
    /**
     * Renames an Installation, sets whether it is global and its whole list of Repos, and sets the
     * values given for its MCP server's header secrets, keeping the others.
     */
    readonly editInstallation: (
      id: InstallationId,
      input: {
        readonly name: string
        readonly global?: boolean
        readonly repos: ReadonlyArray<RepoName>
        readonly values?: ReadonlyArray<HeaderValueInput>
      },
      by: ParticipantId,
    ) => Effect.Effect<McpServersChanged, McpServerRefused | SqlError>
    readonly deleteInstallation: (
      id: InstallationId,
      by: ParticipantId,
    ) => Effect.Effect<McpServersChanged, McpServerRefused | SqlError>
    /**
     * Turns a global Installation off for the Repo, by any spelling, or back on (#219); nothing if
     * it already is.
     */
    readonly turnGlobalInstallation: (
      id: InstallationId,
      repo: RepoName,
      on: boolean,
      by: ParticipantId,
    ) => Effect.Effect<McpServersChanged, McpServerRefused | SqlError>
    /**
     * Keeps the tokens a connection of an OAuth Installation was granted (#217), logging Connected,
     * or Reconnected if it had a connection, on each Repo it lists, or once for every Repo, for a
     * global one; and ClientSet before it, if it was made with a client entered that the
     * Installation didn't have (#218). Refused if the Installation lists another Repo than the
     * connection began with, became global or Repo-scoped since, or its MCP server's URL or auth
     * changed since.
     */
    readonly connectInstallation: (
      pending: PendingConnection,
      granted: Granted,
      by: ParticipantId,
    ) => Effect.Effect<McpServersChanged, McpServerRefused | SqlError>
    /**
     * Refuses connecting or disconnecting a global OAuth Installation, unless by the Owner (#217,
     * #219): every Session on the Hub acts as its account. A Repo-scoped one's Repos are its gate.
     */
    readonly checkConnector: (
      installation: StoredInstallation,
      by: ParticipantId,
    ) => Effect.Effect<void, McpServerRefused | SqlError>
    /**
     * Forgets an OAuth Installation's tokens, logging Disconnected on each Repo it lists, or once
     * for every Repo, for a global one.
     */
    readonly disconnectInstallation: (
      id: InstallationId,
      by: ParticipantId,
    ) => Effect.Effect<McpServersChanged, McpServerRefused | SqlError>
    /**
     * The Installations on for each of the Repos, by {@link repoKey}, as a Session starting now
     * would run with them (see `forSession`): a Repo with none has no entry. What a Session's are
     * compared with, to say its Repo's changed since it started.
     */
    readonly installationsOn: (
      repos: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<SessionInstallation>>, SqlError>
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
     * started with; and the OAuth tokens and client secrets of the Installations on for it (#217,
     * #218), global ones too.
     */
    readonly valuesOn: (
      repo: string,
    ) => Effect.Effect<ReadonlyArray<Redacted.Redacted<string>>, SecretsUnavailable | SqlError>
    /** The Repo's MCP server change log, newest first, by any spelling of its name. */
    readonly log: (repo: string) => Effect.Effect<ReadonlyArray<McpServerLogEntry>, SqlError>
  }
>()("@kndl/hub/McpServers") {
  static readonly layer = Layer.effect(
    McpServers,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const secrets = yield* Secrets
      const oauth = yield* McpServerOAuth

      const mcpServerRows = (where: Fragment) =>
        sql<{
          readonly id: string
          readonly name: string
          readonly url: string
          readonly description: string | null
          readonly auth: string
          readonly package: string | null
          readonly iconHash: string | null
          readonly createdAt: number
          readonly byId: string
          readonly byLogin: string
          readonly byName: string
          readonly byAvatarUrl: string | null
        }>`
          SELECT g.id, g.name, g.url, g.description, g.auth, g.package, g.icon_hash AS iconHash,
            g.created_at AS createdAt,
            p.id AS byId, p.login AS byLogin, p.name AS byName, p.avatar_url AS byAvatarUrl
          FROM mcp_servers g JOIN participants p ON p.id = g.created_by
          ${where}
          ORDER BY g.created_at, g.id
        `.pipe(
          Effect.map((rows) =>
            rows.map((row): McpServer => ({
              id: McpServerId.make(row.id),
              name: row.name,
              ...(row.description !== null && { description: row.description }),
              url: row.url,
              auth: authOf(row.auth),
              ...(row.iconHash !== null && { iconHash: row.iconHash }),
              ...(row.package !== null && { package: decodePackage(row.package) }),
              createdBy: toParticipant(row),
              createdAt: row.createdAt,
            })),
          ),
        )

      const installationRows = Effect.fn("McpServers.installationRows")(function* (
        where: Fragment,
      ) {
        const rows = yield* sql<{
          readonly id: string
          readonly mcpServerId: string
          readonly name: string
          readonly global: number
          readonly createdAt: number
          readonly byId: string
          readonly byLogin: string
          readonly byName: string
          readonly byAvatarUrl: string | null
        }>`
          SELECT i.id, i.mcp_server_id AS mcpServerId, i.name, i.global, i.created_at AS createdAt,
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
        const off = yield* sql<{ readonly installationId: string; readonly repo: string }>`
          SELECT installation_id AS installationId, repo FROM installation_repo_off
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
        // Who connected each OAuth Installation, when, and as whom (#217): never a token.
        const connections = yield* sql<{
          readonly installationId: string
          readonly account: string | null
          readonly connectedAt: number
          readonly lostAt: number | null
          readonly byId: string
          readonly byLogin: string
          readonly byName: string
          readonly byAvatarUrl: string | null
        }>`
          SELECT o.installation_id AS installationId, o.account, o.connected_at AS connectedAt,
            o.lost_at AS lostAt, p.id AS byId, p.login AS byLogin, p.name AS byName,
            p.avatar_url AS byAvatarUrl
          FROM installation_oauth o JOIN participants p ON p.id = o.connected_by
          WHERE o.connected_at IS NOT NULL AND o.installation_id IN ${sql.in(ids)}
        `
        // The client entered for each, if one was (#218): its id, and whether it has a secret.
        const clients = yield* sql<{
          readonly installationId: string
          readonly clientId: string
          readonly secret: number
          readonly setAt: number
          readonly byId: string
          readonly byLogin: string
          readonly byName: string
          readonly byAvatarUrl: string | null
        }>`
          SELECT o.installation_id AS installationId, o.manual_client_id AS clientId,
            o.manual_client_secret AS secret, o.client_set_at AS setAt, p.id AS byId,
            p.login AS byLogin, p.name AS byName, p.avatar_url AS byAvatarUrl
          FROM installation_oauth o JOIN participants p ON p.id = o.client_set_by
          WHERE o.manual_client_id IS NOT NULL AND o.installation_id IN ${sql.in(ids)}
        `
        const clientOf = (id: string): InstallationClient | undefined => {
          const found = clients.find((client) => client.installationId === id)
          return found === undefined
            ? undefined
            : {
                clientId: found.clientId,
                secret: found.secret === 1,
                setBy: toParticipant(found),
                setAt: found.setAt,
              }
        }
        const connectionOf = (id: string): InstallationConnection | undefined => {
          const found = connections.find((connection) => connection.installationId === id)
          return found === undefined
            ? undefined
            : {
                connectedBy: toParticipant(found),
                connectedAt: found.connectedAt,
                ...(found.account !== null && { account: found.account }),
                ...(found.lostAt !== null && { lostAt: found.lostAt }),
              }
        }
        return rows.map((row): StoredInstallation => {
          const connection = connectionOf(row.id)
          const client = clientOf(row.id)
          const turnedOff = off
            .filter((repo) => repo.installationId === row.id)
            .map((repo) => RepoName.make(repo.repo))
          return {
            id: InstallationId.make(row.id),
            mcpServerId: McpServerId.make(row.mcpServerId),
            name: row.name,
            ...(row.global === 1 && { global: true }),
            repos: repos
              .filter((repo) => repo.installationId === row.id)
              .map((repo) => RepoName.make(repo.repo)),
            ...(turnedOff.length > 0 && { off: turnedOff }),
            values: values
              .filter((value) => value.installationId === row.id)
              .map((value): HeaderValueSet => ({
                key: value.key,
                setBy: toParticipant(value),
                setAt: value.setAt,
              })),
            ...(connection !== undefined && { connection }),
            ...(client !== undefined && { client }),
            createdBy: toParticipant(row),
            createdAt: row.createdAt,
          }
        })
      })

      /** Whether the person is the Hub's Owner (#219). */
      const isOwner = Effect.fn("McpServers.isOwner")(function* (by: ParticipantId) {
        const rows = yield* sql<{ readonly owner: number }>`
          SELECT owner FROM participants WHERE id = ${by}
        `
        return rows[0]?.owner === 1
      })

      /** Refuses anyone but the Owner, saying why (#219). */
      const ownerOnly = Effect.fn("McpServers.ownerOnly")(function* (
        by: ParticipantId,
        message: string,
      ) {
        if (!(yield* isOwner(by))) return yield* refuse(message)
      })

      /** The MCP server's global Installation, by name, if it has one (#219). */
      const globalOf = Effect.fn("McpServers.globalOf")(function* (
        id: McpServerId,
        except: InstallationId | null,
      ) {
        const rows = yield* sql<{ readonly name: string }>`
          SELECT name FROM installations
          WHERE mcp_server_id = ${id} AND global = 1 AND id IS NOT ${except}
          LIMIT 1
        `
        return Option.fromNullishOr(rows[0]?.name)
      })

      /**
       * Refuses a change to an MCP server with a global Installation, unless by the Owner (#219).
       */
      const checkMcpServerOwner = Effect.fn("McpServers.checkMcpServerOwner")(function* (
        target: McpServer,
        by: ParticipantId,
      ) {
        if (Option.isSome(yield* globalOf(target.id, null))) {
          yield* ownerOnly(by, globalMcpServerRefusal(target.name))
        }
      })

      const list = Effect.gen(function* () {
        return {
          mcpServers: yield* mcpServerRows(sql``),
          installations: yield* installationRows(sql``),
        }
      }).pipe(Effect.withSpan("McpServers.list"))

      const mcpServer = Effect.fn("McpServers.mcpServer")(function* (id: McpServerId) {
        return Option.fromNullishOr((yield* mcpServerRows(sql`WHERE g.id = ${id}`))[0])
      })

      const icon = Effect.fn("McpServers.icon")(function* (id: McpServerId) {
        const rows = yield* sql<{ readonly icon: Uint8Array; readonly contentType: string }>`
          SELECT icon, icon_type AS contentType FROM mcp_servers
          WHERE id = ${id} AND icon IS NOT NULL AND icon_type IS NOT NULL
        `
        return Option.map(Option.fromNullishOr(rows[0]), (row) => ({
          bytes: new Uint8Array(row.icon),
          contentType: row.contentType,
        }))
      })

      const setIcon = Effect.fn("McpServers.setIcon")(function* (
        id: McpServerId,
        forUrl: string,
        found: Icon | undefined,
      ) {
        const rows =
          found === undefined
            ? yield* sql<{ readonly id: string }>`
                UPDATE mcp_servers SET icon = NULL, icon_type = NULL, icon_hash = NULL
                WHERE id = ${id} AND url = ${forUrl} RETURNING id
              `
            : yield* sql<{ readonly id: string }>`
                UPDATE mcp_servers SET icon = ${found.bytes}, icon_type = ${found.contentType},
                  icon_hash = ${iconHash(found.bytes)}
                WHERE id = ${id} AND url = ${forUrl} RETURNING id
              `
        return rows.length > 0
      })

      const installation = Effect.fn("McpServers.installation")(function* (id: InstallationId) {
        return Option.fromNullishOr((yield* installationRows(sql`WHERE i.id = ${id}`))[0])
      })

      const mcpServerRepos = Effect.fn("McpServers.mcpServerRepos")(function* (id: McpServerId) {
        const rows = yield* sql<{ readonly repo: string }>`
          SELECT repo FROM installation_repos WHERE mcp_server_id = ${id} ORDER BY repo COLLATE NOCASE
        `
        const repos: Array<RepoName> = []
        for (const row of rows) {
          if (!repos.some((repo) => sameRepo(repo, row.repo))) repos.push(RepoName.make(row.repo))
        }
        return repos
      })

      const record = Effect.fn("McpServers.record")(function* (
        entries: ReadonlyArray<Entry>,
        about: {
          readonly mcpServer: {
            readonly id: string
            readonly name: string
            readonly package?: { readonly version: string; readonly commit?: string }
          }
          readonly installation: { readonly id: string; readonly name: string }
        },
        by: ParticipantId,
        at: number,
      ) {
        for (const { repo, change, secrets: titles } of entries) {
          // Only an Upgrade records the version, which is what it changed.
          const version =
            change === "McpServerUpgraded" && about.mcpServer.package !== undefined
              ? packageVersion(about.mcpServer.package)
              : null
          yield* sql`
            INSERT INTO mcp_server_log (
              repo, at, by, change, mcp_server_id, mcp_server_name, mcp_server_version, installation_id,
              installation_name, secrets
            ) VALUES (
              ${repo}, ${at}, ${by}, ${change}, ${about.mcpServer.id}, ${about.mcpServer.name},
              ${version}, ${about.installation.id}, ${about.installation.name},
              ${titles === undefined ? null : encodeTitles(titles)}
            )
          `
        }
      })

      /** Saves the values for the Installation, encrypted, over any it held for the same keys. */
      const saveValues = Effect.fn("McpServers.saveValues")(function* (
        id: InstallationId,
        values: ReadonlyArray<ValueToSave>,
        by: ParticipantId,
        at: number,
      ) {
        for (const { secret, value } of values) {
          const stored = yield* secrets
            .encrypt(value, valueContext(id, secret.key))
            .pipe(Effect.mapError((error) => new McpServerRefused({ message: error.message })))
          yield* sql`
            INSERT INTO installation_values (installation_id, key, value, set_by, set_at)
            VALUES (${id}, ${secret.key}, ${stored}, ${by}, ${at})
            ON CONFLICT (installation_id, key) DO UPDATE SET
              value = excluded.value, set_by = excluded.set_by, set_at = excluded.set_at
          `
        }
      })

      const createMcpServer = Effect.fn("McpServers.createMcpServer")(
        function* (
          input: { readonly name: string; readonly url: string; readonly auth: McpServerAuth },
          by: ParticipantId,
        ) {
          yield* checkMcpServer(input)
          const name = input.name.trim()
          const slug = mcpServerSlug(name)
          const taken = new Set(
            (yield* sql<{ readonly id: string }>`
              SELECT id FROM mcp_servers WHERE id = ${HubMcpServerPrefix + slug}
                OR id LIKE ${`${HubMcpServerPrefix}${slug}-%`}
            `).map((row) => row.id),
          )
          let id = `${HubMcpServerPrefix}${slug}`
          for (let n = 2; taken.has(id); n++) id = `${HubMcpServerPrefix}${slug}-${n}`
          const auth = encodeAuth(normalizedAuth(input.auth))
          yield* sql`
            INSERT INTO mcp_servers (id, name, url, auth, created_by, created_at)
            VALUES (${id}, ${name}, ${input.url}, ${auth}, ${by}, ${yield* Clock.currentTimeMillis})
          `
          return Option.getOrThrow(yield* mcpServer(McpServerId.make(id)))
        },
        (effect) => sql.withTransaction(effect),
      )

      /**
       * Changes the MCP server to `next`, clearing the values the change leaves no use for on its
       * Installations and their Sessions ({@link clearedHeaderSecrets}), and logs `change` on each
       * Repo they list, then ValuesCleared, naming the values each Installation lost. An edit and
       * an Upgrade both change an MCP server this way: only the Owner's, for an MCP server with a
       * global Installation, whose change is logged in every Repo's log (#219).
       */
      const changeMcpServer = Effect.fn("McpServers.changeMcpServer")(function* (
        before: McpServer,
        next: {
          readonly name: string
          readonly description?: string
          readonly url: string
          readonly auth: McpServerAuth
          readonly package?: McpServerPackage
        },
        change: "McpServerEdited" | "McpServerUpgraded",
        by: ParticipantId,
      ) {
        const id = before.id
        yield* checkMcpServerOwner(before, by)
        const cleared = clearedHeaderSecrets(before, next)
        const installed = yield* installationRows(sql`WHERE i.mcp_server_id = ${id}`)
        yield* sql`
          UPDATE mcp_servers SET name = ${next.name}, description = ${next.description ?? null},
            url = ${next.url}, auth = ${encodeAuth(next.auth)},
            package = ${next.package === undefined ? null : encodePackage(next.package)}
          WHERE id = ${id}
        `
        if (cleared.length > 0) {
          const keys = cleared.map((secret) => secret.key)
          const ofMcpServer = sql`
            installation_id IN (SELECT id FROM installations WHERE mcp_server_id = ${id})
              AND key IN ${sql.in(keys)}
          `
          yield* sql`DELETE FROM installation_values WHERE ${ofMcpServer}`
          yield* sql`DELETE FROM session_installation_values WHERE ${ofMcpServer}`
        }
        // Tokens and the registered client go with the origin they were for (#217), so a URL edit
        // can't send them to another server.
        const disconnects = clearsConnections(before, next)
        if (disconnects) {
          yield* sql`
            DELETE FROM installation_oauth
            WHERE installation_id IN (SELECT id FROM installations WHERE mcp_server_id = ${id})
          `
        }
        const at = yield* Clock.currentTimeMillis
        const repos: Array<RepoName> = []
        for (const one of installed) {
          const lost = cleared
            .filter((secret) => one.values.some((value) => value.key === secret.key))
            .map((secret) => secret.title)
          yield* record(
            [
              ...withValues(logRepos(one), change, { change: "ValuesCleared", secrets: lost }),
              ...(disconnects && one.connection !== undefined
                ? logRepos(one).map((repo) => ({ repo, change: "Disconnected" as const }))
                : []),
            ],
            {
              mcpServer: {
                id,
                name: next.name,
                ...(next.package !== undefined && { package: next.package }),
              },
              installation: one,
            },
            by,
            at,
          )
          repos.push(...one.repos)
        }
        return {
          repos,
          ...(installed.some((one) => one.global === true) && { everyRepo: true }),
        }
      })

      const editMcpServer = Effect.fn("McpServers.editMcpServer")(
        function* (
          id: McpServerId,
          input: { readonly name: string; readonly url: string; readonly auth: McpServerAuth },
          by: ParticipantId,
        ) {
          const existing = yield* mcpServer(id)
          if (Option.isNone(existing)) return yield* refuse("There is no such MCP server.")
          if (existing.value.package !== undefined) {
            return yield* refuse(packagedMcpServerRefusal(existing.value.name))
          }
          yield* checkMcpServer(input)
          const name = input.name.trim()
          const auth = encodeAuth(normalizedAuth(input.auth))
          if (
            name === existing.value.name &&
            input.url === existing.value.url &&
            auth === encodeAuth(existing.value.auth)
          ) {
            return { repos: [] }
          }
          return yield* changeMcpServer(
            existing.value,
            { ...existing.value, name, url: input.url, auth: normalizedAuth(input.auth) },
            "McpServerEdited",
            by,
          )
        },
        (effect) => sql.withTransaction(effect),
      )

      const deleteMcpServer = Effect.fn("McpServers.deleteMcpServer")(
        function* (id: McpServerId, by: ParticipantId) {
          const existing = yield* mcpServer(id)
          if (Option.isNone(existing)) return yield* refuse("There is no such MCP server.")
          yield* checkMcpServerOwner(existing.value, by)
          const rows = yield* sql<{ readonly count: number }>`
            SELECT count(*) AS count FROM installations WHERE mcp_server_id = ${id}
          `
          const count = rows[0]?.count ?? 0
          if (count > 0) return yield* refuse(mcpServerInUseRefusal(existing.value.name, count))
          yield* sql`DELETE FROM mcp_servers WHERE id = ${id}`
        },
        (effect) => sql.withTransaction(effect),
      )

      const addPackage = Effect.fn("McpServers.addPackage")(
        function* (read: PackagedMcpServer, by: ParticipantId) {
          if (Option.isSome(yield* mcpServer(read.id)))
            return yield* refuse(mcpServerTakenRefusal(read.id))
          yield* checkMcpServer(read)
          yield* sql`
            INSERT INTO mcp_servers (id, name, url, description, auth, package, created_by, created_at)
            VALUES (
              ${read.id}, ${read.name}, ${read.url}, ${read.description ?? null},
              ${encodeAuth(read.auth)}, ${encodePackage(read.package)}, ${by},
              ${yield* Clock.currentTimeMillis}
            )
          `
          return Option.getOrThrow(yield* mcpServer(read.id))
        },
        (effect) => sql.withTransaction(effect),
      )

      const upgradeMcpServer = Effect.fn("McpServers.upgradeMcpServer")(
        function* (read: PackagedMcpServer, by: ParticipantId) {
          const existing = yield* mcpServer(read.id)
          if (Option.isNone(existing) || existing.value.package === undefined) {
            return yield* refuse("There is no such packaged MCP server.")
          }
          yield* checkMcpServer(read)
          const before = existing.value
          if (
            encodePackage(read.package) === encodePackage(existing.value.package) &&
            encodeAuth(read.auth) === encodeAuth(before.auth) &&
            read.name === before.name &&
            read.url === before.url &&
            read.description === before.description
          ) {
            return { repos: [] }
          }
          return yield* changeMcpServer(before, read, "McpServerUpgraded", by)
        },
        (effect) => sql.withTransaction(effect),
      )

      /**
       * Refuses a Repo-scoped Installation of the MCP server on a Repo that lists another one. A
       * global one lists none, so a Repo-scoped one may take its place (#219).
       */
      const checkOnePerRepo = Effect.fn("McpServers.checkOnePerRepo")(function* (
        target: McpServer,
        repos: ReadonlyArray<RepoName>,
        except: InstallationId | null,
      ) {
        for (const repo of repos) {
          const rows = yield* sql<{ readonly name: string }>`
            SELECT i.name FROM installation_repos r JOIN installations i ON i.id = r.installation_id
            WHERE r.mcp_server_id = ${target.id} AND r.repo = ${repo} COLLATE NOCASE
              AND r.installation_id IS NOT ${except}
            LIMIT 1
          `
          if (rows[0] !== undefined) {
            return yield* refuse(secondInstallationRefusal(repo, rows[0].name, target.name))
          }
        }
      })

      /** Refuses a second global Installation of the MCP server (#219). */
      const checkOneGlobal = Effect.fn("McpServers.checkOneGlobal")(function* (
        target: McpServer,
        except: InstallationId | null,
      ) {
        const existing = yield* globalOf(target.id, except)
        if (Option.isSome(existing)) {
          return yield* refuse(secondGlobalRefusal(existing.value, target.name))
        }
      })

      const createInstallation = Effect.fn("McpServers.createInstallation")(
        function* (
          input: {
            readonly mcpServerId: McpServerId
            readonly name: string
            readonly global?: boolean
            readonly repos: ReadonlyArray<RepoName>
            readonly values?: ReadonlyArray<HeaderValueInput>
          },
          by: ParticipantId,
        ) {
          const global = input.global === true
          if (global) yield* ownerOnly(by, globalOwnerOnlyRefusal)
          const target = yield* mcpServer(input.mcpServerId)
          if (Option.isNone(target)) return yield* refuse("There is no such MCP server.")
          yield* checkInstallation(input)
          const values = yield* checkValues(target.value, input.values ?? [])
          if (global) yield* checkOneGlobal(target.value, null)
          else yield* checkOnePerRepo(target.value, input.repos, null)
          const id = InstallationId.make(randomId())
          const name = input.name.trim()
          const at = yield* Clock.currentTimeMillis
          yield* sql`
            INSERT INTO installations (id, mcp_server_id, name, global, created_by, created_at)
            VALUES (${id}, ${input.mcpServerId}, ${name}, ${global ? 1 : 0}, ${by}, ${at})
          `
          for (const repo of input.repos) {
            yield* sql`
              INSERT INTO installation_repos (installation_id, mcp_server_id, repo)
              VALUES (${id}, ${input.mcpServerId}, ${repo})
            `
          }
          yield* saveValues(id, values, by, at)
          yield* record(
            withValues(logRepos({ global, repos: input.repos }), "Created", {
              change: "ValuesSet",
              secrets: values.map(({ secret }) => secret.title),
            }),
            { mcpServer: target.value, installation: { id, name } },
            by,
            at,
          )
          return {
            ...Option.getOrThrow(yield* installation(id)),
            ...(global && { everyRepo: true }),
          }
        },
        (effect) => sql.withTransaction(effect),
      )

      const editInstallation = Effect.fn("McpServers.editInstallation")(
        function* (
          id: InstallationId,
          input: {
            readonly name: string
            readonly global?: boolean
            readonly repos: ReadonlyArray<RepoName>
            readonly values?: ReadonlyArray<HeaderValueInput>
          },
          by: ParticipantId,
        ) {
          const existing = yield* installation(id)
          if (Option.isNone(existing)) return yield* refuse("There is no such Installation.")
          const before = existing.value
          const wasGlobal = before.global === true
          const global = input.global === true
          if (wasGlobal || global) yield* ownerOnly(by, globalOwnerOnlyRefusal)
          const target = Option.getOrThrow(yield* mcpServer(before.mcpServerId))
          yield* checkInstallation(input)
          const values = yield* checkValues(target, input.values ?? [])
          const name = input.name.trim()
          const added = missingFrom(before.repos, input.repos)
          const removed = missingFrom(input.repos, before.repos)
          const kept = before.repos.filter((repo) => !removed.includes(repo))
          const renamed = name !== before.name
          const rescoped = global !== wasGlobal
          if (global && !wasGlobal) yield* checkOneGlobal(target, id)
          yield* checkOnePerRepo(target, added, id)
          const at = yield* Clock.currentTimeMillis
          if (renamed) yield* sql`UPDATE installations SET name = ${name} WHERE id = ${id}`
          if (rescoped) {
            yield* sql`UPDATE installations SET global = ${global ? 1 : 0} WHERE id = ${id}`
            // A Repo that turned it off had it as a global one: as a Repo-scoped one, it lists.
            if (!global) yield* sql`DELETE FROM installation_repo_off WHERE installation_id = ${id}`
          }
          for (const repo of removed) {
            yield* sql`
              DELETE FROM installation_repos WHERE installation_id = ${id} AND repo = ${repo}
            `
          }
          for (const repo of added) {
            yield* sql`
              INSERT INTO installation_repos (installation_id, mcp_server_id, repo)
              VALUES (${id}, ${before.mcpServerId}, ${repo})
            `
          }
          yield* saveValues(id, values, by, at)
          const titles = values.map(({ secret }) => secret.title)
          if (wasGlobal || global) {
            // A change to every Repo, logged once (#219). One made global is on where it was
            // listed still, and one made Repo-scoped was on in the Repos it now lists already.
            const entries: Array<Entry> = [
              ...(renamed ? [{ repo: everyRepo, change: "Renamed" as const }] : []),
              ...(rescoped
                ? [
                    {
                      repo: everyRepo,
                      change: global ? ("MadeGlobal" as const) : ("MadeRepoScoped" as const),
                    },
                  ]
                : []),
              ...(titles.length > 0
                ? [{ repo: everyRepo, change: "ValuesSet" as const, secrets: titles }]
                : []),
            ]
            yield* record(entries, { mcpServer: target, installation: { id, name } }, by, at)
            return {
              repos: [...before.repos, ...added],
              ...(entries.length > 0 && { everyRepo: true }),
            }
          }
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
            { mcpServer: target, installation: { id, name } },
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

      const deleteInstallation = Effect.fn("McpServers.deleteInstallation")(
        function* (id: InstallationId, by: ParticipantId) {
          const existing = yield* installation(id)
          if (Option.isNone(existing)) return yield* refuse("There is no such Installation.")
          const global = existing.value.global === true
          if (global) yield* ownerOnly(by, globalOwnerOnlyRefusal)
          const target = Option.getOrThrow(yield* mcpServer(existing.value.mcpServerId))
          yield* sql`DELETE FROM installations WHERE id = ${id}`
          yield* record(
            logRepos(existing.value).map((repo) => ({ repo, change: "Deleted" as const })),
            { mcpServer: target, installation: existing.value },
            by,
            yield* Clock.currentTimeMillis,
          )
          return { repos: existing.value.repos, ...(global && { everyRepo: true }) }
        },
        (effect) => sql.withTransaction(effect),
      )

      const turnGlobalInstallation = Effect.fn("McpServers.turnGlobalInstallation")(
        function* (id: InstallationId, repo: RepoName, on: boolean, by: ParticipantId) {
          const existing = yield* installation(id)
          if (Option.isNone(existing)) return yield* refuse("There is no such Installation.")
          if (existing.value.global !== true) {
            return yield* refuse(notGlobalRefusal(existing.value.name))
          }
          const wasOff = (existing.value.off ?? []).some((other) => sameRepo(other, repo))
          if (wasOff !== on) return { repos: [] }
          if (on) {
            yield* sql`
              DELETE FROM installation_repo_off
              WHERE installation_id = ${id} AND repo = ${repo} COLLATE NOCASE
            `
          } else {
            yield* sql`INSERT INTO installation_repo_off (installation_id, repo) VALUES (${id}, ${repo})`
          }
          yield* record(
            [{ repo, change: on ? "TurnedOn" : "TurnedOff" }],
            {
              mcpServer: Option.getOrThrow(yield* mcpServer(existing.value.mcpServerId)),
              installation: existing.value,
            },
            by,
            yield* Clock.currentTimeMillis,
          )
          return { repos: [repo] }
        },
        (effect) => sql.withTransaction(effect),
      )

      const checkConnector = Effect.fn("McpServers.checkConnector")(function* (
        target: StoredInstallation,
        by: ParticipantId,
      ) {
        if (target.global === true) yield* ownerOnly(by, globalConnectRefusal)
      })

      const connectInstallation = Effect.fn("McpServers.connectInstallation")(
        function* (pending: PendingConnection, granted: Granted, by: ParticipantId) {
          const existing = yield* installation(pending.installationId)
          if (Option.isNone(existing)) return yield* refuse("There is no such Installation.")
          const target = Option.getOrThrow(yield* mcpServer(existing.value.mcpServerId))
          const global = existing.value.global === true
          if (
            global !== pending.global ||
            existing.value.repos.some(
              (repo) => !pending.repos.some((other) => sameRepo(other, repo)),
            ) ||
            connectionBasis(target) !== pending.basis
          ) {
            return yield* refuse(
              `${existing.value.name} or its MCP server changed meanwhile: connect it again.`,
            )
          }
          yield* checkConnector(existing.value, by)
          const { reconnected, clientSet } = yield* oauth
            .store(pending, granted, by)
            .pipe(
              Effect.catchTag("SecretsUnavailable", (error) =>
                Effect.fail(new McpServerRefused({ message: error.message })),
              ),
            )
          const change = reconnected ? ("Reconnected" as const) : ("Connected" as const)
          yield* record(
            logRepos(existing.value).flatMap((repo) => [
              ...(clientSet ? [{ repo, change: "ClientSet" as const }] : []),
              { repo, change },
            ]),
            { mcpServer: target, installation: existing.value },
            by,
            yield* Clock.currentTimeMillis,
          )
          return { repos: existing.value.repos, ...(global && { everyRepo: true }) }
        },
        (effect) => sql.withTransaction(effect),
      )

      const disconnectInstallation = Effect.fn("McpServers.disconnectInstallation")(
        function* (id: InstallationId, by: ParticipantId) {
          const existing = yield* installation(id)
          if (Option.isNone(existing)) return yield* refuse("There is no such Installation.")
          yield* checkConnector(existing.value, by)
          if (!(yield* oauth.disconnect(id))) {
            return yield* refuse(`${existing.value.name} isn't connected.`)
          }
          yield* record(
            logRepos(existing.value).map((repo) => ({ repo, change: "Disconnected" as const })),
            {
              mcpServer: Option.getOrThrow(yield* mcpServer(existing.value.mcpServerId)),
              installation: existing.value,
            },
            by,
            yield* Clock.currentTimeMillis,
          )
          return {
            repos: existing.value.repos,
            ...(existing.value.global === true && { everyRepo: true }),
          }
        },
        (effect) => sql.withTransaction(effect),
      )

      const forSession = Effect.fn("McpServers.forSession")(
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

      const gatewayTarget = Effect.fn("McpServers.gatewayTarget")(function* (
        id: InstallationId,
        session: { readonly id: SessionId; readonly repo: string },
      ) {
        // On for the Repo now, as a Session starting now would have it, decided where forSession's
        // are: an Installation turned off or overridden since the Session started stops at once.
        const on = (yield* onFor(sql, [session.repo])).get(repoKey(session.repo)) ?? []
        const row = on.find((one) => one.id === id)
        if (row === undefined) return Option.none<GatewayTarget>()
        const auth = authOf(row.auth)
        if (auth._tag === "OAuth") {
          // The token as it is now, not as the Session started (#217): refreshes reach it at once.
          const token = yield* oauth.accessToken(id)
          switch (token._tag) {
            case "NotConnected":
              return Option.some<GatewayTarget>({
                _tag: "NotConnected",
                message: notConnectedRefusal(row.name),
              })
            case "Unavailable":
              return Option.some<GatewayTarget>({
                _tag: "Unavailable",
                message: `${row.name}'s token expired, and its authorization server could not be reached to refresh it: try again.`,
              })
            case "Token":
              return Option.some<GatewayTarget>({
                _tag: "Ready",
                url: row.url,
                headers: [
                  {
                    header: "Authorization",
                    value: Redacted.make(`Bearer ${Redacted.value(token.token)}`),
                  },
                ],
                oauth: { generation: token.generation },
              })
          }
        }
        const declared = headerSecretsOf(auth)
        const held =
          declared.length === 0
            ? []
            : yield* sql<{ readonly key: string; readonly value: string }>`
                SELECT key, value FROM session_installation_values
                WHERE session_id = ${session.id} AND installation_id = ${id}
              `
        const missing = declared.filter((secret) => !held.some((one) => one.key === secret.key))
        if (missing.length > 0) {
          return Option.some<GatewayTarget>({
            _tag: "NeedsValue",
            message: valueNeededRefusal(row.name, missing[0]?.title ?? ""),
            secrets: missing.map((secret) => secret.title),
          })
        }
        const headers: Array<{ header: string; value: Redacted.Redacted<string> }> = []
        for (const secret of declared) {
          const stored = held.find((one) => one.key === secret.key)
          if (stored === undefined) continue
          const value = yield* secrets.decrypt(stored.value, valueContext(id, secret.key))
          headers.push({
            header: secret.header,
            value: Redacted.make(headerValue(secret, Redacted.value(value))),
          })
        }
        return Option.some<GatewayTarget>({ _tag: "Ready", url: row.url, headers })
      })

      // Not onFor's answer, on purpose: what to redact is every value a Session of the Repo may
      // hold, not what is on now. A Session keeps the values it started with after its Repo turns
      // a global Installation off, or a Repo-scoped one overrides it, so this takes every global
      // one's, every one listing the Repo, and every one its Sessions started with: a superset of
      // onFor's, where redacting too much is harmless and too little leaks a credential.
      const valuesOn = Effect.fn("McpServers.valuesOn")(function* (repo: string) {
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
          -- Every global one's (#219): redacting one the Repo has off or overridden is harmless.
          SELECT v.installation_id AS installationId, v.key, v.value
          FROM installation_values v JOIN installations i ON i.id = v.installation_id
          WHERE i.global = 1
          UNION
          SELECT v.installation_id AS installationId, v.key, v.value
          FROM session_installation_values v JOIN sessions s ON s.id = v.session_id
          WHERE s.repo = ${repo} COLLATE NOCASE
        `
        const values = yield* Effect.forEach(rows, (row) =>
          secrets.decrypt(row.value, valueContext(row.installationId, row.key)),
        )
        // The OAuth tokens and client secrets of each it lists, and of every global one (#219).
        const on = yield* sql<{ readonly installationId: string }>`
          SELECT installation_id AS installationId FROM installation_repos
          WHERE repo = ${repo} COLLATE NOCASE
          UNION
          SELECT id AS installationId FROM installations WHERE global = 1
        `
        const tokens = yield* oauth.tokensOf(on.map((row) => row.installationId))
        return [...values, ...tokens]
      })

      const log = Effect.fn("McpServers.log")(function* (repo: string) {
        const rows = yield* sql<{
          readonly repo: string
          readonly at: number
          readonly change: string
          readonly mcpServerId: string
          readonly mcpServerName: string
          readonly installationId: string
          readonly installationName: string
          readonly secrets: string | null
          readonly mcpServerVersion: string | null
          readonly byId: string
          readonly byLogin: string
          readonly byName: string
          readonly byAvatarUrl: string | null
        }>`
          SELECT l.repo, l.at, l.change, l.mcp_server_id AS mcpServerId, l.mcp_server_name AS mcpServerName,
            l.mcp_server_version AS mcpServerVersion,
            l.installation_id AS installationId, l.installation_name AS installationName,
            l.secrets, p.id AS byId, p.login AS byLogin, p.name AS byName,
            p.avatar_url AS byAvatarUrl
          FROM mcp_server_log l JOIN participants p ON p.id = l.by
          WHERE l.repo = ${repo} COLLATE NOCASE OR l.repo = ${everyRepo}
          ORDER BY l.at DESC, l.id DESC
          LIMIT ${logLimit}
        `
        return rows.map((row): McpServerLogEntry => {
          const titles = row.secrets === null ? Option.none() : decodeTitles(row.secrets)
          return {
            at: row.at,
            by: toParticipant(row),
            change: decodeChange(row.change),
            ...(row.repo === everyRepo && { global: true }),
            mcpServerId: McpServerId.make(row.mcpServerId),
            mcpServerName: row.mcpServerName,
            ...(row.mcpServerVersion !== null && { mcpServerVersion: row.mcpServerVersion }),
            installationId: InstallationId.make(row.installationId),
            installationName: row.installationName,
            ...(Option.isSome(titles) && { secrets: titles.value }),
          }
        })
      })

      return McpServers.of({
        list,
        mcpServer,
        icon,
        setIcon,
        installation,
        mcpServerRepos,
        createMcpServer,
        editMcpServer,
        deleteMcpServer,
        addPackage,
        upgradeMcpServer,
        createInstallation,
        editInstallation,
        deleteInstallation,
        turnGlobalInstallation,
        connectInstallation,
        checkConnector,
        disconnectInstallation,
        installationsOn: (repos) => installationsOn(sql, repos),
        forSession,
        gatewayTarget,
        valuesOn,
        log,
      })
    }),
  )
}

/** An Installation on for a Repo, as {@link onFor} reads it with its MCP server. */
interface OnRow {
  readonly repo: string
  readonly id: string
  readonly name: string
  readonly global: number
  readonly mcpServerId: string
  readonly mcpServerName: string
  readonly url: string
  readonly auth: string
  readonly version: string | null
  readonly pinnedCommit: string | null
}

/**
 * The one place the Hub decides which Installations are on for a Repo (ADR 0020, #219): for each
 * of the Repos, by {@link repoKey}, oldest first. A Repo-scoped one is on where it lists the Repo,
 * by any spelling; a global one is on in each, unless overridden or turned off there, as
 * {@link installationsFor} resolves it. A Session's start and the Gateway's check both use it.
 */
const onFor = Effect.fn("McpServers.onFor")(function* (
  sql: SqlClient.SqlClient,
  repos: ReadonlyArray<string>,
) {
  const byRepo = new Map<string, Array<OnRow>>()
  if (repos.length === 0) return byRepo
  // Each Repo-scoped Installation once for each of the Repos it lists, and each global one once.
  const candidates = yield* sql<Omit<OnRow, "repo"> & { readonly repo: string | null }>`
    SELECT r.repo, i.id, i.name, i.global, g.id AS mcpServerId, g.name AS mcpServerName,
      g.url, g.auth,
      json_extract(g.package, '$.version') AS version, json_extract(g.package, '$.commit') AS pinnedCommit
    FROM installations i JOIN mcp_servers g ON g.id = i.mcp_server_id
      LEFT JOIN installation_repos r ON r.installation_id = i.id
        AND r.repo COLLATE NOCASE IN ${sql.in(repos)}
    WHERE i.global = 1 OR r.repo IS NOT NULL
    ORDER BY i.created_at, i.id
  `
  const off = candidates.some((row) => row.global === 1)
    ? yield* sql<{ readonly installationId: string; readonly repo: string }>`
        SELECT installation_id AS installationId, repo FROM installation_repo_off
        WHERE repo COLLATE NOCASE IN ${sql.in(repos)}
      `
    : []
  const asked = new Map(repos.map((repo) => [repoKey(repo), repo]))
  for (const [key, repo] of asked) {
    const resolved = installationsFor(
      candidates
        .filter((row) => row.global === 1 || sameRepo(row.repo ?? "", repo))
        .map((row) => ({
          row,
          mcpServerId: row.mcpServerId,
          global: row.global === 1,
          repos: row.repo === null ? [] : [row.repo],
          off: off.filter((one) => one.installationId === row.id).map((one) => one.repo),
        })),
      repo,
    )
    const on = resolved.flatMap(({ installation, source }) =>
      isOn(source) ? [{ ...installation.row, repo }] : [],
    )
    if (on.length > 0) byRepo.set(key, on)
  }
  return byRepo
})

/**
 * The Installations on for each of the Repos, by any spelling, as a Session starting now runs
 * with them: by {@link repoKey}, oldest first, each with its MCP server's name, unique in its Repo,
 * and when each value it holds was set; as {@link onFor} decides them.
 */
const installationsOn = Effect.fn("McpServers.installationsOn")(function* (
  sql: SqlClient.SqlClient,
  repos: ReadonlyArray<string>,
) {
  const byRepo = new Map<string, Array<SessionInstallation>>()
  const rows = [...(yield* onFor(sql, repos)).values()].flat()
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
      mcpServerId: McpServerId.make(row.mcpServerId),
      mcpServerName: row.mcpServerName,
      ...(row.global === 1 && { global: true }),
      ...(row.version !== null && {
        mcpServerVersion: packageVersion({
          version: row.version,
          ...(row.pinnedCommit !== null && { commit: row.pinnedCommit }),
        }),
      }),
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
    installation.mcpServerName,
    installation.mcpServerVersion ?? null,
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
