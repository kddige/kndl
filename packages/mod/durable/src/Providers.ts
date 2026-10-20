// The Models a durable agent runs on (ADR 0029, docs/design/pi-harness.md, "The Gateway forwards,
// it doesn't translate"): it asks the Hub for its Creator's Models (`GET /mod/providers`), and
// gives pi-ai each of their Providers pointed at the Gateway, so pi-ai's own API code talks to the
// Hub, with the Session's token as its key, and the Hub adds the Creator's credential. Claude's go
// to the Claude bridge (ClaudeModels.ts). pi-ai's own providers, which would call a Provider
// directly with whatever key they find, are never registered: credentials stay on the Hub.
//
// Each Gateway provider is pi-ai's built-in one under its own name, so pi-ai's per-Provider
// behaviour, keyed on that name, still applies: its streams are the built-in ones, its models the
// built-in catalogue's, filtered to those the Hub lists, each with its `baseUrl` at the Gateway,
// keeping the path of its own address (OpenRouter's Claude is at `/api`, its others at `/api/v1`).
// The key is the Session token, which pi-ai puts where its client for the Model's API does; the
// Runner's relay reads it from `Authorization` alone, so that header carries it too, always.

import type { Api, Model, MutableModels, Provider } from "@earendil-works/pi-ai"
import { createModels } from "@earendil-works/pi-ai/models"
import { modelGatewayPath, ModProviders, parseProviderModelName } from "@kndl/protocol"
import type { ModelProvider } from "@kndl/protocol"
import { Exit, Schema } from "effect"
import { retryDelay } from "../../src/HubLink.ts"
import type { HubFetch } from "../../src/HubLink.ts"
import { builtinProvider } from "./Builtins.ts"
import { installClaude } from "./ClaudeModels.ts"
import type { ClaudeInstall } from "./ClaudeModels.ts"

/** A model as Pi Durable names one. */
export interface ModelRef {
  readonly provider: string
  readonly modelId: string
}

/**
 * What a Provider's sign-in refuses that its API keys take: pi-ai leaves these out itself only for
 * a request it sees going to OpenAI directly, never one to the Gateway.
 */
const signInCompat: Partial<Record<ModelProvider, Readonly<Record<string, boolean>>>> = {
  openai: {
    supportsMaxOutputTokens: false,
    supportsMidConvoEffort: false,
    supportsLongCacheRetention: false,
    supportsExplicitPromptCacheMode: false,
  },
}

/** The path of a catalogue address, without a trailing slash: `/v1`, or none for an origin. */
const pathOf = (baseUrl: string | undefined) => {
  if (baseUrl === undefined) return ""
  try {
    return new URL(baseUrl).pathname.replace(/\/+$/, "")
  } catch {
    return ""
  }
}

/**
 * A Provider's built-in models, at the Gateway: each the catalogue's, in the Hub's order, with the
 * sign-in's `compat` when the Provider is signed in. Those the catalogue doesn't know are `missing`.
 */
export const gatewayModels = (
  base: Pick<Provider, "getModels">,
  ids: ReadonlyArray<string>,
  options: {
    readonly hubUrl: string
    readonly provider: ModelProvider
    readonly signedIn: boolean
  },
): { readonly models: Array<Model<Api>>; readonly missing: Array<string> } => {
  const gateway = `${options.hubUrl.replace(/\/+$/, "")}${modelGatewayPath(options.provider)}`
  const catalogue = base.getModels()
  const compat = options.signedIn ? signInCompat[options.provider] : undefined
  const models: Array<Model<Api>> = []
  const missing: Array<string> = []
  for (const id of ids) {
    const model = catalogue.find((entry) => entry.id === id)
    if (model === undefined) {
      missing.push(id)
      continue
    }
    const atGateway = { ...model, baseUrl: `${gateway}${pathOf(model.baseUrl)}` }
    models.push(
      compat === undefined ? atGateway : { ...atGateway, compat: { ...model.compat, ...compat } },
    )
  }
  return { models, missing }
}

/**
 * The built-in provider `base`, at the Gateway: its streams, the `models` given, and the Session
 * token as its key, in `Authorization: Bearer` too.
 */
export const gatewayProvider = (
  base: Provider,
  models: ReadonlyArray<Model<Api>>,
  modToken: string,
): Provider => {
  const provider: Provider = {
    id: base.id,
    name: base.name,
    ...(models[0] === undefined ? {} : { baseUrl: models[0].baseUrl }),
    auth: {
      apiKey: {
        name: "kndl Gateway",
        resolve: async () => ({
          auth: { apiKey: modToken, headers: { Authorization: `Bearer ${modToken}` } },
          source: "kndl Gateway",
        }),
      },
    },
    getModels: () => models,
    stream: (model, context, options) => base.stream(model, context, options),
    streamSimple: (model, context, options) => base.streamSimple(model, context, options),
  }
  const { fetchDeferred, cancelDeferred } = base
  if (fetchDeferred !== undefined)
    Object.assign(provider, {
      fetchDeferred: (...args: Parameters<typeof fetchDeferred>) => fetchDeferred.apply(base, args),
    })
  if (cancelDeferred !== undefined)
    Object.assign(provider, {
      cancelDeferred: (...args: Parameters<typeof cancelDeferred>) =>
        cancelDeferred.apply(base, args),
    })
  return provider
}

const decodeProviders = Schema.decodeUnknownExit(Schema.fromJsonString(ModProviders))

/** Reads the Hub's answer to `GET /mod/providers`; undefined when it isn't one. */
export const readProviders = (text: string): ModProviders | undefined => {
  const providers = decodeProviders(text)
  return Exit.isSuccess(providers) ? providers.value : undefined
}

/** How long to wait before each try after the first. */
const retryDelays = [500, 1_000, 2_000]

/**
 * Asks the Hub for the Creator's Models, trying a few times while it can't answer; undefined when
 * it never answers, or refuses the token.
 */
export const fetchProviders = async (options: {
  readonly hubUrl: string
  readonly modToken: string
  readonly fetch: HubFetch
  readonly wait: (ms: number) => Promise<void>
  readonly log: (text: string) => void
}): Promise<ModProviders | undefined> => {
  const url = `${options.hubUrl.replace(/\/+$/, "")}/mod/providers`
  for (let attempt = 0; ; attempt++) {
    let why: string
    try {
      const response = await options.fetch(url, {
        method: "GET",
        headers: { authorization: `Bearer ${options.modToken}` },
      })
      if (response.status === 401 || response.status === 403) {
        options.log(`kndl: the Hub refused the mod token (${response.status})`)
        return undefined
      }
      const providers = response.status === 200 ? readProviders(response.text) : undefined
      if (providers !== undefined) return providers
      why = `the Hub answered ${response.status}`
    } catch (error) {
      why = String(error)
    }
    const delay = retryDelays[attempt]
    if (delay === undefined) {
      options.log(`kndl: couldn't get the Session's Models: ${why}`)
      return undefined
    }
    await options.wait(delay)
  }
}

/** The Models the agent runs on, and how it finds one by name. */
export interface Catalog {
  /** pi-ai's Models, which Pi Durable's generation calls. */
  readonly models: MutableModels
  /** The Creator's Models the agent has, as `<provider>/<id>`, in the Hub's order. */
  names(): ReadonlyArray<string>
  /** Calls `listener` whenever asking the Hub again changes the Creator's Models. */
  onChange(listener: () => void): void
  /**
   * Asks the Hub for the Creator's Models again; false when it doesn't answer. Listeners hear of
   * what changed.
   */
  refresh(): Promise<boolean>
  /**
   * The model `name` is, or the first the agent has without one; asks the Hub again, once, when
   * the agent doesn't have it (a Provider connected since it started).
   */
  resolve(
    name: string | undefined,
  ): Promise<{ readonly model: ModelRef } | { readonly why: string }>
  /** Lets go of what the Models hold, as the Claude bridge's Claude Code. */
  close(): Promise<void>
}

/** The model `name` names, if the agent has it. */
const lookup = (models: MutableModels, name: string): ModelRef | undefined => {
  const parsed = parseProviderModelName(name)
  if (parsed === undefined) return undefined
  return models.getModel(parsed.provider, parsed.id) === undefined
    ? undefined
    : { provider: parsed.provider, modelId: parsed.id }
}

/**
 * A catalogue over `models`, whose names are `listed` (the Creator's, as `<provider>/<id>`), and
 * which `ask` asks the Hub for again.
 */
export const catalogOf = (
  models: MutableModels,
  listed: () => ReadonlyArray<string>,
  ask: () => Promise<boolean>,
  close: () => Promise<void> = async () => undefined,
): Catalog => {
  const names = () => listed().filter((name) => lookup(models, name) !== undefined)
  const listeners: Array<() => void> = []
  const refresh = async () => {
    const before = names().join("\n")
    if (!(await ask())) return false
    if (names().join("\n") !== before) for (const listener of listeners) listener()
    return true
  }
  const resolveNow = (name: string | undefined) => {
    if (name === undefined) {
      for (const each of listed()) {
        const model = lookup(models, each)
        if (model !== undefined) return { model }
      }
      return { why: "the agent has none of the Creator's Models" }
    }
    if (parseProviderModelName(name) === undefined)
      return { why: "it isn't a model the agent names" }
    if (!listed().includes(name))
      return {
        why: "it isn't one of the Creator's Models: its Provider isn't connected, or doesn't offer it",
      }
    const model = lookup(models, name)
    return model === undefined ? { why: "the agent doesn't know that model" } : { model }
  }
  return {
    models,
    names,
    onChange: (listener) => void listeners.push(listener),
    refresh,
    resolve: async (name) => {
      const found = resolveNow(name)
      if ("model" in found) return found
      if (!(await refresh())) return { why: "the Hub didn't say which Models the Creator has" }
      return resolveNow(name)
    },
    close,
  }
}

/**
 * The Gateway's catalogue: the Creator's Models as the Hub lists them, each Provider's at the
 * Gateway, and Claude's through the Claude bridge, asked again of the Hub when one is missing.
 */
export const gatewayCatalog = async (options: {
  readonly hubUrl: string
  readonly modToken: string
  readonly fetch: HubFetch
  readonly env: NodeJS.ProcessEnv
  readonly cwd: string
  readonly log: (text: string) => void
  /** Waits `ms`; a timer by default. */
  readonly wait?: (ms: number) => Promise<void>
}): Promise<Catalog> => {
  const models = createModels()
  let listed: ModProviders = { models: [] }
  let claude: ClaudeInstall | undefined
  const wait =
    options.wait ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        // A wait this long must not keep a shutting down agent alive.
        setTimeout(resolve, ms).unref?.()
      }))
  const ask = () => fetchProviders({ ...options, wait })
  const register = (providers: ModProviders) => {
    listed = providers
    const byProvider = new Map<ModelProvider, Array<string>>()
    for (const model of providers.models) {
      if (model.provider === "anthropic") continue
      byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model.id])
    }
    for (const [name, ids] of byProvider) {
      const base = builtinProvider(name)
      if (base === undefined) {
        options.log(`kndl: pi-ai has no provider ${name}`)
        continue
      }
      const signedIn = (providers.signedIn ?? []).some((each) => each === name)
      const { models: atGateway, missing } = gatewayModels(base, ids, {
        hubUrl: options.hubUrl,
        provider: name,
        signedIn,
      })
      if (missing.length > 0)
        options.log(`kndl: pi-ai doesn't know ${name}'s ${missing.join(", ")}`)
      // One the Hub no longer lists stays, at the Gateway, which refuses it: never pi-ai's own.
      if (atGateway.length > 0)
        models.setProvider(gatewayProvider(base, atGateway, options.modToken))
    }
    claude ??= installClaude(models, providers.models, {
      env: options.env,
      cwd: options.cwd,
      log: options.log,
    })
    claude?.update(providers.models)
  }
  const first = await ask()
  if (first !== undefined) register(first)
  let isClosed = false
  const catalog = catalogOf(
    models,
    () => listed.models.map((model) => `${model.provider}/${model.id}`),
    async () => {
      const providers = await ask()
      if (providers === undefined) return false
      register(providers)
      return true
    },
    async () => {
      isClosed = true
      await claude?.close()
    },
  )
  // A Hub that couldn't answer at startup, or listed no Models yet (it was starting too), is asked
  // again until it lists some: only a Model switch would otherwise ask, so until then every Turn
  // would fail for want of a Provider.
  void (async () => {
    for (let attempt = 0; listed.models.length === 0; attempt++) {
      await wait(retryDelay(attempt))
      if (isClosed) return
      await catalog.refresh()
    }
  })()
  return catalog
}
