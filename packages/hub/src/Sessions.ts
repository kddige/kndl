import {
  ClaudeSessionId,
  ParticipantId,
  RunnerId,
  SessionId,
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
}

interface SessionRow {
  readonly id: string
  readonly repo: string
  readonly baseBranch: string
  readonly workBranch: string
  readonly state: string
  readonly runnerId: string
  readonly runnerLoginAccount: string
  readonly creatorId: string
  readonly creatorLogin: string
  readonly creatorName: string
  readonly createdAt: number
  readonly currentTurn: string | null
}

const decodeState = Schema.decodeUnknownSync(SessionState)

const toSummary = (row: SessionRow): SessionSummary =>
  SessionSummary.make({
    id: SessionId.make(row.id),
    repo: row.repo,
    baseBranch: row.baseBranch,
    workBranch: row.workBranch,
    state: decodeState(row.state),
    runnerId: RunnerId.make(row.runnerId),
    runnerLogin: { account: row.runnerLoginAccount },
    creator: {
      id: ParticipantId.make(row.creatorId),
      login: row.creatorLogin,
      name: row.creatorName,
    },
    createdAt: row.createdAt,
    currentTurn: row.currentTurn === null ? null : TurnId.make(row.currentTurn),
  })

/**
 * Every Session the Hub knows, in SQLite: its Repo and branches, lifecycle state, Runner,
 * Creator, and the Turn running now. The Creator is shown with their current login and name.
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
    readonly setState: (id: SessionId, state: SessionState) => Effect.Effect<void, SqlError>
    /** The Turn running now, or null once the Session is idle. */
    readonly setCurrentTurn: (id: SessionId, turn: TurnId | null) => Effect.Effect<void, SqlError>
    /** Claude Code's own session id, from the mod's hello, for waking the Session (#12). */
    readonly setClaudeSessionId: (
      id: SessionId,
      claudeSessionId: ClaudeSessionId,
    ) => Effect.Effect<void, SqlError>
    /** The Claude Code session id last recorded, or none if its mod never said hello. */
    readonly claudeSessionId: (
      id: SessionId,
    ) => Effect.Effect<Option.Option<ClaudeSessionId>, SqlError>
  }
>()("@claude-hub/hub/Sessions") {
  static readonly layer = Layer.effect(
    Sessions,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const select = (where: Fragment) => sql<SessionRow>`
        SELECT s.id, s.repo, s.base_branch AS baseBranch, s.work_branch AS workBranch, s.state,
          s.runner_id AS runnerId, s.runner_login_account AS runnerLoginAccount,
          s.creator_id AS creatorId, p.login AS creatorLogin, p.name AS creatorName,
          s.created_at AS createdAt, s.current_turn AS currentTurn
        FROM sessions s JOIN participants p ON p.id = s.creator_id
        ${where}
        ORDER BY s.created_at, s.id
      `

      const get = Effect.fn("Sessions.get")(function* (id: SessionId) {
        const rows = yield* select(sql`WHERE s.id = ${id}`)
        return Option.map(Option.fromNullishOr(rows[0]), toSummary)
      })

      const create = Effect.fn("Sessions.create")(function* (session: NewSession) {
        yield* sql`
          INSERT INTO sessions (
            id, repo, base_branch, work_branch, state, runner_id, runner_login_account,
            creator_id, created_at
          ) VALUES (
            ${session.id}, ${session.repo}, ${session.baseBranch}, ${session.workBranch},
            ${session.state}, ${session.runnerId}, ${session.runnerLogin.account},
            ${session.creatorId}, ${session.createdAt}
          )
        `
        return Option.getOrThrow(yield* get(session.id))
      })

      const list = Effect.map(select(sql``), (rows) => rows.map(toSummary)).pipe(
        Effect.withSpan("Sessions.list"),
      )

      const listByRunner = Effect.fn("Sessions.listByRunner")(function* (runnerId: RunnerId) {
        const rows = yield* select(sql`WHERE s.runner_id = ${runnerId}`)
        return rows.map(toSummary)
      })

      const setState = Effect.fn("Sessions.setState")(function* (
        id: SessionId,
        state: SessionState,
      ) {
        yield* sql`UPDATE sessions SET state = ${state} WHERE id = ${id}`
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

      const claudeSessionId = Effect.fn("Sessions.claudeSessionId")(function* (id: SessionId) {
        const rows = yield* sql<{ readonly claudeSessionId: string | null }>`
          SELECT claude_session_id AS claudeSessionId FROM sessions WHERE id = ${id}
        `
        return Option.map(Option.fromNullishOr(rows[0]?.claudeSessionId), (value) =>
          ClaudeSessionId.make(value),
        )
      })

      return Sessions.of({
        create,
        get,
        list,
        listByRunner,
        setState,
        setCurrentTurn,
        setClaudeSessionId,
        claudeSessionId,
      })
    }),
  )
}
