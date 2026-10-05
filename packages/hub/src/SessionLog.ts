import { EventSeq, SessionEvent, type SessionId, SessionLogEntry } from "@claude-hub/protocol"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"

/** A SessionEvent as the JSON text the log stores. */
const EventJson = Schema.fromJsonString(SessionEvent)
const encodeEvent = Schema.encodeSync(EventJson)
const decodeEvent = Schema.decodeUnknownSync(EventJson)

/**
 * Each Session's event log, in SQLite: Turn events from the mod and what the Hub saw happen
 * (SessionStateChanged, TurnStopRequested), numbered 0, 1, 2, ... in the order appended. It is
 * the source of truth for what happened in a Session, replayed to every web client that joins.
 */
export class SessionLog extends Context.Service<
  SessionLog,
  {
    /** Appends an event to the Session's log, numbered after the last, stamped with the time. */
    readonly append: (
      sessionId: SessionId,
      event: SessionEvent,
    ) => Effect.Effect<SessionLogEntry, SqlError>
    /** The Session's log, oldest first: all of it, or only the entries after `afterSeq`. */
    readonly history: (
      sessionId: SessionId,
      afterSeq?: EventSeq,
    ) => Effect.Effect<ReadonlyArray<SessionLogEntry>, SqlError>
    /** The Session's last `limit` entries, oldest first. */
    readonly recent: (
      sessionId: SessionId,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<SessionLogEntry>, SqlError>
    /**
     * The main loop's entries of the Session's last Turn, oldest first, from its TurnStarted on:
     * none of its subagents'. Empty if no Turn has started.
     */
    readonly lastTurn: (
      sessionId: SessionId,
    ) => Effect.Effect<ReadonlyArray<SessionLogEntry>, SqlError>
  }
>()("@claude-hub/hub/SessionLog") {
  static readonly layer = Layer.effect(
    SessionLog,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const append = Effect.fn("SessionLog.append")(function* (
        sessionId: SessionId,
        event: SessionEvent,
      ) {
        const at = yield* Clock.currentTimeMillis
        const rows = yield* sql<{ readonly seq: number }>`
            SELECT COALESCE(MAX(seq) + 1, 0) AS seq FROM session_events
            WHERE session_id = ${sessionId}
          `
        const seq = EventSeq.make(rows[0]?.seq ?? 0)
        yield* sql`
            INSERT INTO session_events (session_id, seq, at, event)
            VALUES (${sessionId}, ${seq}, ${at}, ${encodeEvent(event)})
          `
        return SessionLogEntry.make({ seq, at, event })
      }, sql.withTransaction)

      interface Row {
        readonly seq: number
        readonly at: number
        readonly event: string
      }
      const toEntry = (row: Row) =>
        SessionLogEntry.make({
          seq: EventSeq.make(row.seq),
          at: row.at,
          event: decodeEvent(row.event),
        })

      const history = Effect.fn("SessionLog.history")(function* (
        sessionId: SessionId,
        afterSeq?: EventSeq,
      ) {
        const rows = yield* sql<Row>`
          SELECT seq, at, event FROM session_events
          WHERE session_id = ${sessionId} AND seq > ${afterSeq ?? -1}
          ORDER BY seq
        `
        return rows.map(toEntry)
      })

      const recent = Effect.fn("SessionLog.recent")(function* (
        sessionId: SessionId,
        limit: number,
      ) {
        const rows = yield* sql<Row>`
          SELECT seq, at, event FROM session_events
          WHERE session_id = ${sessionId}
          ORDER BY seq DESC LIMIT ${limit}
        `
        return rows.map(toEntry).toReversed()
      })

      const lastTurn = Effect.fn("SessionLog.lastTurn")(function* (sessionId: SessionId) {
        const rows = yield* sql<Row>`
          SELECT seq, at, event FROM session_events
          WHERE session_id = ${sessionId}
            AND json_extract(event, '$.agentId') IS NULL
            AND seq >= (
              SELECT MAX(seq) FROM session_events
              WHERE session_id = ${sessionId} AND json_extract(event, '$._tag') = 'TurnStarted'
            )
          ORDER BY seq
        `
        return rows.map(toEntry)
      })

      return SessionLog.of({ append, history, recent, lastTurn })
    }),
  )
}
