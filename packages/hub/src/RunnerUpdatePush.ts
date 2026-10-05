// What `claude-hub update` on the Hub's machine leaves for the Hub it restarts (issue #87, ADR
// 0011): the commit it moved the Hub to, for Runners to follow. The CLI writes it into the Hub's
// database before restarting the Hub; the Hub reads it once it runs, and tells the Runners it
// covers to update as they connect. It applies only while the Hub runs that commit, and the next
// `update` replaces it.

import { RunnerId } from "@claude-hub/protocol"
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
  }
>()("@claude-hub/hub/RunnerUpdatePush") {
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
      const forCommit = Effect.fn("RunnerUpdatePush.forCommit")(function* (commit: string) {
        const rows = yield* sql<PushRow>`
          SELECT target_commit AS "commit", update_now AS now, all_runners AS allRunners,
            local_runner_id AS localRunner
          FROM runner_update_push WHERE target_commit = ${commit}
        `
        return Option.fromNullishOr(rows[0]).pipe(
          Option.map((row): UpdatePush => ({
            commit: row.commit,
            now: row.now === 1,
            allRunners: row.allRunners === 1,
            localRunner: row.localRunner === null ? undefined : RunnerId.make(row.localRunner),
          })),
        )
      })
      return RunnerUpdatePush.of({ request, forCommit })
    }),
  )

  /** For tests: no update left a push. */
  static readonly none = Layer.succeed(
    RunnerUpdatePush,
    RunnerUpdatePush.of({
      request: () => Effect.void,
      forCommit: () => Effect.succeed(Option.none()),
    }),
  )
}

/** What the CLI hears back from {@link requestRunnerUpdates}. */
export interface PushRecorded {
  /** The Runner on this machine, by its token in `runner.env`, if the Hub knows it. */
  readonly localRunner:
    | { readonly id: RunnerId; readonly name: string; readonly updatesItself: boolean }
    | undefined
}

/**
 * Leaves a push for the Hub in its database at `DatabaseFile` (read from the configuration, as
 * `issueRunnerToken` does), for `claude-hub update`. `localToken` is the token of the Runner on
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
    yield* (yield* RunnerUpdatePush).request(
      {
        commit: options.commit,
        now: options.now,
        allRunners: options.allRunners,
        localRunner: localRunner?.id,
      },
      Date.now(),
    )
    return { localRunner } satisfies PushRecorded
  }).pipe(
    Effect.provide(
      Layer.mergeAll(RunnerTokens.layer, Runners.layer, RunnerUpdatePush.layer).pipe(
        Layer.provideMerge(DatabaseLive),
      ),
    ),
  )
