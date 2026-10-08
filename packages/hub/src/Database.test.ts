import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentId, EnvironmentVersion, ParticipantId, SessionId } from "@kndl/protocol"
import { ConfigProvider, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import { CliTokens } from "./CliTokens.ts"
import { DatabaseFile, databaseAt } from "./Database.ts"
import { Members } from "./Members.ts"
import { PromptQueue } from "./PromptQueue.ts"
import { SessionLog } from "./SessionLog.ts"
import { Sessions } from "./Sessions.ts"
import { SignIns } from "./SignIns.ts"

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

  test("is hub.db in the home KNDL_HOME names", () => {
    expect(databaseIn({ KNDL_HOME: "/srv/kndl" })).toBe("/srv/kndl/hub.db")
  })

  test("is HUB_DATABASE when set, whatever the home", () => {
    expect(databaseIn({ HUB_DATABASE: "/tmp/a.db" })).toBe("/tmp/a.db")
    expect(databaseIn({ HUB_DATABASE: "/tmp/a.db", KNDL_HOME: "/srv/kndl" })).toBe("/tmp/a.db")
  })
})

const onDatabase = <A>(file: string, effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
  Effect.runPromise(Effect.provide(effect, databaseAt(file)))

/**
 * Takes the database back to before migration 0029, OAuth Installations: the migrator runs only
 * the migrations after the last it ran, so a test of an earlier one undoes this first. Dropping
 * the table undoes 0030, its client entered by hand (#218), too, and dropping the columns undoes
 * 0031, Plugin icons (#230).
 */
const beforePluginOAuth = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE plugins DROP COLUMN icon`
  yield* sql`ALTER TABLE plugins DROP COLUMN icon_type`
  yield* sql`ALTER TABLE plugins DROP COLUMN icon_hash`
  yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'plugin_icon'`
  yield* sql`DROP TABLE installation_oauth`
  yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'plugin_oauth_manual_client'`
  yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'plugin_oauth'`
})

/** Takes the database back to before migration 0028, global Installations, as above. */
const beforeGlobalInstallations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* beforePluginOAuth
  yield* sql`DROP TABLE installation_repo_off`
  yield* sql`DROP INDEX installations_one_global_per_plugin`
  yield* sql`ALTER TABLE installations DROP COLUMN global`
  yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'global_installations'`
})

/** Takes the database back to before migration 0026, Plugin packages, as above. */
const beforePluginPackages = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* beforeGlobalInstallations
  yield* sql`ALTER TABLE plugins DROP COLUMN description`
  yield* sql`ALTER TABLE plugins DROP COLUMN package`
  yield* sql`ALTER TABLE plugin_log DROP COLUMN plugin_version`
  yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'plugin_packages'`
})

/** Takes the database back to before migration 0025, header secrets, as above. */
const beforeHeaderSecrets = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* beforePluginPackages
  yield* sql`DROP TABLE session_installation_values`
  yield* sql`DROP TABLE installation_values`
  yield* sql`ALTER TABLE plugins DROP COLUMN auth`
  yield* sql`ALTER TABLE plugin_log DROP COLUMN secrets`
  yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'header_secrets'`
})

/** Takes the database back to before migration 0024, Plugins, as above. */
const beforePlugins = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* beforeHeaderSecrets
  for (const table of ["plugin_log", "installation_repos", "installations", "plugins"]) {
    yield* sql.unsafe(`DROP TABLE ${table}`)
  }
  yield* sql`ALTER TABLE sessions DROP COLUMN plugins`
  yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'plugins'`
})

/** Takes the database back to before migration 0023, Members, as above. */
const beforeMembers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* beforePlugins
  yield* sql`DROP TABLE setup_links`
  yield* sql`DROP TABLE invites`
  yield* sql`DROP INDEX participants_owner`
  yield* sql`ALTER TABLE participants DROP COLUMN owner`
  yield* sql`ALTER TABLE participants DROP COLUMN admitted_at`
  yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'members'`
})

/** Takes the database back to before migration 0022, Open questions, as above. */
const beforeOpenQuestion = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* beforeMembers
  yield* sql`ALTER TABLE sessions DROP COLUMN open_question`
  yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'open_question'`
})

/**
 * Takes the database back to before migration 0021, no WIP ref: the migrator runs only the
 * migrations after the last it ran, so a test of an earlier one undoes this first.
 */
const beforeNoWipRef = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* beforeOpenQuestion
  yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'no_wip_ref'`
})

/** Takes the database back to before migration 0020, Repo names ignoring case, as above. */
const beforeRepoNocase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* beforeNoWipRef
  yield* sql`DROP INDEX environments_repo_nocase`
  yield* sql`DROP INDEX test_builds_digest`
  yield* sql`CREATE INDEX test_builds_digest ON test_builds (repo, digest)`
  yield* sql`DROP INDEX retired_values_repo`
  yield* sql`CREATE INDEX retired_values_repo ON retired_values (repo)`
  yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'repo_nocase'`
})

/** Takes the database back to before migration 0019, CLI tokens, as above. */
const beforeCliTokens = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* beforeRepoNocase
  yield* sql`DROP TABLE cli_tokens`
  yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'cli_tokens'`
})

/** Takes the database back to before migration 0018, Keep awake, as above. */
const beforeKeepAwake = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* beforeCliTokens
  yield* sql`ALTER TABLE sessions DROP COLUMN keep_awake_by`
  yield* sql`ALTER TABLE sessions DROP COLUMN keep_awake_at`
  yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'keep_awake'`
})

/** Takes the database back to before migration 0017, subagents, as above. */
const beforeAgents = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* beforeKeepAwake
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

const membersLayer = Members.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(SignIns.layer, CliTokens.layer)),
)

describe("migration 0031, Plugin icons", () => {
  test("leaves the Plugins there were without an icon", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kndl-migration-"))
    dirs.push(dir)
    const file = join(dir, "hub.db")
    await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`ALTER TABLE plugins DROP COLUMN icon`
        yield* sql`ALTER TABLE plugins DROP COLUMN icon_type`
        yield* sql`ALTER TABLE plugins DROP COLUMN icon_hash`
        yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'plugin_icon'`
        yield* sql`INSERT INTO participants (id, login, name, created_at, updated_at)
          VALUES ('dev:alice', 'alice', 'alice', 1, 1)`
        yield* sql`INSERT INTO plugins (id, name, url, created_by, created_at)
          VALUES ('hub:docs', 'Docs', 'https://mcp.example.com/mcp', 'dev:alice', 1)`
      }),
    )
    const after = await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql`SELECT id, icon, icon_type, icon_hash FROM plugins`
      }),
    )
    expect(after).toEqual([{ id: "hub:docs", icon: null, icon_type: null, icon_hash: null }])
  })
})

describe("migration 0025, header secrets", () => {
  test("leaves the Plugins there were without header secrets, and their log without titles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kndl-migration-"))
    dirs.push(dir)
    const file = join(dir, "hub.db")
    await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* beforeHeaderSecrets
        yield* sql`INSERT INTO participants (id, login, name, created_at, updated_at)
          VALUES ('dev:alice', 'alice', 'alice', 1, 1)`
        yield* sql`INSERT INTO plugins (id, name, url, created_by, created_at)
          VALUES ('hub:docs', 'Docs', 'https://mcp.example.com/mcp', 'dev:alice', 1)`
        yield* sql`INSERT INTO installations (id, plugin_id, name, created_by, created_at)
          VALUES ('i-1', 'hub:docs', 'Docs', 'dev:alice', 1)`
        yield* sql`INSERT INTO plugin_log (id, repo, at, by, change, plugin_id, plugin_name,
            installation_id, installation_name)
          VALUES (1, 'kddige/kndl', 1, 'dev:alice', 'Created', 'hub:docs', 'Docs', 'i-1', 'Docs')`
      }),
    )
    const after = await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return {
          plugins: yield* sql`SELECT id, auth FROM plugins`,
          log: yield* sql`SELECT id, secrets FROM plugin_log`,
          values: yield* sql`SELECT * FROM installation_values`,
        }
      }),
    )
    expect(after).toEqual({
      plugins: [{ id: "hub:docs", auth: '{"_tag":"None"}' }],
      log: [{ id: 1, secrets: null }],
      values: [],
    })
  })
})

describe("migration 0026, Plugin packages", () => {
  test("leaves the Plugins there were Hub-only, and their logs as they were", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kndl-migration-"))
    dirs.push(dir)
    const file = join(dir, "hub.db")
    await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* beforePluginPackages
        yield* sql`INSERT INTO participants (id, login, name, created_at, updated_at)
          VALUES ('github:1', 'octocat', 'Octocat', 1, 1)`
        yield* sql`INSERT INTO plugins (id, name, url, created_by, created_at)
          VALUES ('hub:docs', 'Docs', 'https://mcp.example.com/mcp', 'github:1', 2)`
        yield* sql`INSERT INTO plugin_log (
            repo, at, by, change, plugin_id, plugin_name, installation_id, installation_name
          ) VALUES ('acme/app', 3, 'github:1', 'PluginEdited', 'hub:docs', 'Docs', 'in-1', 'Docs')`
      }),
    )
    const after = await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return {
          plugins: yield* sql`SELECT id, description, package FROM plugins`,
          log: yield* sql`SELECT change, plugin_version AS pluginVersion FROM plugin_log`,
        }
      }),
    )
    expect(after).toEqual({
      plugins: [{ id: "hub:docs", description: null, package: null }],
      log: [{ change: "PluginEdited", pluginVersion: null }],
    })
  })
})

describe("migration 0028, global Installations", () => {
  test("leaves the Installations there were Repo-scoped, on in the Repos they list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kndl-migration-"))
    dirs.push(dir)
    const file = join(dir, "hub.db")
    await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* beforeGlobalInstallations
        yield* sql`INSERT INTO participants (id, login, name, created_at, updated_at)
          VALUES ('github:1', 'octocat', 'Octocat', 1, 1)`
        yield* sql`INSERT INTO plugins (id, name, url, created_by, created_at)
          VALUES ('hub:docs', 'Docs', 'https://mcp.example.com/mcp', 'github:1', 2)`
        yield* sql`INSERT INTO installations (id, plugin_id, name, created_by, created_at)
          VALUES ('in-1', 'hub:docs', 'Docs', 'github:1', 3)`
        yield* sql`INSERT INTO installation_repos (installation_id, plugin_id, repo)
          VALUES ('in-1', 'hub:docs', 'acme/app')`
      }),
    )
    const after = await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return {
          installations: yield* sql`SELECT id, global FROM installations`,
          repos: yield* sql`SELECT installation_id AS id, repo FROM installation_repos`,
          off: yield* sql`SELECT * FROM installation_repo_off`,
        }
      }),
    )
    expect(after).toEqual({
      installations: [{ id: "in-1", global: 0 }],
      repos: [{ id: "in-1", repo: "acme/app" }],
      off: [],
    })
  })
})

describe("migration 0023, Members", () => {
  test("admits everyone there was, and makes the earliest from GitHub the Owner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kndl-migration-"))
    dirs.push(dir)
    const file = join(dir, "hub.db")
    const token = await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const signedIn = yield* (yield* SignIns).signIn({
          id: ParticipantId.make("github:2"),
          login: "bob",
          name: "Bob",
        })
        yield* beforeMembers
        // Dev login's Participant is the earliest, but never the Owner.
        yield* sql`INSERT INTO participants (id, login, name, created_at, updated_at)
          VALUES ('dev:alice', 'alice', 'alice', 1, 1)`
        yield* sql`INSERT INTO participants (id, login, name, created_at, updated_at)
          VALUES ('github:3', 'carol', 'Carol', 3, 3)`
        yield* sql`INSERT INTO participants (id, login, name, created_at, updated_at)
          VALUES ('github:4', 'dave', 'Dave', 4, 4)`
        return signedIn.token
      }).pipe(Effect.provide(SignIns.layer)),
    )
    const after = await onDatabase(
      file,
      Effect.gen(function* () {
        const members = yield* Members
        const signedIn = yield* (yield* SignIns).authenticate(token)
        return {
          members: (yield* members.list).map((member) => [
            member.participant.id,
            member.owner,
            member.admittedAt,
          ]),
          owner: yield* members.owner,
          signedIn: Option.map(signedIn, (participant) => participant.login),
          setupLink: yield* Effect.flip(members.newSetupLink),
        }
      }).pipe(Effect.provide(membersLayer)),
    )
    expect(after.members).toEqual([
      ["github:3", true, 3],
      ["dev:alice", false, 1],
      ["github:4", false, 4],
      ["github:2", false, expect.any(Number)],
    ])
    expect(after.owner).toEqual(Option.some(ParticipantId.make("github:3")))
    // Everyone signed in before stays signed in.
    expect(after.signedIn).toEqual(Option.some("bob"))
    expect(after.setupLink._tag).toBe("SetupLinkRefused")
  })

  test("leaves a Hub no one signed in to with GitHub without an Owner, so it takes a Setup link", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kndl-migration-"))
    dirs.push(dir)
    const file = join(dir, "hub.db")
    await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* beforeMembers
        yield* sql`INSERT INTO participants (id, login, name, created_at, updated_at)
          VALUES ('dev:alice', 'alice', 'alice', 1, 1)`
      }),
    )
    const after = await onDatabase(
      file,
      Effect.gen(function* () {
        const members = yield* Members
        return {
          owner: yield* members.owner,
          members: (yield* members.list).map((member) => member.participant.id as string),
          setupLink: yield* members.newSetupLink,
        }
      }).pipe(Effect.provide(membersLayer)),
    )
    expect(after.owner).toEqual(Option.none())
    expect(after.members).toEqual(["dev:alice"])
    expect(after.setupLink).toMatch(/^cho_/)
  })
})

describe("migration 0013, Session names", () => {
  test("leaves the Sessions there were unnamed, shown by their Work branch, and lets them be named", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kndl-migration-"))
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
    const dir = mkdtempSync(join(tmpdir(), "kndl-migration-"))
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
    const dir = mkdtempSync(join(tmpdir(), "kndl-migration-"))
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

describe("migration 0018, Keep awake", () => {
  test("leaves the Sessions there were with it off, and keeps who turned it on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kndl-migration-"))
    dirs.push(dir)
    const file = join(dir, "hub.db")
    await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO participants (id, login, name, created_at, updated_at)
          VALUES ('p-1', 'alice', 'Alice', 1, 1)`
        yield* sql`INSERT INTO participants (id, login, name, avatar_url, created_at, updated_at)
          VALUES ('p-2', 'bob', 'Bob', 'https://avatars.githubusercontent.com/u/2', 1, 1)`
        yield* sql`INSERT INTO runners (id, name, secret_hash, created_at)
          VALUES ('r-1', 'build-box', 'hash', 1)`
        yield* beforeKeepAwake
        yield* sql`
          INSERT INTO sessions (
            id, repo, base_branch, work_branch, state, runner_id, runner_login_account,
            creator_id, created_at
          ) VALUES ('s-1', 'o/r', 'main', 'claude/s-1', 'Asleep', 'r-1', 'a@example.com', 'p-1', 1)
        `
      }),
    )
    const id = SessionId.make("s-1")
    const before = await onDatabase(
      file,
      Effect.gen(function* () {
        const sessions = yield* Sessions
        const old = Option.getOrThrow(yield* sessions.get(id))
        yield* sessions.setKeepAwake(id, { by: ParticipantId.make("p-2"), at: 5 })
        return old.keepAwake
      }).pipe(Effect.provide(Sessions.layer)),
    )
    expect(before).toBeUndefined()

    // It stays on through a Hub restart, until turned off.
    const after = await onDatabase(
      file,
      Effect.gen(function* () {
        const sessions = yield* Sessions
        const on = Option.getOrThrow(yield* sessions.get(id)).keepAwake
        yield* sessions.setKeepAwake(id, null)
        const off = Option.getOrThrow(yield* sessions.get(id)).keepAwake
        return { on, off }
      }).pipe(Effect.provide(Sessions.layer)),
    )
    expect(after).toEqual({
      on: {
        by: {
          id: ParticipantId.make("p-2"),
          login: "bob",
          name: "Bob",
          avatarUrl: "https://avatars.githubusercontent.com/u/2",
        },
        at: 5,
      },
      off: undefined,
    })
  })
})

describe("migration 0021, no WIP ref", () => {
  test("drops the failed WIP pushes from a Session's history, and keeps the rest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kndl-migration-"))
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
        yield* sql`
          INSERT INTO sessions (
            id, repo, base_branch, work_branch, state, runner_id, runner_login_account,
            creator_id, created_at
          ) VALUES ('s-1', 'acme/web', 'main', 'claude/s-1', 'Asleep', 'r-1',
            'a@example.com', 'p-1', 1)
        `
        yield* beforeNoWipRef
        // From before #194: a failed WIP push between two notes.
        for (const [seq, event] of [
          [0, { _tag: "SandboxNoted", message: "Capped at 4 CPUs" }],
          [1, { _tag: "WipNotPushed", message: "git push exited with 128" }],
          [2, { _tag: "SandboxNoted", message: "Capped at 8 GiB" }],
        ] as const) {
          yield* sql`
            INSERT INTO session_events (session_id, seq, at, event)
            VALUES ('s-1', ${seq}, 2, ${JSON.stringify(event)})
          `
        }
      }),
    )
    const history = await onDatabase(
      file,
      Effect.gen(function* () {
        const log = yield* SessionLog
        return yield* log.history(SessionId.make("s-1"))
      }).pipe(Effect.provide(SessionLog.layer)),
    )
    expect(history.map((entry): Array<unknown> => [entry.seq, entry.event])).toEqual([
      [0, { _tag: "SandboxNoted", message: "Capped at 4 CPUs" }],
      [2, { _tag: "SandboxNoted", message: "Capped at 8 GiB" }],
    ])
  })
})

describe("migration 0020, Repo names ignoring case", () => {
  test("leaves the rows there were, and finds a Repo's Environment by any spelling", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kndl-migration-"))
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
        yield* beforeRepoNocase
        // From before #197: two spellings of one Repo, each with an Environment.
        yield* sql`
          INSERT INTO environments (
            repo, version, build_version, image, bootstrap_script, docker, dependency_folders,
            cpus, memory_mib
          ) VALUES ('Entria-io/PEP', 3, 1, 'debian', '', 0, '[]', 2, 4096),
            ('entria-io/PEP', 1, 1, 'debian', '', 0, '[]', 2, 4096)
        `
        yield* sql`
          INSERT INTO sessions (
            id, repo, base_branch, work_branch, state, runner_id, runner_login_account,
            creator_id, created_at
          ) VALUES ('s-1', 'entria-io/pep', 'main', 'claude/s-1', 'Asleep', 'r-1',
            'a@example.com', 'p-1', 1)
        `
      }),
    )
    const after = await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const sessions = yield* Sessions
        const session = Option.getOrThrow(yield* sessions.get(SessionId.make("s-1")))
        return {
          environments: yield* sql`SELECT repo, version FROM environments ORDER BY repo`,
          environment: session.environment,
        }
      }).pipe(Effect.provide(Sessions.layer)),
    )
    expect(after).toEqual({
      environments: [
        { repo: "Entria-io/PEP", version: 3 },
        { repo: "entria-io/PEP", version: 1 },
      ],
      // Neither spelling is the Session's own, so the first of them, as SQLite orders them.
      environment: { version: null, latestVersion: EnvironmentVersion.make(3) },
    })
  })
})

describe("migration 0015, Session models", () => {
  test("leaves the Sessions there were on Claude Code's default, and lets their model be set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kndl-migration-"))
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
    const dir = mkdtempSync(join(tmpdir(), "kndl-migration-"))
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
