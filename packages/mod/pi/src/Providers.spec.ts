import { describe, expect, test } from "bun:test"
import { getModels } from "@earendil-works/pi-ai/compat"
import { type ModProviders, ProviderIds } from "@kndl/protocol"
import {
  defaultModel,
  fetchProviders,
  gatewayProviders,
  literalConfigValue,
  readProviders,
} from "./Providers.ts"

const listed: ModProviders = {
  models: [
    { provider: "anthropic", id: "claude-opus-4-6", label: "Claude Opus 4.6", thinkingLevels: [] },
    { provider: "openai", id: "gpt-4.1", label: "GPT-4.1", thinkingLevels: [] },
    { provider: "openai", id: "gpt-unknown-to-pi", label: "?", thinkingLevels: [] },
    { provider: "openai", id: "gpt-4o", label: "GPT-4o", thinkingLevels: [] },
    { provider: "xai", id: "grok-4.3", label: "Grok 4.3", thinkingLevels: ["low", "high"] },
  ],
}

const catalog = (provider: string) => getModels(provider as never)

/** A registered model's compat flags, which only a chat model has. */
const compatOf = (model: unknown) => (model as { readonly compat?: unknown }).compat

describe("the Gateway providers (ADR 0029)", () => {
  test("each Provider but Claude's is pi's own, pointed at the Gateway with the Session token, with only the listed Models", () => {
    const registered = gatewayProviders(listed, {
      hubUrl: "http://hub.test:4000/",
      modToken: "tok-123",
      catalog,
    })
    expect(registered.map((provider) => provider.name)).toEqual(["openai", "xai"])
    const [openai, xai] = registered
    // The Provider's own path below the Gateway's: pi-ai's is https://api.openai.com/v1.
    expect(openai?.config.baseUrl).toBe("http://hub.test:4000/gateway/models/openai/v1")
    expect(openai?.config.apiKey).toBe("tok-123")
    expect(openai?.config.headers).toEqual({ Authorization: "Bearer tok-123" })
    // In the order the Hub lists them, as pi-ai's catalogue has them, each at the Gateway.
    expect(openai?.config.models?.map((model) => model.id)).toEqual(["gpt-4.1", "gpt-4o"])
    expect(openai?.missing).toEqual(["gpt-unknown-to-pi"])
    const builtin = catalog("openai").find((model) => model.id === "gpt-4.1")
    expect(openai?.config.models?.[0]).toEqual({
      ...builtin,
      baseUrl: "http://hub.test:4000/gateway/models/openai/v1",
    } as never)
    expect(xai?.config.baseUrl).toBe("http://hub.test:4000/gateway/models/xai/v1")
    expect(xai?.config.models?.map((model) => [model.id, model.api])).toEqual([
      ["grok-4.3", "openai-responses"],
    ])
  })

  test("ChatGPT's sign-in gets requests without the fields it refuses; other sign-ins, pi-ai's own", () => {
    // pi-ai leaves them out itself only for a request it sees going to OpenAI directly.
    const [openai, xai] = gatewayProviders(
      { ...listed, signedIn: ["openai", "xai"] },
      { hubUrl: "http://hub.test", modToken: "t", catalog },
    )
    for (const model of openai?.config.models ?? []) {
      expect(compatOf(model)).toMatchObject({
        supportsMaxOutputTokens: false,
        supportsMidConvoEffort: false,
        supportsLongCacheRetention: false,
        supportsExplicitPromptCacheMode: false,
      })
    }
    const builtin = catalog("xai").find((model) => model.id === "grok-4.3")
    expect(compatOf(xai?.config.models?.[0])).toEqual(builtin?.compat)
  })

  test("Google's: pi's own Google API at the Gateway, which sends the token in Google's header", () => {
    const [google] = gatewayProviders(
      {
        models: [
          { provider: "google", id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", thinkingLevels: [] },
        ],
      },
      { hubUrl: "http://hub.test", modToken: "tok", catalog },
    )
    expect(google?.name).toBe("google")
    expect(google?.config.baseUrl).toBe("http://hub.test/gateway/models/google/v1beta")
    // pi's Google client puts the key in `x-goog-api-key`; the relay still reads the bearer.
    expect(google?.config.apiKey).toBe("tok")
    expect(google?.config.headers).toEqual({ Authorization: "Bearer tok" })
    const [model] = google?.config.models ?? []
    expect([model?.id, model?.api, model?.baseUrl]).toEqual([
      "gemini-2.5-pro",
      "google-generative-ai",
      "http://hub.test/gateway/models/google/v1beta",
    ])
  })

  test("GitHub Copilot's: its Models' integration headers kept, each API's Models at their own path", () => {
    const [copilot] = gatewayProviders(
      {
        models: [
          {
            provider: "github-copilot",
            id: "claude-opus-5",
            label: "Claude Opus 5",
            thinkingLevels: [],
          },
          { provider: "github-copilot", id: "gpt-6-sol", label: "GPT-6 Sol", thinkingLevels: [] },
        ],
        signedIn: ["github-copilot"],
      },
      { hubUrl: "http://hub.test", modToken: "tok", catalog },
    )
    expect(copilot?.name).toBe("github-copilot")
    // The Hub sends it on to the account's own endpoint, which its sign-in names.
    expect(copilot?.config.baseUrl).toBe("http://hub.test/gateway/models/github-copilot")
    const models = copilot?.config.models ?? []
    expect(models.map((model) => [model.id, model.api, model.baseUrl])).toEqual([
      ["claude-opus-5", "anthropic-messages", "http://hub.test/gateway/models/github-copilot"],
      ["gpt-6-sol", "openai-responses", "http://hub.test/gateway/models/github-copilot"],
    ])
    for (const model of models) {
      expect(model.headers).toMatchObject({ "Copilot-Integration-Id": "vscode-chat" })
    }
    // A sign-in other than ChatGPT's takes what its API keys take: pi-ai's own compat stays.
    const builtin = catalog("github-copilot").find((model) => model.id === "gpt-6-sol")
    expect(compatOf(models[1])).toEqual(builtin?.compat)
  })

  test("OpenRouter's: its Claude at /api, for Anthropic's API, and the rest at /api/v1", () => {
    const [openrouter] = gatewayProviders(
      {
        models: [
          {
            provider: "openrouter",
            id: "anthropic/claude-haiku-4.5",
            label: "?",
            thinkingLevels: [],
          },
          { provider: "openrouter", id: "openai/gpt-4o", label: "?", thinkingLevels: [] },
        ],
      },
      { hubUrl: "http://hub.test", modToken: "tok", catalog },
    )
    expect(openrouter?.config.models?.map((model) => model.baseUrl)).toEqual([
      "http://hub.test/gateway/models/openrouter/api",
      "http://hub.test/gateway/models/openrouter/api/v1",
    ])
  })

  test("every Provider a Member can connect is one pi has, each Model at the Gateway at its own path", () => {
    for (const provider of ProviderIds) {
      const [first] = catalog(provider)
      expect([provider, first !== undefined]).toEqual([provider, true])
      if (first === undefined) continue
      const [registered] = gatewayProviders(
        { models: [{ provider, id: first.id, label: first.name, thinkingLevels: [] }] },
        { hubUrl: "http://hub.test", modToken: "tok", catalog },
      )
      expect(registered?.name).toBe(provider)
      expect(registered?.config.models?.[0]?.baseUrl).toBe(
        `http://hub.test/gateway/models/${provider}${new URL(first.baseUrl).pathname.replace(/\/+$/, "")}`,
      )
    }
  })

  test("a Provider none of whose Models pi knows isn't registered", () => {
    const registered = gatewayProviders(
      { models: [{ provider: "xai", id: "grok-zz", label: "?", thinkingLevels: [] }] },
      { hubUrl: "http://hub.test", modToken: "t", catalog },
    )
    expect(registered).toEqual([])
  })

  test("the token is passed as it is, never read as an environment variable or a command", () => {
    expect(literalConfigValue("plain")).toBe("plain")
    expect(literalConfigValue("a$HOME")).toBe("a$$HOME")
    expect(literalConfigValue("!rm -rf")).toBe("$!rm -rf")
    expect(literalConfigValue("Bearer $X")).toBe("Bearer $$X")
  })
})

/** pi has every Model but Claude's. */
const has = (provider: string) => provider !== "anthropic"

describe("the default Model", () => {
  test("is the first the Hub lists that pi has", () => {
    expect(defaultModel(listed, has)).toEqual({ provider: "openai", id: "gpt-4.1" })
    expect(defaultModel({ models: [] }, has)).toBeUndefined()
  })
})

describe("fetching /mod/providers", () => {
  test("asks with the mod token, and reads the answer", async () => {
    const asked: Array<{ url: string; authorization: string | undefined }> = []
    const providers = await fetchProviders({
      hubUrl: "http://hub.test/",
      modToken: "tok",
      fetch: async (url, init) => {
        asked.push({ url, authorization: init.headers.authorization })
        return { status: 200, text: JSON.stringify(listed) }
      },
      wait: async () => undefined,
    })
    expect(asked).toEqual([{ url: "http://hub.test/mod/providers", authorization: "Bearer tok" }])
    expect(providers?.models.map((model) => model.id)).toContain("grok-4.3")
  })

  test("tries again while the Hub can't answer, then gives up", async () => {
    let calls = 0
    const waits: Array<number> = []
    const providers = await fetchProviders({
      hubUrl: "http://hub.test",
      modToken: "tok",
      fetch: async () => {
        calls++
        if (calls === 1) throw new Error("ECONNREFUSED")
        return { status: 502, text: "" }
      },
      wait: async (ms) => void waits.push(ms),
    })
    expect(providers).toBeUndefined()
    expect(calls).toBe(4)
    expect(waits).toEqual([500, 1_000, 2_000])
  })

  test("a refused token isn't tried again", async () => {
    let calls = 0
    const providers = await fetchProviders({
      hubUrl: "http://hub.test",
      modToken: "tok",
      fetch: async () => {
        calls++
        return { status: 403, text: "" }
      },
      wait: async () => undefined,
    })
    expect(providers).toBeUndefined()
    expect(calls).toBe(1)
  })

  test("an answer that isn't one is none", () => {
    expect(readProviders("nope")).toBeUndefined()
    expect(readProviders(JSON.stringify({ models: [{ provider: "openai" }] }))).toBeUndefined()
  })
})
