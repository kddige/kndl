import { afterEach, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { join } from "node:path"
import {
  AgentId,
  AttachmentId,
  ConversationId,
  EnvironmentVersion,
  ParticipantId,
  RunnerId,
  SessionId,
} from "@kndl/protocol"
import { ConfigProvider, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import { Attachments } from "./Attachments.ts"
import { CliTokens } from "./CliTokens.ts"
import { DatabaseFile, databaseAt } from "./Database.ts"
import { Members } from "./Members.ts"
import { PromptQueue } from "./PromptQueue.ts"
import { SessionLog } from "./SessionLog.ts"
import { Sessions } from "./Sessions.ts"
import { SignIns } from "./SignIns.ts"
import { SessionsTest, testDatabaseDir } from "./testSupport.ts"

const dirs: Array<string> = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const databaseIn = (env: Record<string, string>) =>
  Effect.runSync(DatabaseFile.parse(ConfigProvider.fromEnv({ env })))

describe("the Hub's database", () => {
  test("is hub.db in packages/hub from a checkout, in the home KNDL_HOME names, or HUB_DATABASE", () => {
    // Not in the dev home from a checkout.
    expect(databaseIn({})).toBe(new URL("../hub.db", import.meta.url).pathname)
    expect(databaseIn({ KNDL_HOME: "/srv/kndl" })).toBe("/srv/kndl/hub.db")
    expect(databaseIn({ HUB_DATABASE: "/tmp/a.db" })).toBe("/tmp/a.db")
    expect(databaseIn({ HUB_DATABASE: "/tmp/a.db", KNDL_HOME: "/srv/kndl" })).toBe("/tmp/a.db")
  })
})

const onDatabase = <A>(file: string, effect: Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
  Effect.runPromise(Effect.provide(effect, databaseAt(file)))

/**
 * Takes the database back to before migration 0045, each subagent's Harness (ADR 0030): the
 * migrator runs only the migrations after the last it ran, so a test of an earlier one undoes this
 * first.
 */
const beforeAgentHarness = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE agents DROP COLUMN harness`
  yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'agent_harness'`
})

/**
 * Takes the database back to before migration 0044, a Member's Harness for Claude (ADR 0030), and
 * 0045.
 */
const beforeClaudeHarness = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* beforeAgentHarness
  yield* sql`ALTER TABLE participants DROP COLUMN claude_harness`
  yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'claude_harness'`
})

/**
 * Takes the database back to before migration 0043, each Harness's conversation (ADR 0030), and
 * 0044. A conversation recorded since is lost.
 */
const beforeSessionConversations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* beforeClaudeHarness
  yield* sql`DROP TABLE session_conversations`
  yield* sql`ALTER TABLE sessions DROP COLUMN handoff_from`
  yield* sql`ALTER TABLE sessions ADD COLUMN conversation_id TEXT`
  yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'session_conversations'`
})

/**
 * Takes the database back to before migration 0042, a Session's Harness (ADR 0029), and the ones
 * after it.
 */
const beforeSessionHarness = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* beforeSessionConversations
  yield* sql`ALTER TABLE sessions DROP COLUMN harness`
  yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'session_harness'`
})

/**
 * Takes the database back to before migration 0041, Connected providers (ADR 0029), and 0042: the
 * migrator runs only the migrations after the last it ran, so a test of an earlier one undoes this
 * first.
 */
const beforeConnectedProviders = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* beforeSessionHarness
  yield* sql`DROP TABLE connected_providers`
  yield* sql`DROP TABLE hub_device`
  yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'connected_providers'`
})

/**
 * Takes the database back to before migration 0040, pi-ai's vocabulary (ADR 0029), and the ones
 * after it. The JSON it rewrote is left as it is: a test inserts what it needs after this.
 */
const beforeNeutralVocabulary = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* beforeConnectedProviders
  yield* sql`ALTER TABLE sessions RENAME COLUMN thinking_level TO effort`
  yield* sql`ALTER TABLE sessions RENAME COLUMN conversation_id TO claude_session_id`
  yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'neutral_vocabulary'`
})

/**
 * Takes the database back to before migration 0039, the Hub's last update check (ADR 0028), and
 * 0040.
 */
const beforeHubUpdateCheck = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* beforeNeutralVocabulary
  yield* sql`DROP TABLE hub_update_check`
  yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'hub_update_check'`
})

/** Takes the database back to before migration 0038, a Runner's memory and load history (#356), and 0039. */
const beforeRunnerHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* beforeHubUpdateCheck
  yield* sql`DROP INDEX runner_history_at`
  yield* sql`ALTER TABLE runner_history DROP COLUMN load_1`
  yield* sql`ALTER TABLE runner_history DROP COLUMN memory_available_bytes`
  yield* sql`ALTER TABLE runner_history RENAME COLUMN disk_free_bytes TO free_bytes`
  yield* sql`ALTER TABLE runner_history RENAME TO runner_disk_history`
  yield* sql`CREATE INDEX runner_disk_history_at ON runner_disk_history (at)`
  yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'runner_history'`
})

/** Takes the database back to before migration 0037, a Runner's disk-free history (#350), and 0038. */
const beforeRunnerDiskHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* beforeRunnerHistory
  yield* sql`DROP TABLE runner_disk_history`
  yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'runner_disk_history'`
})

/**
 * Takes the database back to before migration 0036, the Creator drives (ADR 0026), and 0037. A
 * Session's Runner login was NOT NULL with no default, which a column added can't be.
 */
const beforeCreatorDrives = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* beforeRunnerDiskHistory
  yield* sql`ALTER TABLE runners ADD COLUMN login_account TEXT`
  yield* sql`ALTER TABLE sessions ADD COLUMN runner_login_account TEXT NOT NULL DEFAULT ''`
  yield* sql`ALTER TABLE claude_credentials ADD COLUMN plan TEXT`
  yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'creator_drives'`
})

/** Takes the database back to before migration 0035, a Runner's Release (ADR 0025), and 0036. */
const beforeRunnerRelease = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* beforeCreatorDrives
  yield* sql`ALTER TABLE runners DROP COLUMN version_release`
  yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'runner_release'`
})

/** Takes the database back to before migration 0034, attachments' sent_at (#280), and 0035. */
const beforeAttachmentsSent = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* beforeRunnerRelease
  yield* sql`DROP INDEX attachments_unsent`
  yield* sql`ALTER TABLE attachments DROP COLUMN sent_at`
  yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'attachments_sent'`
})

/** Takes the database back to before migration 0033, attachments (#276), and the ones after. */
const beforeAttachments = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* beforeAttachmentsSent
  yield* sql`DROP TABLE attachments`
  yield* sql`ALTER TABLE queued_prompts DROP COLUMN attachments`
  yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'attachments'`
})

/**
 * Takes the database back to before migration 0032, Plugins named MCP servers (#232), and the
 * migrations after it.
 */
const beforeMcpServers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* beforeAttachments
  yield* sql`
    UPDATE sessions SET mcp_servers = REPLACE(REPLACE(REPLACE(mcp_servers,
      '"mcpServerId":', '"pluginId":'),
      '"mcpServerName":', '"pluginName":'),
      '"mcpServerVersion":', '"pluginVersion":')
    WHERE mcp_servers IS NOT NULL
  `
  yield* sql`UPDATE mcp_server_log SET change = 'PluginEdited' WHERE change = 'McpServerEdited'`
  yield* sql`UPDATE mcp_server_log SET change = 'PluginUpgraded' WHERE change = 'McpServerUpgraded'`
  yield* sql`DROP INDEX mcp_server_log_repo`
  yield* sql`DROP INDEX installations_one_global_per_mcp_server`
  yield* sql`DROP INDEX installation_repos_one_per_mcp_server`
  yield* sql`DROP INDEX installations_mcp_server_id`
  yield* sql`ALTER TABLE sessions RENAME COLUMN mcp_servers TO plugins`
  yield* sql`ALTER TABLE mcp_server_log RENAME COLUMN mcp_server_version TO plugin_version`
  yield* sql`ALTER TABLE mcp_server_log RENAME COLUMN mcp_server_name TO plugin_name`
  yield* sql`ALTER TABLE mcp_server_log RENAME COLUMN mcp_server_id TO plugin_id`
  yield* sql`ALTER TABLE mcp_server_log RENAME TO plugin_log`
  yield* sql`ALTER TABLE installation_repos RENAME COLUMN mcp_server_id TO plugin_id`
  yield* sql`ALTER TABLE installations RENAME COLUMN mcp_server_id TO plugin_id`
  yield* sql`ALTER TABLE mcp_servers RENAME TO plugins`
  yield* sql`CREATE INDEX installations_plugin_id ON installations (plugin_id)`
  yield* sql`
    CREATE UNIQUE INDEX installation_repos_one_per_plugin
    ON installation_repos (plugin_id, repo COLLATE NOCASE)
  `
  yield* sql`
    CREATE UNIQUE INDEX installations_one_global_per_plugin
    ON installations (plugin_id) WHERE global = 1
  `
  yield* sql`CREATE INDEX plugin_log_repo ON plugin_log (repo COLLATE NOCASE, at)`
  yield* sql`DELETE FROM effect_sql_migrations WHERE name = 'mcp_servers'`
})

/**
 * Takes the database back to before migration 0029, OAuth Installations: the migrator runs only
 * the migrations after the last it ran, so a test of an earlier one undoes this first. Dropping
 * the table undoes 0030, its client entered by hand (#218), too, and dropping the columns undoes
 * 0031, Plugin icons (#230).
 */
const beforePluginOAuth = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* beforeMcpServers
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

const membersLayer = Members.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(SignIns.layer, CliTokens.layer)),
)

describe("migration 0041, Connected providers", () => {
  test("keeps every Member, and a person's Connected providers go with them", async () => {
    const dir = testDatabaseDir("kndl-migration-")
    dirs.push(dir)
    const file = join(dir, "hub.db")
    await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* beforeConnectedProviders
        yield* sql`INSERT INTO participants (id, login, name, created_at, updated_at)
          VALUES ('p-1', 'alice', 'Alice', 1, 1)`
      }),
    )
    const after = await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`PRAGMA foreign_keys = ON`
        yield* sql`INSERT INTO connected_providers
          (participant_id, provider, kind, credential, label, connected_at)
          VALUES ('p-1', 'openai', 'ApiKey', 'sealed', 'abcd', 2)`
        const kept = yield* sql`
          SELECT participant_id AS participantId, provider, kind, label, models,
            models_checked_at AS modelsCheckedAt, models_problem AS modelsProblem, problem
          FROM connected_providers
        `
        const people = yield* sql`SELECT id FROM participants`
        yield* sql`DELETE FROM participants WHERE id = 'p-1'`
        return {
          kept,
          people,
          left: yield* sql`SELECT * FROM connected_providers`,
          device: yield* sql`SELECT * FROM hub_device`,
        }
      }),
    )
    expect(after.people).toEqual([{ id: "p-1" }])
    expect(after.kept).toEqual([
      {
        participantId: "p-1",
        provider: "openai",
        kind: "ApiKey",
        label: "abcd",
        models: "[]",
        modelsCheckedAt: null,
        modelsProblem: null,
        problem: null,
      },
    ])
    expect(after.left).toEqual([])
    // The Hub's device id is made when a sign-in first needs it.
    expect(after.device).toEqual([])
  })
})

describe("migration 0044, a Member's Harness for Claude", () => {
  test("keeps every Member, on Claude Code until they choose pi", async () => {
    const dir = testDatabaseDir("kndl-migration-")
    dirs.push(dir)
    const file = join(dir, "hub.db")
    await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* beforeClaudeHarness
        yield* sql`INSERT INTO participants (id, login, name, created_at, updated_at)
          VALUES ('p-1', 'alice', 'Alice', 1, 1), ('p-2', 'bob', 'Bob', 1, 1)`
      }),
    )
    const after = await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE participants SET claude_harness = 'Pi' WHERE id = 'p-2'`
        return yield* sql<{ readonly id: string; readonly claudeHarness: string | null }>`
          SELECT id, claude_harness AS claudeHarness FROM participants ORDER BY id
        `
      }),
    )
    expect(after).toEqual([
      { id: "p-1", claudeHarness: null },
      { id: "p-2", claudeHarness: "Pi" },
    ])
  })
})

describe("migration 0043, each Harness's conversation", () => {
  test("keeps each Session's conversation as its Harness's, and a purge forgets them", async () => {
    const dir = testDatabaseDir("kndl-migration-")
    dirs.push(dir)
    const file = join(dir, "hub.db")
    const conversation = ConversationId.make("0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f")
    await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* beforeSessionConversations
        yield* sql`INSERT INTO participants (id, login, name, created_at, updated_at)
          VALUES ('p-1', 'alice', 'Alice', 1, 1)`
        yield* sql`INSERT INTO runners (id, name, secret_hash, created_at)
          VALUES ('r-1', 'build-box', 'hash', 1)`
        yield* sql`
          INSERT INTO sessions (
            id, repo, base_branch, work_branch, state, runner_id, creator_id, created_at, harness,
            conversation_id
          ) VALUES
            ('s-1', 'o/r', 'main', 'claude/s-1', 'Asleep', 'r-1', 'p-1', 1, NULL, ${conversation}),
            ('s-2', 'o/r', 'main', 'claude/s-2', 'Asleep', 'r-1', 'p-1', 1, 'Pi', ${conversation}),
            ('s-3', 'o/r', 'main', 'claude/s-3', 'Asleep', 'r-1', 'p-1', 1, NULL, NULL)
        `
      }),
    )
    const after = await onDatabase(
      file,
      Effect.gen(function* () {
        const sessions = yield* Sessions
        const sql = yield* SqlClient.SqlClient
        const of = (id: string, harness: "ClaudeCode" | "Pi") =>
          Effect.map(sessions.conversationId(SessionId.make(id), harness), Option.getOrUndefined)
        const found = {
          claudeCode: yield* of("s-1", "ClaudeCode"),
          notPi: yield* of("s-1", "Pi"),
          pi: yield* of("s-2", "Pi"),
          notClaudeCode: yield* of("s-2", "ClaudeCode"),
          none: yield* of("s-3", "ClaudeCode"),
        }
        const s1 = Option.getOrThrow(yield* sessions.get(SessionId.make("s-1")))
        yield* sessions.purge(s1, 2)
        const left = yield* sql<{ readonly id: string }>`
          SELECT session_id AS id FROM session_conversations ORDER BY session_id
        `
        return { found, left: left.map((row) => row.id) }
      }).pipe(Effect.provide(SessionsTest)),
    )
    expect(after.found).toEqual({
      claudeCode: conversation,
      notPi: undefined,
      pi: conversation,
      notClaudeCode: undefined,
      none: undefined,
    })
    expect(after.left).toEqual(["s-2"])
  })
})

describe("migration 0042, a Session's Harness", () => {
  test("a Session from before runs Claude Code, and a new one keeps its Harness", async () => {
    const dir = testDatabaseDir("kndl-migration-")
    dirs.push(dir)
    const file = join(dir, "hub.db")
    await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* beforeSessionHarness
        yield* sql`INSERT INTO participants (id, login, name, created_at, updated_at)
          VALUES ('p-1', 'alice', 'Alice', 1, 1)`
        yield* sql`INSERT INTO runners (id, name, secret_hash, created_at)
          VALUES ('r-1', 'build-box', 'hash', 1)`
        yield* sql`
          INSERT INTO sessions (
            id, repo, base_branch, work_branch, state, runner_id, creator_id, created_at, model
          ) VALUES ('s-1', 'o/r', 'main', 'claude/s-1', 'Asleep', 'r-1', 'p-1', 1, 'sonnet')
        `
      }),
    )
    const after = await onDatabase(
      file,
      Effect.gen(function* () {
        const sessions = yield* Sessions
        const pi = yield* sessions.create({
          id: SessionId.make("s-2"),
          repo: "o/r",
          baseBranch: "main",
          workBranch: "claude/s-2",
          state: "Active",
          runnerId: RunnerId.make("r-1"),
          creatorId: ParticipantId.make("p-1"),
          createdAt: 2,
          harness: "Pi",
          model: "openai/gpt-6-sol",
        })
        const before = Option.getOrThrow(yield* sessions.get(SessionId.make("s-1")))
        return { before, pi }
      }).pipe(Effect.provide(SessionsTest)),
    )
    expect(after.before).not.toHaveProperty("harness")
    expect(after.before.model).toBe("sonnet")
    expect(after.pi).toMatchObject({ harness: "Pi", model: "openai/gpt-6-sol" })
  })
})

describe("migration 0040, pi-ai's vocabulary", () => {
  test("keeps each Session's history, thinking level and conversation, in pi-ai's names", async () => {
    const dir = testDatabaseDir("kndl-migration-")
    dirs.push(dir)
    const file = join(dir, "hub.db")
    const alice = { id: ParticipantId.make("p-1"), login: "alice", name: "Alice" }
    const conversation = ConversationId.make("0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f")
    await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* beforeNeutralVocabulary
        yield* sql`INSERT INTO participants (id, login, name, created_at, updated_at)
          VALUES ('p-1', 'alice', 'Alice', 1, 1)`
        // Its models as a Runner from before said them.
        yield* sql`INSERT INTO runners (id, name, secret_hash, created_at, models)
          VALUES ('r-1', 'build-box', 'hash', 1, ${JSON.stringify({
            default: { alias: "default", id: "claude-opus-5-5", label: "Opus 5.5", effort: true },
            models: [],
            efforts: ["low", "high"],
          })})`
        yield* sql`
          INSERT INTO sessions (
            id, repo, base_branch, work_branch, state, runner_id, creator_id, created_at, model,
            effort, claude_session_id
          ) VALUES ('s-1', 'o/r', 'main', 'claude/s-1', 'Asleep', 'r-1', 'p-1', 1, 'sonnet',
            'high', ${conversation})
        `
        // A Turn ended for each reason there was, the first with its usage, and two switches.
        for (const [seq, event] of [
          [
            0,
            {
              _tag: "TurnEnded",
              turnId: "t-0",
              reason: "Answered",
              durationMs: 5200,
              usage: {
                model: "claude-opus-5-5",
                inputTokens: 1200,
                outputTokens: 300,
                cacheReadInputTokens: 40000,
                cacheCreationInputTokens: 7,
              },
            },
          ],
          [1, { _tag: "TurnEnded", turnId: "t-1", reason: "Stopped", durationMs: 800 }],
          [
            2,
            { _tag: "TurnEnded", turnId: "t-2", agentId: "a-1", reason: "Refused", durationMs: 1 },
          ],
          [3, { _tag: "TurnEnded", turnId: "t-3", reason: "Failed", durationMs: 2 }],
          [4, { _tag: "ModelSwitched", by: alice, model: "sonnet", effort: "high" }],
          [5, { _tag: "ModelSwitched", by: alice }],
          [6, { _tag: "SandboxNoted", message: "Capped at 4 CPUs" }],
        ] as const) {
          yield* sql`
            INSERT INTO session_events (session_id, seq, at, event)
            VALUES ('s-1', ${seq}, 2, ${JSON.stringify(event)})
          `
        }
      }),
    )
    const after = await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const sessions = yield* Sessions
        const log = yield* SessionLog
        const id = SessionId.make("s-1")
        const session = Option.getOrThrow(yield* sessions.get(id))
        return {
          history: (yield* log.history(id)).map((entry): unknown => entry.event),
          setting: { model: session.model, thinkingLevel: session.thinkingLevel },
          conversation: yield* sessions.conversationId(id, "ClaudeCode"),
          runnerModels: yield* sql`SELECT models FROM runners`,
        }
      }).pipe(Effect.provide([SessionsTest, SessionLog.layer])),
    )
    expect(after).toEqual({
      history: [
        {
          _tag: "TurnEnded",
          turnId: "t-0",
          reason: "stop",
          durationMs: 5200,
          usage: {
            model: "claude-opus-5-5",
            input: 1200,
            output: 300,
            cacheRead: 40000,
            cacheWrite: 7,
          },
        },
        { _tag: "TurnEnded", turnId: "t-1", reason: "aborted", durationMs: 800 },
        { _tag: "TurnEnded", turnId: "t-2", agentId: "a-1", reason: "error", durationMs: 1 },
        { _tag: "TurnEnded", turnId: "t-3", reason: "error", durationMs: 2 },
        { _tag: "ModelSwitched", by: alice, model: "sonnet", thinkingLevel: "high" },
        { _tag: "ModelSwitched", by: alice },
        { _tag: "SandboxNoted", message: "Capped at 4 CPUs" },
      ],
      setting: { model: "sonnet", thinkingLevel: "high" },
      conversation: Option.some(conversation),
      // Its next hello says them again, in the new names.
      runnerModels: [{ models: null }],
    })
  })
})

describe("migration 0038, a Runner's memory and load history", () => {
  test("keeps each disk-free point, without memory or load", async () => {
    const dir = testDatabaseDir("kndl-migration-")
    dirs.push(dir)
    const file = join(dir, "hub.db")
    await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* beforeRunnerHistory
        yield* sql`INSERT INTO runners (id, name, secret_hash, created_at)
          VALUES ('r-1', 'build-box', 'hash', 1)`
        yield* sql`INSERT INTO runner_disk_history (runner_id, bucket, at, free_bytes)
          VALUES ('r-1', 1, 300000, 5)`
      }),
    )
    const after = await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO runner_history
          (runner_id, bucket, at, disk_free_bytes, memory_available_bytes, load_1)
          VALUES ('r-1', 2, 600000, 4, 7, 0.5)`
        return yield* sql`
          SELECT bucket, disk_free_bytes AS diskFreeBytes,
            memory_available_bytes AS memoryAvailableBytes, load_1 AS load1
          FROM runner_history ORDER BY bucket
        `
      }),
    )
    expect(after).toEqual([
      { bucket: 1, diskFreeBytes: 5, memoryAvailableBytes: null, load1: null },
      { bucket: 2, diskFreeBytes: 4, memoryAvailableBytes: 7, load1: 0.5 },
    ])
  })
})

describe("migration 0037, a Runner's disk-free history", () => {
  test("keeps every Runner, and drops a deleted Runner's points with it", async () => {
    const dir = testDatabaseDir("kndl-migration-")
    dirs.push(dir)
    const file = join(dir, "hub.db")
    await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* beforeRunnerDiskHistory
        yield* sql`INSERT INTO runners (id, name, secret_hash, created_at)
          VALUES ('r-1', 'build-box', 'hash', 1)`
      }),
    )
    const after = await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`PRAGMA foreign_keys = ON`
        // As migration 0038 renamed it.
        yield* sql`INSERT INTO runner_history (runner_id, bucket, at, disk_free_bytes)
          VALUES ('r-1', 1, 300000, 5)`
        const kept =
          yield* sql`SELECT runner_id AS runnerId, disk_free_bytes AS freeBytes FROM runner_history`
        yield* sql`DELETE FROM runners WHERE id = 'r-1'`
        return { kept, left: yield* sql`SELECT runner_id FROM runner_history` }
      }),
    )
    expect(after.kept).toEqual([{ runnerId: "r-1", freeBytes: 5 }])
    expect(after.left).toEqual([])
  })
})

describe("migration 0036, the Creator drives", () => {
  test("keeps every Runner, Session and Claude credential, without their Runner login or plan", async () => {
    const dir = testDatabaseDir("kndl-migration-")
    dirs.push(dir)
    const file = join(dir, "hub.db")
    await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* beforeCreatorDrives
        yield* sql`INSERT INTO participants (id, login, name, created_at, updated_at)
          VALUES ('p-1', 'alice', 'Alice', 1, 1)`
        yield* sql`INSERT INTO runners (id, name, secret_hash, created_at, login_account)
          VALUES ('r-1', 'build-box', 'hash', 1, 'a@example.com')`
        yield* sql`
          INSERT INTO sessions (id, repo, base_branch, work_branch, state, runner_id,
            runner_login_account, creator_id, created_at)
          VALUES ('s-1', 'o/r', 'main', 'claude/s-1', 'Asleep', 'r-1', 'a@example.com', 'p-1', 1)
        `
        yield* sql`
          INSERT INTO claude_credentials (participant_id, kind, ciphertext, last4, plan, added_at)
          VALUES ('p-1', 'OAuthToken', 'sealed', '9f3b', 'max5x', 1)
        `
      }),
    )
    const after = await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const columns = (table: string) =>
          Effect.map(
            sql.unsafe<{ readonly name: string }>(`SELECT name FROM pragma_table_info('${table}')`),
            (rows) => rows.map((row) => row.name),
          )
        return {
          runners: yield* sql`SELECT id FROM runners`,
          sessions: yield* sql`SELECT id FROM sessions`,
          credentials:
            yield* sql`SELECT participant_id AS participantId, last4 FROM claude_credentials`,
          runnerColumns: yield* columns("runners"),
          sessionColumns: yield* columns("sessions"),
          credentialColumns: yield* columns("claude_credentials"),
        }
      }),
    )
    expect(after.runners).toEqual([{ id: "r-1" }])
    expect(after.sessions).toEqual([{ id: "s-1" }])
    expect(after.credentials).toEqual([{ participantId: "p-1", last4: "9f3b" }])
    expect(after.runnerColumns).not.toContain("login_account")
    expect(after.sessionColumns).not.toContain("runner_login_account")
    expect(after.credentialColumns).not.toContain("plan")
  })
})

describe("migration 0034, attachments' sent_at", () => {
  test("counts the files kept before it sent, so the Hub never deletes them unsent", async () => {
    const dir = testDatabaseDir("kndl-migration-")
    dirs.push(dir)
    const file = join(dir, "hub.db")
    await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* beforeAttachmentsSent
        yield* sql`INSERT INTO participants (id, login, name, created_at, updated_at)
          VALUES ('p-1', 'alice', 'Alice', 1, 1)`
        yield* sql`INSERT INTO runners (id, name, secret_hash, created_at)
          VALUES ('r-1', 'build-box', 'hash', 1)`
        yield* sql`
          INSERT INTO sessions (id, repo, base_branch, work_branch, state, runner_id,
            runner_login_account, creator_id, created_at)
          VALUES ('s-1', 'o/r', 'main', 'claude/s-1', 'Asleep', 'r-1', 'a@example.com', 'p-1', 1)
        `
        // Uploaded long before the day an unsent file lasts.
        yield* sql`
          INSERT INTO attachments
            (id, session_id, name, media_type, size, data, uploaded_by, uploaded_at)
          VALUES ('a-1', 's-1', 'shot.png', 'image/png', 1, ${new Uint8Array([1])}, 'p-1', 1)
        `
      }),
    )
    // The Hub starts, and sweeps.
    const kept = await onDatabase(
      file,
      Effect.flatMap(Attachments, (attachments) =>
        attachments.get(SessionId.make("s-1"), AttachmentId.make("a-1")),
      ).pipe(Effect.provide(Attachments.layer)),
    )
    expect(Option.isSome(kept)).toBe(true)
  })
})

describe("migration 0032, Plugins named MCP servers", () => {
  test("keeps every Plugin, Installation, log entry and Session's Installations, by their new names", async () => {
    const dir = testDatabaseDir("kndl-migration-")
    dirs.push(dir)
    const file = join(dir, "hub.db")
    const started = JSON.stringify([
      {
        id: "i-1",
        name: 'Say "pluginId": hi',
        pluginId: "hub:docs",
        pluginName: "Docs",
        pluginVersion: "1.0.0",
        server: "docs",
      },
    ])
    await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* beforeMcpServers
        yield* sql`INSERT INTO participants (id, login, name, created_at, updated_at)
          VALUES ('dev:alice', 'alice', 'alice', 1, 1)`
        yield* sql`INSERT INTO plugins (id, name, url, created_by, created_at)
          VALUES ('hub:docs', 'Docs', 'https://mcp.example.com/mcp', 'dev:alice', 1)`
        yield* sql`INSERT INTO installations (id, plugin_id, name, global, created_by, created_at)
          VALUES ('i-1', 'hub:docs', 'Docs', 1, 'dev:alice', 1)`
        yield* sql`INSERT INTO installation_repos (installation_id, plugin_id, repo)
          VALUES ('i-1', 'hub:docs', 'acme/app')`
        yield* sql`INSERT INTO plugin_log (repo, at, by, change, plugin_id, plugin_name,
            plugin_version, installation_id, installation_name)
          VALUES ('acme/app', 2, 'dev:alice', 'PluginEdited', 'hub:docs', 'Docs', NULL, 'i-1', 'Docs'),
            ('acme/app', 3, 'dev:alice', 'PluginUpgraded', 'hub:docs', 'Docs', '1.0.0', 'i-1', 'Docs'),
            ('acme/app', 4, 'dev:alice', 'Renamed', 'hub:docs', 'Docs', NULL, 'i-1', 'Docs')`
        yield* sql`INSERT INTO runners (id, name, secret_hash, created_at)
          VALUES ('r-1', 'build-box', 'hash', 1)`
        yield* sql`
          INSERT INTO sessions (
            id, repo, base_branch, work_branch, state, runner_id, runner_login_account,
            creator_id, created_at, plugins
          ) VALUES
            ('s-1', 'o/r', 'main', 'claude/s-1', 'Asleep', 'r-1', 'a@example.com', 'dev:alice', 1, ${started}),
            ('s-2', 'o/r', 'main', 'claude/s-2', 'Asleep', 'r-1', 'a@example.com', 'dev:alice', 1, NULL)
        `
      }),
    )
    const after = await onDatabase(
      file,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return {
          mcpServers: yield* sql`SELECT id FROM mcp_servers`,
          installations: yield* sql`SELECT id, mcp_server_id AS mcpServerId FROM installations`,
          repos: yield* sql`SELECT mcp_server_id AS mcpServerId, repo FROM installation_repos`,
          log: yield* sql`SELECT change, mcp_server_id AS mcpServerId, mcp_server_name AS mcpServerName,
            mcp_server_version AS mcpServerVersion FROM mcp_server_log ORDER BY at`,
          sessions: yield* sql`SELECT id, mcp_servers AS mcpServers FROM sessions ORDER BY id`,
          indexes: yield* sql`SELECT name FROM sqlite_master
            WHERE type = 'index' AND sql IS NOT NULL AND (name LIKE '%plugin%' OR name LIKE '%mcp_server%') ORDER BY name`,
        }
      }),
    )
    const entry = { mcpServerId: "hub:docs", mcpServerName: "Docs" }
    expect(after).toEqual({
      mcpServers: [{ id: "hub:docs" }],
      installations: [{ id: "i-1", mcpServerId: "hub:docs" }],
      repos: [{ mcpServerId: "hub:docs", repo: "acme/app" }],
      log: [
        { change: "McpServerEdited", ...entry, mcpServerVersion: null },
        { change: "McpServerUpgraded", ...entry, mcpServerVersion: "1.0.0" },
        { change: "Renamed", ...entry, mcpServerVersion: null },
      ],
      sessions: [
        {
          id: "s-1",
          mcpServers: JSON.stringify([
            {
              id: "i-1",
              name: 'Say "pluginId": hi',
              mcpServerId: "hub:docs",
              mcpServerName: "Docs",
              mcpServerVersion: "1.0.0",
              server: "docs",
            },
          ]),
        },
        { id: "s-2", mcpServers: null },
      ],
      indexes: [
        { name: "installation_repos_one_per_mcp_server" },
        { name: "installations_mcp_server_id" },
        { name: "installations_one_global_per_mcp_server" },
        { name: "mcp_server_log_repo" },
      ],
    })
  })
})

describe("migration 0023, Members", () => {
  test("admits everyone there was, and makes the earliest from GitHub the Owner", async () => {
    const dir = testDatabaseDir("kndl-migration-")
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
    const dir = testDatabaseDir("kndl-migration-")
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

/** The `n`th agent a Session started. */
const agent = (n: number) => ({
  id: AgentId.make(`a-${n}`),
  description: `Task ${n}`,
  startedAt: n,
  harness: "ClaudeCode" as const,
})

describe("migration 0017, subagents", () => {
  test("makes Child Sessions ordinary Sessions, and keeps their history and queue readable", async () => {
    const dir = testDatabaseDir("kndl-migration-")
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
      }).pipe(Effect.provide([SessionsTest, PromptQueue.layer, SessionLog.layer])),
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
    const dir = testDatabaseDir("kndl-migration-")
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
            id, repo, base_branch, work_branch, state, runner_id, creator_id, created_at
          ) VALUES ('s-1', 'o/r', 'main', 'claude/s-1', 'Active', 'r-1', 'p-1', 1)
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
      }).pipe(Effect.provide(SessionsTest)),
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

describe("migration 0021, no WIP ref", () => {
  test("drops the failed WIP pushes from a Session's history, and keeps the rest", async () => {
    const dir = testDatabaseDir("kndl-migration-")
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
            id, repo, base_branch, work_branch, state, runner_id, creator_id, created_at
          ) VALUES ('s-1', 'acme/web', 'main', 'claude/s-1', 'Asleep', 'r-1', 'p-1', 1)
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
    const dir = testDatabaseDir("kndl-migration-")
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
      }).pipe(Effect.provide(SessionsTest)),
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

describe("migration 0009, Sensitive values that need a value", () => {
  test("keeps the variables and links, and lets only a Sensitive value be null", async () => {
    const dir = testDatabaseDir("kndl-migration-")
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
