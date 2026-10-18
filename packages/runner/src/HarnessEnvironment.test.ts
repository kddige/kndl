import { describe, expect, test } from "bun:test"
import { dirname, join } from "node:path"
import { findEnvKeys } from "@earendil-works/pi-ai/compat"
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all"
import { type ClaudeCredential, credentialFromSecret, PiProviderKeyVariables } from "@kndl/protocol"
import { Redacted } from "effect"
import { KeptOutOfClaude } from "./ClaudeEnvironment.ts"
import { harnessEnvironment, HarnessVariable, keptOut } from "./HarnessEnvironment.ts"
import { PinnedPiVersion } from "./sandbox/SandboxPi.ts"

// Fake only: shaped like a setup token, valid nowhere.
const setupToken = "sk-ant-oat01-FAKE_TOKEN_FOR_TESTS_ONLY_9f3b"
const credential = credentialFromSecret(setupToken) as ClaudeCredential
const sessionToken = Redacted.make("chp_session")
const relayUrl = "http://host.microsandbox.internal:7778"

const claudeEnvironment = (base: Record<string, string>) =>
  harnessEnvironment({ harness: "ClaudeCode", base, relayUrl, sessionToken, credential }).env

describe("Claude Code's environment", () => {
  test("gives Claude Code its Creator's setup token, and the mod the relay and the Session token", () => {
    expect(claudeEnvironment({ CLAUDE_CONFIG_DIR: "/claude" })).toEqual({
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
    const env = claudeEnvironment(base)

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
    expect(keptOut("ClaudeCode", credential)).toEqual(KeptOutOfClaude)
    // The launch's setup token wins over a Variable of that name; other Variables are left be.
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(setupToken)
    expect(env.DATABASE_URL).toBe("postgres://db")
  })

  test("states no plan, scopes or base URL: Claude Code learns them from Anthropic", () => {
    const env = claudeEnvironment({})
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

/** pi's environment, with the Creator's Claude credential when given. */
const piEnvironment = (base: Record<string, string>, given?: ClaudeCredential) =>
  harnessEnvironment({
    harness: "Pi",
    base,
    relayUrl,
    sessionToken,
    ...(given === undefined ? {} : { credential: given }),
  }).env

describe("pi's environment", () => {
  test("gives the extension the relay and the Session token, and the bridge the Creator's setup token", () => {
    expect(piEnvironment({ LANG: "C.UTF-8" }, credential)).toEqual({
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
      piEnvironment({ LANG: "C.UTF-8", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-from-a-Variable" }),
    ).toEqual({ LANG: "C.UTF-8", KNDL_URL: relayUrl, KNDL_MOD_TOKEN: "chp_session" })
  })

  test("keeps out what would sign Claude Code in another way, as pi passes its environment on", () => {
    const base = Object.fromEntries(KeptOutOfClaude.map((name) => [name, "from a Variable"]))
    for (const given of [credential, undefined]) {
      const env = piEnvironment(base, given)
      for (const name of KeptOutOfClaude) expect(env).not.toHaveProperty(name)
    }
  })

  test("keeps out every Provider key variable pi-ai reads, so pi reaches Providers through the Gateway alone", () => {
    const fromVariables = {
      LANG: "C.UTF-8",
      OPENAI_API_KEY: "sk-from-a-Variable",
      GEMINI_API_KEY: "from a Variable",
      COPILOT_GITHUB_TOKEN: "from a Variable",
      ANTHROPIC_OAUTH_TOKEN: "from a Variable",
      HF_TOKEN: "from a Variable",
    }
    for (const given of [credential, undefined]) {
      const kept = keptOut("Pi", given)
      for (const name of PiProviderKeyVariables) expect(kept).toContain(name)
      const env = piEnvironment(fromVariables, given)
      expect(env["LANG"]).toBe("C.UTF-8")
      for (const name of Object.keys(fromVariables).filter((each) => each !== "LANG"))
        expect(env).not.toHaveProperty(name)
    }
  })

  test("unsets what it keeps out, each variable once", () => {
    for (const given of [credential, undefined]) {
      const { unset } = harnessEnvironment({
        harness: "Pi",
        base: {},
        relayUrl,
        sessionToken,
        ...(given === undefined ? {} : { credential: given }),
      })
      expect(unset).toEqual(keptOut("Pi", given))
      expect(new Set(unset).size).toBe(unset.length)
    }
    expect(keptOut("Pi", undefined)).toContain("CLAUDE_CODE_OAUTH_TOKEN")
    expect(keptOut("Pi", credential)).not.toContain("CLAUDE_CODE_OAUTH_TOKEN")
  })

  test("the Provider key variables are pi-ai's, as the pi the Runner pins has it", async () => {
    const piAi = dirname(dirname(Bun.resolveSync("@earendil-works/pi-ai", import.meta.dir)))
    const { version } = (await Bun.file(join(piAi, "package.json")).json()) as { version: string }
    expect(version).toBe(PinnedPiVersion)
    // With every variable set, pi-ai finds each of a Provider's key variables.
    const everything = new Proxy({}, { get: () => "set" }) as Record<string, string>
    const read = new Set(
      [...getBuiltinProviders(), "radius"].flatMap(
        (provider) => findEnvKeys(provider, everything) ?? [],
      ),
    )
    expect([...read].toSorted()).toEqual([...PiProviderKeyVariables].toSorted())
  })
})

test("a Harness's process says which it is by KNDL_HARNESS", () => {
  expect(HarnessVariable).toBe("KNDL_HARNESS")
})
