import {
  type BuildVersion,
  CommitIdPattern,
  type Harness,
  ReleaseVersionPattern,
  RunnerHistoryPointMillis,
  RunnerHistoryRetentionMillis,
  type RunnerHistoryPoint,
  RunnerId,
  RunnerModels,
  RunnerUpdater,
  type SessionState,
  type Sysinfo,
  type SysinfoSample,
} from "@kndl/protocol"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import type { Fragment } from "effect/sql/Statement"

/** A Runner paired with the Hub and not removed, as the Hub last heard from it. */
export interface KnownRunner {
  readonly id: RunnerId
  readonly name: string
  /** The version it last said hello with; null before then, or from a Runner too old to say. */
  readonly version: BuildVersion | null
  /** When it was last connected, as of its last hello or disconnect. */
  readonly lastSeenAt: number | null
  /** Its Sessions that aren't Archived. */
  readonly openSessions: number
  /** Whether it updates itself, as it last said; null from a Runner too old to say (#87). */
  readonly updater: RunnerUpdater | null
  /** The models its Claude Code offers, as it last said; null before it first says (#128). */
  readonly models: RunnerModels | null
  /** Its last sysinfo sample (#350), kept in memory only: null before its first since the Hub started. */
  readonly sysinfo: SysinfoSample | null
  /**
   * The Harnesses it runs Sessions on (ADR 0029), as its last hello since the Hub started said,
   * kept in memory only; null before then, or from a Runner that runs Claude Code alone.
   */
  readonly harnesses: ReadonlyArray<Harness> | null
}

/** The Session states that keep a Runner from being removed. */
const openStates: ReadonlyArray<SessionState> = ["Active", "Asleep", "Frozen"]

interface RunnerRow {
  readonly id: string
  readonly name: string
  readonly commit: string | null
  readonly branch: string | null
  readonly release: string | null
  readonly lastSeenAt: number | null
  readonly openSessions: number
  readonly updater: string | null
  readonly models: string | null
}

const decodeUpdater = Schema.decodeUnknownOption(Schema.fromJsonString(RunnerUpdater))
const decodeModels = Schema.decodeUnknownOption(Schema.fromJsonString(RunnerModels))

const fromRow = (
  row: RunnerRow,
  sysinfo: SysinfoSample | undefined,
  harnesses: ReadonlyArray<Harness> | undefined,
): KnownRunner => ({
  id: RunnerId.make(row.id),
  name: row.name,
  // A row from a hello is a full commit id, and a Release's version; anything else would fail the
  // Runners list's encoding, so it reads as no version, or no Release.
  version:
    row.commit === null || !CommitIdPattern.test(row.commit)
      ? null
      : {
          commit: row.commit,
          ...(row.branch !== null && { branch: row.branch }),
          ...(row.release !== null &&
            ReleaseVersionPattern.test(row.release) && { release: row.release }),
        },
  lastSeenAt: row.lastSeenAt,
  openSessions: row.openSessions,
  updater: row.updater === null ? null : Option.getOrNull(decodeUpdater(row.updater)),
  models: row.models === null ? null : Option.getOrNull(decodeModels(row.models)),
  sysinfo: sysinfo ?? null,
  harnesses: harnesses ?? null,
})

/**
 * What the Hub remembers about Runners beyond their tokens (RunnerTokens.ts): the version each
 * last said hello with, and when it was last connected, so the web UI can list Runners that are
 * offline too; and the samples of their hosts (#350): the latest of each in memory, and their free
 * disk, available memory and load in the database for a week (#356).
 */
export class Runners extends Context.Service<
  Runners,
  {
    /**
     * A Runner said hello: what it said, and that it is connected as of `at`. Its models are kept
     * from before when it doesn't say, as when its Claude Code couldn't tell it this time. Its
     * Harnesses (ADR 0029) are kept in memory only.
     */
    readonly recordHello: (
      id: RunnerId,
      hello: {
        readonly version: BuildVersion | undefined
        readonly updater: RunnerUpdater | undefined
        readonly models?: RunnerModels | undefined
        readonly harnesses?: ReadonlyArray<Harness> | undefined
      },
      at: number,
    ) => Effect.Effect<void, SqlError>
    /**
     * A Runner sampled its host at `at` (#350). The sample replaces the one before, and its free
     * disk, available memory and 1-minute load (#356) are kept as a point of the Runner's history,
     * in place of any earlier one in the same {@link RunnerHistoryPointMillis}. Points older than
     * {@link RunnerHistoryRetentionMillis} are deleted, every Runner's.
     */
    readonly recordSysinfo: (
      id: RunnerId,
      sysinfo: Sysinfo,
      at: number,
    ) => Effect.Effect<void, SqlError>
    /** A Runner's history points of the retention before `now`, oldest first. */
    readonly history: (
      id: RunnerId,
      now: number,
    ) => Effect.Effect<ReadonlyArray<RunnerHistoryPoint>, SqlError>
    /** A Runner was last connected at `at`, as when it disconnects. */
    readonly recordSeen: (id: RunnerId, at: number) => Effect.Effect<void, SqlError>
    /** Every Runner paired and not removed, by name. */
    readonly list: Effect.Effect<ReadonlyArray<KnownRunner>, SqlError>
    /** A Runner paired and not removed. */
    readonly get: (id: RunnerId) => Effect.Effect<Option.Option<KnownRunner>, SqlError>
  }
>()("@kndl/hub/Runners") {
  static readonly layer = Layer.effect(
    Runners,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      /** Each Runner's Harnesses, as its last hello said (ADR 0029). */
      const harnesses = new Map<string, ReadonlyArray<Harness>>()

      const recordHello = Effect.fn("Runners.recordHello")(function* (
        id: RunnerId,
        hello: {
          readonly version: BuildVersion | undefined
          readonly updater: RunnerUpdater | undefined
          readonly models?: RunnerModels | undefined
          readonly harnesses?: ReadonlyArray<Harness> | undefined
        },
        at: number,
      ) {
        if (hello.harnesses === undefined) harnesses.delete(id)
        else harnesses.set(id, hello.harnesses)
        yield* sql`
          UPDATE runners SET version_commit = ${hello.version?.commit ?? null},
            version_branch = ${hello.version?.branch ?? null},
            version_release = ${hello.version?.release ?? null},
            updater = ${hello.updater === undefined ? null : JSON.stringify(hello.updater)},
            models = COALESCE(${hello.models === undefined ? null : JSON.stringify(hello.models)}, models),
            last_seen_at = ${at}
          WHERE id = ${id}
        `
      })

      const recordSeen = Effect.fn("Runners.recordSeen")(function* (id: RunnerId, at: number) {
        yield* sql`UPDATE runners SET last_seen_at = ${at} WHERE id = ${id}`
      })

      const latest = new Map<string, SysinfoSample>()

      const recordSysinfo = Effect.fn("Runners.recordSysinfo")(function* (
        id: RunnerId,
        sysinfo: Sysinfo,
        at: number,
      ) {
        latest.set(id, { ...sysinfo, at })
        yield* sql`
          INSERT INTO runner_history
            (runner_id, bucket, at, disk_free_bytes, memory_available_bytes, load_1)
          VALUES (${id}, ${Math.floor(at / RunnerHistoryPointMillis)}, ${at},
            ${sysinfo.diskFreeBytes}, ${sysinfo.memoryAvailableBytes}, ${sysinfo.loadAverage[0]})
          ON CONFLICT (runner_id, bucket) DO UPDATE SET at = excluded.at,
            disk_free_bytes = excluded.disk_free_bytes,
            memory_available_bytes = excluded.memory_available_bytes, load_1 = excluded.load_1
        `
        yield* sql`DELETE FROM runner_history WHERE at < ${at - RunnerHistoryRetentionMillis}`
      })

      const history = Effect.fn("Runners.history")(function* (id: RunnerId, now: number) {
        const rows = yield* sql<{
          readonly at: number
          readonly diskFreeBytes: number
          readonly memoryAvailableBytes: number | null
          readonly load1: number | null
        }>`
          SELECT at, disk_free_bytes AS diskFreeBytes,
            memory_available_bytes AS memoryAvailableBytes, load_1 AS load1
          FROM runner_history
          WHERE runner_id = ${id} AND at >= ${now - RunnerHistoryRetentionMillis}
          ORDER BY at
        `
        // A point from before #356 has no memory or load.
        return rows.map(
          ({ at, diskFreeBytes, memoryAvailableBytes, load1 }): RunnerHistoryPoint => ({
            at,
            diskFreeBytes,
            ...(memoryAvailableBytes !== null && { memoryAvailableBytes }),
            ...(load1 !== null && { load1 }),
          }),
        )
      })

      const select = (where: Fragment) => sql<RunnerRow>`
        SELECT r.id, r.name, r.version_commit AS "commit",
          r.version_branch AS branch, r.version_release AS release, r.last_seen_at AS lastSeenAt, r.updater, r.models,
          (SELECT count(*) FROM sessions s
            WHERE s.runner_id = r.id AND s.state IN ${sql.in(openStates)}) AS openSessions
        FROM runners r
        WHERE r.removed_at IS NULL ${where}
        ORDER BY r.name
      `

      const list = select(sql``).pipe(
        Effect.map((rows) =>
          rows.map((row) => fromRow(row, latest.get(row.id), harnesses.get(row.id))),
        ),
        Effect.withSpan("Runners.list"),
      )

      const get = Effect.fn("Runners.get")(function* (id: RunnerId) {
        const rows = yield* select(sql`AND r.id = ${id}`)
        return Option.fromNullishOr(rows[0]).pipe(
          Option.map((row) => fromRow(row, latest.get(row.id), harnesses.get(row.id))),
        )
      })

      return Runners.of({ recordHello, recordSysinfo, history, recordSeen, list, get })
    }),
  )
}
