import {
  AgentId,
  AgentStatus,
  type AgentSummary,
  ClaudeSessionId,
  EffortLevel,
  EnvironmentVersion,
  ModelName,
  ParticipantId,
  RunnerId,
  SessionId,
  type SessionName,
  SessionState,
  SessionSummary,
  TurnId,
} from "@claude-hub/protocol"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import type { Fragment } from "effect/sql/Statement"

/** A Session to record, as CreateSession makes it. */
export interface NewSession {
  readonly id: SessionId
  readonly repo: string
  readonly baseBranch: string
  readonly workBranch: string
  readonly state: SessionState
  readonly runnerId: RunnerId
  readonly runnerLogin: { readonly account: string }
  /** The Creator, a signed-in Participant: recorded for history only (ADR 0003). */
  readonly creatorId: ParticipantId
  readonly createdAt: number
  /** Its model and effort (#128); absent for Claude Code's default. */
  readonly model?: ModelName
  readonly effort?: EffortLevel
}

/** A Session's model and effort (#128): absent for Claude Code's default. */
export interface ModelSetting {
  readonly model?: ModelName
  readonly effort?: EffortLevel
}

/** A subagent the main loop started with its Agent tool (ADR 0014), as AgentStarted said. */
export interface NewAgent {
  readonly id: AgentId
  readonly description: string
  readonly startedAt: number
}

interface SessionRow {
  readonly id: string
  readonly repo: string
  readonly baseBranch: string
  readonly workBranch: string
  readonly name: string | null
  readonly state: string
  readonly runnerId: string
  readonly runnerLoginAccount: string
  readonly creatorId: string
  readonly creatorLogin: string
  readonly creatorName: string
  readonly creatorAvatarUrl: string | null
  readonly createdAt: number
  readonly currentTurn: string | null
  readonly archivedById: string | null
  readonly archivedByLogin: string | null
  readonly archivedByName: string | null
  readonly archivedByAvatarUrl: string | null
  readonly archivedAt: number | null
  readonly purgeAt: number | null
  readonly environmentVersion: number | null
  readonly latestEnvironmentVersion: number | null
  readonly lastOutput: string | null
  readonly model: string | null
  readonly effort: string | null
  readonly modelPending: number
}

/** Archiving a Session: who did it, when, and when it is purged unless restored first. */
export interface Archiving {
  readonly by: ParticipantId
  readonly at: number
  readonly purgeAt: number
}

const decodeState = Schema.decodeUnknownSync(SessionState)
const decodeAgentStatus = Schema.decodeUnknownSync(AgentStatus)
const decodeModel = Schema.decodeUnknownOption(ModelName)
const decodeEffort = Schema.decodeUnknownOption(EffortLevel)

/** The model and effort a row holds, without a value the Hub would no longer take. */
const settingOf = (row: { readonly model: string | null; readonly effort: string | null }) => {
  const model = Option.getOrUndefined(decodeModel(row.model))
  const effort = Option.getOrUndefined(decodeEffort(row.effort))
  return {
    ...(model !== undefined && { model }),
    ...(effort !== undefined && { effort }),
  }
}

const toSummary = (row: SessionRow, agents: ReadonlyArray<AgentSummary> = []): SessionSummary =>
  SessionSummary.make({
    id: SessionId.make(row.id),
    repo: row.repo,
    baseBranch: row.baseBranch,
    workBranch: row.workBranch,
    ...(row.name !== null && { name: row.name }),
    state: decodeState(row.state),
    runnerId: RunnerId.make(row.runnerId),
    runnerLogin: { account: row.runnerLoginAccount },
    creator: {
      id: ParticipantId.make(row.creatorId),
      login: row.creatorLogin,
      name: row.creatorName,
      ...(row.creatorAvatarUrl !== null && { avatarUrl: row.creatorAvatarUrl }),
    },
    createdAt: row.createdAt,
    currentTurn: row.currentTurn === null ? null : TurnId.make(row.currentTurn),
    ...(agents.length > 0 && { agents }),
    ...(row.archivedById !== null &&
      row.archivedAt !== null &&
      row.purgeAt !== null && {
        archived: {
          by: {
            id: ParticipantId.make(row.archivedById),
            login: row.archivedByLogin ?? row.archivedById,
            name: row.archivedByName ?? row.archivedById,
            ...(row.archivedByAvatarUrl !== null && { avatarUrl: row.archivedByAvatarUrl }),
          },
          at: row.archivedAt,
          purgeAt: row.purgeAt,
        },
      }),
    ...(row.latestEnvironmentVersion !== null && {
      environment: {
        version:
          row.environmentVersion === null ? null : EnvironmentVersion.make(row.environmentVersion),
        latestVersion: EnvironmentVersion.make(row.latestEnvironmentVersion),
      },
    }),
    // Only an Asleep Session's: once it is woken, what its last Claude Code printed is history.
    ...(row.lastOutput !== null && row.state === "Asleep" && { lastOutput: row.lastOutput }),
    ...settingOf(row),
    ...(row.modelPending !== 0 && { modelPending: true }),
  })

/**
 * Every Session the Hub knows, in SQLite: its Repo and branches, lifecycle state, Runner,
 * Creator, the Turn running now, its subagents (ADR 0014), and while it is Archived who archived
 * it. People are shown with their current login and name. A summary lists the Running and
 * Interrupted subagents; the others are only history, in the event log.
 *
 * Purging a Session deletes it, with its event log and Prompt queue, and leaves a
 * note for its Runner to delete what it holds, until the Runner says it has.
 */
export class Sessions extends Context.Service<
  Sessions,
  {
    readonly create: (session: NewSession) => Effect.Effect<SessionSummary, SqlError>
    readonly get: (id: SessionId) => Effect.Effect<Option.Option<SessionSummary>, SqlError>
    /** Every Session, oldest first. */
    readonly list: Effect.Effect<ReadonlyArray<SessionSummary>, SqlError>
    readonly listByRunner: (
      runnerId: RunnerId,
    ) => Effect.Effect<ReadonlyArray<SessionSummary>, SqlError>
    /** Records a subagent the Session's main loop started, Running. */
    readonly agentStarted: (id: SessionId, agent: NewAgent) => Effect.Effect<void, SqlError>
    /** The subagent's status, or none if the Session never started it. */
    readonly agentStatus: (
      id: SessionId,
      agentId: AgentId,
    ) => Effect.Effect<Option.Option<AgentStatus>, SqlError>
    /** Records the subagent's new status; false if the Session never started it. */
    readonly setAgentStatus: (
      id: SessionId,
      agentId: AgentId,
      status: AgentStatus,
    ) => Effect.Effect<boolean, SqlError>
    /** Its Claude Code stopped: its Running subagents are Interrupted. Returns which they were. */
    readonly interruptAgents: (id: SessionId) => Effect.Effect<ReadonlyArray<AgentId>, SqlError>
    readonly setState: (id: SessionId, state: SessionState) => Effect.Effect<void, SqlError>
    /** Its Session name, or null to clear it, so it is shown by its Work branch. */
    readonly setName: (id: SessionId, name: SessionName | null) => Effect.Effect<void, SqlError>
    /**
     * Its model and effort (#128), and whether its running Claude Code is yet to be restarted with
     * them.
     */
    readonly setModel: (
      id: SessionId,
      setting: ModelSetting,
      pending: boolean,
    ) => Effect.Effect<void, SqlError>
    /** Whether its running Claude Code is yet to be restarted with its model and effort. */
    readonly setModelPending: (id: SessionId, pending: boolean) => Effect.Effect<void, SqlError>
    /** The Turn running now, or null once the Session is idle. */
    readonly setCurrentTurn: (id: SessionId, turn: TurnId | null) => Effect.Effect<void, SqlError>
    /** Records the Session Archived, by whom and until when; its Runner has yet to stop it. */
    readonly archive: (id: SessionId, archiving: Archiving) => Effect.Effect<void, SqlError>
    /** Brings an Archived Session back, in `state`. */
    readonly restore: (id: SessionId, state: SessionState) => Effect.Effect<void, SqlError>
    /** The Runner stopped the Archived Session and destroyed its Sandbox. */
    readonly setArchiveStopped: (id: SessionId) => Effect.Effect<void, SqlError>
    /** The runner's Archived Sessions it hasn't stopped yet, as because it was offline. */
    readonly unstoppedArchives: (
      runnerId: RunnerId,
    ) => Effect.Effect<ReadonlyArray<SessionId>, SqlError>
    /** The Archived Sessions whose purge time has come, by `now`. */
    readonly dueForPurge: (now: number) => Effect.Effect<ReadonlyArray<SessionSummary>, SqlError>
    /**
     * Deletes the Session, its event log, Prompt queue and mod token, and notes that
     * its Runner must delete what it holds of it.
     */
    readonly purge: (session: SessionSummary, at: number) => Effect.Effect<void, SqlError>
    /** The purged Sessions the Runner hasn't yet said it deleted. */
    readonly pendingPurges: (
      runnerId: RunnerId,
    ) => Effect.Effect<ReadonlyArray<SessionId>, SqlError>
    /** The Runner deleted what it held of a purged Session: forgets it. False if it wasn't due. */
    readonly purgeDone: (id: SessionId, runnerId: RunnerId) => Effect.Effect<boolean, SqlError>
    /**
     * The Environment version the Session's Sandbox runs on, as its Runner reported when it
     * started it, or null if it didn't say.
     */
    readonly setEnvironmentVersion: (
      id: SessionId,
      version: EnvironmentVersion | null,
    ) => Effect.Effect<void, SqlError>
    /** Claude Code's own session id, from the mod's hello, for waking the Session (#12). */
    readonly setClaudeSessionId: (
      id: SessionId,
      claudeSessionId: ClaudeSessionId,
    ) => Effect.Effect<void, SqlError>
    /** The Claude Code session id last recorded, or none if its mod never said hello. */
    readonly claudeSessionId: (
      id: SessionId,
    ) => Effect.Effect<Option.Option<ClaudeSessionId>, SqlError>
    /**
     * What Claude Code's terminal showed last when it exited on its own, already redacted, or
     * null to forget it. Its summary shows it while the Session is Asleep.
     */
    readonly setLastOutput: (id: SessionId, output: string | null) => Effect.Effect<void, SqlError>
  }
>()("@claude-hub/hub/Sessions") {
  static readonly layer = Layer.effect(
    Sessions,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      /** The Running and Interrupted subagents of the Sessions `ids`, by Session. */
      const activeAgents = Effect.fn("Sessions.activeAgents")(function* (
        ids: ReadonlyArray<string>,
      ) {
        const rows = yield* sql<{
          readonly sessionId: string
          readonly id: string
          readonly description: string
          readonly status: string
        }>`
          SELECT g.session_id AS sessionId, g.agent_id AS id, g.description, g.status
          FROM agents g
          WHERE g.session_id IN ${sql.in(ids)} AND g.status IN ('Running', 'Interrupted')
          ORDER BY g.started_at, g.agent_id
        `
        const bySession = new Map<string, Array<AgentSummary>>()
        for (const row of rows) {
          const agents = bySession.get(row.sessionId) ?? []
          agents.push({
            id: AgentId.make(row.id),
            description: row.description,
            status: decodeAgentStatus(row.status),
          })
          bySession.set(row.sessionId, agents)
        }
        return bySession
      })

      const selectRows = (where: Fragment) => sql<SessionRow>`
        SELECT s.id, s.repo, s.base_branch AS baseBranch, s.work_branch AS workBranch, s.name,
          s.state,
          s.runner_id AS runnerId, s.runner_login_account AS runnerLoginAccount,
          s.creator_id AS creatorId, p.login AS creatorLogin, p.name AS creatorName,
          p.avatar_url AS creatorAvatarUrl,
          s.created_at AS createdAt, s.current_turn AS currentTurn,
          s.archived_by AS archivedById, a.login AS archivedByLogin, a.name AS archivedByName,
          a.avatar_url AS archivedByAvatarUrl, s.archived_at AS archivedAt, s.purge_at AS purgeAt,
          s.environment_version AS environmentVersion, e.version AS latestEnvironmentVersion,
          s.last_output AS lastOutput, s.model, s.effort, s.model_pending AS modelPending
        FROM sessions s JOIN participants p ON p.id = s.creator_id
          LEFT JOIN participants a ON a.id = s.archived_by
          LEFT JOIN environments e ON e.repo = s.repo
        ${where}
        ORDER BY s.created_at, s.id
      `

      /** The Sessions `where` picks, as summaries. */
      const select = Effect.fn("Sessions.select")(function* (where: Fragment) {
        const rows = yield* selectRows(where)
        if (rows.length === 0) return []
        const agents = yield* activeAgents(rows.map((row) => row.id))
        return rows.map((row) => toSummary(row, agents.get(row.id)))
      })

      const get = Effect.fn("Sessions.get")(function* (id: SessionId) {
        const summaries = yield* select(sql`WHERE s.id = ${id}`)
        return Option.fromNullishOr(summaries[0])
      })

      const create = Effect.fn("Sessions.create")(function* (session: NewSession) {
        yield* sql`
          INSERT INTO sessions (
            id, repo, base_branch, work_branch, state, runner_id, runner_login_account,
            creator_id, created_at, model, effort
          ) VALUES (
            ${session.id}, ${session.repo}, ${session.baseBranch}, ${session.workBranch},
            ${session.state}, ${session.runnerId}, ${session.runnerLogin.account},
            ${session.creatorId}, ${session.createdAt}, ${session.model ?? null},
            ${session.effort ?? null}
          )
        `
        return Option.getOrThrow(yield* get(session.id))
      })

      const list = select(sql``).pipe(Effect.withSpan("Sessions.list"))

      const listByRunner = (runnerId: RunnerId) => select(sql`WHERE s.runner_id = ${runnerId}`)

      const agentStarted = Effect.fn("Sessions.agentStarted")(function* (
        id: SessionId,
        agent: NewAgent,
      ) {
        yield* sql`
          INSERT INTO agents (session_id, agent_id, description, status, started_at)
          VALUES (${id}, ${agent.id}, ${agent.description}, 'Running', ${agent.startedAt})
          ON CONFLICT (session_id, agent_id) DO UPDATE SET status = 'Running'
        `
      })

      const agentStatus = Effect.fn("Sessions.agentStatus")(function* (
        id: SessionId,
        agentId: AgentId,
      ) {
        const rows = yield* sql<{ readonly status: string }>`
          SELECT status FROM agents WHERE session_id = ${id} AND agent_id = ${agentId}
        `
        return Option.map(Option.fromNullishOr(rows[0]), (row) => decodeAgentStatus(row.status))
      })

      const setAgentStatus = Effect.fn("Sessions.setAgentStatus")(function* (
        id: SessionId,
        agentId: AgentId,
        status: AgentStatus,
      ) {
        const rows = yield* sql<{ readonly id: string }>`
          UPDATE agents SET status = ${status}
          WHERE session_id = ${id} AND agent_id = ${agentId}
          RETURNING agent_id AS id
        `
        return rows.length > 0
      })

      const interruptAgents = Effect.fn("Sessions.interruptAgents")(function* (id: SessionId) {
        const rows = yield* sql<{ readonly id: string }>`
          UPDATE agents SET status = 'Interrupted'
          WHERE session_id = ${id} AND status = 'Running'
          RETURNING agent_id AS id
        `
        return rows.map((row) => AgentId.make(row.id)).toSorted()
      })

      const setState = Effect.fn("Sessions.setState")(function* (
        id: SessionId,
        state: SessionState,
      ) {
        yield* sql`UPDATE sessions SET state = ${state} WHERE id = ${id}`
      })

      const setName = Effect.fn("Sessions.setName")(function* (
        id: SessionId,
        name: SessionName | null,
      ) {
        yield* sql`UPDATE sessions SET name = ${name} WHERE id = ${id}`
      })

      const setModel = Effect.fn("Sessions.setModel")(function* (
        id: SessionId,
        setting: ModelSetting,
        pending: boolean,
      ) {
        yield* sql`
          UPDATE sessions SET model = ${setting.model ?? null}, effort = ${setting.effort ?? null},
            model_pending = ${pending ? 1 : 0}
          WHERE id = ${id}
        `
      })

      const setModelPending = Effect.fn("Sessions.setModelPending")(function* (
        id: SessionId,
        pending: boolean,
      ) {
        yield* sql`UPDATE sessions SET model_pending = ${pending ? 1 : 0} WHERE id = ${id}`
      })

      const setCurrentTurn = Effect.fn("Sessions.setCurrentTurn")(function* (
        id: SessionId,
        turn: TurnId | null,
      ) {
        yield* sql`UPDATE sessions SET current_turn = ${turn} WHERE id = ${id}`
      })

      const setClaudeSessionId = Effect.fn("Sessions.setClaudeSessionId")(function* (
        id: SessionId,
        claudeSessionId: ClaudeSessionId,
      ) {
        yield* sql`UPDATE sessions SET claude_session_id = ${claudeSessionId} WHERE id = ${id}`
      })

      const setEnvironmentVersion = Effect.fn("Sessions.setEnvironmentVersion")(function* (
        id: SessionId,
        version: EnvironmentVersion | null,
      ) {
        yield* sql`UPDATE sessions SET environment_version = ${version} WHERE id = ${id}`
      })

      const claudeSessionId = Effect.fn("Sessions.claudeSessionId")(function* (id: SessionId) {
        const rows = yield* sql<{ readonly claudeSessionId: string | null }>`
          SELECT claude_session_id AS claudeSessionId FROM sessions WHERE id = ${id}
        `
        return Option.map(Option.fromNullishOr(rows[0]?.claudeSessionId), (value) =>
          ClaudeSessionId.make(value),
        )
      })

      const setLastOutput = Effect.fn("Sessions.setLastOutput")(function* (
        id: SessionId,
        output: string | null,
      ) {
        yield* sql`UPDATE sessions SET last_output = ${output} WHERE id = ${id}`
      })

      const archive = Effect.fn("Sessions.archive")(function* (
        id: SessionId,
        archiving: Archiving,
      ) {
        yield* sql`
          UPDATE sessions SET state = 'Archived', current_turn = NULL,
            archived_by = ${archiving.by}, archived_at = ${archiving.at},
            purge_at = ${archiving.purgeAt}, archive_stopped = 0, last_output = NULL
          WHERE id = ${id}
        `
      })

      const restore = Effect.fn("Sessions.restore")(function* (id: SessionId, state: SessionState) {
        yield* sql`
          UPDATE sessions SET state = ${state}, archived_by = NULL, archived_at = NULL,
            purge_at = NULL, archive_stopped = 0, last_output = NULL
          WHERE id = ${id}
        `
      })

      const setArchiveStopped = Effect.fn("Sessions.setArchiveStopped")(function* (id: SessionId) {
        yield* sql`UPDATE sessions SET archive_stopped = 1 WHERE id = ${id} AND state = 'Archived'`
      })

      const unstoppedArchives = Effect.fn("Sessions.unstoppedArchives")(function* (
        runnerId: RunnerId,
      ) {
        const rows = yield* sql<{ readonly id: string }>`
          SELECT id FROM sessions
          WHERE runner_id = ${runnerId} AND state = 'Archived' AND archive_stopped = 0
          ORDER BY created_at, id
        `
        return rows.map((row) => SessionId.make(row.id))
      })

      const dueForPurge = Effect.fn("Sessions.dueForPurge")(function* (now: number) {
        return yield* select(sql`WHERE s.state = 'Archived' AND s.purge_at <= ${now}`)
      })

      const purge = Effect.fn("Sessions.purge")(function* (session: SessionSummary, at: number) {
        yield* sql`
            INSERT OR REPLACE INTO session_purges (session_id, runner_id, purged_at)
            VALUES (${session.id}, ${session.runnerId}, ${at})
          `
        yield* sql`DELETE FROM mod_tokens WHERE session_id = ${session.id}`
        // The event log, Prompt queue and subagents go with it (ON DELETE CASCADE).
        yield* sql`DELETE FROM sessions WHERE id = ${session.id}`
      }, sql.withTransaction)

      const pendingPurges = Effect.fn("Sessions.pendingPurges")(function* (runnerId: RunnerId) {
        const rows = yield* sql<{ readonly id: string }>`
          SELECT session_id AS id FROM session_purges WHERE runner_id = ${runnerId}
          ORDER BY purged_at, session_id
        `
        return rows.map((row) => SessionId.make(row.id))
      })

      const purgeDone = Effect.fn("Sessions.purgeDone")(function* (
        id: SessionId,
        runnerId: RunnerId,
      ) {
        const rows = yield* sql<{ readonly id: string }>`
          DELETE FROM session_purges WHERE session_id = ${id} AND runner_id = ${runnerId}
          RETURNING session_id AS id
        `
        return rows.length > 0
      })

      return Sessions.of({
        create,
        archive,
        restore,
        setArchiveStopped,
        unstoppedArchives,
        dueForPurge,
        purge,
        pendingPurges,
        purgeDone,
        get,
        list,
        listByRunner,
        agentStarted,
        agentStatus,
        setAgentStatus,
        interruptAgents,
        setState,
        setName,
        setModel,
        setModelPending,
        setCurrentTurn,
        setClaudeSessionId,
        setEnvironmentVersion,
        claudeSessionId,
        setLastOutput,
      })
    }),
  )
}
