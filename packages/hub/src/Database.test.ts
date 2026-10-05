import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ParticipantId, PromptId, QueuedPrompt, SessionId } from "@claude-hub/protocol"
import { ConfigProvider, Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import { DatabaseFile, databaseAt } from "./Database.ts"
import { PromptQueue } from "./PromptQueue.ts"
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

/**
 * Takes the database back to before migration 0014, Child Sessions: the migrator runs only the
 * migrations after the last it ran, so a test of an earlier one undoes this first.
 */
const beforeChildSessions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`DROP INDEX sessions_parent_id`
  for (const column of ["parent_id", "last_report", "last_report_at", "parent_exchanges"]) {
    yield* sql.unsafe(`ALTER TABLE sessions DROP COLUMN ${column}`)
  }
  yield* sql`ALTER TABLE queued_prompts DROP COLUMN from_session`
  yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'child_sessions'`
})

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
        yield* beforeChildSessions
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

describe("migration 0014, Child Sessions", () => {
  test("leaves the Sessions and queued prompts there were with no parent and no sending Session", async () => {
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
        yield* beforeChildSessions
        yield* sql`
          INSERT INTO sessions (
            id, repo, base_branch, work_branch, state, runner_id, runner_login_account,
            creator_id, created_at
          ) VALUES ('s-1', 'o/r', 'main', 'claude/s-1', 'Asleep', 'r-1', 'a@example.com', 'p-1', 1)
        `
        yield* sql`
          INSERT INTO queued_prompts (id, session_id, text, sender_id, queued_at)
          VALUES ('q-1', 's-1', 'Fix the test', 'p-1', 2)
        `
      }),
    )
    const after = await onDatabase(
      file,
      Effect.gen(function* () {
        const sessions = yield* Sessions
        const prompts = yield* PromptQueue
        const id = SessionId.make("s-1")
        const before = Option.getOrThrow(yield* sessions.get(id))
        const queue = yield* prompts.list(id)
        const record = yield* sessions.childRecord(id)
        return {
          parentId: before.parentId,
          children: (yield* sessions.children(id)).length,
          record,
          fromSession: queue.map((prompt) => prompt.fromSession),
        }
      }).pipe(Effect.provide([Sessions.layer, PromptQueue.layer])),
    )
    expect(after).toEqual({
      parentId: undefined,
      children: 0,
      record: { exchanges: 0 },
      fromSession: [undefined],
    })
  })

  test("keeps a prompt another Session sent with who sent it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-hub-migration-"))
    dirs.push(dir)
    const file = join(dir, "hub.db")
    const sent = await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO participants (id, login, name, created_at, updated_at)
          VALUES ('p-1', 'alice', 'Alice', 1, 1)`
        yield* sql`INSERT INTO runners (id, name, secret_hash, created_at)
          VALUES ('r-1', 'build-box', 'hash', 1)`
        yield* sql`
          INSERT INTO sessions (
            id, repo, base_branch, work_branch, state, runner_id, runner_login_account,
            creator_id, created_at
          ) VALUES ('s-1', 'o/r', 'main', 'claude/s-1', 'Asleep', 'r-1', 'a@example.com', 'p-1', 1)
        `
        const prompts = yield* PromptQueue
        const id = SessionId.make("s-1")
        yield* prompts.add(
          id,
          QueuedPrompt.make({
            id: PromptId.make("q-1"),
            text: "[Report] Done.",
            sender: { id: ParticipantId.make("p-1"), login: "alice", name: "Alice" },
            fromSession: {
              _tag: "FromChildSession",
              session: { id: SessionId.make("s-2"), title: "Docs" },
            },
            queuedAt: 2,
          }),
        )
        return (yield* prompts.list(id)).map((prompt) => prompt.fromSession)
      }).pipe(Effect.provide(PromptQueue.layer)),
    )
    expect(sent).toEqual([
      { _tag: "FromChildSession", session: { id: SessionId.make("s-2"), title: "Docs" } },
    ])
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
