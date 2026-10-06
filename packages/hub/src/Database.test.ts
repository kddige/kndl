import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentId, SessionId } from "@claude-hub/protocol"
import { ConfigProvider, Effect, Option } from "effect"
import { SqlClient } from "effect/sql"
import { DatabaseFile, databaseAt } from "./Database.ts"
import { PromptQueue } from "./PromptQueue.ts"
import { SessionLog } from "./SessionLog.ts"
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
 * Takes the database back to before migration 0017, subagents: the migrator runs only the
 * migrations after the last it ran, so a test of an earlier one undoes this first.
 */
const beforeAgents = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`DROP TABLE agents`
  yield* sql`ALTER TABLE sessions ADD COLUMN parent_id TEXT`
  yield* sql`ALTER TABLE sessions ADD COLUMN last_report TEXT`
  yield* sql`ALTER TABLE sessions ADD COLUMN last_report_at INTEGER`
  yield* sql`ALTER TABLE sessions ADD COLUMN parent_exchanges INTEGER NOT NULL DEFAULT 0`
  yield* sql`CREATE INDEX sessions_parent_id ON sessions (parent_id)`
  yield* sql`ALTER TABLE queued_prompts ADD COLUMN from_session TEXT`
  yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'agents'`
})

/** Takes the database back to before migration 0016, Claude credentials, as above. */
const beforeClaudeCredentials = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* beforeAgents
  yield* sql`DROP TABLE claude_credentials`
  yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'claude_credentials'`
})

/** Takes the database back to before migration 0015, Session models, as above. */
const beforeSessionModels = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* beforeClaudeCredentials
  for (const column of ["model", "effort", "model_pending"]) {
    yield* sql.unsafe(`ALTER TABLE sessions DROP COLUMN ${column}`)
  }
  yield* sql`ALTER TABLE runners DROP COLUMN models`
  yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'session_model'`
})

/** Takes the database back to before migration 0014, Child Sessions, as above. */
const beforeChildSessions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* beforeSessionModels
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

/** The `n`th agent a Session started. */
const agent = (n: number) => ({
  id: AgentId.make(`a-${n}`),
  description: `Task ${n}`,
  startedAt: n,
})

describe("migration 0017, subagents", () => {
  test("makes Child Sessions ordinary Sessions, and keeps their history and queue readable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-hub-migration-"))
    dirs.push(dir)
    const file = join(dir, "hub.db")
    const ref = { id: SessionId.make("s-2"), title: "Docs" }
    await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO participants (id, login, name, created_at, updated_at)
          VALUES ('p-1', 'alice', 'Alice', 1, 1)`
        yield* sql`INSERT INTO runners (id, name, secret_hash, created_at)
          VALUES ('r-1', 'build-box', 'hash', 1)`
        yield* beforeAgents
        // A parent, and its child with a Report.
        yield* sql`
          INSERT INTO sessions (
            id, repo, base_branch, work_branch, state, runner_id, runner_login_account,
            creator_id, created_at, parent_id, last_report, parent_exchanges
          ) VALUES
            ('s-1', 'o/r', 'main', 'claude/s-1', 'Asleep', 'r-1', 'a@example.com', 'p-1', 1,
              NULL, NULL, 0),
            ('s-2', 'o/r', 'main', 'claude/s-2', 'Asleep', 'r-1', 'a@example.com', 'p-1', 2,
              's-1', '{"text":"Done."}', 3)
        `
        // The child's Report, queued to the parent, and the Turn an earlier one started.
        yield* sql`
          INSERT INTO queued_prompts (id, session_id, text, sender_id, from_session, queued_at)
          VALUES ('q-1', 's-1', '[Report] Done.', 'p-1',
            ${JSON.stringify({ _tag: "FromChildSession", session: ref })}, 3)
        `
        for (const [seq, tag] of [
          [0, "FromChildSession"],
          [1, "FromChildSessionMessage"],
        ] as const) {
          yield* sql`
            INSERT INTO session_events (session_id, seq, at, event) VALUES ('s-1', ${seq}, 4,
              ${JSON.stringify({
                _tag: "TurnStarted",
                turnId: `t-${seq}`,
                text: "[Report] Done.",
                sender: { _tag: tag, session: ref },
              })})
          `
        }
        yield* sql`
          INSERT INTO session_events (session_id, seq, at, event) VALUES ('s-2', 0, 4,
            ${JSON.stringify({
              _tag: "TurnStarted",
              turnId: "t-2",
              text: "Write the docs",
              sender: { _tag: "FromParentSession", session: { id: "s-1", title: "Main" } },
            })})
        `
      }),
    )
    const after = await onDatabase(
      file,
      Effect.gen(function* () {
        const sessions = yield* Sessions
        const prompts = yield* PromptQueue
        const log = yield* SessionLog
        const senders = (id: string) =>
          Effect.map(log.history(SessionId.make(id)), (entries) =>
            entries.map((entry) =>
              entry.event._tag === "TurnStarted" ? entry.event.sender : null,
            ),
          )
        return {
          sessions: (yield* sessions.list).map((session): Array<unknown> => [
            session.id,
            session.agents,
          ]),
          queue: (yield* prompts.list(SessionId.make("s-1"))).map((prompt) => prompt.text),
          parent: yield* senders("s-1"),
          child: yield* senders("s-2"),
        }
      }).pipe(Effect.provide([Sessions.layer, PromptQueue.layer, SessionLog.layer])),
    )
    expect(after).toEqual({
      sessions: [
        ["s-1", undefined],
        ["s-2", undefined],
      ],
      queue: ["[Report] Done."],
      parent: [
        { _tag: "FromSession", session: ref },
        { _tag: "FromSession", session: ref },
      ],
      child: [{ _tag: "FromSession", session: { id: SessionId.make("s-1"), title: "Main" } }],
    })
  })

  test("keeps a Session's subagents, listing the Running and Interrupted ones on its summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-hub-migration-"))
    dirs.push(dir)
    const file = join(dir, "hub.db")
    const listed = await onDatabase(
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
          ) VALUES ('s-1', 'o/r', 'main', 'claude/s-1', 'Active', 'r-1', 'a@example.com', 'p-1', 1)
        `
        const sessions = yield* Sessions
        const id = SessionId.make("s-1")
        for (const n of [3, 1, 2]) yield* sessions.agentStarted(id, agent(n))
        yield* sessions.setAgentStatus(id, AgentId.make("a-2"), "Done")
        const unknown = yield* sessions.setAgentStatus(id, AgentId.make("a-9"), "Done")
        const interrupted = yield* sessions.interruptAgents(id)
        // A message resumes it, and Claude Code says so with SubagentStart.
        yield* sessions.setAgentStatus(id, AgentId.make("a-3"), "Running")
        const summary = Option.getOrThrow(yield* sessions.get(id))
        return {
          unknown,
          interrupted,
          agents: summary.agents,
          done: yield* sessions.agentStatus(id, AgentId.make("a-2")),
        }
      }).pipe(Effect.provide(Sessions.layer)),
    )
    expect(listed).toEqual({
      unknown: false,
      interrupted: [AgentId.make("a-1"), AgentId.make("a-3")],
      agents: [
        { id: AgentId.make("a-1"), description: "Task 1", status: "Interrupted" },
        { id: AgentId.make("a-3"), description: "Task 3", status: "Running" },
      ],
      done: Option.some("Done"),
    })
  })
})

describe("migration 0015, Session models", () => {
  test("leaves the Sessions there were on Claude Code's default, and lets their model be set", async () => {
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
        yield* beforeSessionModels
        yield* sql`
          INSERT INTO sessions (
            id, repo, base_branch, work_branch, state, runner_id, runner_login_account,
            creator_id, created_at
          ) VALUES ('s-1', 'o/r', 'main', 'claude/s-1', 'Asleep', 'r-1', 'a@example.com', 'p-1', 1)
        `
      }),
    )
    const after = await onDatabase(
      file,
      Effect.gen(function* () {
        const sessions = yield* Sessions
        const id = SessionId.make("s-1")
        const before = Option.getOrThrow(yield* sessions.get(id))
        yield* sessions.setModel(id, { model: "sonnet", effort: "high" }, true)
        const set = Option.getOrThrow(yield* sessions.get(id))
        return {
          before: [before.model, before.effort, before.modelPending],
          set: [set.model, set.effort, set.modelPending],
        }
      }).pipe(Effect.provide(Sessions.layer)),
    )
    expect(after).toEqual({
      before: [undefined, undefined, undefined],
      set: ["sonnet", "high", true],
    })
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
