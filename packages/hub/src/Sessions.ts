import {
  AgentId,
  AgentStatus,
  type AgentSummary,
  ConversationId,
  EnvironmentVersion,
  EventSeq,
  Harness,
  installationsDiffer,
  ModelName,
  OpenQuestion,
  ParticipantId,
  repoKey,
  RunnerId,
  SessionId,
  SessionInstallation,
  type SessionName,
  SessionState,
  SessionSummary,
  ThinkingLevel,
  ThreadId,
  type ThreadSummary,
  TurnId,
} from "@kndl/protocol"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import type { Fragment } from "effect/sql/Statement"
import { McpServers } from "./McpServers.ts"

/** A Session to record, as CreateSession makes it. */
export interface NewSession {
  readonly id: SessionId
  readonly repo: string
  readonly baseBranch: string
  readonly workBranch: string
  readonly state: SessionState
  readonly runnerId: RunnerId
  /** The Creator, a signed-in Participant: it runs on their Claude credential (ADR 0026). */
  readonly creatorId: ParticipantId
  readonly createdAt: number
  /** What runs its agent (ADR 0029), until a switch (ADR 0030); absent for Claude Code. */
  readonly harness?: Harness
  /** Its model and thinking level (#128); absent for Claude Code's default. */
  readonly model?: ModelName
  readonly thinkingLevel?: ThinkingLevel
}

/** A Session's model and thinking level (#128): absent for Claude Code's default. */
export interface ModelSetting {
  readonly model?: ModelName
  readonly thinkingLevel?: ThinkingLevel
}

/** A subagent the main loop started with its Agent tool (ADR 0014), as AgentStarted said. */
export interface NewAgent {
  readonly id: AgentId
  readonly description: string
  readonly startedAt: number
  /** The Harness it runs on, the Session's when it started (ADR 0030). */
  readonly harness: Harness
}

interface SessionRow {
  readonly id: string
  readonly repo: string
  readonly baseBranch: string
  readonly workBranch: string
  readonly name: string | null
  readonly state: string
  readonly runnerId: string
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
  readonly harness: string | null
  readonly model: string | null
  readonly thinkingLevel: string | null
  readonly modelPending: number
  readonly keepAwakeById: string | null
  readonly keepAwakeByLogin: string | null
  readonly keepAwakeByName: string | null
  readonly keepAwakeByAvatarUrl: string | null
  readonly keepAwakeAt: number | null
  readonly openQuestion: string | null
  readonly mcpServers: string | null
}

/** A thread a Participant started (docs/design/durable-harness.md), as ThreadStarted said. */
export interface NewThread {
  readonly id: ThreadId
  readonly anchorTurnId: TurnId
  readonly title: string
  readonly startedBy: ParticipantId
  /** Its own model and thinking level: a thread doesn't follow the Session's. */
  readonly model: ModelName
  readonly thinkingLevel?: ThinkingLevel
  readonly createdAt: number
}

/** A thread's Turn running now: which, and since when. */
export interface ThreadTurn {
  readonly threadId: ThreadId
  readonly turnId: TurnId
  /** When it started, if known. */
  readonly startedAt: number | undefined
}

/** Turning a Session's Keep awake on (ADR 0016): who did it, and when. */
export interface KeepingAwake {
  readonly by: ParticipantId
  readonly at: number
}

/** Archiving a Session: who did it, when, and when it is purged unless restored first. */
export interface Archiving {
  readonly by: ParticipantId
  readonly at: number
  readonly purgeAt: number
}

const decodeState = Schema.decodeUnknownSync(SessionState)
const decodeAgentStatus = Schema.decodeUnknownSync(AgentStatus)
const decodeHarness = Schema.decodeUnknownOption(Harness)
const decodeModel = Schema.decodeUnknownOption(ModelName)
const decodeThinkingLevel = Schema.decodeUnknownOption(ThinkingLevel)
const decodeConversationId = Schema.decodeUnknownOption(ConversationId)
const OpenQuestionJson = Schema.fromJsonString(OpenQuestion)
const decodeOpenQuestion = Schema.decodeUnknownOption(OpenQuestionJson)
const encodeOpenQuestion = Schema.encodeSync(OpenQuestionJson)
const InstallationsJson = Schema.fromJsonString(Schema.Array(SessionInstallation))
const decodeInstallations = Schema.decodeUnknownOption(InstallationsJson)
const encodeInstallations = Schema.encodeSync(InstallationsJson)

/**
 * The Harness a row holds (ADR 0029), said only when it isn't Claude Code, as for a Session from
 * before, whose is null.
 */
const harnessOf = (row: { readonly harness: string | null }): { readonly harness?: Harness } => {
  const harness = Option.getOrUndefined(decodeHarness(row.harness))
  return harness === undefined || harness === "ClaudeCode" ? {} : { harness }
}

/** The model and thinking level a row holds, without a value the Hub would no longer take. */
const settingOf = (row: {
  readonly model: string | null
  readonly thinkingLevel: string | null
}) => {
  const model = Option.getOrUndefined(decodeModel(row.model))
  const thinkingLevel = Option.getOrUndefined(decodeThinkingLevel(row.thinkingLevel))
  return {
    ...(model !== undefined && { model }),
    ...(thinkingLevel !== undefined && { thinkingLevel }),
  }
}

const toSummary = (
  row: SessionRow,
  agents: ReadonlyArray<AgentSummary> = [],
  installations: ReadonlyArray<SessionInstallation> = [],
  threads: ReadonlyArray<ThreadSummary> = [],
): SessionSummary =>
  SessionSummary.make({
    id: SessionId.make(row.id),
    repo: row.repo,
    baseBranch: row.baseBranch,
    workBranch: row.workBranch,
    ...(row.name !== null && { name: row.name }),
    state: decodeState(row.state),
    runnerId: RunnerId.make(row.runnerId),
    creator: {
      id: ParticipantId.make(row.creatorId),
      login: row.creatorLogin,
      name: row.creatorName,
      ...(row.creatorAvatarUrl !== null && { avatarUrl: row.creatorAvatarUrl }),
    },
    createdAt: row.createdAt,
    currentTurn: row.currentTurn === null ? null : TurnId.make(row.currentTurn),
    ...(agents.length > 0 && { agents }),
    ...(threads.length > 0 && { threads }),
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
    ...harnessOf(row),
    ...settingOf(row),
    ...(row.modelPending !== 0 && { modelPending: true }),
    ...(row.keepAwakeById !== null &&
      row.keepAwakeAt !== null && {
        keepAwake: {
          by: {
            id: ParticipantId.make(row.keepAwakeById),
            login: row.keepAwakeByLogin ?? row.keepAwakeById,
            name: row.keepAwakeByName ?? row.keepAwakeById,
            ...(row.keepAwakeByAvatarUrl !== null && { avatarUrl: row.keepAwakeByAvatarUrl }),
          },
          at: row.keepAwakeAt,
        },
      }),
    ...openQuestionOf(row),
    ...mcpServersOf(row, installations),
  })

/**
 * The Installations a Session's Claude Code last started with (ADR 0020), as its row's
 * `mcp_servers` holds them: none if it never started since MCP servers came.
 */
const startedWithOf = (mcpServers: string | null): ReadonlyArray<SessionInstallation> =>
  mcpServers === null ? [] : Option.getOrElse(decodeInstallations(mcpServers), () => [])

/**
 * The Installations a row says the Session's Claude Code last started with, and whether its
 * Repo's, `installations`, changed since. An Archived Session's don't: it starts again only once
 * restored.
 */
const mcpServersOf = (row: SessionRow, installations: ReadonlyArray<SessionInstallation>) => {
  const recorded = startedWithOf(row.mcpServers)
  return {
    ...(recorded.length > 0 && { mcpServers: recorded }),
    ...(row.state !== "Archived" &&
      installationsDiffer(recorded, installations) && { mcpServersChanged: true as const }),
  }
}

/** The Open question a row holds, if any the Hub can still read. */
const openQuestionOf = (row: SessionRow) => {
  if (row.openQuestion === null) return {}
  const question = Option.getOrUndefined(decodeOpenQuestion(row.openQuestion))
  return question === undefined ? {} : { openQuestion: question }
}

/**
 * Every Session the Hub knows, in SQLite: its Repo and branches, lifecycle state, Runner,
 * Creator, the Turn running now, its subagents (ADR 0014), and while it is Archived who archived
 * it. People are shown with their current login and name. A summary lists the Running and
 * Interrupted subagents; the others are only history, in the event log. Each Harness a Session
 * ran on keeps its own conversation and how far into its history it has seen (ADR 0030).
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
    /**
     * What the Gateway checks a request against (ADR 0020): the Session's Repo, its state, and the
     * Installations its Claude Code last started with. Unlike `get`, it doesn't ask McpServers
     * for its Repo's now, which the Gateway asks itself.
     */
    readonly startedWith: (id: SessionId) => Effect.Effect<
      Option.Option<{
        readonly repo: string
        readonly state: SessionState
        readonly mcpServers: ReadonlyArray<SessionInstallation>
      }>,
      SqlError
    >
    /** Records a subagent the Session's main loop started, Running. */
    readonly agentStarted: (id: SessionId, agent: NewAgent) => Effect.Effect<void, SqlError>
    /** The subagent's status, or none if the Session never started it. */
    readonly agentStatus: (
      id: SessionId,
      agentId: AgentId,
    ) => Effect.Effect<Option.Option<AgentStatus>, SqlError>
    /** The subagent's description and the Harness it ran on (ADR 0030), if the Session has it. */
    readonly agentOf: (
      id: SessionId,
      agentId: AgentId,
    ) => Effect.Effect<
      Option.Option<{ readonly description: string; readonly harness: Harness }>,
      SqlError
    >
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
     * Its model and thinking level (#128), and whether its running Claude Code is yet to be
     * restarted with them.
     */
    readonly setModel: (
      id: SessionId,
      setting: ModelSetting,
      pending: boolean,
    ) => Effect.Effect<void, SqlError>
    /** Whether its running Claude Code is yet to be restarted with its model and thinking level. */
    readonly setModelPending: (id: SessionId, pending: boolean) => Effect.Effect<void, SqlError>
    /** Turns its Keep awake on, by whom and when (ADR 0016), or off with null. */
    readonly setKeepAwake: (
      id: SessionId,
      keepingAwake: KeepingAwake | null,
    ) => Effect.Effect<void, SqlError>
    /** Its Open question (#193), or null once it has closed. */
    readonly setOpenQuestion: (
      id: SessionId,
      question: OpenQuestion | null,
    ) => Effect.Effect<void, SqlError>
    /** The Turn running now, or null once the Session is idle. */
    readonly setCurrentTurn: (id: SessionId, turn: TurnId | null) => Effect.Effect<void, SqlError>
    /**
     * Records the Session Archived, by whom and until when, and turns its Keep awake off; its
     * Runner has yet to stop it.
     */
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
    /**
     * The Harness's conversation, from its mod's hello, for waking the Session (#12) or switching
     * back to it (ADR 0030).
     */
    readonly setConversationId: (
      id: SessionId,
      harness: Harness,
      conversationId: ConversationId,
    ) => Effect.Effect<void, SqlError>
    /**
     * The Harness's conversation last recorded, or none if the Session never ran on it, its mod
     * never said hello, or the one recorded isn't a conversation id.
     */
    readonly conversationId: (
      id: SessionId,
      harness: Harness,
    ) => Effect.Effect<Option.Option<ConversationId>, SqlError>
    /**
     * How far into the Session's history the Harness has seen (ADR 0030): the last entry it ran
     * through or was handed, or none, as for a Harness that never ran the Session.
     */
    readonly seenSeq: (
      id: SessionId,
      harness: Harness,
    ) => Effect.Effect<Option.Option<EventSeq>, SqlError>
    /** The Harness has seen the Session's history up to `seq`: it was handed it. */
    readonly setSeenSeq: (
      id: SessionId,
      harness: Harness,
      seq: EventSeq,
    ) => Effect.Effect<void, SqlError>
    /**
     * Records the Session on another Harness (ADR 0030), as it is relaunched or woken on it: the one
     * it ran on has seen its history up to `seenUpTo`, unless it was yet to be handed what it
     * hadn't, and the new one is to be handed what it hasn't seen (`handoffFrom`).
     */
    readonly switchHarness: (
      id: SessionId,
      to: Harness,
      seenUpTo: EventSeq | undefined,
    ) => Effect.Effect<void, SqlError>
    /**
     * The Harness the Session switched from, while the one it runs now is yet to be handed what it
     * hasn't seen; none once it was.
     */
    readonly handoffFrom: (id: SessionId) => Effect.Effect<Option.Option<Harness>, SqlError>
    /** The Harness the Session runs now was handed what it hadn't seen, or never will be. */
    readonly handoffDone: (id: SessionId) => Effect.Effect<void, SqlError>
    /**
     * What Claude Code's terminal showed last when it exited on its own, already redacted, or
     * null to forget it. Its summary shows it while the Session is Asleep.
     */
    readonly setLastOutput: (id: SessionId, output: string | null) => Effect.Effect<void, SqlError>
    /**
     * The Installations its Claude Code starts with (ADR 0020), recorded as the Hub sends its
     * StartSession: its summary shows them, and whether its Repo's changed since.
     */
    readonly setMcpServers: (
      id: SessionId,
      installations: ReadonlyArray<SessionInstallation>,
    ) => Effect.Effect<void, SqlError>
    /** Records a thread a Participant started (docs/design/durable-harness.md), idle. */
    readonly threadStarted: (id: SessionId, thread: NewThread) => Effect.Effect<void, SqlError>
    /**
     * The thread's title, model and whether a Turn runs in it, and which, or none if the Session
     * has no such thread.
     */
    readonly threadOf: (
      id: SessionId,
      threadId: ThreadId,
    ) => Effect.Effect<
      Option.Option<
        ModelSetting & {
          readonly title: string
          readonly running: boolean
          readonly runningTurn?: TurnId
        }
      >,
      SqlError
    >
    /** The thread's Turn starts: it runs now. False if there is no such thread. */
    readonly setThreadTurn: (
      id: SessionId,
      threadId: ThreadId,
      turn: { readonly turnId: TurnId; readonly startedAt: number },
    ) => Effect.Effect<boolean, SqlError>
    /**
     * The thread's Turn `turnId` ended: it is idle, unless a later Turn started in it, which a
     * late end of an earlier one leaves running. Whether it was idled.
     */
    readonly threadTurnEnded: (
      id: SessionId,
      threadId: ThreadId,
      turnId: TurnId,
    ) => Effect.Effect<boolean, SqlError>
    /** The thread's model and thinking level. */
    readonly setThreadModel: (
      id: SessionId,
      threadId: ThreadId,
      setting: ModelSetting & { readonly model: ModelName },
    ) => Effect.Effect<void, SqlError>
    /** Forgets a thread the agent never made. Whether the Session had it. */
    readonly dropThread: (id: SessionId, threadId: ThreadId) => Effect.Effect<boolean, SqlError>
    /** Its agent stopped: no Turn runs in any of its threads. Returns those that ran. */
    readonly endThreadTurns: (id: SessionId) => Effect.Effect<ReadonlyArray<ThreadTurn>, SqlError>
  }
>()("@kndl/hub/Sessions") {
  static readonly layer = Layer.effect(
    Sessions,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      // Which Installations are on for a Repo is McpServers' to say (ADR 0020).
      const mcpServers = yield* McpServers

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

      /** The threads of the Sessions `ids`, oldest first, by Session. */
      const threadsOf = Effect.fn("Sessions.threadsOf")(function* (ids: ReadonlyArray<string>) {
        const rows = yield* sql<{
          readonly sessionId: string
          readonly id: string
          readonly anchorTurnId: string
          readonly title: string
          readonly startedById: string
          readonly startedByLogin: string
          readonly startedByName: string
          readonly startedByAvatarUrl: string | null
          readonly model: string | null
          readonly thinkingLevel: string | null
          readonly runningTurn: string | null
        }>`
          SELECT t.session_id AS sessionId, t.thread_id AS id, t.anchor_turn_id AS anchorTurnId,
            t.title, t.started_by AS startedById, p.login AS startedByLogin,
            p.name AS startedByName, p.avatar_url AS startedByAvatarUrl, t.model,
            t.thinking_level AS thinkingLevel, t.running_turn AS runningTurn
          FROM threads t JOIN participants p ON p.id = t.started_by
          WHERE t.session_id IN ${sql.in(ids)}
          ORDER BY t.created_at, t.rowid
        `
        const bySession = new Map<string, Array<ThreadSummary>>()
        for (const row of rows) {
          // A thread without a model the Hub still takes is hidden: it can't be shown as running on one.
          const { model, ...setting } = settingOf(row)
          if (model === undefined) continue
          const threads = bySession.get(row.sessionId) ?? []
          threads.push({
            id: ThreadId.make(row.id),
            title: row.title,
            anchorTurnId: TurnId.make(row.anchorTurnId),
            startedBy: {
              id: ParticipantId.make(row.startedById),
              login: row.startedByLogin,
              name: row.startedByName,
              ...(row.startedByAvatarUrl !== null && { avatarUrl: row.startedByAvatarUrl }),
            },
            running: row.runningTurn !== null,
            model,
            ...setting,
          })
          bySession.set(row.sessionId, threads)
        }
        return bySession
      })

      // A Session's latest Environment version is its Repo's, the spelling it was made with first
      // (#197). The exact match is picked in a table of its own: SQLite 3.51, macOS 26's, refuses
      // the Session's columns in a subquery's ORDER BY.
      const selectRows = (where: Fragment) => sql<SessionRow>`
        SELECT s.id, s.repo, s.base_branch AS baseBranch, s.work_branch AS workBranch, s.name,
          s.state,
          s.runner_id AS runnerId,
          s.creator_id AS creatorId, p.login AS creatorLogin, p.name AS creatorName,
          p.avatar_url AS creatorAvatarUrl,
          s.created_at AS createdAt, s.current_turn AS currentTurn,
          s.archived_by AS archivedById, a.login AS archivedByLogin, a.name AS archivedByName,
          a.avatar_url AS archivedByAvatarUrl, s.archived_at AS archivedAt, s.purge_at AS purgeAt,
          s.environment_version AS environmentVersion,
          (SELECT version FROM (
              SELECT e.version, e.repo, e.repo = s.repo AS exact FROM environments e
              WHERE e.repo = s.repo COLLATE NOCASE
            ) ORDER BY exact DESC, repo LIMIT 1) AS latestEnvironmentVersion,
          s.last_output AS lastOutput, s.harness, s.model, s.thinking_level AS thinkingLevel,
          s.model_pending AS modelPending,
          s.keep_awake_by AS keepAwakeById, k.login AS keepAwakeByLogin,
          k.name AS keepAwakeByName, k.avatar_url AS keepAwakeByAvatarUrl,
          s.keep_awake_at AS keepAwakeAt, s.open_question AS openQuestion, s.mcp_servers AS mcpServers
        FROM sessions s JOIN participants p ON p.id = s.creator_id
          LEFT JOIN participants a ON a.id = s.archived_by
          LEFT JOIN participants k ON k.id = s.keep_awake_by
        ${where}
        ORDER BY s.created_at, s.id
      `

      /** The Sessions `where` picks, as summaries. */
      const select = Effect.fn("Sessions.select")(function* (where: Fragment) {
        const rows = yield* selectRows(where)
        if (rows.length === 0) return []
        const agents = yield* activeAgents(rows.map((row) => row.id))
        const threads = yield* threadsOf(rows.map((row) => row.id))
        const installations = yield* mcpServers.installationsOn([
          ...new Set(rows.map((row) => row.repo)),
        ])
        return rows.map((row) =>
          toSummary(
            row,
            agents.get(row.id),
            installations.get(repoKey(row.repo)),
            threads.get(row.id),
          ),
        )
      })

      const get = Effect.fn("Sessions.get")(function* (id: SessionId) {
        const summaries = yield* select(sql`WHERE s.id = ${id}`)
        return Option.fromNullishOr(summaries[0])
      })

      const create = Effect.fn("Sessions.create")(function* (session: NewSession) {
        yield* sql`
          INSERT INTO sessions (
            id, repo, base_branch, work_branch, state, runner_id, creator_id, created_at, harness,
            model, thinking_level
          ) VALUES (
            ${session.id}, ${session.repo}, ${session.baseBranch}, ${session.workBranch},
            ${session.state}, ${session.runnerId}, ${session.creatorId}, ${session.createdAt},
            ${session.harness ?? null}, ${session.model ?? null}, ${session.thinkingLevel ?? null}
          )
        `
        return Option.getOrThrow(yield* get(session.id))
      })

      const startedWith = Effect.fn("Sessions.startedWith")(function* (id: SessionId) {
        const rows = yield* sql<{
          readonly repo: string
          readonly state: string
          readonly mcpServers: string | null
        }>`SELECT repo, state, mcp_servers AS mcpServers FROM sessions WHERE id = ${id}`
        return Option.map(Option.fromNullishOr(rows[0]), (row) => ({
          repo: row.repo,
          state: decodeState(row.state),
          mcpServers: startedWithOf(row.mcpServers),
        }))
      })

      const list = select(sql``).pipe(Effect.withSpan("Sessions.list"))

      const listByRunner = (runnerId: RunnerId) => select(sql`WHERE s.runner_id = ${runnerId}`)

      const agentStarted = Effect.fn("Sessions.agentStarted")(function* (
        id: SessionId,
        agent: NewAgent,
      ) {
        yield* sql`
          INSERT INTO agents (session_id, agent_id, description, status, started_at, harness)
          VALUES (${id}, ${agent.id}, ${agent.description}, 'Running', ${agent.startedAt},
            ${agent.harness === "Pi" ? "Pi" : null})
          ON CONFLICT (session_id, agent_id) DO UPDATE SET status = 'Running'
        `
      })

      const agentOf = Effect.fn("Sessions.agentOf")(function* (id: SessionId, agentId: AgentId) {
        const rows = yield* sql<{ readonly description: string; readonly harness: string | null }>`
          SELECT description, harness FROM agents WHERE session_id = ${id} AND agent_id = ${agentId}
        `
        return Option.map(Option.fromNullishOr(rows[0]), (row) => ({
          description: row.description,
          harness: (row.harness === "Pi" ? "Pi" : "ClaudeCode") as Harness,
        }))
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
          UPDATE sessions SET model = ${setting.model ?? null},
            thinking_level = ${setting.thinkingLevel ?? null}, model_pending = ${pending ? 1 : 0}
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

      const setOpenQuestion = Effect.fn("Sessions.setOpenQuestion")(function* (
        id: SessionId,
        question: OpenQuestion | null,
      ) {
        const json = question === null ? null : encodeOpenQuestion(question)
        yield* sql`UPDATE sessions SET open_question = ${json} WHERE id = ${id}`
      })

      const setConversationId = Effect.fn("Sessions.setConversationId")(function* (
        id: SessionId,
        harness: Harness,
        conversationId: ConversationId,
      ) {
        yield* sql`
          INSERT INTO session_conversations (session_id, harness, conversation_id)
          VALUES (${id}, ${harness}, ${conversationId})
          ON CONFLICT (session_id, harness) DO UPDATE SET conversation_id = excluded.conversation_id
        `
      })

      const seenSeq = Effect.fn("Sessions.seenSeq")(function* (id: SessionId, harness: Harness) {
        const rows = yield* sql<{ readonly seenSeq: number | null }>`
          SELECT seen_seq AS seenSeq FROM session_conversations
          WHERE session_id = ${id} AND harness = ${harness}
        `
        return Option.map(Option.fromNullishOr(rows[0]?.seenSeq), (seq) => EventSeq.make(seq))
      })

      const setSeenSeq = Effect.fn("Sessions.setSeenSeq")(function* (
        id: SessionId,
        harness: Harness,
        seq: EventSeq,
      ) {
        yield* sql`
          INSERT INTO session_conversations (session_id, harness, seen_seq)
          VALUES (${id}, ${harness}, ${seq})
          ON CONFLICT (session_id, harness) DO UPDATE SET seen_seq = excluded.seen_seq
        `
      })

      const switchHarness = Effect.fn("Sessions.switchHarness")(function* (
        id: SessionId,
        to: Harness,
        seenUpTo: EventSeq | undefined,
      ) {
        const rows = yield* sql<{
          readonly harness: string | null
          readonly handoffFrom: string | null
        }>`SELECT harness, handoff_from AS handoffFrom FROM sessions WHERE id = ${id}`
        const row = rows[0]
        if (row === undefined) return
        const from = harnessOf(row).harness ?? "ClaudeCode"
        if (from === to) return
        // One yet to be handed what it hadn't seen has seen no more than before.
        if (row.handoffFrom === null && seenUpTo !== undefined) {
          yield* setSeenSeq(id, from, seenUpTo)
        }
        // Claude Code is stored as none, as for a Session from before pi.
        yield* sql`
          UPDATE sessions SET harness = ${to === "Pi" ? to : null}, handoff_from = ${from}
          WHERE id = ${id}
        `
      }, sql.withTransaction)

      const handoffFrom = Effect.fn("Sessions.handoffFrom")(function* (id: SessionId) {
        const rows = yield* sql<{ readonly handoffFrom: string | null }>`
          SELECT handoff_from AS handoffFrom FROM sessions WHERE id = ${id}
        `
        return Option.flatMap(Option.fromNullishOr(rows[0]?.handoffFrom), decodeHarness)
      })

      const handoffDone = Effect.fn("Sessions.handoffDone")(function* (id: SessionId) {
        yield* sql`UPDATE sessions SET handoff_from = NULL WHERE id = ${id}`
      })

      const setEnvironmentVersion = Effect.fn("Sessions.setEnvironmentVersion")(function* (
        id: SessionId,
        version: EnvironmentVersion | null,
      ) {
        yield* sql`UPDATE sessions SET environment_version = ${version} WHERE id = ${id}`
      })

      const conversationId = Effect.fn("Sessions.conversationId")(function* (
        id: SessionId,
        harness: Harness,
      ) {
        const rows = yield* sql<{ readonly conversationId: string | null }>`
          SELECT conversation_id AS conversationId FROM session_conversations
          WHERE session_id = ${id} AND harness = ${harness}
        `
        // One recorded before conversation ids were checked may not be one: then it is unknown.
        return Option.flatMap(Option.fromNullishOr(rows[0]?.conversationId), decodeConversationId)
      })

      const setLastOutput = Effect.fn("Sessions.setLastOutput")(function* (
        id: SessionId,
        output: string | null,
      ) {
        yield* sql`UPDATE sessions SET last_output = ${output} WHERE id = ${id}`
      })

      const setMcpServers = Effect.fn("Sessions.setMcpServers")(function* (
        id: SessionId,
        installations: ReadonlyArray<SessionInstallation>,
      ) {
        yield* sql`
          UPDATE sessions SET mcp_servers = ${encodeInstallations(installations)} WHERE id = ${id}
        `
      })

      const setKeepAwake = Effect.fn("Sessions.setKeepAwake")(function* (
        id: SessionId,
        keepingAwake: KeepingAwake | null,
      ) {
        yield* sql`
          UPDATE sessions SET keep_awake_by = ${keepingAwake?.by ?? null},
            keep_awake_at = ${keepingAwake?.at ?? null}
          WHERE id = ${id}
        `
      })

      const archive = Effect.fn("Sessions.archive")(function* (
        id: SessionId,
        archiving: Archiving,
      ) {
        yield* sql`
          UPDATE sessions SET state = 'Archived', current_turn = NULL, open_question = NULL,
            archived_by = ${archiving.by}, archived_at = ${archiving.at},
            purge_at = ${archiving.purgeAt}, archive_stopped = 0, last_output = NULL,
            keep_awake_by = NULL, keep_awake_at = NULL
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
        // The event log, Prompt queue, subagents and threads go with it (ON DELETE CASCADE).
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

      const threadStarted = Effect.fn("Sessions.threadStarted")(function* (
        id: SessionId,
        thread: NewThread,
      ) {
        yield* sql`
          INSERT INTO threads (
            session_id, thread_id, anchor_turn_id, title, started_by, model, thinking_level,
            created_at
          ) VALUES (
            ${id}, ${thread.id}, ${thread.anchorTurnId}, ${thread.title}, ${thread.startedBy},
            ${thread.model}, ${thread.thinkingLevel ?? null}, ${thread.createdAt}
          )
        `
      })

      const threadOf = Effect.fn("Sessions.threadOf")(function* (
        id: SessionId,
        threadId: ThreadId,
      ) {
        const rows = yield* sql<{
          readonly title: string
          readonly model: string | null
          readonly thinkingLevel: string | null
          readonly runningTurn: string | null
        }>`
          SELECT title, model, thinking_level AS thinkingLevel, running_turn AS runningTurn
          FROM threads WHERE session_id = ${id} AND thread_id = ${threadId}
        `
        return Option.map(Option.fromNullishOr(rows[0]), (row) => ({
          title: row.title,
          ...settingOf(row),
          running: row.runningTurn !== null,
          ...(row.runningTurn !== null && { runningTurn: TurnId.make(row.runningTurn) }),
        }))
      })

      const setThreadTurn = Effect.fn("Sessions.setThreadTurn")(function* (
        id: SessionId,
        threadId: ThreadId,
        turn: { readonly turnId: TurnId; readonly startedAt: number },
      ) {
        const rows = yield* sql<{ readonly id: string }>`
          UPDATE threads SET running_turn = ${turn.turnId}, turn_started_at = ${turn.startedAt}
          WHERE session_id = ${id} AND thread_id = ${threadId}
          RETURNING thread_id AS id
        `
        return rows.length > 0
      })

      const threadTurnEnded = Effect.fn("Sessions.threadTurnEnded")(function* (
        id: SessionId,
        threadId: ThreadId,
        turnId: TurnId,
      ) {
        const rows = yield* sql<{ readonly id: string }>`
          UPDATE threads SET running_turn = NULL, turn_started_at = NULL
          WHERE session_id = ${id} AND thread_id = ${threadId} AND running_turn = ${turnId}
          RETURNING thread_id AS id
        `
        return rows.length > 0
      })

      const setThreadModel = Effect.fn("Sessions.setThreadModel")(function* (
        id: SessionId,
        threadId: ThreadId,
        setting: ModelSetting & { readonly model: ModelName },
      ) {
        yield* sql`
          UPDATE threads SET model = ${setting.model},
            thinking_level = ${setting.thinkingLevel ?? null}
          WHERE session_id = ${id} AND thread_id = ${threadId}
        `
      })

      const dropThread = Effect.fn("Sessions.dropThread")(function* (
        id: SessionId,
        threadId: ThreadId,
      ) {
        const rows = yield* sql<{ readonly id: string }>`
          DELETE FROM threads WHERE session_id = ${id} AND thread_id = ${threadId}
          RETURNING thread_id AS id
        `
        return rows.length > 0
      })

      const endThreadTurns = Effect.fn("Sessions.endThreadTurns")(function* (id: SessionId) {
        // Read before they are cleared: RETURNING gives the values a row has after.
        const rows = yield* sql<{
          readonly threadId: string
          readonly turnId: string
          readonly startedAt: number | null
        }>`
          SELECT thread_id AS threadId, running_turn AS turnId, turn_started_at AS startedAt
          FROM threads WHERE session_id = ${id} AND running_turn IS NOT NULL
          ORDER BY created_at, rowid
        `
        if (rows.length === 0) return []
        yield* sql`
          UPDATE threads SET running_turn = NULL, turn_started_at = NULL
          WHERE session_id = ${id} AND running_turn IS NOT NULL
        `
        return rows.map((row): ThreadTurn => ({
          threadId: ThreadId.make(row.threadId),
          turnId: TurnId.make(row.turnId),
          startedAt: row.startedAt ?? undefined,
        }))
      }, sql.withTransaction)

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
        startedWith,
        agentStarted,
        agentStatus,
        agentOf,
        setAgentStatus,
        interruptAgents,
        setState,
        setName,
        setModel,
        setModelPending,
        setKeepAwake,
        setOpenQuestion,
        setCurrentTurn,
        setConversationId,
        setEnvironmentVersion,
        conversationId,
        seenSeq,
        setSeenSeq,
        switchHarness,
        handoffFrom,
        handoffDone,
        setLastOutput,
        setMcpServers,
        threadStarted,
        threadOf,
        setThreadTurn,
        threadTurnEnded,
        setThreadModel,
        dropThread,
        endThreadTurns,
      })
    }),
  )
}
