import { describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { ConfigProvider, Effect, Layer, Option } from "effect"
import { issueRunnerToken } from "./Admin.ts"
import { DatabaseLive } from "./Database.ts"
import { Runners } from "./Runners.ts"
import { requestRunnerUpdates, restoreRunnerUpdates, RunnerUpdatePush } from "./RunnerUpdatePush.ts"
import { testDatabaseDir } from "./testSupport.ts"

/** Runs `effect` against a fresh database file, as the CLI opens the Hub's. */
const withDatabase = async <A, E>(effect: Effect.Effect<A, E>) => {
  const dir = testDatabaseDir("kndl-push-")
  try {
    return await Effect.runPromise(
      effect.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: { HUB_DATABASE: join(dir, "hub.db"), KNDL_HOME: dir },
            }),
          ),
        ),
      ),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const read = (commit: string) =>
  Effect.flatMap(RunnerUpdatePush, (push) => push.forCommit(commit)).pipe(
    Effect.provide(RunnerUpdatePush.layer.pipe(Layer.provideMerge(DatabaseLive))),
  )

/** Leaves a push for every Runner, for `commit`. */
const request = (commit: string) =>
  requestRunnerUpdates({ commit, now: false, allRunners: true, localToken: undefined })

describe("kndl update leaving the push", () => {
  test("records it for the commit, and finds the Runner here by its token", async () => {
    const outcome = await withDatabase(
      Effect.gen(function* () {
        const issued = yield* issueRunnerToken("studio")
        yield* Effect.flatMap(Runners, (runners) =>
          runners.recordHello(
            issued.runnerId,
            {
              version: { commit: "a".repeat(40) },
              updater: { self: true },
            },
            1,
          ),
        ).pipe(Effect.provide(Runners.layer.pipe(Layer.provideMerge(DatabaseLive))))
        const recorded = yield* requestRunnerUpdates({
          commit: "b".repeat(40),
          now: true,
          allRunners: false,
          localToken: issued.token,
        })
        return { issued, recorded, push: yield* read("b".repeat(40)), other: yield* read("c") }
      }),
    )
    expect(outcome.recorded.localRunner).toEqual({
      id: outcome.issued.runnerId,
      name: "studio",
      updatesItself: true,
    })
    expect(Option.getOrUndefined(outcome.push)).toEqual({
      commit: "b".repeat(40),
      now: true,
      allRunners: false,
      localRunner: outcome.issued.runnerId,
    })
    // Only while the Hub runs that commit.
    expect(Option.isNone(outcome.other)).toBe(true)
  })

  test("the next update replaces it; an unknown token leaves no Runner here", async () => {
    const outcome = await withDatabase(
      Effect.gen(function* () {
        yield* requestRunnerUpdates({
          commit: "b".repeat(40),
          now: false,
          allRunners: true,
          localToken: undefined,
        })
        const recorded = yield* requestRunnerUpdates({
          commit: "d".repeat(40),
          now: false,
          allRunners: true,
          localToken: "not-a-token",
        })
        return { recorded, old: yield* read("b".repeat(40)), next: yield* read("d".repeat(40)) }
      }),
    )
    expect(outcome.recorded.localRunner).toBeUndefined()
    expect(Option.isNone(outcome.old)).toBe(true)
    expect(Option.getOrUndefined(outcome.next)?.allRunners).toBe(true)
  })

  test("an update rolling back puts back the push it replaced, or leaves none", async () => {
    const outcome = await withDatabase(
      Effect.gen(function* () {
        const first = yield* request("b".repeat(40))
        yield* restoreRunnerUpdates(first.replaced)
        const cleared = yield* read("b".repeat(40))
        yield* request("b".repeat(40))
        const second = yield* request("d".repeat(40))
        yield* restoreRunnerUpdates(second.replaced)
        return {
          first,
          cleared,
          second,
          back: yield* read("b".repeat(40)),
          next: yield* read("d".repeat(40)),
        }
      }),
    )
    expect(outcome.first.replaced).toBeUndefined()
    expect(Option.isNone(outcome.cleared)).toBe(true)
    expect(outcome.second.replaced?.commit).toBe("b".repeat(40))
    expect(Option.getOrUndefined(outcome.back)?.allRunners).toBe(true)
    expect(Option.isNone(outcome.next)).toBe(true)
  })
})
