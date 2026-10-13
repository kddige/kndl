import { describe, expect, test } from "bun:test"
import { type ClaudeCredential, credentialFromSecret } from "@kndl/protocol"
import { Redacted } from "effect"
import { claudeEnvironment, KeptOutOfClaude } from "./ClaudeEnvironment.ts"

// Fake only: shaped like a setup token, valid nowhere.
const setupToken = "sk-ant-oat01-FAKE_TOKEN_FOR_TESTS_ONLY_9f3b"
const credential = credentialFromSecret(setupToken) as ClaudeCredential
const sessionToken = Redacted.make("chp_session")
const relayUrl = "http://host.microsandbox.internal:7778"

describe("claudeEnvironment", () => {
  test("gives Claude Code its Creator's setup token, and the mod the relay and the Session token", () => {
    expect(
      claudeEnvironment({
        base: { CLAUDE_CONFIG_DIR: "/claude" },
        relayUrl,
        sessionToken,
        credential,
      }),
    ).toEqual({
      CLAUDE_CONFIG_DIR: "/claude",
      KNDL_URL: relayUrl,
      KNDL_MOD_TOKEN: "chp_session",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_OAUTH_TOKEN: setupToken,
    })
  })

  test("keeps out every variable that would sign Claude Code in another way, or send it elsewhere", () => {
    const base = {
      ...Object.fromEntries(KeptOutOfClaude.map((name) => [name, "from a Variable"])),
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-from-a-Variable",
      DATABASE_URL: "postgres://db",
    }
    const env = claudeEnvironment({ base, relayUrl, sessionToken, credential })

    for (const name of KeptOutOfClaude) expect(env).not.toHaveProperty(name)
    expect(KeptOutOfClaude).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
    ])
    // The launch's setup token wins over a Variable of that name; other Variables are left be.
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(setupToken)
    expect(env.DATABASE_URL).toBe("postgres://db")
  })

  test("states no plan, scopes or base URL: Claude Code learns them from Anthropic", () => {
    const env = claudeEnvironment({ base: {}, relayUrl, sessionToken, credential })
    for (const name of [
      "ANTHROPIC_BASE_URL",
      "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
      "CLAUDE_CODE_OAUTH_SCOPES",
      "CLAUDE_CODE_SUBSCRIPTION_TYPE",
      "CLAUDE_CODE_RATE_LIMIT_TIER",
    ])
      expect(env).not.toHaveProperty(name)
  })
})
