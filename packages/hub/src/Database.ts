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

/** A fresh in-memory database, migrated, for tests. */
export const DatabaseTest = migrated(SqliteClient.layer({ filename: ":memory:" }))
