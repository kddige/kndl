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
 * The Hub's SQLite database, migrated, at `HUB_DATABASE` (default `hub.db` in `packages/hub`,
 * wherever the Hub is started from).
 */
export const DatabaseLive = migrated(
  SqliteClient.layerConfig({
    filename: Config.String("HUB_DATABASE").pipe(
      Config.withDefault(new URL("../hub.db", import.meta.url).pathname),
    ),
  }),
)

/** The database in a file, migrated, as tests that restart the Hub use. */
export const databaseAt = (filename: string) => migrated(SqliteClient.layer({ filename }))

/** A fresh in-memory database, migrated, for tests. */
export const DatabaseTest = databaseAt(":memory:")
