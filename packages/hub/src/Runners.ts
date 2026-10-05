import {
  type BuildVersion,
  RunnerId,
  type RunnerLogin,
  type SessionState,
} from "@claude-hub/protocol"
import { Context, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import type { Fragment } from "effect/sql/Statement"

/** A Runner paired with the Hub and not removed, as the Hub last heard from it. */
export interface KnownRunner {
  readonly id: RunnerId
  readonly name: string
  /** The Runner login it last said hello with; null until it first connects. */
  readonly login: RunnerLogin | null
  /** The version it last said hello with; null before then, or from a Runner too old to say. */
  readonly version: BuildVersion | null
  /** When it was last connected, as of its last hello or disconnect. */
  readonly lastSeenAt: number | null
  /** Its Sessions that aren't Archived. */
  readonly openSessions: number
}

/** The Session states that keep a Runner from being removed. */
const openStates: ReadonlyArray<SessionState> = ["Active", "Asleep", "Frozen"]

/**
 * Why a Runner can't be removed, or `undefined` when it can: while it has Sessions that aren't
 * Archived, they would be stranded on a Runner that can never come back.
 */
export function removalRefusal(name: string, openSessions: number): string | undefined {
  if (openSessions === 0) return undefined
  const sessions = openSessions === 1 ? "1 Session" : `${openSessions} Sessions`
  return `Runner ${name} has ${sessions} that ${openSessions === 1 ? "isn't" : "aren't"} Archived. Archive ${openSessions === 1 ? "it" : "them"} first, then remove the Runner.`
}

interface RunnerRow {
  readonly id: string
  readonly name: string
  readonly account: string | null
  readonly commit: string | null
  readonly branch: string | null
  readonly lastSeenAt: number | null
  readonly openSessions: number
}

const fromRow = (row: RunnerRow): KnownRunner => ({
  id: RunnerId.make(row.id),
  name: row.name,
  login: row.account === null ? null : { account: row.account },
  version:
    row.commit === null
      ? null
      : { commit: row.commit, ...(row.branch !== null && { branch: row.branch }) },
  lastSeenAt: row.lastSeenAt,
  openSessions: row.openSessions,
})

/**
 * What the Hub remembers about Runners beyond their tokens (RunnerTokens.ts): the Runner login and
 * version each last said hello with, and when it was last connected, so the web UI can list
 * Runners that are offline too.
 */
export class Runners extends Context.Service<
  Runners,
  {
    /** A Runner said hello: what it said, and that it is connected as of `at`. */
    readonly recordHello: (
      id: RunnerId,
      hello: { readonly login: RunnerLogin; readonly version: BuildVersion | undefined },
      at: number,
    ) => Effect.Effect<void, SqlError>
    /** A Runner was last connected at `at`, as when it disconnects. */
    readonly recordSeen: (id: RunnerId, at: number) => Effect.Effect<void, SqlError>
    /** Every Runner paired and not removed, by name. */
    readonly list: Effect.Effect<ReadonlyArray<KnownRunner>, SqlError>
    /** A Runner paired and not removed. */
    readonly get: (id: RunnerId) => Effect.Effect<Option.Option<KnownRunner>, SqlError>
  }
>()("@claude-hub/hub/Runners") {
  static readonly layer = Layer.effect(
    Runners,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const recordHello = Effect.fn("Runners.recordHello")(function* (
        id: RunnerId,
        hello: { readonly login: RunnerLogin; readonly version: BuildVersion | undefined },
        at: number,
      ) {
        yield* sql`
          UPDATE runners SET login_account = ${hello.login.account},
            version_commit = ${hello.version?.commit ?? null},
            version_branch = ${hello.version?.branch ?? null},
            last_seen_at = ${at}
          WHERE id = ${id}
        `
      })

      const recordSeen = Effect.fn("Runners.recordSeen")(function* (id: RunnerId, at: number) {
        yield* sql`UPDATE runners SET last_seen_at = ${at} WHERE id = ${id}`
      })

      const select = (where: Fragment) => sql<RunnerRow>`
        SELECT r.id, r.name, r.login_account AS account, r.version_commit AS "commit",
          r.version_branch AS branch, r.last_seen_at AS lastSeenAt,
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
