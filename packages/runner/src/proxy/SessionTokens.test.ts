import { describe, expect, test } from "bun:test"
import { type ClaudeCredential, credentialFromSecret } from "@claude-hub/protocol"
import { Effect, Redacted } from "effect"
import { sessionId } from "../testSupport.ts"
import { makeSessionTokens, SessionTokenPrefix } from "./SessionTokens.ts"

const modToken = Redacted.make("chm_mod.FAKE")
const run = Effect.runSync

describe("SessionTokens", () => {
  test("issues each Session its own random token, which finds what it stands for", () => {
    const tokens = makeSessionTokens()
    const credential = credentialFromSecret("sk-ant-oat01-FAKE") as ClaudeCredential
    const one = run(tokens.issue({ sessionId: sessionId("s-1"), modToken, credential }))
    const two = run(tokens.issue({ sessionId: sessionId("s-2"), modToken }))

    expect(Redacted.value(one)).toStartWith(SessionTokenPrefix)
    expect(Redacted.value(one)).not.toBe(Redacted.value(two))
    expect(String(one)).not.toContain(Redacted.value(one))
    expect(run(tokens.find(Redacted.value(one)))).toEqual({
      sessionId: sessionId("s-1"),
      modToken,
      credential,
    })
    expect(run(tokens.find(Redacted.value(two)))?.sessionId).toBe(sessionId("s-2"))
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
})
