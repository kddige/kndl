import { join } from "node:path"
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun"
import { HomeConfig } from "@kndl/protocol/home"
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
    // The Runner's own Claude credential, as its last hello showed it; null until it first connects.
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
  // `kndl update` on the Hub's machine leaves one row in `runner_update_push`: the commit it
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
  // Keep awake (ADR 0016): who turned it on and when, null while it is off. While it is on, the
  // Session doesn't go Asleep for being idle, and is woken again when its Runner comes back.
  "0018_keep_awake": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE sessions ADD COLUMN keep_awake_by TEXT REFERENCES participants (id)`
    yield* sql`ALTER TABLE sessions ADD COLUMN keep_awake_at INTEGER`
  }),
  // CLI tokens (ADR 0016): what `kndl login` leaves on a machine, named after it. Only the
  // secret's hash is kept; revoking one deletes its row.
  "0019_cli_tokens": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE cli_tokens (
        id TEXT PRIMARY KEY,
        participant_id TEXT NOT NULL REFERENCES participants (id),
        machine TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER
      )
    `
    yield* sql`CREATE INDEX cli_tokens_participant_id ON cli_tokens (participant_id)`
  }),
  // GitHub's names ignore case, so the Hub looks a Repo up by its name ignoring case (#197). The
  // indexes it looks up by follow; no row changes, so two spellings stored before stay apart.
  "0020_repo_nocase": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE INDEX environments_repo_nocase ON environments (repo COLLATE NOCASE)`
    yield* sql`DROP INDEX test_builds_digest`
    yield* sql`CREATE INDEX test_builds_digest ON test_builds (repo COLLATE NOCASE, digest)`
    yield* sql`DROP INDEX retired_values_repo`
    yield* sql`CREATE INDEX retired_values_repo ON retired_values (repo COLLATE NOCASE)`
  }),
  // The Runner no longer pushes a WIP ref (#194), so a Session's history has no failed push in it
  // any more: the events that said so go, and the rest of the history reads as before.
  "0021_no_wip_ref": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`DELETE FROM session_events WHERE json_extract(event, '$._tag') = 'WipNotPushed'`
  }),
  // A Session's Open question (#193), as JSON, null while there is none: kept, so a Hub that
  // restarts still shows the question its Claude Code waits on.
  "0022_open_question": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE sessions ADD COLUMN open_question TEXT`
  }),
  // Invites decide who gets in (#209, ADR 0019). A Participant is a Member while `admitted_at` is
  // set; removing one clears it. One Member at most is the Owner. Everyone who signed in before
  // stays admitted, and the earliest to sign in with GitHub becomes the Owner. An Invite and a
  // Setup link are kept as their secret's hash, the way a Pairing code is; a Hub has one Setup
  // link at most, and only while it has no Owner.
  "0023_members": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE participants ADD COLUMN admitted_at INTEGER`
    yield* sql`ALTER TABLE participants ADD COLUMN owner INTEGER NOT NULL DEFAULT 0`
    yield* sql`CREATE UNIQUE INDEX participants_owner ON participants (owner) WHERE owner = 1`
    yield* sql`UPDATE participants SET admitted_at = created_at`
    yield* sql`
      UPDATE participants SET owner = 1
      WHERE id = (
        SELECT id FROM participants WHERE id LIKE 'github:%' ORDER BY created_at, id LIMIT 1
      )
    `
    yield* sql`
      CREATE TABLE invites (
        id TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL,
        login TEXT,
        created_by TEXT NOT NULL REFERENCES participants (id),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        used_by TEXT REFERENCES participants (id),
        revoked_at INTEGER
      )
    `
    yield* sql`
      CREATE TABLE setup_links (
        id TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `
  }),
  // Plugins (#221, ADR 0020): remote MCP servers, and the Installations that put them on Repos. A
  // Repo has at most one Installation of each Plugin, by any spelling of its name. Each Repo keeps
  // a log of its Plugin changes, with the names as they were, which outlives what it names. A
  // Session records the Installations it started with, as JSON, null from before.
  "0024_plugins": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE plugins (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        created_by TEXT NOT NULL REFERENCES participants (id),
        created_at INTEGER NOT NULL
      )
    `
    yield* sql`
      CREATE TABLE installations (
        id TEXT PRIMARY KEY,
        plugin_id TEXT NOT NULL REFERENCES plugins (id),
        name TEXT NOT NULL,
        created_by TEXT NOT NULL REFERENCES participants (id),
        created_at INTEGER NOT NULL
      )
    `
    yield* sql`CREATE INDEX installations_plugin_id ON installations (plugin_id)`
    yield* sql`
      CREATE TABLE installation_repos (
        installation_id TEXT NOT NULL REFERENCES installations (id) ON DELETE CASCADE,
        plugin_id TEXT NOT NULL REFERENCES plugins (id),
        repo TEXT NOT NULL,
        PRIMARY KEY (installation_id, repo)
      )
    `
    yield* sql`
      CREATE UNIQUE INDEX installation_repos_one_per_plugin
      ON installation_repos (plugin_id, repo COLLATE NOCASE)
    `
    yield* sql`
      CREATE TABLE plugin_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        at INTEGER NOT NULL,
        by TEXT NOT NULL REFERENCES participants (id),
        change TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        plugin_name TEXT NOT NULL,
        installation_id TEXT NOT NULL,
        installation_name TEXT NOT NULL
      )
    `
    yield* sql`CREATE INDEX plugin_log_repo ON plugin_log (repo COLLATE NOCASE, at)`
    yield* sql`ALTER TABLE sessions ADD COLUMN plugins TEXT`
  }),
  // Header secrets (#215): a Plugin's declared headers, as JSON; each Installation's values,
  // encrypted with the secrets key; the values each Session started with, which the Gateway uses
  // until its next wake or Restart; and the titles of the values a Plugin log entry set or cleared.
  "0025_header_secrets": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE plugins ADD COLUMN auth TEXT NOT NULL DEFAULT '{"_tag":"None"}'`
    yield* sql`
      CREATE TABLE installation_values (
        installation_id TEXT NOT NULL REFERENCES installations (id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        set_by TEXT NOT NULL REFERENCES participants (id),
        set_at INTEGER NOT NULL,
        PRIMARY KEY (installation_id, key)
      )
    `
    yield* sql`
      CREATE TABLE session_installation_values (
        session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
        installation_id TEXT NOT NULL REFERENCES installations (id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        set_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, installation_id, key)
      )
    `
    yield* sql`
      CREATE INDEX session_installation_values_installation
      ON session_installation_values (installation_id)
    `
    yield* sql`ALTER TABLE plugin_log ADD COLUMN secrets TEXT`
  }),
  // Packaged Plugins (#220): a manifest's description, and the version, commit and source a
  // packaged Plugin is pinned to, as JSON; null for a Hub-only one. The log records the version an
  // Upgrade went to.
  "0026_plugin_packages": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE plugins ADD COLUMN description TEXT`
    yield* sql`ALTER TABLE plugins ADD COLUMN package TEXT`
    yield* sql`ALTER TABLE plugin_log ADD COLUMN plugin_version TEXT`
  }),
  // Global Installations (#219): on in every Repo, listing none in installation_repos, at most one
  // of each Plugin; and the Repos that turned one off, each once by any spelling. A change to a
  // global Installation is logged once, under the Repo `*`, which every Repo's log reads.
  "0028_global_installations": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE installations ADD COLUMN global INTEGER NOT NULL DEFAULT 0`
    yield* sql`
      CREATE UNIQUE INDEX installations_one_global_per_plugin
      ON installations (plugin_id) WHERE global = 1
    `
    yield* sql`
      CREATE TABLE installation_repo_off (
        installation_id TEXT NOT NULL REFERENCES installations (id) ON DELETE CASCADE,
        repo TEXT NOT NULL,
        PRIMARY KEY (installation_id, repo)
      )
    `
    yield* sql`
      CREATE UNIQUE INDEX installation_repo_off_once
      ON installation_repo_off (installation_id, repo COLLATE NOCASE)
    `
  }),
  // OAuth Installations (#217): the client the Hub registered with an Installation's authorization
  // server, and its tokens, each encrypted with the secrets key (tokens null when not connected);
  // a generation each rotation bumps, so a refresh never overwrites a newer one; and who connected
  // it, when, the account it acts as, and when the connection was lost. 0029, not 0027: the
  // migrator runs only those after the last it ran, and a Hub may have run 0028 already.
  "0029_plugin_oauth": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE installation_oauth (
        installation_id TEXT PRIMARY KEY REFERENCES installations (id) ON DELETE CASCADE,
        client TEXT,
        tokens TEXT,
        generation INTEGER NOT NULL DEFAULT 0,
        account TEXT,
        connected_by TEXT REFERENCES participants (id),
        connected_at INTEGER,
        lost_at INTEGER
      )
    `
  }),
  // A client someone entered for an OAuth Installation whose authorization server offers no
  // Dynamic Client Registration (#218): its id, whether it has a secret, and who set it when. The
  // client itself, with its secret, stays in `client`, encrypted. All NULL for a registered one.
  "0030_plugin_oauth_manual_client": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE installation_oauth ADD COLUMN manual_client_id TEXT`
    yield* sql`ALTER TABLE installation_oauth ADD COLUMN manual_client_secret INTEGER`
    yield* sql`ALTER TABLE installation_oauth ADD COLUMN client_set_by TEXT REFERENCES participants (id)`
    yield* sql`ALTER TABLE installation_oauth ADD COLUMN client_set_at INTEGER`
  }),
  // A Plugin's icon (#230, ADR 0021): the bytes the Hub found, what they are, and a hash of them
  // for the web to bust its cache with. All NULL for a Plugin with none.
  "0031_plugin_icon": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE plugins ADD COLUMN icon BLOB`
    yield* sql`ALTER TABLE plugins ADD COLUMN icon_type TEXT`
    yield* sql`ALTER TABLE plugins ADD COLUMN icon_hash TEXT`
  }),
  // Plugins are MCP servers (#232): every table, column and index named for a Plugin is named for
  // an MCP server, and so are the change log's two Plugin changes and the keys of the Installations
  // each Session started with. A key's quotes can't be in a JSON string unescaped, so replacing
  // `"pluginId":` touches only keys.
  "0032_mcp_servers": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE plugins RENAME TO mcp_servers`
    yield* sql`ALTER TABLE installations RENAME COLUMN plugin_id TO mcp_server_id`
    yield* sql`ALTER TABLE installation_repos RENAME COLUMN plugin_id TO mcp_server_id`
    yield* sql`ALTER TABLE plugin_log RENAME TO mcp_server_log`
    yield* sql`ALTER TABLE mcp_server_log RENAME COLUMN plugin_id TO mcp_server_id`
    yield* sql`ALTER TABLE mcp_server_log RENAME COLUMN plugin_name TO mcp_server_name`
    yield* sql`ALTER TABLE mcp_server_log RENAME COLUMN plugin_version TO mcp_server_version`
    yield* sql`ALTER TABLE sessions RENAME COLUMN plugins TO mcp_servers`
    yield* sql`DROP INDEX installations_plugin_id`
    yield* sql`CREATE INDEX installations_mcp_server_id ON installations (mcp_server_id)`
    yield* sql`DROP INDEX installation_repos_one_per_plugin`
    yield* sql`
      CREATE UNIQUE INDEX installation_repos_one_per_mcp_server
      ON installation_repos (mcp_server_id, repo COLLATE NOCASE)
    `
    yield* sql`DROP INDEX installations_one_global_per_plugin`
    yield* sql`
      CREATE UNIQUE INDEX installations_one_global_per_mcp_server
      ON installations (mcp_server_id) WHERE global = 1
    `
    yield* sql`DROP INDEX plugin_log_repo`
    yield* sql`CREATE INDEX mcp_server_log_repo ON mcp_server_log (repo COLLATE NOCASE, at)`
    yield* sql`UPDATE mcp_server_log SET change = 'McpServerEdited' WHERE change = 'PluginEdited'`
    yield* sql`UPDATE mcp_server_log SET change = 'McpServerUpgraded' WHERE change = 'PluginUpgraded'`
    yield* sql`
      UPDATE sessions SET mcp_servers = REPLACE(REPLACE(REPLACE(mcp_servers,
        '"pluginId":', '"mcpServerId":'),
        '"pluginName":', '"mcpServerName":'),
        '"pluginVersion":', '"mcpServerVersion":')
      WHERE mcp_servers IS NOT NULL
    `
  }),
  // Attachments (#276, ADR 0024): the files Participants upload to a Session, kept until it is
  // purged, and the ones each queued prompt carries, as a JSON array of Attachment.
  "0033_attachments": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        data BLOB NOT NULL,
        uploaded_by TEXT NOT NULL REFERENCES participants (id),
        uploaded_at INTEGER NOT NULL
      )
    `
    yield* sql`CREATE INDEX attachments_session ON attachments (session_id)`
    yield* sql`ALTER TABLE queued_prompts ADD COLUMN attachments TEXT`
  }),
  // Unsent attachments (#280): when a prompt first took each file, or null while none has, so
  // that the ones nobody sent can be deleted a day after upload. Those already kept are counted
  // sent: a queued prompt or a past Turn may name them.
  "0034_attachments_sent": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE attachments ADD COLUMN sent_at INTEGER`
    yield* sql`UPDATE attachments SET sent_at = uploaded_at`
    // The sweep reads only these, never the blobs of the rest.
    yield* sql`CREATE INDEX attachments_unsent ON attachments (uploaded_at) WHERE sent_at IS NULL`
  }),
  // The Release a Runner's commit is, as it last said hello (ADR 0025); null on a commit that is
  // no Release's, and from a Runner from before.
  "0035_runner_release": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE runners ADD COLUMN version_release TEXT`
  }),
  // A Session runs on its Creator's setup token alone (ADR 0026): no Runner has a Claude
  // credential of its own to show, and Claude Code learns its plan from Anthropic.
  "0036_creator_drives": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE runners DROP COLUMN login_account`
    yield* sql`ALTER TABLE sessions DROP COLUMN runner_login_account`
    yield* sql`ALTER TABLE claude_credentials DROP COLUMN plan`
  }),
  // A Runner's disk-free history (#350): one point per 5 minutes, the bucket being the epoch
  // milliseconds divided by that, so a later sample in it replaces the one before. Points older
  // than 7 days are deleted as samples arrive, which the index on `at` serves.
  "0037_runner_disk_history": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE runner_disk_history (
        runner_id TEXT NOT NULL REFERENCES runners (id) ON DELETE CASCADE,
        bucket INTEGER NOT NULL,
        at INTEGER NOT NULL,
        free_bytes INTEGER NOT NULL,
        PRIMARY KEY (runner_id, bucket)
      ) WITHOUT ROWID
    `
    yield* sql`CREATE INDEX runner_disk_history_at ON runner_disk_history (at)`
  }),
  // A Runner's history keeps its available memory and 1-minute load too (#356), for the Monitor's
  // charts, so the table is named for the Runner, not its disk. A point from before has neither.
  "0038_runner_history": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`DROP INDEX runner_disk_history_at`
    yield* sql`ALTER TABLE runner_disk_history RENAME TO runner_history`
    yield* sql`ALTER TABLE runner_history RENAME COLUMN free_bytes TO disk_free_bytes`
    yield* sql`ALTER TABLE runner_history ADD COLUMN memory_available_bytes INTEGER`
    yield* sql`ALTER TABLE runner_history ADD COLUMN load_1 REAL`
    yield* sql`CREATE INDEX runner_history_at ON runner_history (at)`
  }),
  // What the Hub's last check for a newer kndl found (ADR 0028), as the HubUpdateState its Owner
  // is sent, JSON: one row, for the commit the Hub ran then. A Hub on another commit drops it.
  "0039_hub_update_check": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE hub_update_check (
        hub_commit TEXT NOT NULL,
        state TEXT NOT NULL,
        saved_at INTEGER NOT NULL
      )
    `
  }),
  // pi-ai's vocabulary (ADR 0029): a Session's effort is its thinking level, its Claude session id
  // the conversation id, and its history speaks pi-ai's names. A Turn's end reason becomes pi-ai's
  // stop reason, a refusal being an error, and its usage takes pi-ai's keys, without a cost: none
  // was counted then. A Runner's models are forgotten, its next hello says them again in the new
  // names.
  "0040_neutral_vocabulary": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE sessions RENAME COLUMN effort TO thinking_level`
    yield* sql`ALTER TABLE sessions RENAME COLUMN claude_session_id TO conversation_id`
    yield* sql`
      UPDATE session_events
      SET event = json_set(event, '$.reason', CASE json_extract(event, '$.reason')
        WHEN 'Answered' THEN 'stop'
        WHEN 'Stopped' THEN 'aborted'
        ELSE 'error'
      END)
      WHERE json_extract(event, '$._tag') = 'TurnEnded'
        AND json_extract(event, '$.reason') IN ('Answered', 'Stopped', 'Refused', 'Failed')
    `
    yield* sql`
      UPDATE session_events
      SET event = json_set(event, '$.usage', json_object(
        'model', json_extract(event, '$.usage.model'),
        'input', json_extract(event, '$.usage.inputTokens'),
        'output', json_extract(event, '$.usage.outputTokens'),
        'cacheRead', json_extract(event, '$.usage.cacheReadInputTokens'),
        'cacheWrite', json_extract(event, '$.usage.cacheCreationInputTokens')
      ))
      WHERE json_extract(event, '$._tag') = 'TurnEnded'
        AND json_type(event, '$.usage.inputTokens') IS NOT NULL
    `
    yield* sql`
      UPDATE session_events
      SET event = json_set(
        json_remove(event, '$.effort'), '$.thinkingLevel', json_extract(event, '$.effort')
      )
      WHERE json_extract(event, '$._tag') = 'ModelSwitched'
        AND json_type(event, '$.effort') IS NOT NULL
    `
    yield* sql`UPDATE runners SET models = NULL`
  }),
  // Each Member's Connected providers (ADR 0029): one row per person and Provider, its pi-ai
  // credential JSON encrypted as a Claude credential is, and the Models last found under it, as
  // JSON, when, and why the last ask failed. `problem` says why the connection no longer works.
  // `hub_device` holds the one UUID the Hub gives a sign-in as its device id, once one needs it.
  "0041_connected_providers": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE connected_providers (
        participant_id TEXT NOT NULL REFERENCES participants (id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        kind TEXT NOT NULL,
        credential TEXT NOT NULL,
        label TEXT NOT NULL,
        connected_at INTEGER NOT NULL,
        models TEXT NOT NULL DEFAULT '[]',
        models_checked_at INTEGER,
        models_problem TEXT,
        problem TEXT,
        PRIMARY KEY (participant_id, provider)
      ) WITHOUT ROWID
    `
    yield* sql`CREATE TABLE hub_device (id TEXT NOT NULL)`
  }),
  // What runs a Session's agent (ADR 0029): null for a Session from before, which runs Claude Code.
  "0042_session_harness": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE sessions ADD COLUMN harness TEXT`
  }),
  // A Session switches Harness (ADR 0030): each Harness it ran on keeps its own conversation, from
  // its mod's last hello, and how far into the Session's history it has seen (`seen_seq`, the last
  // entry, null for none), so a switch back resumes it and hands it only what came after. A
  // Session's conversation from before is its Harness's. `handoff_from` is the Harness it switched
  // from while the one it runs now is yet to be handed what it hasn't seen.
  "0043_session_conversations": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE session_conversations (
        session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
        harness TEXT NOT NULL,
        conversation_id TEXT,
        seen_seq INTEGER,
        PRIMARY KEY (session_id, harness)
      ) WITHOUT ROWID
    `
    yield* sql`
      INSERT INTO session_conversations (session_id, harness, conversation_id)
      SELECT id, COALESCE(harness, 'ClaudeCode'), conversation_id FROM sessions
      WHERE conversation_id IS NOT NULL
    `
    yield* sql`ALTER TABLE sessions DROP COLUMN conversation_id`
    yield* sql`ALTER TABLE sessions ADD COLUMN handoff_from TEXT`
  }),
  // Which Harness runs Claude's Models in a Member's new Sessions (ADR 0030): null for Claude Code,
  // on their setup token, until they choose pi.
  "0044_claude_harness": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE participants ADD COLUMN claude_harness TEXT`
  }),
  // The Harness each subagent ran on (ADR 0030): only that Harness can message or stop it. Null for
  // Claude Code, as for every agent from before.
  "0045_agent_harness": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`ALTER TABLE agents ADD COLUMN harness TEXT`
  }),
  // The Hub has one device id (0041): `hub_device` holds one row at most, keyed by `one`, always
  // 1, as `secrets_check` does. A Hub that made two kept the first it made.
  "0046_one_hub_device": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE hub_device_one (
        one INTEGER PRIMARY KEY CHECK (one = 1),
        id TEXT NOT NULL
      )
    `
    yield* sql`
      INSERT INTO hub_device_one (one, id) SELECT 1, id FROM hub_device ORDER BY rowid LIMIT 1
    `
    yield* sql`DROP TABLE hub_device`
    yield* sql`ALTER TABLE hub_device_one RENAME TO hub_device`
  }),
  // Threads (docs/design/durable-harness.md): conversations forked off a Session's main loop at one
  // of its Turns, oldest first by `created_at`. `model` and `thinking_level` are the thread's own
  // (0048 made `model` always set); `running_turn` is the Turn running in it now, null while it is
  // idle, with when it started. `thread_commands` holds each Session's thread commands and Compacts
  // its agent hasn't taken yet, as HubToMod JSON, numbered in the order they were sent, never twice,
  // delivered again after each hello of its agent until it has: a prompt's (`prompt_id`) once its
  // Turn starts or it steers one, the others once its agent has polled past them.
  //
  // Every conversation the Hub has recorded for the Harness `Pi` is the old pi extension's, which
  // the durable agent can't resume: it would adopt that id on a fresh database and start empty
  // with no handoff. They are forgotten, and a Session that ran on pi is marked to be handed its
  // whole history when it next wakes, on the durable agent. A Session that switched from Claude
  // Code to pi, and back, loses its stale pi id the same way (the wake hands it off from Claude Code).
  "0047_threads": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      CREATE TABLE threads (
        session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL,
        anchor_turn_id TEXT NOT NULL,
        title TEXT NOT NULL,
        started_by TEXT NOT NULL REFERENCES participants (id),
        model TEXT,
        thinking_level TEXT,
        running_turn TEXT,
        turn_started_at INTEGER,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, thread_id)
      )
    `
    yield* sql`
      CREATE TABLE thread_commands (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
        command TEXT NOT NULL,
        prompt_id TEXT
      )
    `
    yield* sql`CREATE INDEX thread_commands_session ON thread_commands (session_id, seq)`
    yield* sql`
      UPDATE sessions SET handoff_from = COALESCE(handoff_from, 'Pi') WHERE harness = 'Pi'
    `
    yield* sql`DELETE FROM session_conversations WHERE harness = 'Pi'`
  }),
  // A thread has its own model, never the Session's: a fork keeps the model its parent had at the
  // fork and doesn't follow the Session's switches. Threads recorded as running on the Session's
  // (null) are given the Session's model and thinking level as they are now.
  "0048_thread_models": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      UPDATE threads SET
        model = (SELECT s.model FROM sessions s WHERE s.id = threads.session_id),
        thinking_level = (SELECT s.thinking_level FROM sessions s WHERE s.id = threads.session_id)
      WHERE model IS NULL
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
 * Where the Hub's database is: `HUB_DATABASE`, or else `hub.db` in the home `KNDL_HOME`
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
