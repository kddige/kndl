import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionId } from "@claude-hub/protocol"
import { ConfigProvider, Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import { DatabaseFile, databaseAt } from "./Database.ts"
import { Sessions } from "./Sessions.ts"

const dirs: Array<string> = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const databaseIn = (env: Record<string, string>) =>
  Effect.runSync(DatabaseFile.parse(ConfigProvider.fromEnv({ env })))

describe("the Hub's database", () => {
  test("from a checkout is hub.db in packages/hub, not in the dev home", () => {
    expect(databaseIn({})).toBe(new URL("../hub.db", import.meta.url).pathname)
  })

  test("is hub.db in the home CLAUDE_HUB_HOME names", () => {
    expect(databaseIn({ CLAUDE_HUB_HOME: "/srv/claude-hub" })).toBe("/srv/claude-hub/hub.db")
  })

  test("is HUB_DATABASE when set, whatever the home", () => {
    expect(databaseIn({ HUB_DATABASE: "/tmp/a.db" })).toBe("/tmp/a.db")
    expect(databaseIn({ HUB_DATABASE: "/tmp/a.db", CLAUDE_HUB_HOME: "/srv/claude-hub" })).toBe(
      "/tmp/a.db",
    )
  })
})

const onDatabase = <A>(file: string, effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
  Effect.runPromise(Effect.provide(effect, databaseAt(file)))

describe("migration 0013, Session names", () => {
  test("leaves the Sessions there were unnamed, shown by their Work branch, and lets them be named", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-hub-migration-"))
    dirs.push(dir)
    const file = join(dir, "hub.db")
    await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO participants (id, login, name, created_at, updated_at)
          VALUES ('p-1', 'alice', 'Alice', 1, 1)`
        yield* sql`INSERT INTO runners (id, name, secret_hash, created_at)
          VALUES ('r-1', 'build-box', 'hash', 1)`
        // A database from before it: no name column, and the migration not yet run.
        yield* sql`ALTER TABLE sessions DROP COLUMN name`
        yield* sql`
          INSERT INTO sessions (
            id, repo, base_branch, work_branch, state, runner_id, runner_login_account,
            creator_id, created_at
          ) VALUES ('s-1', 'o/r', 'main', 'claude/s-1', 'Asleep', 'r-1', 'a@example.com', 'p-1', 1)
        `
        const deleted =
          yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'session_name' RETURNING name`
        expect(deleted).toHaveLength(1)
      }),
    )
    const after = await onDatabase(
      file,
      Effect.gen(function* () {
        const sessions = yield* Sessions
        const id = SessionId.make("s-1")
        const before = Option.getOrThrow(yield* sessions.get(id))
        yield* sessions.setName(id, "Health check")
        const named = Option.getOrThrow(yield* sessions.get(id))
        return { before: [before.workBranch, before.name], named: named.name }
      }).pipe(Effect.provide(Sessions.layer)),
    )
    expect(after).toEqual({ before: ["claude/s-1", undefined], named: "Health check" })
  })
})

describe("migration 0009, Sensitive values that need a value", () => {
  test("keeps the variables and links, and lets only a Sensitive value be null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-hub-migration-"))
    dirs.push(dir)
    const file = join(dir, "hub.db")
    await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO participants (id, login, name, created_at, updated_at)
          VALUES ('p-1', 'alice', 'Alice', 1, 1)`
        yield* sql`
          INSERT INTO shared_variables (name, kind, value, updated_by, updated_at)
          VALUES ('TOKEN', 'Sensitive', 'ciphertext', 'p-1', 1), ('HOST', 'Plain', 'a', 'p-1', 1)
        `
        yield* sql`
          INSERT INTO environments (
            repo, version, build_version, image, bootstrap_script, docker, dependency_folders,
            cpus, memory_mib
          ) VALUES ('o/r', 1, 1, 'debian', '', 0, '[]', 2, 4096)
        `
        yield* sql`
          INSERT INTO environment_variables (
            repo, name, kind, value, shared_name, available_at_build, position
          ) VALUES ('o/r', 'GH', 'Link', NULL, 'TOKEN', 0, 0)
        `
        // Run it again on these rows, as on a database from before it.
        const deleted =
          yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'values_needed' RETURNING name`
        expect(deleted).toHaveLength(1)
      }),
    )
    const after = await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE shared_variables SET value = NULL WHERE name = 'TOKEN'`
        const plainNull = yield* Effect.exit(
          sql`UPDATE shared_variables SET value = NULL WHERE name = 'HOST'`,
        )
        const dangling = yield* Effect.exit(sql`DELETE FROM shared_variables WHERE name = 'TOKEN'`)
        return {
          shared: yield* sql`SELECT name, kind, value FROM shared_variables ORDER BY name`,
          links: yield* sql`SELECT repo, name, shared_name FROM environment_variables`,
          plainNull: plainNull._tag,
          dangling: dangling._tag,
        }
      }),
    )
    expect(after).toEqual({
      shared: [
        { name: "HOST", kind: "Plain", value: "a" },
        { name: "TOKEN", kind: "Sensitive", value: null },
      ],
      links: [{ repo: "o/r", name: "GH", shared_name: "TOKEN" }],
      plainNull: "Failure",
      dangling: "Failure",
    })
  })
})
