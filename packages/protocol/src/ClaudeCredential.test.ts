import { describe, expect, test } from "bun:test"
import { Redacted, Schema } from "effect"
import { ClaudeCredential, credentialFromSecret, defaultRateLimitTier } from "./ClaudeCredential.ts"

describe("credentialFromSecret", () => {
  test("takes an API key by its prefix, and anything else as a subscription token", () => {
    const key = credentialFromSecret(" sk-ant-api03-FAKE\n", { subscriptionType: "pro" })
    expect(key?._tag).toBe("ApiKey")
    expect(key?._tag === "ApiKey" && Redacted.value(key.key)).toBe("sk-ant-api03-FAKE")

    const token = credentialFromSecret("sk-ant-oat01-FAKE\n", { subscriptionType: "pro" })
    expect(token?._tag).toBe("OAuthToken")
    expect(token?._tag === "OAuthToken" && Redacted.value(token.token)).toBe("sk-ant-oat01-FAKE")
    expect(token?._tag === "OAuthToken" && token.plan).toEqual({ subscriptionType: "pro" })
  })

  test("is undefined for a blank secret", () => {
    expect(credentialFromSecret(" \n")).toBeUndefined()
  })

  test("never shows the secret when printed", () => {
    const credential = credentialFromSecret("sk-ant-oat01-FAKE")
    expect(String(credential?._tag === "OAuthToken" && credential.token)).not.toContain("FAKE")
    expect(JSON.stringify(credential)).not.toContain("FAKE")
  })
})

describe("ClaudeCredential", () => {
  test("decodes either kind from its plain form, as the Hub would send it", () => {
    const decode = Schema.decodeUnknownSync(ClaudeCredential)
    const token = decode({
      _tag: "OAuthToken",
      token: "sk-ant-oat01-FAKE",
      plan: { subscriptionType: "max", rateLimitTier: "default_claude_max_5x" },
    })
    expect(token._tag === "OAuthToken" && Redacted.value(token.token)).toBe("sk-ant-oat01-FAKE")
    expect(decode({ _tag: "ApiKey", key: "sk-ant-api03-FAKE" })._tag).toBe("ApiKey")
    expect(() => decode({ _tag: "OAuthToken", token: "" })).toThrow()
    expect(() =>
      decode({ _tag: "OAuthToken", token: "x", plan: { subscriptionType: "free" } }),
    ).toThrow()
  })
})

test("defaultRateLimitTier is Claude Code's for Pro and Max, and unknown for the rest", () => {
  expect(defaultRateLimitTier("pro")).toBe("default_claude_ai")
  expect(defaultRateLimitTier("max")).toBe("default_claude_max_5x")
  expect(defaultRateLimitTier("team")).toBeUndefined()
})
