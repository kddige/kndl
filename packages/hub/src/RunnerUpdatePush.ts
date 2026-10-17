// What `kndl update` on the Hub's machine leaves for the Hub it restarts (issue #87, ADR
// 0011): the commit it moved the Hub to, for Runners to follow. The CLI writes it into the Hub's
// database before restarting the Hub; the Hub reads it once it runs, and tells the Runners it
// covers to update as they connect. It applies only while the Hub runs that commit, and the next
// `update` replaces it. An update that rolls back (issue #360) puts back the push it replaced, so
// the Hub, back on the old commit, sends no Runner forwards.

import { RunnerId } from "@kndl/protocol"
import { Context, Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { DatabaseLive } from "./Database.ts"
import { Runners } from "./Runners.ts"
import { RunnerTokens } from "./RunnerTokens.ts"

/** Runners to tell to follow the Hub's commit. */
export interface UpdatePush {
  /** The commit the Hub was moved to. */
  readonly commit: string
  /** Stop running Turns at once, rather than letting them end (`update --now`). */
  readonly now: boolean
  /** Every Runner; or, with `--no-update-runners`, only the Runner on the Hub's machine. */
  readonly allRunners: boolean
  /** The Runner on the Hub's machine, which shares its checkout and always follows. */
  readonly localRunner: RunnerId | undefined
}

/** Whether a push covers a Runner. */
export const pushCovers = (push: UpdatePush, runnerId: RunnerId) =>
  push.allRunners || push.localRunner === runnerId

interface PushRow {
  readonly commit: string
  readonly now: number
  readonly allRunners: number
  readonly localRunner: string | null
}

export class RunnerUpdatePush extends Context.Service<
  RunnerUpdatePush,
  {
    /** Leaves the push, in place of any earlier one. */
    readonly request: (push: UpdatePush, at: number) => Effect.Effect<void, SqlError>
    /** The push for `commit`, the one the Hub runs, if the last update left one. */
    readonly forCommit: (commit: string) => Effect.Effect<Option.Option<UpdatePush>, SqlError>
    /** The push the last update left, whatever its commit. */
    readonly latest: Effect.Effect<Option.Option<UpdatePush>, SqlError>
    /** Leaves no push. */
    readonly clear: Effect.Effect<void, SqlError>
  }
>()("@kndl/hub/RunnerUpdatePush") {
  static readonly layer = Layer.effect(
    RunnerUpdatePush,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const request = Effect.fn("RunnerUpdatePush.request")(function* (
        push: UpdatePush,
        at: number,
      ) {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM runner_update_push`
            yield* sql`
              INSERT INTO runner_update_push
                (target_commit, update_now, all_runners, local_runner_id, requested_at)
              VALUES (${push.commit}, ${push.now ? 1 : 0}, ${push.allRunners ? 1 : 0},
                ${push.localRunner ?? null}, ${at})
            `
          }),
        )
      })
      const pushOf = (rows: ReadonlyArray<PushRow>) =>
        Option.fromNullishOr(rows[0]).pipe(
          Option.map((row): UpdatePush => ({
            commit: row.commit,
            now: row.now === 1,
            allRunners: row.allRunners === 1,
            localRunner: row.localRunner === null ? undefined : RunnerId.make(row.localRunner),
          })),
        )
      const forCommit = Effect.fn("RunnerUpdatePush.forCommit")(function* (commit: string) {
        return pushOf(
          yield* sql<PushRow>`
            SELECT target_commit AS "commit", update_now AS now, all_runners AS allRunners,
              local_runner_id AS localRunner
            FROM runner_update_push WHERE target_commit = ${commit}
          `,
        )
      })
      const latest = Effect.map(
        sql<PushRow>`
          SELECT target_commit AS "commit", update_now AS now, all_runners AS allRunners,
            local_runner_id AS localRunner
          FROM runner_update_push ORDER BY requested_at DESC LIMIT 1
        `,
        pushOf,
      )
      const clear = Effect.asVoid(sql`DELETE FROM runner_update_push`)
      return RunnerUpdatePush.of({ request, forCommit, latest, clear })
    }),
  )

  /** For tests: no update left a push. */
  static readonly none = Layer.succeed(
    RunnerUpdatePush,
    RunnerUpdatePush.of({
      request: () => Effect.void,
      forCommit: () => Effect.succeed(Option.none()),
      latest: Effect.succeed(Option.none()),
      clear: Effect.void,
    }),
  )
}

/** What the CLI hears back from {@link requestRunnerUpdates}. */
export interface PushRecorded {
  /** The Runner on this machine, by its token in `runner.env`, if the Hub knows it. */
  readonly localRunner:
    | { readonly id: RunnerId; readonly name: string; readonly updatesItself: boolean }
    | undefined
  /** The push it replaced, if there was one, for {@link restoreRunnerUpdates}. */
  readonly replaced: UpdatePush | undefined
}

/** The services the CLI opens the Hub's database with, for the push. */
const PushServices = Layer.mergeAll(RunnerTokens.layer, Runners.layer, RunnerUpdatePush.layer).pipe(
  Layer.provideMerge(DatabaseLive),
)

/**
 * Leaves a push for the Hub in its database at `DatabaseFile` (read from the configuration, as
 * `issueRunnerToken` does), for `kndl update`. `localToken` is the token of the Runner on
 * this machine, if one is set up: it always follows.
 */
export const requestRunnerUpdates = (options: {
  readonly commit: string
  readonly now: boolean
  readonly allRunners: boolean
  readonly localToken: string | undefined
}) =>
  Effect.gen(function* () {
    const tokens = yield* RunnerTokens
    const runners = yield* Runners
    const local =
      options.localToken === undefined
        ? Option.none()
        : yield* tokens.authenticate(options.localToken)
    const known = Option.isNone(local) ? Option.none() : yield* runners.get(local.value.runnerId)
    const localRunner = Option.isNone(known)
      ? undefined
      : {
          id: known.value.id,
          name: known.value.name,
          updatesItself: known.value.updater?.self === true,
        }
    const push = yield* RunnerUpdatePush
    const replaced = Option.getOrUndefined(yield* push.latest)
    yield* push.request(
      {
        commit: options.commit,
        now: options.now,
        allRunners: options.allRunners,
        localRunner: localRunner?.id,
      },
      Date.now(),
    )
    return { localRunner, replaced } satisfies PushRecorded
  }).pipe(Effect.provide(PushServices))

/**
 * Puts back the push {@link requestRunnerUpdates} replaced, or leaves none, for `kndl update`
 * rolling back: the Hub, back on the commit it ran, sends no Runner on to the one it left.
 */
export const restoreRunnerUpdates = (replaced: UpdatePush | undefined) =>
  Effect.flatMap(RunnerUpdatePush, (push) =>
    replaced === undefined ? push.clear : push.request(replaced, Date.now()),
  ).pipe(Effect.provide(PushServices))
