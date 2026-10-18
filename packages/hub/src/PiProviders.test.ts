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
  enterpriseDomainOf,
  keyHeaderOf,
  modelCallAllowed,
  modelsCall,
  modelsListed,
  signInOrigin,
  upstreamUrl,
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
    const signIn = { type: "oauth", access: "a", refresh: "r", expires: 0 } as const
    expect(
      signInOrigin("github-copilot", signIn, {
        baseUrl: "https://api.business.githubcopilot.com",
      }),
    ).toBe("https://api.business.githubcopilot.com")
    expect(signInOrigin("github-copilot", signIn, {})).toBe(
      "https://api.individual.githubcopilot.com",
    )
    expect(signInOrigin("kimi-coding", signIn, {})).toBe("https://api.kimi.com")
  })
})

/** A GitHub Copilot sign-in, on GitHub Enterprise at `enterpriseUrl` if given. */
const copilot = (enterpriseUrl?: string) => ({
  type: "oauth" as const,
  access: "a",
  refresh: "r",
  expires: 0,
  ...(enterpriseUrl !== undefined && { enterpriseUrl }),
})

describe("GitHub Copilot's addresses", () => {
  test("an Enterprise domain is taken only on GHE.com", () => {
    expect(enterpriseDomainOf("company.ghe.com")).toBe("company.ghe.com")
    expect(enterpriseDomainOf(" https://Company.GHE.com/ ")).toBe("company.ghe.com")
    for (const refused of [
      "github.example.com",
      "ghe.com",
      ".ghe.com",
      "evil.example/x.ghe.com",
      "company.ghe.com.evil.example",
      "127.0.0.1",
      "localhost",
      "user@company.ghe.com",
      "company.ghe.com:8443",
      "http://company.ghe.com",
      "https://company.ghe.com/path",
    ]) {
      expect([refused, enterpriseDomainOf(refused)]).toEqual([refused, undefined])
    }
  })

  test("a sign-in's address is taken only at githubcopilot.com or its Enterprise domain", () => {
    const at = (baseUrl: string, enterpriseUrl?: string) =>
      signInOrigin("github-copilot", copilot(enterpriseUrl), { baseUrl })
    expect(at("https://api.individual.githubcopilot.com")).toBe(
      "https://api.individual.githubcopilot.com",
    )
    expect(at("https://copilot-api.company.ghe.com", "company.ghe.com")).toBe(
      "https://copilot-api.company.ghe.com",
    )
    expect(at("https://api.evil.example")).toBeUndefined()
    expect(at("https://api.evilgithubcopilot.com")).toBeUndefined()
    expect(at("http://api.individual.githubcopilot.com")).toBeUndefined()
    expect(at("https://api.githubcopilot.com.evil.example")).toBeUndefined()
    expect(at("https://api.githubcopilot.com:8443")).toBeUndefined()
    expect(at("https://copilot-api.other.ghe.com", "company.ghe.com")).toBeUndefined()
    // A domain kept from before kndl checked it isn't trusted.
    expect(at("https://copilot-api.evil.example", "evil.example")).toBeUndefined()
    // No other sign-in may name an address.
    expect(
      signInOrigin("kimi-coding", copilot(), { baseUrl: "https://evil.example" }),
    ).toBeUndefined()
  })
})

describe("the Gateway's model calls", () => {
  test("go to the inference and model-listing endpoints pi calls for the Model's API", () => {
    for (const [provider, method, path] of [
      // OpenAI's Responses API.
      ["openai", "POST", "/v1/responses"],
      ["openai", "GET", "/v1/models"],
      ["xai", "POST", "/v1/responses"],
      // Chat Completions, below each Provider's own base.
      ["groq", "POST", "/openai/v1/chat/completions"],
      ["deepseek", "POST", "/chat/completions"],
      ["openrouter", "POST", "/api/v1/chat/completions"],
      ["openrouter", "GET", "/api/v1/models"],
      // Anthropic's Messages API.
      ["openrouter", "POST", "/api/v1/messages"],
      ["minimax", "POST", "/anthropic/v1/messages"],
      ["vercel-ai-gateway", "POST", "/v1/messages"],
      // Google's.
      ["google", "POST", "/v1beta/models/gemini-2.5-pro:streamGenerateContent"],
      ["google", "POST", "/v1beta/models/gemini-2.5-pro:generateContent"],
      ["google", "POST", "/v1beta/models/gemini-2.5-pro:countTokens"],
      ["google", "GET", "/v1beta/models"],
      ["opencode", "POST", "/inference/v1/models/gemini-3-pro:streamGenerateContent"],
      // Mistral's.
      ["mistral", "POST", "/v1/chat/completions"],
      // GitHub Copilot's three.
      ["github-copilot", "POST", "/chat/completions"],
      ["github-copilot", "POST", "/responses"],
      ["github-copilot", "POST", "/v1/messages"],
      ["github-copilot", "GET", "/models"],
    ] as const) {
      expect([provider, method, path, modelCallAllowed(provider, method, path)]).toEqual([
        provider,
        method,
        path,
        true,
      ])
    }
  })

  test("go nowhere else: not files, batches, fine-tuning, or another method", () => {
    for (const [provider, method, path] of [
      ["openai", "POST", "/v1/files"],
      ["openai", "GET", "/v1/files"],
      ["openai", "POST", "/v1/batches"],
      ["openai", "POST", "/v1/fine_tuning/jobs"],
      ["openai", "GET", "/v1/responses"],
      ["openai", "GET", "/v1/responses/resp_1"],
      ["openai", "DELETE", "/v1/models/ft:gpt-6"],
      ["openai", "POST", "/v1/chat/completions"],
      ["openai", "POST", "/v1/responses/"],
      ["openai", "POST", "/V1/responses"],
      ["groq", "POST", "/v1/chat/completions"],
      ["minimax", "POST", "/anthropic/v1/messages/batches"],
      ["minimax", "POST", "/anthropic/v1/files"],
      ["google", "POST", "/v1beta/files"],
      ["google", "POST", "/v1beta/cachedContents"],
      ["google", "POST", "/v1beta/tunedModels"],
      ["google", "POST", "/v1beta/models/gemini-2.5-pro:predict"],
      ["google", "POST", "/v1beta/models/a/b:generateContent"],
      ["mistral", "POST", "/v1/files"],
      ["mistral", "POST", "/v1/fine_tuning/jobs"],
      ["github-copilot", "POST", "/models/gpt-6-sol/policy"],
    ] as const) {
      expect([provider, method, path, modelCallAllowed(provider, method, path)]).toEqual([
        provider,
        method,
        path,
        false,
      ])
    }
  })
})

describe("the upstream address", () => {
  const origin = "https://api.openai.com"

  test("is the path and query below the Provider's origin", () => {
    expect(upstreamUrl(origin, "/v1/responses?stream=true")?.href).toBe(
      "https://api.openai.com/v1/responses?stream=true",
    )
    // An `@` below the origin stays below it.
    expect(upstreamUrl(origin, "/@evil.example/v1")?.origin).toBe(origin)
  })

  test("is none for a path that could leave the origin, or climb out of where it points", () => {
    for (const path of [
      "//evil.example/v1/responses",
      "/%2F%2Fevil.example/v1/responses",
      "/%2f%2fevil.example",
      "/v1/../v1/files",
      "/v1/..",
      "/v1/%2e%2e/files",
      "/v1/%2E./files",
      "/v1/./responses",
      "@evil.example/v1/responses",
      "evil.example/v1/responses",
      "https://evil.example/v1/responses",
      "/\\evil.example/v1/responses",
      "/%5Cevil.example",
      "/v1/responses\nHost: evil.example",
      "",
    ]) {
      expect([path, upstreamUrl(origin, path)?.href]).toEqual([path, undefined])
    }
  })
})

/** Where the Hub asks the Provider for an account's Models, and with which header the key. */
const at = (provider: ProviderId) => {
  const call = modelsCall(provider)
  const headers = new Headers(call.headers)
  authorize(headers, { apiKey: "k" }, call.keyHeader)
  return [
    `${apiOrigin(provider)}${call.path}`,
    headers.get("authorization"),
    headers.get("x-goog-api-key"),
  ]
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
