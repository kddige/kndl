import { EventSeq, SessionEvent, type SessionId, SessionLogEntry } from "@kndl/protocol"
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
    /**
     * The Session's log from the start of the `count`th last Turn of its main loop (ADR 0030),
     * among its entries after `after` and before `before`, oldest first: all of those, with fewer
     * Turns. `earlier` says whether a Turn starts before them. Only those are read, so paging back
     * through a long log reads each page alone.
     */
    readonly lastTurns: (
      sessionId: SessionId,
      range: { readonly count: number; readonly after?: EventSeq; readonly before?: EventSeq },
    ) => Effect.Effect<
      { readonly entries: ReadonlyArray<SessionLogEntry>; readonly earlier: boolean },
      SqlError
    >
    /** The seq of the Session's last entry, or none for an empty log. */
    readonly lastSeq: (sessionId: SessionId) => Effect.Effect<EventSeq | undefined, SqlError>
  }
>()("@kndl/hub/SessionLog") {
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

      const lastTurns = Effect.fn("SessionLog.lastTurns")(function* (
        sessionId: SessionId,
        range: { readonly count: number; readonly after?: EventSeq; readonly before?: EventSeq },
      ) {
        const after = range.after ?? -1
        const before = range.before ?? Number.MAX_SAFE_INTEGER
        // The main loop's: a subagent's Turn says its agent, a thread's its thread.
        const starts = yield* sql<{ readonly seq: number }>`
          SELECT seq FROM session_events
          WHERE session_id = ${sessionId} AND seq > ${after} AND seq < ${before}
            AND json_extract(event, '$._tag') = 'TurnStarted'
            AND json_extract(event, '$.agentId') IS NULL
            AND json_extract(event, '$.threadId') IS NULL
          ORDER BY seq DESC
          LIMIT ${range.count + 1}
        `
        const earlier = starts.length > range.count
        const from = earlier ? (starts[range.count - 1]?.seq ?? after + 1) : after + 1
        const rows = yield* sql<Row>`
          SELECT seq, at, event FROM session_events
          WHERE session_id = ${sessionId} AND seq >= ${from} AND seq > ${after}
            AND seq < ${before}
          ORDER BY seq
        `
        return { entries: rows.map(toEntry), earlier }
      })

      const lastSeq = Effect.fn("SessionLog.lastSeq")(function* (sessionId: SessionId) {
        const rows = yield* sql<{ readonly seq: number | null }>`
          SELECT MAX(seq) AS seq FROM session_events WHERE session_id = ${sessionId}
        `
        const seq = rows[0]?.seq
        return seq === null || seq === undefined ? undefined : EventSeq.make(seq)
      })

      return SessionLog.of({ append, history, lastTurns, lastSeq })
    }),
  )
}
