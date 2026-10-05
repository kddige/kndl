import { describe, expect, test } from "bun:test"
import { credentialFromSecret } from "@claude-hub/protocol"
import { Redacted } from "effect"
import { ClaudeOAuthScopes, sandboxClaudeEnvironment } from "./ClaudeEnvironment.ts"

const token = Redacted.make("chp_session")
const proxyUrl = "http://host.microsandbox.internal:7778"

const proxied = {
  ANTHROPIC_BASE_URL: proxyUrl,
  CLAUDE_HUB_URL: proxyUrl,
  CLAUDE_HUB_MOD_TOKEN: "chp_session",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_AUTOUPDATER: "1",
}

describe("sandboxClaudeEnvironment", () => {
  test("gives a subscription token's Session the Session token as its OAuth token, and the plan", () => {
    const credential = credentialFromSecret("sk-ant-oat01-FAKE", {
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
    })
    expect(sandboxClaudeEnvironment({ proxyUrl, token, credential })).toEqual({
      ...proxied,
      CLAUDE_CODE_OAUTH_TOKEN: "chp_session",
      _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
      CLAUDE_CODE_OAUTH_SCOPES: ClaudeOAuthScopes,
      CLAUDE_CODE_SUBSCRIPTION_TYPE: "max",
      CLAUDE_CODE_RATE_LIMIT_TIER: "default_claude_max_20x",
    })
  })

  test("states no plan it doesn't know", () => {
    const env = sandboxClaudeEnvironment({
      proxyUrl,
      token,
      credential: credentialFromSecret("sk-ant-oat01-FAKE"),
    })
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("chp_session")
    expect(env).not.toHaveProperty("CLAUDE_CODE_SUBSCRIPTION_TYPE")
    expect(env).not.toHaveProperty("CLAUDE_CODE_RATE_LIMIT_TIER")
  })

  test("gives an API key's Session the Session token as a plain bearer, and nothing of a subscription", () => {
    const credential = credentialFromSecret("sk-ant-api03-FAKE")
    expect(sandboxClaudeEnvironment({ proxyUrl, token, credential })).toEqual({
      ...proxied,
      ANTHROPIC_AUTH_TOKEN: "chp_session",
    })
  })

  test("never holds the credential itself", () => {
    for (const secret of ["sk-ant-oat01-FAKE", "sk-ant-api03-FAKE"]) {
      const env = sandboxClaudeEnvironment({
        proxyUrl,
        token,
        credential: credentialFromSecret(secret),
      })
      expect(JSON.stringify(env)).not.toContain(secret)
    }
  })
})
