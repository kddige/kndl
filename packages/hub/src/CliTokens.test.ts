import { describe, expect, test } from "bun:test"
import {
  CliLoginCodeLifetimeMs,
  normalizeCliLoginCode,
  PairingAlphabet,
  Participant,
  ParticipantId,
} from "@claude-hub/protocol"
import { Effect, Exit, Layer, Option } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { returnPath } from "./AuthRoutes.ts"
import {
  CliTokens,
  lastUsedResolutionMs,
  LoginRefused,
  newCliLoginCode,
  pkceChallenge,
} from "./CliTokens.ts"
import { DatabaseTest } from "./Database.ts"
import { RunnerTokens } from "./RunnerTokens.ts"
import { SignIns } from "./SignIns.ts"

const CliTest = Layer.mergeAll(CliTokens.layer, RunnerTokens.layer, SignIns.layer).pipe(
  Layer.provideMerge(DatabaseTest),
)

type R = CliTokens | RunnerTokens | SignIns | SqlClient.SqlClient

const run = <A, E>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestClock.layer()), Effect.provide(CliTest)))

const alice = Participant.make({
  id: ParticipantId.make("github:1"),
  login: "alice",
  name: "Alice",
})
const bob = Participant.make({ id: ParticipantId.make("github:2"), login: "bob", name: "Bob" })

const verifier = "v".repeat(20) + "-verifier-of-the-cli-that-asked"
const challenge = pkceChallenge(verifier)

/** Signs alice (and bob) in, so they are Participants on record. */
const people = Effect.gen(function* () {
  const signIns = yield* SignIns
  yield* signIns.signIn(alice)
  yield* signIns.signIn(bob)
})

/** alice approves `machine`, and the CLI trades the code with its verifier. */
const signInCli = (machine = "laptop", who = alice) =>
  Effect.gen(function* () {
    const cli = yield* CliTokens
    const { code } = yield* cli.approve(who, machine, challenge)
    return yield* cli.redeem(code, verifier)
  })

const refused = <A>(effect: Effect.Effect<A, unknown, R>) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    if (Exit.isSuccess(exit)) throw new Error("expected a refusal")
    const error = Exit.findErrorOption(exit)
    return Option.isSome(error) && error.value instanceof LoginRefused
  })

describe("a Login code", () => {
  test("has 16 characters of the alphabet, shown in groups of four", async () => {
    const code = newCliLoginCode()
    expect(code).toHaveLength(16)
    for (const char of code) expect(PairingAlphabet).toContain(char)
    expect(newCliLoginCode((size) => new Uint8Array(size).fill(0xff))).toBe("Z".repeat(16))
    const approved = await run(
      Effect.flatMap(CliTokens, (cli) => cli.approve(alice, "laptop", challenge)),
    )
    expect(approved.code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/)
  })

  test("is read forgivingly: case, dashes, spaces, and O, I and L for 0 and 1", () => {
    expect(normalizeCliLoginCode("abcd-efgh-jkmn-pqrs")).toBe("ABCDEFGHJKMNPQRS")
    expect(normalizeCliLoginCode(" o1il 2345 6789 ABCD ")).toBe("011123456789ABCD")
    expect(normalizeCliLoginCode("ABCD-EFGH")).toBeUndefined()
    expect(normalizeCliLoginCode("ABCD-EFGH-JKMN-PQRU")).toBeUndefined()
  })
})

describe("signing the CLI in", () => {
  test("trades an approved code and its verifier for a CLI token named after the machine", () =>
    run(
      Effect.gen(function* () {
        yield* people
        const signedIn = yield* signInCli("laptop")
        expect(signedIn.token).toMatch(/^chc_[0-9a-f]{24}\.[A-Za-z0-9_-]{43}$/)
        expect(signedIn).toMatchObject({ participant: alice, machine: "laptop", createdAt: 0 })
        const cli = yield* CliTokens
        const found = yield* cli.authenticate(signedIn.token)
        expect(Option.getOrThrow(found)).toEqual({
          participant: alice,
          id: signedIn.id,
          machine: "laptop",
          createdAt: 0,
        })
        // The Hub keeps only the secret's hash.
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql<Record<string, unknown>>`SELECT * FROM cli_tokens`
        expect(JSON.stringify(rows)).not.toContain(signedIn.token.split(".")[1])
      }),
    ))

  test("spends a code once, whether the verifier was right or not", () =>
    run(
      Effect.gen(function* () {
        yield* people
        const cli = yield* CliTokens
        const first = yield* cli.approve(alice, "laptop", challenge)
        yield* cli.redeem(first.code, verifier)
        expect(yield* refused(cli.redeem(first.code, verifier))).toBe(true)

        const second = yield* cli.approve(alice, "laptop", challenge)
        expect(yield* refused(cli.redeem(second.code, `${verifier}-not`))).toBe(true)
        // The wrong verifier spent it: the right one comes too late.
        expect(yield* refused(cli.redeem(second.code, verifier))).toBe(true)
        expect(yield* cli.list(alice.id)).toHaveLength(1)
      }),
    ))

  test("refuses a code once it has expired, and one that never was", () =>
    run(
      Effect.gen(function* () {
        yield* people
        const cli = yield* CliTokens
        const { code, expiresAt } = yield* cli.approve(alice, "laptop", challenge)
        expect(expiresAt).toBe(CliLoginCodeLifetimeMs)
        yield* TestClock.adjust(CliLoginCodeLifetimeMs)
        expect(yield* refused(cli.redeem(code, verifier))).toBe(true)
        expect(yield* refused(cli.redeem("ABCD-EFGH-JKMN-PQRS", verifier))).toBe(true)
        expect(yield* refused(cli.redeem("not a code", verifier))).toBe(true)
      }),
    ))

  test("reads a pasted code in lower case and without dashes", () =>
    run(
      Effect.gen(function* () {
        yield* people
        const cli = yield* CliTokens
        const { code } = yield* cli.approve(alice, "laptop", challenge)
        const signedIn = yield* cli.redeem(code.toLowerCase().replaceAll("-", " "), verifier)
        expect(signedIn.machine).toBe("laptop")
      }),
    ))
})

describe("a CLI token", () => {
  test("is refused at once when revoked, and only its owner can revoke it", () =>
    run(
      Effect.gen(function* () {
        yield* people
        const cli = yield* CliTokens
        const signedIn = yield* signInCli("laptop")
        expect(yield* cli.revoke(bob.id, signedIn.id)).toBe(false)
        expect(Option.isSome(yield* cli.authenticate(signedIn.token))).toBe(true)
        expect(yield* cli.revoke(alice.id, signedIn.id)).toBe(true)
        expect(Option.isNone(yield* cli.authenticate(signedIn.token))).toBe(true)
        expect(yield* cli.list(alice.id)).toEqual([])
        expect(yield* cli.revoke(alice.id, signedIn.id)).toBe(false)
      }),
    ))

  test("is not any other kind of token, nor another kind one", () =>
    run(
      Effect.gen(function* () {
        yield* people
        const cli = yield* CliTokens
        const signedIn = yield* signInCli("laptop")
        const runner = yield* (yield* RunnerTokens).issue("studio")
        expect(Option.isNone(yield* cli.authenticate(runner.token))).toBe(true)
        expect(Option.isNone(yield* (yield* RunnerTokens).authenticate(signedIn.token))).toBe(true)
        const [prefix, secret] = signedIn.token.split(".") as [string, string]
        const tampered = `${prefix}.${secret.slice(0, -1)}${secret.endsWith("A") ? "B" : "A"}`
        expect(Option.isNone(yield* cli.authenticate(tampered))).toBe(true)
      }),
    ))

  test("is listed to its owner alone, newest first, with when it was last used to the minute", () =>
    run(
      Effect.gen(function* () {
        yield* people
        const cli = yield* CliTokens
        const laptop = yield* signInCli("laptop")
        yield* TestClock.adjust(1000)
        const desktop = yield* signInCli("desktop")
        yield* signInCli("bobs-box", bob)
        expect(yield* cli.list(alice.id)).toEqual([
          { id: desktop.id, machine: "desktop", createdAt: 1000 },
          { id: laptop.id, machine: "laptop", createdAt: 0 },
        ])

        yield* TestClock.adjust(5000)
        yield* cli.authenticate(laptop.token)
        yield* TestClock.adjust(lastUsedResolutionMs - 1)
        yield* cli.authenticate(laptop.token)
        expect((yield* cli.list(alice.id))[1]?.lastUsedAt).toBe(6000)
        yield* TestClock.adjust(1)
        yield* cli.authenticate(laptop.token)
        expect((yield* cli.list(alice.id))[1]?.lastUsedAt).toBe(6000 + lastUsedResolutionMs)
      }),
    ))
})

describe("the path GitHub sign-in comes back to", () => {
  test("is a path on the Hub, never another site", () => {
    expect(returnPath("/cli-login?machine=laptop&challenge=abc")).toBe(
      "/cli-login?machine=laptop&challenge=abc",
    )
    expect(returnPath("/")).toBe("/")
    for (const text of [
      null,
      undefined,
      "",
      "cli-login",
      "//evil.example",
      "/\\evil.example",
      "https://evil.example/",
      "/ok\nSet-Cookie: x",
      `/${"a".repeat(2048)}`,
    ]) {
      expect(returnPath(text)).toBeUndefined()
    }
  })
})
