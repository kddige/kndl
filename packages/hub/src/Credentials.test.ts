import { describe, expect, test } from "bun:test"
import { Participant, ParticipantId, RunnerId, SessionId } from "@claude-hub/protocol"
import { Effect, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { DatabaseTest } from "./Database.ts"
import { ModTokens } from "./ModTokens.ts"
import { RunnerTokens } from "./RunnerTokens.ts"
import { signInDuration, SignIns } from "./SignIns.ts"

const CredentialsTest = Layer.mergeAll(SignIns.layer, RunnerTokens.layer, ModTokens.layer).pipe(
  Layer.provideMerge(DatabaseTest),
)

const run = <A, E>(
  effect: Effect.Effect<A, E, SignIns | RunnerTokens | ModTokens | SqlClient.SqlClient>,
) => Effect.runPromise(effect.pipe(Effect.provide(CredentialsTest)))

const alice = Participant.make({
  id: ParticipantId.make("github:1"),
  login: "alice",
  name: "Alice",
})

/** Flips one character of a token's secret. */
const tamper = (token: string) => token.slice(0, -1) + (token.endsWith("A") ? "B" : "A")

describe("Runner tokens", () => {
  test("identify the Runner they were issued to, and nothing else", () =>
    run(
      Effect.gen(function* () {
        const runners = yield* RunnerTokens
        const issued = yield* runners.issue("mac")

        expect(issued.token.startsWith("chr_")).toBe(true)
        expect(yield* runners.authenticate(issued.token)).toEqual(
          Option.some({ runnerId: issued.runnerId, name: "mac" }),
        )
        expect(yield* runners.authenticate(tamper(issued.token))).toEqual(Option.none())
        expect(yield* runners.authenticate("")).toEqual(Option.none())
      }),
    ))

  test("issuing again keeps the RunnerId and invalidates the old token", () =>
    run(
      Effect.gen(function* () {
        const runners = yield* RunnerTokens
        const first = yield* runners.issue("mac")
        const second = yield* runners.issue("mac")

        expect(second.runnerId).toBe(first.runnerId)
        expect(yield* runners.authenticate(first.token)).toEqual(Option.none())
        expect(Option.isSome(yield* runners.authenticate(second.token))).toBe(true)
      }),
    ))

  test("are stored only as hashes", () =>
    run(
      Effect.gen(function* () {
        const issued = yield* (yield* RunnerTokens).issue("mac")
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql<{ readonly secretHash: string }>`
          SELECT secret_hash AS secretHash FROM runners
        `
        const secret = issued.token.slice(issued.token.indexOf(".") + 1)

        expect(rows[0]?.secretHash).toMatch(/^[0-9a-f]{64}$/)
        expect(JSON.stringify(rows)).not.toContain(secret)
      }),
    ))
})

describe("mod tokens", () => {
  test("are scoped to one Session, and replaced or revoked per Session", () =>
    run(
      Effect.gen(function* () {
        const mods = yield* ModTokens
        const runnerId = (yield* (yield* RunnerTokens).issue("mac")).runnerId
        const sessionA = SessionId.make("s-a")
        const sessionB = SessionId.make("s-b")
        const tokenA = yield* mods.issue({ sessionId: sessionA, runnerId })
        const tokenB = yield* mods.issue({ sessionId: sessionB, runnerId })

        expect(yield* mods.authenticate(tokenA)).toEqual(
          Option.some({ sessionId: sessionA, runnerId }),
        )
        expect(yield* mods.authenticate(tamper(tokenA))).toEqual(Option.none())

        const newTokenA = yield* mods.issue({ sessionId: sessionA, runnerId })
        expect(yield* mods.authenticate(tokenA)).toEqual(Option.none())
        expect(Option.isSome(yield* mods.authenticate(newTokenA))).toBe(true)

        yield* mods.revoke(sessionB)
        expect(yield* mods.authenticate(tokenB)).toEqual(Option.none())
      }),
    ))

  test("a Runner token is not a mod token, nor the other way round", () =>
    run(
      Effect.gen(function* () {
        const runners = yield* RunnerTokens
        const mods = yield* ModTokens
        const runner = yield* runners.issue("mac")
        const modToken = yield* mods.issue({
          sessionId: SessionId.make("s-a"),
          runnerId: runner.runnerId,
        })

        expect(yield* mods.authenticate(runner.token)).toEqual(Option.none())
        expect(yield* runners.authenticate(modToken)).toEqual(Option.none())
        // Even with the kind rewritten, the secret only matches in its own table.
        expect(yield* mods.authenticate(runner.token.replace(/^chr_/, "chm_"))).toEqual(
          Option.none(),
        )
      }),
    ))

  test("can't be issued for an unknown Runner", () =>
    run(
      Effect.gen(function* () {
        const mods = yield* ModTokens
        const result = yield* Effect.exit(
          mods.issue({ sessionId: SessionId.make("s-a"), runnerId: RunnerId.make("nope") }),
        )

        expect(result._tag).toBe("Failure")
      }),
    ))
})

describe("sign-ins", () => {
  test("identify the person until they sign out", () =>
    run(
      Effect.gen(function* () {
        const signIns = yield* SignIns
        const { token } = yield* signIns.signIn(alice)

        expect(token.startsWith("chs_")).toBe(true)
        expect(yield* signIns.authenticate(token)).toEqual(Option.some(alice))
        expect(yield* signIns.authenticate(tamper(token))).toEqual(Option.none())

        yield* signIns.signOut(token)
        expect(yield* signIns.authenticate(token)).toEqual(Option.none())
      }),
    ))

  test("expire", () =>
    run(
      Effect.gen(function* () {
        const signIns = yield* SignIns
        const { token } = yield* signIns.signIn(alice)

        yield* TestClock.adjust(signInDuration)
        expect(yield* signIns.authenticate(token)).toEqual(Option.none())
      }).pipe(Effect.provide(TestClock.layer())),
    ))

  test("update the person's login and name", () =>
    run(
      Effect.gen(function* () {
        const signIns = yield* SignIns
        const first = yield* signIns.signIn(alice)
        const renamed = Participant.make({ ...alice, login: "alice2", name: "Alice B" })
        yield* signIns.signIn(renamed)

        expect(yield* signIns.authenticate(first.token)).toEqual(Option.some(renamed))
      }),
    ))
})
