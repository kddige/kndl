import { join } from "node:path"
import { HomeConfig } from "@claude-hub/protocol/home"
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun"
import { Config, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"

const migrations = SqliteMigrator.fromRecord({
  // Credentials keep only the SHA-256 of their secret (see Tokens.ts).
  "0001_auth": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE participants (
        id TEXT PRIMARY KEY,
        login TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `
    yield* sql`
      CREATE TABLE sign_ins (
        id TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL,
        participant_id TEXT NOT NULL REFERENCES participants (id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `
    yield* sql`
      CREATE TABLE runners (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        secret_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `
    yield* sql`
      CREATE TABLE mod_tokens (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        runner_id TEXT NOT NULL REFERENCES runners (id) ON DELETE CASCADE,
        secret_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `
  }),

  // Sessions, their event logs and Prompt queues (issue #8).
  "0002_sessions": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    // The Runner login a Runner last said hello with; null until it first connects.
    yield* sql`ALTER TABLE runners ADD COLUMN login_account TEXT`
    yield* sql`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        work_branch TEXT NOT NULL,
        state TEXT NOT NULL,
        runner_id TEXT NOT NULL REFERENCES runners (id),
        runner_login_account TEXT NOT NULL,
        creator_id TEXT NOT NULL REFERENCES participants (id),
        created_at INTEGER NOT NULL,
        current_turn TEXT,
        claude_session_id TEXT
      )
    `
    yield* sql`
      CREATE TABLE session_events (
        session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        at INTEGER NOT NULL,
        event TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      )
    `
    yield* sql`
      CREATE TABLE queued_prompts (
        position INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        sender_id TEXT NOT NULL REFERENCES participants (id),
        queued_at INTEGER NOT NULL
      )
    `
    yield* sql`CREATE INDEX queued_prompts_session ON queued_prompts (session_id, position)`
  }),

  // The GitHub avatar a person signed in with; null for dev login.
  "0003_participant_avatar": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE participants ADD COLUMN avatar_url TEXT`
  }),

  // Who prompted each Session since its last commit, for Co-authored-by trailers (issue #13).
  "0004_session_prompters": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE session_prompters (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
        participant_id TEXT NOT NULL REFERENCES participants (id),
        at INTEGER NOT NULL
      )
    `
    yield* sql`CREATE INDEX session_prompters_session ON session_prompters (session_id, seq)`
  }),

  // Archived Sessions (issue #18): who archived each and when, when it is purged unless restored,
  // and whether its Runner has stopped it and destroyed its Sandbox yet. Purged Sessions whose
  // Runner hasn't yet deleted what it holds of them wait in session_purges.
  "0005_session_archive": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE sessions ADD COLUMN archived_by TEXT REFERENCES participants (id)`
    yield* sql`ALTER TABLE sessions ADD COLUMN archived_at INTEGER`
    yield* sql`ALTER TABLE sessions ADD COLUMN purge_at INTEGER`
    yield* sql`ALTER TABLE sessions ADD COLUMN archive_stopped INTEGER NOT NULL DEFAULT 0`
    yield* sql`
      CREATE TABLE session_purges (
        session_id TEXT PRIMARY KEY,
        runner_id TEXT NOT NULL REFERENCES runners (id) ON DELETE CASCADE,
        purged_at INTEGER NOT NULL
      )
    `
  }),

  // Environments (issue #47, ADR 0009): each Repo's recipe as last applied, its variables and
  // links, the Hub-wide shared variables, and who applied each version when (no values). A
  // Sensitive value is stored only as AES-256-GCM ciphertext (Secrets.ts); the check value tells
  // whether HUB_SECRETS_KEY is the key they were encrypted with. Each Session records the
  // version its Sandbox runs on, as its Runner reports it.
  "0006_environments": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE secrets_check (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        ciphertext TEXT NOT NULL
      )
    `
    yield* sql`
      CREATE TABLE environments (
        repo TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        build_version INTEGER NOT NULL,
        image TEXT NOT NULL,
        bootstrap_script TEXT NOT NULL,
        start_script TEXT,
        docker INTEGER NOT NULL,
        dependency_folders TEXT NOT NULL,
        cpus INTEGER NOT NULL,
        memory_mib INTEGER NOT NULL
      )
    `
    yield* sql`
      CREATE TABLE environment_versions (
        repo TEXT NOT NULL REFERENCES environments (repo) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        applied_by TEXT NOT NULL REFERENCES participants (id),
        applied_at INTEGER NOT NULL,
        rebuilt INTEGER NOT NULL,
        PRIMARY KEY (repo, version)
      )
    `
    yield* sql`
      CREATE TABLE shared_variables (
        name TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('Plain', 'Sensitive')),
        value TEXT NOT NULL,
        updated_by TEXT NOT NULL REFERENCES participants (id),
        updated_at INTEGER NOT NULL
      )
    `
    // Local variables and links share one table, so a name is unique in an Environment.
    // `value` is the plain value, a Sensitive one's ciphertext, or null for a link.
    yield* sql`
      CREATE TABLE environment_variables (
        repo TEXT NOT NULL REFERENCES environments (repo) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('Plain', 'Sensitive', 'Link')),
        value TEXT,
        shared_name TEXT REFERENCES shared_variables (name),
        available_at_build INTEGER NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (repo, name)
      )
    `
    yield* sql`CREATE INDEX environment_variables_shared ON environment_variables (shared_name)`
    // Each Test build and its result, against the digest of the draft's build inputs (an HMAC
    // under a key derived from HUB_SECRETS_KEY, as it covers values available at build).
    yield* sql`
      CREATE TABLE test_builds (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        runner_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        started_by TEXT NOT NULL REFERENCES participants (id),
        started_at INTEGER NOT NULL,
        result TEXT CHECK (result IN ('Passed', 'Failed')),
        finished_at INTEGER
      )
    `
    yield* sql`CREATE INDEX test_builds_digest ON test_builds (repo, digest)`
    yield* sql`ALTER TABLE sessions ADD COLUMN environment_version INTEGER`
  }),

  // Sensitive values an apply or a shared variable's change replaced (issue #48), encrypted, for
  // redacting what a Session started before still prints: kept while a Session of the Repo runs
  // on a version below `until_version`.
  "0007_retired_values": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE retired_values (
        repo TEXT NOT NULL,
        value TEXT NOT NULL,
        until_version INTEGER NOT NULL,
        retired_at INTEGER NOT NULL
      )
    `
    yield* sql`CREATE INDEX retired_values_repo ON retired_values (repo)`
  }),

  // The git tools are gone (#73, ADR 0010), and with them the Co-authored-by trailers 0004 kept
  // the prompters for.
  "0008_drop_session_prompters": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`DROP TABLE session_prompters`
  }),

  // A Sensitive variable can need a value (#57): `bun run secrets-reset` clears the values a lost
  // HUB_SECRETS_KEY encrypted, keeping the variables. In both tables, a Sensitive variable with a
  // null value needs one. `shared_variables.value` was NOT NULL, so it is rebuilt; the
  // environment_variables rows that reference it are set aside meanwhile, as dropping a table
  // they reference would fail their foreign keys.
  "0009_values_needed": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE environment_variables_kept AS SELECT * FROM environment_variables`
    yield* sql`DROP TABLE environment_variables`
    yield* sql`
      CREATE TABLE shared_variables_new (
        name TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('Plain', 'Sensitive')),
        value TEXT CHECK (value IS NOT NULL OR kind = 'Sensitive'),
        updated_by TEXT NOT NULL REFERENCES participants (id),
        updated_at INTEGER NOT NULL
      )
    `
    yield* sql`INSERT INTO shared_variables_new SELECT * FROM shared_variables`
    yield* sql`DROP TABLE shared_variables`
    yield* sql`ALTER TABLE shared_variables_new RENAME TO shared_variables`
    yield* sql`
      CREATE TABLE environment_variables (
        repo TEXT NOT NULL REFERENCES environments (repo) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('Plain', 'Sensitive', 'Link')),
        value TEXT,
        shared_name TEXT REFERENCES shared_variables (name),
        available_at_build INTEGER NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (repo, name)
      )
    `
    yield* sql`INSERT INTO environment_variables SELECT * FROM environment_variables_kept`
    yield* sql`DROP TABLE environment_variables_kept`
    yield* sql`CREATE INDEX environment_variables_shared ON environment_variables (shared_name)`
  }),

  // Pairing codes and the Runners page (issue #85). A Runner keeps the version it last said hello
  // with and when it was last connected. A removed Runner keeps its row, which its Archived
  // Sessions refer to, with `removed_at` set: its token no longer works, and it isn't listed. A
  // Pairing code is kept as its hash, and is spent, revoked or expired once one of `used_at`,
  // `revoked_at` or `expires_at` says so; `runner_id` is the Runner a Re-pair's code is for.
  "0010_pairing": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE runners ADD COLUMN version_commit TEXT`
    yield* sql`ALTER TABLE runners ADD COLUMN version_branch TEXT`
    yield* sql`ALTER TABLE runners ADD COLUMN last_seen_at INTEGER`
    yield* sql`ALTER TABLE runners ADD COLUMN removed_at INTEGER`
    yield* sql`
      CREATE TABLE pairing_codes (
        id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        runner_id TEXT REFERENCES runners (id) ON DELETE CASCADE,
        created_by TEXT NOT NULL REFERENCES participants (id),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        revoked_at INTEGER
      )
    `
  }),

  // What Claude Code's terminal showed last when it exited on its own (issue #105), redacted,
  // while the Session is Asleep for it. Null otherwise.
  "0011_session_last_output": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE sessions ADD COLUMN last_output TEXT`
  }),

  // Runners follow the Hub's commit (issue #87, ADR 0011). A Runner keeps whether it said it updates
  // itself (`updater`, its hello's RunnerUpdater as JSON; null from a Runner too old to say).
  // `claude-hub update` on the Hub's machine leaves one row in `runner_update_push`: the commit it
  // moved the Hub to, which the Hub, once it runs that commit, tells Runners to follow as they
  // connect; every Runner's, or only `local_runner_id`'s with `--no-update-runners`.
  "0012_runner_updates": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE runners ADD COLUMN updater TEXT`
    yield* sql`
      CREATE TABLE runner_update_push (
        target_commit TEXT NOT NULL,
        update_now INTEGER NOT NULL,
        all_runners INTEGER NOT NULL,
        local_runner_id TEXT REFERENCES runners (id) ON DELETE SET NULL,
        requested_at INTEGER NOT NULL
      )
    `
  }),

  // Session names (issue #120): a Session's editable display name, null until someone names it,
  // when the web UI shows its Work branch.
  "0013_session_name": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE sessions ADD COLUMN name TEXT`
  }),

  // Child Sessions (issue #121, ADR 0012). A Child Session keeps its Parent Session's id, with no
  // foreign key: a parent purged first leaves its child a child, one level deep. `last_report` is
  // its final message of its last Turn, as its parent got it, and `parent_exchanges` how many
  // Turns in a row its parent prompted with no person's prompt to either (the loop guard). A
  // queued prompt another Session sent keeps it, as FromSession JSON, in `from_session`.
  "0014_child_sessions": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE sessions ADD COLUMN parent_id TEXT`
    yield* sql`ALTER TABLE sessions ADD COLUMN last_report TEXT`
    yield* sql`ALTER TABLE sessions ADD COLUMN last_report_at INTEGER`
    yield* sql`ALTER TABLE sessions ADD COLUMN parent_exchanges INTEGER NOT NULL DEFAULT 0`
    yield* sql`CREATE INDEX sessions_parent_id ON sessions (parent_id)`
    yield* sql`ALTER TABLE queued_prompts ADD COLUMN from_session TEXT`
  }),
  // A Session's model and effort (#128), NULL for Claude Code's default; `model_pending` while its
  // running Claude Code still has the ones from before, to be restarted with these once no Turn
  // runs. A Runner's `models`, as its last hello said, is RunnerModels JSON.
  "0015_session_model": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE sessions ADD COLUMN model TEXT`
    yield* sql`ALTER TABLE sessions ADD COLUMN effort TEXT`
    yield* sql`ALTER TABLE sessions ADD COLUMN model_pending INTEGER NOT NULL DEFAULT 0`
    yield* sql`ALTER TABLE runners ADD COLUMN models TEXT`
  }),
  // Each person's own Claude credential (ADR 0015), encrypted as Sensitive values are.
  "0016_claude_credentials": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE claude_credentials (
        participant_id TEXT PRIMARY KEY REFERENCES participants (id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        last4 TEXT NOT NULL,
        plan TEXT,
        added_at INTEGER NOT NULL
      )
    `
  }),
  // Subagents replace Child Sessions (ADR 0014). A former Child Session is an ordinary Session,
  // and history from another Session keeps one legacy sender, FromSession; a queued Report is an
  // ordinary prompt. `agents` holds each Session's subagents the mod reported, by Claude Code's
  // `agentId`, with their status: what the Session's summary and the Hub's own decisions need.
  // Everything else about them is in the event log.
  "0017_agents": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      UPDATE session_events
      SET event = json_set(event, '$.sender._tag', 'FromSession')
      WHERE json_extract(event, '$._tag') = 'TurnStarted'
        AND json_extract(event, '$.sender._tag')
          IN ('FromParentSession', 'FromChildSession', 'FromChildSessionMessage')
    `
    yield* sql`DROP INDEX sessions_parent_id`
    yield* sql`ALTER TABLE sessions DROP COLUMN parent_id`
    yield* sql`ALTER TABLE sessions DROP COLUMN last_report`
    yield* sql`ALTER TABLE sessions DROP COLUMN last_report_at`
    yield* sql`ALTER TABLE sessions DROP COLUMN parent_exchanges`
    yield* sql`ALTER TABLE queued_prompts DROP COLUMN from_session`
    yield* sql`
      CREATE TABLE agents (
        session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, agent_id)
      )
    `
  }),
})

// SQLite leaves foreign keys unenforced unless each connection turns them on.
const enforceForeignKeys = Layer.effectDiscard(
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql`PRAGMA foreign_keys = ON`),
)

const migrated = <E, R>(client: Layer.Layer<SqlClient.SqlClient, E, R>) =>
  SqliteMigrator.layer({ loader: migrations }).pipe(
    Layer.provideMerge(enforceForeignKeys),
    Layer.provideMerge(client),
  )

/**
 * Where the Hub's database is: `HUB_DATABASE`, or else `hub.db` in the home `CLAUDE_HUB_HOME`
 * names. From a checkout it is `hub.db` in `packages/hub` (wherever the Hub is started from), not in
 * the dev home: each checkout keeps its own, beside the `.env.local` holding its `HUB_SECRETS_KEY`.
 */
export const DatabaseFile: Config.Config<string> = Config.flatMap(HomeConfig, (home) =>
  Config.String("HUB_DATABASE").pipe(
    Config.withDefault(
      home.dev ? new URL("../hub.db", import.meta.url).pathname : join(home.dir, "hub.db"),
    ),
  ),
)

/** The Hub's SQLite database, migrated, at {@link DatabaseFile}. */
export const DatabaseLive = migrated(SqliteClient.layerConfig({ filename: DatabaseFile }))

/** The database in a file, migrated, as tests that restart the Hub use. */
export const databaseAt = (filename: string) => migrated(SqliteClient.layer({ filename }))

/** A fresh in-memory database, migrated, for tests. */
export const DatabaseTest = databaseAt(":memory:")
