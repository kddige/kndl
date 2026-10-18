// The Providers kndl connects (ADR 0029), as pi-ai serves them: pi-ai's own built-in providers,
// whose URLs, sign-ins and catalogues the Hub uses, and what kndl adds for each: where it lists the
// Models an account has, and how its answer reads.
//
// - Which: each pi-ai provider whose requests pi sends with a key the Gateway can swap, to an API
//   at a fixed address. Not `anthropic` (Claude runs through Claude Code: ADR 0026, 0029), nor
//   those that need cloud credentials or request signing (Amazon Bedrock, Google Vertex AI), an
//   address per account (Azure, Cloudflare), or a catalogue per account (Radius), nor pi-ai's
//   legacy `openai-codex`, whose sign-in OpenAI's is. docs/design/pi-harness.md lists them.
// - Where: a Provider's API is at its origin, `https://api.openai.com`, and a request's path below
//   it is the one pi sent: each Model's own address in the catalogue is that origin and a path,
//   which the mod keeps below the Gateway's. A sign-in's `toAuth` may name another address, as
//   GitHub Copilot's does for each account: its origin is used instead.
// - The key goes where pi put the Session's token: `x-goog-api-key` (Google's API), `x-api-key`
//   (Anthropic's Messages API, as MiniMax and others serve it), or else `Authorization: Bearer`.
//   pi-ai's `toAuth` says what a sign-in sends: a key (most), or headers of its own (Kimi's).

import type { Api, Credential, Model, ModelAuth, Provider } from "@earendil-works/pi-ai"
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models"
import { antLingProvider } from "@earendil-works/pi-ai/providers/ant-ling"
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic"
import { basetenProvider } from "@earendil-works/pi-ai/providers/baseten"
import { cerebrasProvider } from "@earendil-works/pi-ai/providers/cerebras"
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek"
import { fireworksProvider } from "@earendil-works/pi-ai/providers/fireworks"
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot"
import { googleProvider } from "@earendil-works/pi-ai/providers/google"
import { groqProvider } from "@earendil-works/pi-ai/providers/groq"
import { huggingfaceProvider } from "@earendil-works/pi-ai/providers/huggingface"
import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding"
import { metaProvider } from "@earendil-works/pi-ai/providers/meta"
import { minimaxProvider } from "@earendil-works/pi-ai/providers/minimax"
import { minimaxCnProvider } from "@earendil-works/pi-ai/providers/minimax-cn"
import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral"
import { moonshotaiProvider } from "@earendil-works/pi-ai/providers/moonshotai"
import { moonshotaiCnProvider } from "@earendil-works/pi-ai/providers/moonshotai-cn"
import { nvidiaProvider } from "@earendil-works/pi-ai/providers/nvidia"
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode"
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go"
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter"
import { qwenTokenPlanProvider } from "@earendil-works/pi-ai/providers/qwen-token-plan"
import { qwenTokenPlanCnProvider } from "@earendil-works/pi-ai/providers/qwen-token-plan-cn"
import { qwenTokenPlanIndividualProvider } from "@earendil-works/pi-ai/providers/qwen-token-plan-individual"
import { togetherProvider } from "@earendil-works/pi-ai/providers/together"
import { vercelAIGatewayProvider } from "@earendil-works/pi-ai/providers/vercel-ai-gateway"
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai"
import { xiaomiProvider } from "@earendil-works/pi-ai/providers/xiaomi"
import { xiaomiTokenPlanAmsProvider } from "@earendil-works/pi-ai/providers/xiaomi-token-plan-ams"
import { xiaomiTokenPlanCnProvider } from "@earendil-works/pi-ai/providers/xiaomi-token-plan-cn"
import { xiaomiTokenPlanSgpProvider } from "@earendil-works/pi-ai/providers/xiaomi-token-plan-sgp"
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai"
import { zaiCodingCnProvider } from "@earendil-works/pi-ai/providers/zai-coding-cn"
import {
  type ConnectableProvider,
  type ModelProvider,
  type ProviderId,
  ProviderIds,
  type ProviderModel,
  ThinkingLevel,
  ThinkingLevels,
} from "@kndl/protocol"
import { Schema } from "effect"

/** pi-ai's built-in providers, whose URLs, sign-ins and catalogues the Hub uses. */
const builtIn: Record<ModelProvider, Provider<Api>> = {
  openai: openaiProvider(),
  xai: xaiProvider(),
  "github-copilot": githubCopilotProvider(),
  openrouter: openrouterProvider(),
  google: googleProvider(),
  mistral: mistralProvider(),
  deepseek: deepseekProvider(),
  groq: groqProvider(),
  cerebras: cerebrasProvider(),
  "kimi-coding": kimiCodingProvider(),
  moonshotai: moonshotaiProvider(),
  zai: zaiProvider(),
  minimax: minimaxProvider(),
  meta: metaProvider(),
  together: togetherProvider(),
  fireworks: fireworksProvider(),
  huggingface: huggingfaceProvider(),
  nvidia: nvidiaProvider(),
  "vercel-ai-gateway": vercelAIGatewayProvider(),
  opencode: opencodeProvider(),
  "opencode-go": opencodeGoProvider(),
  baseten: basetenProvider(),
  "qwen-token-plan": qwenTokenPlanProvider(),
  "qwen-token-plan-individual": qwenTokenPlanIndividualProvider(),
  xiaomi: xiaomiProvider(),
  "xiaomi-token-plan-ams": xiaomiTokenPlanAmsProvider(),
  "xiaomi-token-plan-sgp": xiaomiTokenPlanSgpProvider(),
  "ant-ling": antLingProvider(),
  "moonshotai-cn": moonshotaiCnProvider(),
  "zai-coding-cn": zaiCodingCnProvider(),
  "minimax-cn": minimaxCnProvider(),
  "qwen-token-plan-cn": qwenTokenPlanCnProvider(),
  "xiaomi-token-plan-cn": xiaomiTokenPlanCnProvider(),
  anthropic: anthropicProvider(),
}

/** How a Provider's answer listing its Models reads. */
type Listing =
  /**
   * `{data:[{id, created?, display_name?}]}`, or the list alone, OpenAI's way; or, for a ChatGPT
   * sign-in, `{models:[{slug, display_name, visibility, context_window, supported_reasoning_levels}]}`.
   */
  | "OpenAi"
  /** `{models:[{name: "models/<id>", displayName, inputTokenLimit, supportedGenerationMethods}]}`. */
  | "Google"
  /** OpenAI's way, each with `model_picker_enabled` and `policy.state` for the account. */
  | "Copilot"

/** What kndl adds to pi-ai's provider. */
interface Definition {
  /** Where it lists an account's Models, below its API's origin. */
  readonly models: string
  readonly listing?: Listing
  /** The sign-in's label, when pi-ai's has none. */
  readonly signIn?: string
  /** Whether a pasted key is offered; by default, when pi-ai takes one. */
  readonly apiKey?: boolean
  /** What a sign-in is called when its tokens don't name the account. */
  readonly account?: string
}

/** GitHub's API version for Copilot's model list, as pi-ai's sign-in asks it. */
const copilotApiVersion = "2026-06-01"

const definitions: Record<ProviderId, Definition> = {
  openai: { models: "/v1/models", account: "ChatGPT subscription" },
  xai: { models: "/v1/models", account: "SuperGrok or X Premium" },
  "github-copilot": {
    models: "/models",
    listing: "Copilot",
    signIn: "Sign in with GitHub Copilot",
    // pi-ai's "GitHub Copilot token" is the one its sign-in gets, not one a person has to paste.
    apiKey: false,
    account: "GitHub Copilot subscription",
  },
  openrouter: { models: "/api/v1/models", account: "OpenRouter account" },
  google: { models: "/v1beta/models?pageSize=1000", listing: "Google" },
  mistral: { models: "/v1/models" },
  deepseek: { models: "/models" },
  groq: { models: "/openai/v1/models" },
  cerebras: { models: "/v1/models" },
  "kimi-coding": { models: "/coding/v1/models", account: "Kimi Code subscription" },
  moonshotai: { models: "/v1/models" },
  zai: { models: "/api/coding/paas/v4/models" },
  minimax: { models: "/v1/models" },
  meta: { models: "/v1/models", account: "Muse subscription" },
  together: { models: "/v1/models" },
  fireworks: { models: "/inference/v1/models" },
  huggingface: { models: "/v1/models" },
  nvidia: { models: "/v1/models" },
  "vercel-ai-gateway": { models: "/v1/models" },
  opencode: { models: "/inference/v1/models" },
  "opencode-go": { models: "/inference/go/v1/models" },
  baseten: { models: "/v1/models" },
  "qwen-token-plan": { models: "/compatible-mode/v1/models" },
  "qwen-token-plan-individual": { models: "/compatible-mode/v1/models" },
  xiaomi: { models: "/v1/models" },
  "xiaomi-token-plan-ams": { models: "/v1/models" },
  "xiaomi-token-plan-sgp": { models: "/v1/models" },
  "ant-ling": { models: "/v1/models" },
  "moonshotai-cn": { models: "/v1/models" },
  "zai-coding-cn": { models: "/api/coding/paas/v4/models" },
  "minimax-cn": { models: "/v1/models" },
  "qwen-token-plan-cn": { models: "/compatible-mode/v1/models" },
  "xiaomi-token-plan-cn": { models: "/v1/models" },
}

/** What the Account page calls the Provider: pi-ai's name. */
export const nameOf = (provider: ModelProvider) => builtIn[provider].name

/** What a sign-in is labelled when its tokens don't name the account. */
export const accountNameOf = (provider: ProviderId) =>
  definitions[provider].account ?? `${nameOf(provider)} account`

/** The Provider's sign-in, as pi-ai has it. */
export const oauthOf = (provider: ProviderId) => {
  const oauth = builtIn[provider].auth.oauth
  if (oauth === undefined) throw new Error(`pi-ai has no sign-in for ${provider}`)
  return oauth
}

/** Every Provider a Member can connect, and how, in the order the Account page lists them. */
export const connectable: ReadonlyArray<ConnectableProvider> = ProviderIds.map((provider) => {
  const { auth } = builtIn[provider]
  const definition = definitions[provider]
  const signIn = auth.oauth === undefined ? undefined : (auth.oauth.loginLabel ?? definition.signIn)
  const apiKey = auth.apiKey !== undefined && (definition.apiKey ?? true)
  return {
    provider,
    name: nameOf(provider),
    ...(signIn !== undefined && { signIn }),
    apiKey,
    ...(apiKey && auth.apiKey !== undefined && { keyName: auth.apiKey.name }),
  }
})

// ── Where its API is, and how a call is authorised ─────────────────────────

/** The Provider's catalogue, as the Runner's pi has it. */
export const catalogueOf = (provider: ModelProvider): ReadonlyArray<Model<Api>> =>
  builtIn[provider].getModels()

/**
 * The origin of the Provider's API, `https://api.openai.com`: the one a sign-in's `toAuth` names,
 * else pi-ai's for it.
 */
export function apiOrigin(provider: ModelProvider, auth?: ModelAuth): string {
  const base = auth?.baseUrl ?? builtIn[provider].baseUrl ?? catalogueOf(provider)[0]?.baseUrl
  if (base === undefined) throw new Error(`pi-ai has no address for ${provider}`)
  return new URL(base).origin
}

/** The header a request carries its key in, as pi sends it for the Model's API. */
export type KeyHeader = "authorization" | "x-api-key" | "x-goog-api-key"

/** The header `headers` carry their key in: Google's, Anthropic's, else a bearer. */
export const keyHeaderOf = (headers: Headers): KeyHeader =>
  headers.has("x-goog-api-key")
    ? "x-goog-api-key"
    : headers.has("x-api-key")
      ? "x-api-key"
      : "authorization"

/**
 * Sets what `auth` says a request goes with on `headers`: its key in `keyHeader`, a bearer in
 * `authorization`, and any headers of its own over those.
 */
export function authorize(headers: Headers, auth: ModelAuth, keyHeader: KeyHeader): void {
  if (auth.apiKey !== undefined) {
    headers.set(keyHeader, keyHeader === "authorization" ? `Bearer ${auth.apiKey}` : auth.apiKey)
  }
  for (const [name, value] of Object.entries(auth.headers ?? {})) {
    if (value === null) headers.delete(name)
    else headers.set(name, value)
  }
}

/** What an API key sends: itself. None for a sign-in, whose pi-ai `toAuth` says. */
export const keyAuth = (credential: Credential): ModelAuth | undefined =>
  credential.type === "api_key" ? { apiKey: credential.key ?? "" } : undefined

// ── The Models ─────────────────────────────────────────────────────────────

/** How long a reason from a Provider is kept, so a strange answer can't flood the page. */
const reasonLimit = 200

const isThinkingLevel = Schema.is(ThinkingLevel)

/** The thinking levels the Model takes, lowest first: the Provider's, else pi-ai's. */
function thinkingLevelsOf(model: Model<Api>, said: ReadonlyArray<string> = []) {
  if (!model.reasoning) return []
  const fromProvider = said.filter(isThinkingLevel)
  const levels =
    fromProvider.length > 0
      ? fromProvider
      : getSupportedThinkingLevels(model).filter(isThinkingLevel)
  return ThinkingLevels.filter((level) => levels.includes(level))
}

/** The Model as the Hub lists it, if pi-ai's catalogue for the Provider has it. */
export function modelOf(
  provider: ModelProvider,
  id: string,
  said: {
    readonly label?: unknown
    readonly contextWindow?: unknown
    readonly thinkingLevels?: ReadonlyArray<string>
  } = {},
): ProviderModel | undefined {
  const known = catalogueOf(provider).find((model) => model.id === id)
  if (known === undefined) return undefined
  const contextWindow =
    typeof said.contextWindow === "number" &&
    Number.isInteger(said.contextWindow) &&
    said.contextWindow > 0
      ? said.contextWindow
      : known.contextWindow
  return {
    provider,
    id,
    label: typeof said.label === "string" && said.label !== "" ? said.label : known.name,
    thinkingLevels: thinkingLevelsOf(known, said.thinkingLevels),
    ...(Number.isInteger(contextWindow) && contextWindow >= 0 && { contextWindow }),
  }
}

/**
 * The most capable first, as near as pi-ai's catalogue says: the costliest output, then the
 * highest id, so of two that cost the same, the later version.
 */
const byCapability =
  (provider: ModelProvider) =>
  (a: { readonly id: string }, b: { readonly id: string }): number =>
    outputCost(provider, b.id) - outputCost(provider, a.id) ||
    b.id.localeCompare(a.id, "en", { numeric: true })

/** What the Model's output costs, as pi-ai's catalogue says: 0 for one it doesn't know. */
const outputCost = (provider: ModelProvider, id: string) =>
  catalogueOf(provider).find((model) => model.id === id)?.cost.output ?? 0

/** When the Provider says the listed Model was made, if it does. */
const createdOf = (model: Record<string, unknown>) =>
  typeof model.created === "number" ? model.created : undefined

/**
 * The Provider's Models in pi-ai's catalogue, most capable first: what its Member's Sessions are
 * offered when it can't list them.
 */
export const catalogueModels = (provider: ProviderId): ReadonlyArray<ProviderModel> =>
  catalogueOf(provider)
    .toSorted(byCapability(provider))
    .flatMap((model) => modelOf(provider, model.id) ?? [])

/**
 * Claude's current Models in pi-ai's catalogue, for when Anthropic can't say: the newest of each
 * kind, not a dated snapshot, the most costly first.
 */
export const currentClaude: ReadonlyArray<ProviderModel> = (() => {
  const newest = new Map<string, Model<Api>>()
  for (const model of catalogueOf("anthropic")) {
    const kind = /^claude-([a-z]+)-/.exec(model.id)?.[1]
    if (kind === undefined || /-\d{8}$/.test(model.id)) continue
    newest.set(kind, model)
  }
  return [...newest.values()]
    .toSorted((a, b) => b.cost.output - a.cost.output)
    .flatMap((model) => modelOf("anthropic", model.id) ?? [])
})()

export const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const records = (value: unknown): ReadonlyArray<Record<string, unknown>> =>
  Array.isArray(value)
    ? value.flatMap<Record<string, unknown>>((each: unknown) => record(each) ?? [])
    : []

export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The Provider's own reason, from its error shape, kept short. */
export const reasonIn = (body: string) => {
  const error = record(parseJson(body))?.error
  const said = typeof error === "string" ? error : record(error)?.message
  return typeof said === "string" ? `: ${said.slice(0, reasonLimit)}` : ""
}

/** A reason from pi-ai, kept short. */
export const reasonOf = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, reasonLimit)

/** How the Hub asks a Provider for the Models an account has. */
export function modelsRequest(provider: ProviderId, auth: ModelAuth, signal?: AbortSignal) {
  const definition = definitions[provider]
  const headers = new Headers({ accept: "application/json" })
  if (definition.listing === "Copilot") {
    // The integration headers its API takes only with, as pi-ai's catalogue has them.
    for (const [name, value] of Object.entries(catalogueOf(provider)[0]?.headers ?? {})) {
      if (value !== null) headers.set(name, value)
    }
    headers.set("X-GitHub-Api-Version", copilotApiVersion)
  }
  authorize(headers, auth, definition.listing === "Google" ? "x-goog-api-key" : "authorization")
  return new Request(`${apiOrigin(provider, auth)}${definition.models}`, {
    headers,
    ...(signal !== undefined && { signal }),
  })
}

/** Whether a Provider's 400 says the key is wrong, as Google's does. */
export const rejectsKey = (status: number, body: string) =>
  status === 401 || status === 403 || (status === 400 && /api[ _-]?key/i.test(reasonIn(body)))

/**
 * The Models a Provider's answer lists, those pi-ai knows, the newest or most capable first; none
 * when it isn't a list.
 */
export function modelsListed(
  provider: ModelProvider,
  body: unknown,
): ReadonlyArray<ProviderModel> | undefined {
  const listing = provider === "anthropic" ? "OpenAi" : (definitions[provider].listing ?? "OpenAi")
  const answer = record(body)
  if (listing === "Google") {
    if (!Array.isArray(answer?.models)) return undefined
    return records(answer.models)
      .flatMap((model) => {
        const name = typeof model.name === "string" ? model.name.replace(/^models\//, "") : ""
        const methods = model.supportedGenerationMethods
        const generates =
          !Array.isArray(methods) ||
          methods.some(
            (method) => method === "generateContent" || method === "streamGenerateContent",
          )
        if (name === "" || !generates) return []
        return (
          modelOf(provider, name, {
            label: model.displayName,
            contextWindow: model.inputTokenLimit,
          }) ?? []
        )
      })
      .toSorted(byCapability(provider))
  }
  // A ChatGPT sign-in's answer ranks them, and says which to show.
  if (Array.isArray(answer?.models)) {
    return records(answer.models).flatMap((model) => {
      if (model.visibility !== "list" || typeof model.slug !== "string") return []
      return (
        modelOf(provider, model.slug, {
          label: model.display_name,
          contextWindow: model.context_window,
          thinkingLevels: records(model.supported_reasoning_levels).flatMap((level) =>
            typeof level.effort === "string" ? [level.effort] : [],
          ),
        }) ?? []
      )
    })
  }
  if (!Array.isArray(body) && !Array.isArray(answer?.data)) return undefined
  let data = records(Array.isArray(body) ? body : answer?.data)
  if (listing === "Copilot") {
    // As pi-ai's sign-in reads it: those the account's picker offers, which can call tools.
    const usable = data.filter(
      (model) => record(record(model.capabilities)?.supports)?.tool_calls !== false,
    )
    const picked = usable.filter(
      (model) => model.model_picker_enabled === true && record(model.policy)?.state !== "disabled",
    )
    data =
      picked.length > 0
        ? picked
        : usable.filter((model) => record(model.policy)?.state === "enabled")
  }
  const models = data.flatMap((model) => {
    if (typeof model.id !== "string") return []
    const found = modelOf(provider, model.id, { label: model.display_name })
    return found === undefined ? [] : [{ found, created: createdOf(model) }]
  })
  // Anthropic lists the newest first already, and says no `created`.
  const ranked =
    provider === "anthropic"
      ? models
      : models.every((model) => model.created !== undefined)
        ? models.toSorted((a, b) => (b.created ?? 0) - (a.created ?? 0))
        : models.toSorted((a, b) => byCapability(provider)(a.found, b.found))
  return ranked.map((model) => model.found)
}

/**
 * Who the sign-in is for, if its access token says: a JWT's `email`, or OpenAI's profile's.
 * Read without checking its signature, for a label alone.
 */
export function accountOf(access: string): string | undefined {
  const payload = access.split(".")[1]
  if (payload === undefined) return undefined
  try {
    const claims = record(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")))
    const email = claims?.email ?? record(claims?.["https://api.openai.com/profile"])?.email
    return typeof email === "string" && email !== "" ? email : undefined
  } catch {
    return undefined
  }
}
