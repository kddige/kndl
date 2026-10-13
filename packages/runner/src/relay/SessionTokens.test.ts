import { describe, expect, test } from "bun:test"
import { Effect, Redacted } from "effect"
import { sessionId } from "../testSupport.ts"
import { makeSessionTokens, SessionTokenPrefix } from "./SessionTokens.ts"

const modToken = Redacted.make("chm_mod.FAKE")
const run = Effect.runSync

describe("SessionTokens", () => {
  test("issues each Session its own random token, which finds what it stands for", () => {
    const tokens = makeSessionTokens()
    const one = run(tokens.issue({ sessionId: sessionId("s-1"), modToken }))
    const two = run(tokens.issue({ sessionId: sessionId("s-2"), modToken }))

    expect(Redacted.value(one)).toStartWith(SessionTokenPrefix)
    expect(Redacted.value(one)).not.toBe(Redacted.value(two))
    expect(String(one)).not.toContain(Redacted.value(one))
    expect(run(tokens.find(Redacted.value(one)))).toEqual({
      sessionId: sessionId("s-1"),
      modToken,
    })
    expect(run(tokens.find(Redacted.value(two)))).toMatchObject({ sessionId: sessionId("s-2") })
  })

  test("finds nothing for a token it didn't issue", () => {
    const tokens = makeSessionTokens()
    const token = Redacted.value(run(tokens.issue({ sessionId: sessionId("s-1"), modToken })))

    expect(run(tokens.find(`${token}x`))).toBeUndefined()
    expect(run(tokens.find(token.slice(SessionTokenPrefix.length)))).toBeUndefined()
    expect(run(tokens.find(""))).toBeUndefined()
  })

  test("revokes a Session's token on revoke, and on issuing it another", () => {
    const tokens = makeSessionTokens()
    const first = Redacted.value(run(tokens.issue({ sessionId: sessionId("s-1"), modToken })))
    const second = Redacted.value(run(tokens.issue({ sessionId: sessionId("s-1"), modToken })))
    const other = Redacted.value(run(tokens.issue({ sessionId: sessionId("s-2"), modToken })))

    expect(run(tokens.find(first))).toBeUndefined()
    expect(run(tokens.find(second))).toBeDefined()

    run(tokens.revoke(sessionId("s-1")))
    run(tokens.revoke(sessionId("s-3")))
    expect(run(tokens.find(second))).toBeUndefined()
    expect(run(tokens.find(other))).toBeDefined()
  })

  test("holds a token read back after a restart for its Session alone, until it is issued again (#157)", () => {
    const tokens = makeSessionTokens()
    const kept = `${SessionTokenPrefix}${"k".repeat(43)}`

    expect(run(tokens.hold(sessionId("s-1"), kept))).toBe(true)
    expect(run(tokens.find(kept))).toBe("Held")
    // Nothing that isn't a Session token, and no other Session's token.
    expect(run(tokens.hold(sessionId("s-2"), "sk-ant-oat01-FAKE"))).toBe(false)
    expect(run(tokens.hold(sessionId("s-2"), kept))).toBe(false)
    expect(run(tokens.find(kept))).toBe("Held")

    const issued = run(tokens.issue({ sessionId: sessionId("s-1"), modToken }))
    expect(Redacted.value(issued)).toBe(kept)
    expect(run(tokens.find(kept))).toEqual({ sessionId: sessionId("s-1"), modToken })

    // Issued again, as when it starts again, it gets a new one.
    const next = Redacted.value(run(tokens.issue({ sessionId: sessionId("s-1"), modToken })))
    expect(next).not.toBe(kept)
    expect(run(tokens.find(kept))).toBeUndefined()
  })

  test("revokes a held token like a live one", () => {
    const tokens = makeSessionTokens()
    const kept = `${SessionTokenPrefix}${"k".repeat(43)}`
    run(tokens.hold(sessionId("s-1"), kept))
    run(tokens.revoke(sessionId("s-1")))

    expect(run(tokens.find(kept))).toBeUndefined()
    const issued = run(tokens.issue({ sessionId: sessionId("s-1"), modToken }))
    expect(Redacted.value(issued)).not.toBe(kept)
  })
})
