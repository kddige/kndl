// The Providers kndl connects, as pi-ai serves them: where each one's API is, how a call is
// authorised, and how each one's model list reads.

import { describe, expect, test } from "bun:test"
import { type ProviderId, ProviderIds } from "@kndl/protocol"
import {
  apiOrigin,
  authorize,
  catalogueModels,
  catalogueOf,
  connectable,
  keyHeaderOf,
  modelsListed,
  modelsRequest,
} from "./PiProviders.ts"

describe("each Provider", () => {
  test("has every Model of its catalogue at one origin, which the Gateway sends its calls to", () => {
    // The mod keeps each Model's own path below the Gateway's (OpenRouter's Claude is at /api,
    // the rest at /api/v1), so one origin per Provider is what makes that work.
    for (const provider of ProviderIds) {
      const origins = new Set(catalogueOf(provider).map((model) => new URL(model.baseUrl).origin))
      expect([provider, [...origins]]).toEqual([provider, [apiOrigin(provider)]])
    }
    // OpenCode's provider names no address of its own: its Models' is used.
    expect(apiOrigin("opencode")).toBe("https://opencode.ai")
  })

  test("has a sign-in, a key, or both", () => {
    for (const each of connectable) {
      expect([each.provider, each.signIn !== undefined || each.apiKey]).toEqual([
        each.provider,
        true,
      ])
    }
    const signIns = connectable.flatMap((each) =>
      each.signIn === undefined ? [] : [each.provider],
    )
    expect(signIns).toEqual([
      "openai",
      "xai",
      "github-copilot",
      "openrouter",
      "kimi-coding",
      "meta",
    ])
  })
})

describe("a call's credential", () => {
  test("goes in the header pi sent its key in", () => {
    expect(keyHeaderOf(new Headers({ authorization: "Bearer t" }))).toBe("authorization")
    expect(keyHeaderOf(new Headers({ authorization: "Bearer t", "x-api-key": "t" }))).toBe(
      "x-api-key",
    )
    expect(keyHeaderOf(new Headers({ authorization: "Bearer t", "x-goog-api-key": "t" }))).toBe(
      "x-goog-api-key",
    )

    const bearer = new Headers()
    authorize(bearer, { apiKey: "k" }, "authorization")
    expect(Object.fromEntries(bearer)).toEqual({ authorization: "Bearer k" })
    const google = new Headers()
    authorize(google, { apiKey: "k" }, "x-goog-api-key")
    expect(Object.fromEntries(google)).toEqual({ "x-goog-api-key": "k" })
  })

  test("is a sign-in's own headers and address when pi-ai's toAuth says so", () => {
    const headers = new Headers({ "x-drop": "1" })
    authorize(
      headers,
      { headers: { Authorization: "Bearer kimi", "x-drop": null } },
      "authorization",
    )
    expect(Object.fromEntries(headers)).toEqual({ authorization: "Bearer kimi" })
    expect(apiOrigin("github-copilot", { baseUrl: "https://api.business.githubcopilot.com" })).toBe(
      "https://api.business.githubcopilot.com",
    )
    expect(apiOrigin("github-copilot")).toBe("https://api.individual.githubcopilot.com")
  })
})

/** Where the Hub asks the Provider for an account's Models, and with which header the key. */
const at = (provider: ProviderId) => {
  const request = modelsRequest(provider, { apiKey: "k" })
  return [request.url, request.headers.get("authorization"), request.headers.get("x-goog-api-key")]
}

describe("asking for the Models", () => {
  test("goes to each Provider's own list, with the key as its API takes it", () => {
    expect(at("openai")).toEqual(["https://api.openai.com/v1/models", "Bearer k", null])
    expect(at("mistral")).toEqual(["https://api.mistral.ai/v1/models", "Bearer k", null])
    expect(at("groq")).toEqual(["https://api.groq.com/openai/v1/models", "Bearer k", null])
    expect(at("deepseek")).toEqual(["https://api.deepseek.com/models", "Bearer k", null])
    expect(at("openrouter")).toEqual(["https://openrouter.ai/api/v1/models", "Bearer k", null])
    expect(at("google")).toEqual([
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
      null,
      "k",
    ])
  })

  test("reads OpenAI's list, newest first, and one that is just the list, as Together's is", () => {
    const openRouter = modelsListed("openrouter", {
      data: [
        { id: "openai/gpt-4o", created: 1 },
        { id: "anthropic/claude-haiku-4.5", created: 3 },
        { id: "not/in-pi-ai", created: 9 },
      ],
    })
    expect(openRouter?.map((model) => model.id)).toEqual([
      "anthropic/claude-haiku-4.5",
      "openai/gpt-4o",
    ])
    const together = catalogueOf("together").slice(0, 2)
    const listed = modelsListed(
      "together",
      together.map((model) => ({ id: model.id, type: "chat" })),
    )
    expect(listed?.map((model) => model.id).toSorted()).toEqual(
      together.map((model) => model.id).toSorted(),
    )
  })

  test("reads no list from an answer that isn't one", () => {
    expect(modelsListed("groq", { ok: true })).toBeUndefined()
    expect(modelsListed("google", { data: [] })).toBeUndefined()
    expect(modelsListed("groq", "nope")).toBeUndefined()
  })

  test("offers the catalogue, most capable first, when a Provider can't list them", () => {
    const models = catalogueModels("kimi-coding")
    expect(models.map((model) => model.id)).toEqual(
      catalogueOf("kimi-coding")
        .toSorted((a, b) => b.cost.output - a.cost.output || b.id.localeCompare(a.id))
        .map((model) => model.id),
    )
    expect(models.every((model) => model.provider === "kimi-coding")).toBe(true)
  })
})
