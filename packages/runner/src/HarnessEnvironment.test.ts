import { describe, expect, test } from "bun:test"
import { type ClaudeCredential, credentialFromSecret } from "@kndl/protocol"
import { Redacted } from "effect"
import { KeptOutOfClaude } from "./ClaudeEnvironment.ts"
import { harnessEnvironment, HarnessVariable, keptOut } from "./HarnessEnvironment.ts"

// Fake only: shaped like a setup token, valid nowhere.
const setupToken = "sk-ant-oat01-FAKE_TOKEN_FOR_TESTS_ONLY_9f3b"
const credential = credentialFromSecret(setupToken) as ClaudeCredential
const sessionToken = Redacted.make("chp_session")
const relayUrl = "http://host.microsandbox.internal:7778"

/** A Harness's environment, with the Creator's Claude credential when given. */
const environmentOf = (base: Record<string, string>, given?: ClaudeCredential) =>
  harnessEnvironment({
    base,
    relayUrl,
    sessionToken,
    ...(given === undefined ? {} : { credential: given }),
  }).env

describe("Claude Code's environment", () => {
  test("gives Claude Code its Creator's setup token, and the mod the relay and the Session token", () => {
    expect(environmentOf({ CLAUDE_CONFIG_DIR: "/claude" }, credential)).toEqual({
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
    const env = environmentOf(base, credential)

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
    expect(keptOut(credential)).toEqual(KeptOutOfClaude)
    // The launch's setup token wins over a Variable of that name; other Variables are left be.
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(setupToken)
    expect(env.DATABASE_URL).toBe("postgres://db")
  })

  test("states no plan, scopes or base URL: Claude Code learns them from Anthropic", () => {
    const env = environmentOf({}, credential)
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

describe("pi's environment", () => {
  test("gives the extension the relay and the Session token, and the bridge the Creator's setup token", () => {
    expect(environmentOf({ LANG: "C.UTF-8" }, credential)).toEqual({
      LANG: "C.UTF-8",
      KNDL_URL: relayUrl,
      KNDL_MOD_TOKEN: "chp_session",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_OAUTH_TOKEN: setupToken,
    })
  })

  test("without a Claude credential, gives pi no setup token, not even a Variable's", () => {
    expect(
      environmentOf({ LANG: "C.UTF-8", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-from-a-Variable" }),
    ).toEqual({ LANG: "C.UTF-8", KNDL_URL: relayUrl, KNDL_MOD_TOKEN: "chp_session" })
    expect(keptOut(undefined)).toEqual([...KeptOutOfClaude, "CLAUDE_CODE_OAUTH_TOKEN"])
  })

  test("keeps out what would sign Claude Code in another way, as pi passes its environment on", () => {
    const base = Object.fromEntries(KeptOutOfClaude.map((name) => [name, "from a Variable"]))
    for (const given of [credential, undefined]) {
      const env = environmentOf(base, given)
      for (const name of KeptOutOfClaude) expect(env).not.toHaveProperty(name)
    }
  })

  test("leaves a Provider's key from a Variable, which the Repo's own code and pi's tools may need", () => {
    expect(environmentOf({ OPENAI_API_KEY: "sk-from-a-Variable" })).toMatchObject({
      OPENAI_API_KEY: "sk-from-a-Variable",
    })
  })
})

test("unsets what it keeps out", () => {
  for (const given of [credential, undefined]) {
    const { unset } = harnessEnvironment({
      base: {},
      relayUrl,
      sessionToken,
      ...(given === undefined ? {} : { credential: given }),
    })
    expect(unset).toEqual(keptOut(given))
  }
})

test("a Harness's process says which it is by KNDL_HARNESS", () => {
  expect(HarnessVariable).toBe("KNDL_HARNESS")
})
