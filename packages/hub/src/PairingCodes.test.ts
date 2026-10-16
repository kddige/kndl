import { describe, expect, test } from "bun:test"
import {
  normalizePairingCode,
  PairingAlphabet,
  PairingCodeLifetimeMs,
  PairingCodeRefused,
  Participant,
  ParticipantId,
  RunnerId,
} from "@kndl/protocol"
import { Effect, Exit, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { DatabaseTest } from "./Database.ts"
import {
  hashPairingCode,
  newPairingCode,
  PairingCodes,
  pairingCodeState,
  PairingRefused,
} from "./PairingCodes.ts"
import { Runners } from "./Runners.ts"
import { RunnerTokens } from "./RunnerTokens.ts"
import { SignIns } from "./SignIns.ts"

const PairingTest = Layer.mergeAll(
  PairingCodes.layer,
  RunnerTokens.layer,
  Runners.layer,
  SignIns.layer,
).pipe(Layer.provideMerge(DatabaseTest))

type R = PairingCodes | RunnerTokens | Runners | SignIns | SqlClient.SqlClient

const run = <A, E>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestClock.layer()), Effect.provide(PairingTest)))

const alice = Participant.make({
  id: ParticipantId.make("github:1"),
  login: "alice",
  name: "Alice",
})

/** alice, signed in, so the codes she mints have a maker on record. */
const signedIn = Effect.flatMap(SignIns, (signIns) => signIns.signIn(alice))

/** The code a minted one shows, as `runner join` sends it. */
const plain = (code: string) => normalizePairingCode(code) ?? "not a code"

/** What a refused redemption fails with. */
const refusal = <A>(effect: Effect.Effect<A, unknown, R>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    if (Exit.isSuccess(exit)) throw new Error("expected a refusal")
    const error = Exit.findErrorOption(exit)
    if (Option.isNone(error) || !(error.value instanceof PairingRefused)) {
      throw new Error(`expected PairingRefused, got ${String(exit.cause)}`)
    }
    return { status: error.value.status, message: error.value.message }
  })

const refusedCode = { status: 403, message: PairingCodeRefused }

describe("a new Pairing code", () => {
  test("has 20 characters of the alphabet, each from 5 random bits", () => {
    const code = newPairingCode()
    expect(code).toHaveLength(20)
    for (const char of code) expect(PairingAlphabet).toContain(char)
    expect(normalizePairingCode(code)).toBe(code)
    // Only the low 5 bits of each byte count.
    expect(newPairingCode((size) => new Uint8Array(size).fill(0xff))).toBe("Z".repeat(20))
    expect(newPairingCode((size) => new Uint8Array(size).fill(32 + 3))).toBe("3".repeat(20))
  })

  test("is different every time", () => {
    const codes = new Set(Array.from({ length: 200 }, () => newPairingCode()))
    expect(codes.size).toBe(200)
  })
})

describe("a Pairing code's state", () => {
  const row = { expiresAt: 1_000, usedAt: null, revokedAt: null }

  test("is Usable until it expires", () => {
    expect(pairingCodeState(row, 999)).toBe("Usable")
    expect(pairingCodeState(row, 1_000)).toBe("Expired")
  })

  test("is Used or Revoked once it is, whatever the time", () => {
    expect(pairingCodeState({ ...row, usedAt: 5 }, 10)).toBe("Used")
    expect(pairingCodeState({ ...row, revokedAt: 5 }, 10)).toBe("Revoked")
    expect(pairingCodeState({ ...row, usedAt: 5 }, 2_000)).toBe("Used")
  })
})

describe("Pairing codes", () => {
  test("are kept only as their hash", () =>
    run(
      Effect.gen(function* () {
        yield* signedIn
        const minted = yield* (yield* PairingCodes).mint(alice)
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql<Record<string, unknown>>`SELECT * FROM pairing_codes`
        const stored = JSON.stringify(rows)

        expect(stored).not.toContain(plain(minted.code))
        expect(stored).not.toContain(minted.code)
        expect(rows[0]?.code_hash).toBe(hashPairingCode(plain(minted.code)))
        expect(minted.code).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/)
      }),
    ))

  test("register a new Runner by the name asked for, once", () =>
    run(
      Effect.gen(function* () {
        yield* signedIn
        const codes = yield* PairingCodes
        const minted = yield* codes.mint(alice)
        const paired = yield* codes.redeem(plain(minted.code), "studio")

        expect(paired).toMatchObject({ name: "studio", repaired: false, pairingCodeId: minted.id })
        expect(yield* (yield* RunnerTokens).authenticate(paired.token)).toEqual(
          Option.some({ runnerId: paired.runnerId, name: "studio" }),
        )
        expect(yield* refusal(codes.redeem(plain(minted.code), "other"))).toEqual(refusedCode)
        expect(yield* codes.pending).toEqual([])
      }),
    ))

  test("are refused alike when unknown, expired, used or revoked", () =>
    run(
      Effect.gen(function* () {
        yield* signedIn
        const codes = yield* PairingCodes

        expect(yield* refusal(codes.redeem(newPairingCode(), "a"))).toEqual(refusedCode)

        const expiring = yield* codes.mint(alice)
        const revoked = yield* codes.mint(alice)
        yield* codes.revoke(revoked.id)
        expect(yield* refusal(codes.redeem(plain(revoked.code), "b"))).toEqual(refusedCode)

        yield* TestClock.adjust(PairingCodeLifetimeMs - 1)
        expect((yield* codes.pending).map((code) => code.id)).toEqual([expiring.id])
        yield* TestClock.adjust(1)
        expect(yield* codes.pending).toEqual([])
        expect(yield* refusal(codes.redeem(plain(expiring.code), "c"))).toEqual(refusedCode)
      }),
    ))

  test("revoked or expired, leave the Runner paired with them as it is", () =>
    run(
      Effect.gen(function* () {
        yield* signedIn
        const codes = yield* PairingCodes
        const minted = yield* codes.mint(alice)
        const paired = yield* codes.redeem(plain(minted.code), "studio")
        yield* codes.revoke(minted.id)
        yield* TestClock.adjust(PairingCodeLifetimeMs * 2)

        expect(Option.isSome(yield* (yield* RunnerTokens).authenticate(paired.token))).toBe(true)
      }),
    ))

  test("refuse a name in use, or one that can't be a name, leaving the code unspent", () =>
    run(
      Effect.gen(function* () {
        yield* signedIn
        const codes = yield* PairingCodes
        yield* (yield* RunnerTokens).issue("studio")
        const minted = yield* codes.mint(alice)

        const taken = yield* refusal(codes.redeem(plain(minted.code), "studio"))
        expect(taken.status).toBe(409)
        expect(taken.message).toContain("already has a Runner named studio")
        expect((yield* refusal(codes.redeem(plain(minted.code), "-bad name"))).status).toBe(400)

        expect((yield* codes.redeem(plain(minted.code), "studio-2")).name).toBe("studio-2")
      }),
    ))

  test("for a Runner, Re-pair it: same RunnerId and name, a new token in place of the old", () =>
    run(
      Effect.gen(function* () {
        yield* signedIn
        const codes = yield* PairingCodes
        const tokens = yield* RunnerTokens
        const first = yield* codes.redeem(plain((yield* codes.mint(alice)).code), "studio")
        const minted = yield* codes.mint(alice, first.runnerId)

        expect((yield* codes.pending)[0]?.runnerId).toBe(first.runnerId)
        // The name the machine asks for doesn't matter: it takes the Runner's place.
        const again = yield* codes.redeem(plain(minted.code), "anything")

        expect(again).toMatchObject({ runnerId: first.runnerId, name: "studio", repaired: true })
        expect(yield* tokens.authenticate(first.token)).toEqual(Option.none())
        expect(yield* tokens.authenticate(again.token)).toEqual(
          Option.some({ runnerId: first.runnerId, name: "studio" }),
        )
      }),
    ))

  test("can't be minted for a Runner that isn't one, and a removed Runner's are revoked", () =>
    run(
      Effect.gen(function* () {
        yield* signedIn
        const codes = yield* PairingCodes
        const tokens = yield* RunnerTokens
        const studio = yield* tokens.issue("studio")
        const repair = yield* codes.mint(alice, studio.runnerId)

        yield* tokens.remove(studio.runnerId)
        yield* codes.revokeFor(studio.runnerId)

        expect(yield* tokens.authenticate(studio.token)).toEqual(Option.none())
        expect(yield* refusal(codes.redeem(plain(repair.code), "studio"))).toEqual(refusedCode)
        const exit = yield* Effect.exit(codes.mint(alice, studio.runnerId))
        expect(Exit.isFailure(exit)).toBe(true)
        expect(Exit.isFailure(yield* Effect.exit(codes.mint(alice, RunnerId.make("nope"))))).toBe(
          true,
        )
      }),
    ))

  test("free a removed Runner's name: the machine takes over its RunnerId", () =>
    run(
      Effect.gen(function* () {
        yield* signedIn
        const codes = yield* PairingCodes
        const tokens = yield* RunnerTokens
        const studio = yield* tokens.issue("studio")
        yield* tokens.remove(studio.runnerId)
        expect(yield* (yield* Runners).list).toEqual([])

        const paired = yield* codes.redeem(plain((yield* codes.mint(alice)).code), "studio")

        expect(paired.runnerId).toBe(studio.runnerId)
        expect((yield* (yield* Runners).list).map((runner) => runner.name)).toEqual(["studio"])
      }),
    ))
})

describe("Runners", () => {
  test("are listed once paired, with what their hello said and when they were last seen", () =>
    run(
      Effect.gen(function* () {
        const runners = yield* Runners
        const studio = yield* (yield* RunnerTokens).issue("studio")

        expect(yield* runners.list).toEqual([
          {
            id: studio.runnerId,
            name: "studio",
            version: null,
            lastSeenAt: null,
            openSessions: 0,
            updater: null,
            models: null,
            sysinfo: null,
          },
        ])

        const version = { commit: "a".repeat(40), branch: "main", release: "2026.10.1" }
        const updater = { self: false, reason: "it runs from a developer's checkout" }
        const opus = {
          alias: "opus",
          id: "claude-opus-5-5",
          label: "Opus 5.5",
          description: "Best for everyday, complex tasks",
          effort: true,
        }
        const models = {
          default: { ...opus, alias: "default" },
          models: [opus],
          efforts: ["low", "medium"] as const,
        }
        yield* runners.recordHello(studio.runnerId, { version, updater, models }, 10)
        yield* runners.recordSeen(studio.runnerId, 20)
        expect(yield* runners.get(studio.runnerId)).toEqual(
          Option.some({
            id: studio.runnerId,
            name: "studio",
            version,
            lastSeenAt: 20,
            openSessions: 0,
            updater,
            models,
            sysinfo: null,
          }),
        )

        // On a commit after the Release, it says no Release, and none is kept from before.
        const after = { commit: "b".repeat(40), branch: "main" }
        yield* runners.recordHello(studio.runnerId, { version: after, updater }, 25)
        expect(Option.map(yield* runners.get(studio.runnerId), (r) => r.version)).toEqual(
          Option.some(after),
        )

        // A Runner from before the version and the updater were in the hello. Its models are
        // kept: a hello without them is from a Claude Code that couldn't say this time (#128).
        yield* runners.recordHello(studio.runnerId, { version: undefined, updater: undefined }, 30)
        expect(
          Option.map(yield* runners.get(studio.runnerId), (r) => [r.version, r.updater, r.models]),
        ).toEqual(Option.some([null, null, models]))
      }),
    ))
})
