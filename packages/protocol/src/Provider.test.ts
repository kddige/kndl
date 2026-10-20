import { describe, expect, test } from "bun:test"
import {
  defaultProviderModel,
  findProviderModel,
  modelGatewayPath,
  parseProviderModelName,
  providerModelName,
  takesThinkingLevel,
  thinkingLevelRefusal,
} from "./Provider.ts"

describe("a pi Session's model name", () => {
  test("names a Provider's Model as provider/id, and reads it back", () => {
    expect(providerModelName({ provider: "openai", id: "gpt-6-sol" })).toBe("openai/gpt-6-sol")
    expect(parseProviderModelName("openai/gpt-6-sol")).toEqual({
      provider: "openai",
      id: "gpt-6-sol",
    })
    expect(parseProviderModelName("anthropic/claude-opus-5-5")).toEqual({
      provider: "anthropic",
      id: "claude-opus-5-5",
    })
    expect(parseProviderModelName("google/gemini-3-pro")).toEqual({
      provider: "google",
      id: "gemini-3-pro",
    })
  })

  test("keeps an id's own slashes, as OpenRouter's have", () => {
    const model = { provider: "openrouter", id: "anthropic/claude-sonnet-4" } as const
    expect(providerModelName(model)).toBe("openrouter/anthropic/claude-sonnet-4")
    expect(parseProviderModelName("openrouter/anthropic/claude-sonnet-4")).toEqual(model)
  })

  test("reads no Provider from a Claude Code model name, or an unknown Provider", () => {
    for (const name of [
      "sonnet",
      "opus[1m]",
      "claude-sonnet-5-5",
      "amazon-bedrock/claude-x",
      "/x",
      "openai/",
    ])
      expect(parseProviderModelName(name)).toBeUndefined()
  })
})

test("a Provider's model calls go through the Gateway under /gateway/models", () => {
  expect(modelGatewayPath("xai")).toBe("/gateway/models/xai")
})

describe("a pi Session's model among its Creator's Models (ADR 0029)", () => {
  const gpt = {
    provider: "openai",
    id: "gpt-6-sol",
    label: "GPT-6-Sol",
    thinkingLevels: ["low", "medium", "high"],
  } as const
  const grok = { provider: "xai", id: "grok-5", label: "Grok 5", thinkingLevels: [] } as const
  const opus = {
    provider: "anthropic",
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    thinkingLevels: ["low", "max"],
  } as const
  const sonnet = { ...opus, id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" } as const

  test("the default is Claude's first, else the first, and none without Models", () => {
    expect(defaultProviderModel([gpt, opus, sonnet])).toBe(opus)
    expect(defaultProviderModel([grok, gpt])).toBe(grok)
    expect(defaultProviderModel([])).toBeUndefined()
  })

  test("a model name finds its Model, ids with slashes too", () => {
    const routed = { provider: "openrouter", id: "anthropic/claude-sonnet-4" } as const
    expect(findProviderModel([gpt, routed], "openrouter/anthropic/claude-sonnet-4")).toBe(routed)
    expect(findProviderModel([gpt, opus], "anthropic/claude-opus-5-5")).toBe(opus)
    expect(findProviderModel([gpt], "gpt-6-sol")).toBeUndefined()
    expect(findProviderModel([gpt], "xai/gpt-6-sol")).toBeUndefined()
  })

  test("a thinking level fits a Model that lists it, and no level fits any", () => {
    expect(takesThinkingLevel(gpt, "high")).toBe(true)
    expect(takesThinkingLevel(gpt, "max")).toBe(false)
    expect(takesThinkingLevel(grok, "low")).toBe(false)
    expect(takesThinkingLevel(grok, undefined)).toBe(true)
    expect(thinkingLevelRefusal(gpt, "high")).toBeUndefined()
    expect(thinkingLevelRefusal(grok, undefined)).toBeUndefined()
    expect(thinkingLevelRefusal(gpt, "max")).toBe("GPT-6-Sol has no thinking level 'max'.")
    expect(thinkingLevelRefusal(grok, "low")).toBe("Grok 5 takes no thinking level.")
  })
})
