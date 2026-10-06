import {
  type BuildVersion,
  CommitIdPattern,
  RunnerId,
  type RunnerAccount,
  RunnerModels,
  RunnerUpdater,
  type SessionState,
} from "@kndl/protocol"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import type { Fragment } from "effect/sql/Statement"

/** A Runner paired with the Hub and not removed, as the Hub last heard from it. */
export interface KnownRunner {
  readonly id: RunnerId
  readonly name: string
  /** Its own Claude credential, as its last hello showed it; null until it first connects. */
  readonly login: RunnerAccount | null
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
}

/** The Session states that keep a Runner from being removed. */
const openStates: ReadonlyArray<SessionState> = ["Active", "Asleep", "Frozen"]

interface RunnerRow {
  readonly id: string
  readonly name: string
  readonly account: string | null
  readonly commit: string | null
  readonly branch: string | null
  readonly lastSeenAt: number | null
  readonly openSessions: number
  readonly updater: string | null
  readonly models: string | null
}

const decodeUpdater = Schema.decodeUnknownOption(Schema.fromJsonString(RunnerUpdater))
const decodeModels = Schema.decodeUnknownOption(Schema.fromJsonString(RunnerModels))

const fromRow = (row: RunnerRow): KnownRunner => ({
  id: RunnerId.make(row.id),
  name: row.name,
  login: row.account === null ? null : { account: row.account },
  // A row from a hello is a full commit id; anything else would fail the Runners list's encoding,
  // so it reads as no version.
  version:
    row.commit === null || !CommitIdPattern.test(row.commit)
      ? null
      : { commit: row.commit, ...(row.branch !== null && { branch: row.branch }) },
  lastSeenAt: row.lastSeenAt,
  openSessions: row.openSessions,
  updater: row.updater === null ? null : Option.getOrNull(decodeUpdater(row.updater)),
  models: row.models === null ? null : Option.getOrNull(decodeModels(row.models)),
})

/**
 * What the Hub remembers about Runners beyond their tokens (RunnerTokens.ts): the own Claude
 * credential and version each last said hello with, and when it was last connected, so the web
 * UI can list Runners that are offline too.
 */
export class Runners extends Context.Service<
  Runners,
  {
    /**
     * A Runner said hello: what it said, and that it is connected as of `at`. Its models are kept
     * from before when it doesn't say, as when its Claude Code couldn't tell it this time.
     */
    readonly recordHello: (
      id: RunnerId,
      hello: {
        readonly login: RunnerAccount
        readonly version: BuildVersion | undefined
        readonly updater: RunnerUpdater | undefined
        readonly models?: RunnerModels | undefined
      },
      at: number,
    ) => Effect.Effect<void, SqlError>
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

      const recordHello = Effect.fn("Runners.recordHello")(function* (
        id: RunnerId,
        hello: {
          readonly login: RunnerAccount
          readonly version: BuildVersion | undefined
          readonly updater: RunnerUpdater | undefined
          readonly models?: RunnerModels | undefined
        },
        at: number,
      ) {
        yield* sql`
          UPDATE runners SET login_account = ${hello.login.account},
            version_commit = ${hello.version?.commit ?? null},
            version_branch = ${hello.version?.branch ?? null},
            updater = ${hello.updater === undefined ? null : JSON.stringify(hello.updater)},
            models = COALESCE(${hello.models === undefined ? null : JSON.stringify(hello.models)}, models),
            last_seen_at = ${at}
          WHERE id = ${id}
        `
      })

      const recordSeen = Effect.fn("Runners.recordSeen")(function* (id: RunnerId, at: number) {
        yield* sql`UPDATE runners SET last_seen_at = ${at} WHERE id = ${id}`
      })

      const select = (where: Fragment) => sql<RunnerRow>`
        SELECT r.id, r.name, r.login_account AS account, r.version_commit AS "commit",
          r.version_branch AS branch, r.last_seen_at AS lastSeenAt, r.updater, r.models,
          (SELECT count(*) FROM sessions s
            WHERE s.runner_id = r.id AND s.state IN ${sql.in(openStates)}) AS openSessions
        FROM runners r
        WHERE r.removed_at IS NULL ${where}
        ORDER BY r.name
      `

      const list = select(sql``).pipe(
        Effect.map((rows) => rows.map(fromRow)),
        Effect.withSpan("Runners.list"),
      )

      const get = Effect.fn("Runners.get")(function* (id: RunnerId) {
        const rows = yield* select(sql`AND r.id = ${id}`)
        return Option.fromNullishOr(rows[0]).pipe(Option.map(fromRow))
      })

      return Runners.of({ recordHello, recordSeen, list, get })
    }),
  )
}
