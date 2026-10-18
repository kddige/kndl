import { describe, expect, test } from "bun:test"
import { modelGatewayPath, parseProviderModelName, providerModelName } from "./Provider.ts"

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
