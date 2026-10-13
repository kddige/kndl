import { describe, expect, test } from "bun:test"
import { Redacted, Schema } from "effect"
import {
  ClaudeCredential,
  claudeCredentialProblem,
  credentialFromSecret,
} from "./ClaudeCredential.ts"

describe("credentialFromSecret", () => {
  test("takes a subscription token, trimmed", () => {
    const token = credentialFromSecret("sk-ant-oat01-FAKE\n")
    expect(token?._tag).toBe("OAuthToken")
    expect(token !== undefined && Redacted.value(token.token)).toBe("sk-ant-oat01-FAKE")
  })

  test("is undefined for a blank secret, or an API key (#334)", () => {
    expect(credentialFromSecret(" \n")).toBeUndefined()
    expect(credentialFromSecret(" sk-ant-api03-FAKE\n")).toBeUndefined()
  })

  test("never shows the secret when printed", () => {
    const credential = credentialFromSecret("sk-ant-oat01-FAKE")
    expect(String(credential?.token)).not.toContain("FAKE")
    expect(JSON.stringify(credential)).not.toContain("FAKE")
  })
})

describe("claudeCredentialProblem", () => {
  test("refuses an API key, and asks for a setup token", () => {
    expect(claudeCredentialProblem("sk-ant-api03-FAKE-FAKE-FAKE-FAKE")).toContain("setup-token")
  })

  test("takes a whole setup token", () => {
    expect(claudeCredentialProblem("sk-ant-oat01-FAKE-FAKE-FAKE-FAKE")).toBeUndefined()
    expect(claudeCredentialProblem("sk-ant-oat01")).toBeDefined()
    expect(claudeCredentialProblem("hello")).toBeDefined()
  })
})

describe("ClaudeCredential", () => {
  test("decodes a token from its plain form, as the Hub would send it, ignoring a stored plan", () => {
    const decode = Schema.decodeUnknownSync(ClaudeCredential)
    const token = decode({
      _tag: "OAuthToken",
      token: "sk-ant-oat01-FAKE",
      plan: { subscriptionType: "max", rateLimitTier: "default_claude_max_5x" },
    })
    expect(Redacted.value(token.token)).toBe("sk-ant-oat01-FAKE")
    expect(() => decode({ _tag: "ApiKey", key: "sk-ant-api03-FAKE" })).toThrow()
    expect(() => decode({ _tag: "OAuthToken", token: "" })).toThrow()
  })
})
