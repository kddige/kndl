// The Providers a pi Session runs on (ADR 0029, docs/design/pi-harness.md, "The Gateway
// forwards"): at load, the extension asks the Hub for its Creator's Models (`GET /mod/providers`),
// and points each of pi's own providers for them at the Gateway, so pi-ai's own API code talks to
// the Hub, with the Session's token as its key, and the Hub adds the Creator's credential.
//
// pi composes a provider registered by its built-in name over the built-in one
// (pi-coding-agent's provider-composer): its streams stay pi-ai's own for the built-in API, the
// given `models` replace the built-in list, and the given key and headers are what its requests
// carry. A model's own `baseUrl` wins over the provider's, so each listed model is pointed at the
// Gateway too, keeping the path of its own address below the Gateway's: the Gateway sends a call
// on to the origin of the Provider's API with the path pi sent (OpenRouter's Claude is at `/api`,
// its other Models at `/api/v1`).
//
// pi puts the key where its client for the Model's API does: `Authorization: Bearer` for most,
// `x-api-key` for Anthropic's Messages API, `x-goog-api-key` for Google's. The Runner's relay reads
// the Session token from `Authorization` alone, so that header carries it too, always; the Gateway
// drops both, and puts the Creator's key where pi put the token.

import type { Api, Model } from "@earendil-works/pi-ai"
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all"
import { modelGatewayPath, ModProviders } from "@kndl/protocol"
import type { ModelProvider } from "@kndl/protocol"
import { Exit, Schema } from "effect"
import type { HubFetch } from "../../src/HubLink.ts"

/** pi-ai's own catalogue of a Provider's chat models; none for a Provider it doesn't know. */
export const builtinCatalog = (provider: string): ReadonlyArray<Model<Api>> => {
  const known = getBuiltinProviders().find((each) => each === provider)
  return known === undefined ? [] : getBuiltinModels(known)
}

/** A model of pi-ai's built-in catalogue ({@link builtinCatalog}), as far as kndl reads it. */
export interface CatalogModel {
  readonly id: string
  /** Where pi-ai sends its calls: `https://api.openai.com/v1`. */
  readonly baseUrl: string
  readonly compat?: object | undefined
}

/** A provider for pi to register: its name, as pi-ai has it, and its configuration. */
export interface GatewayProvider<M extends CatalogModel> {
  readonly name: ModelProvider
  /** As `pi.registerProvider` takes it: each model is the catalogue's, at the Gateway. */
  readonly config: {
    readonly baseUrl: string
    readonly apiKey: string
    readonly headers: Record<string, string>
    readonly models: Array<M>
  }
  /** The Models the Hub listed that pi-ai's catalogue doesn't know, so pi can't run. */
  readonly missing: ReadonlyArray<string>
}

/**
 * `value` as pi reads a configured key or header literally: pi reads `$NAME` as an environment
 * variable and a leading `!` as a command, unless written `$$` and `$!`.
 */
export const literalConfigValue = (value: string) => {
  const escaped = value.replaceAll("$", () => "$$")
  return escaped.startsWith("!") ? `$${escaped}` : escaped
}

/**
 * What a Provider's sign-in refuses that its API keys take, for each Provider whose sign-in does:
 * pi-ai leaves these out itself only for a request it sees going to OpenAI directly
 * (`isChatGPTSignIn`), never one to the Gateway. pi-ai sends other sign-ins' requests as it sends
 * their keys', keyed on the provider's name, which stays pi's own.
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
 * pi's provider for each Provider among the Models the Hub lists, but Claude's, which runs
 * through the Claude bridge (see `registerClaude`): the built-in one, at the Gateway, with only
 * the listed Models, in the Hub's order.
 */
export const gatewayProviders = <M extends CatalogModel>(
  providers: ModProviders,
  options: {
    readonly hubUrl: string
    readonly modToken: string
    readonly catalog: (provider: ModelProvider) => ReadonlyArray<M>
  },
): Array<GatewayProvider<M>> => {
  const hubUrl = options.hubUrl.replace(/\/+$/, "")
  const listed = new Map<ModelProvider, Array<string>>()
  for (const model of providers.models) {
    if (model.provider === "anthropic") continue
    listed.set(model.provider, [...(listed.get(model.provider) ?? []), model.id])
  }
  return [...listed].flatMap(([name, ids]): Array<GatewayProvider<M>> => {
    const gateway = `${hubUrl}${modelGatewayPath(name)}`
    const catalog = options.catalog(name)
    const signedIn = (providers.signedIn ?? []).some((provider) => provider === name)
    const compatForSignIn = signedIn ? signInCompat[name] : undefined
    const known = ids.flatMap((id): Array<M> => {
      const model = catalog.find((entry) => entry.id === id)
      if (model === undefined) return []
      const atGateway = { ...model, baseUrl: `${gateway}${pathOf(model.baseUrl)}` }
      return [
        compatForSignIn === undefined
          ? atGateway
          : { ...atGateway, compat: { ...model.compat, ...compatForSignIn } },
      ]
    })
    const [first] = known
    if (first === undefined) return []
    return [
      {
        name,
        config: {
          baseUrl: first.baseUrl,
          apiKey: literalConfigValue(options.modToken),
          // The Runner's relay takes the Session token from this header alone.
          headers: { Authorization: literalConfigValue(`Bearer ${options.modToken}`) },
          models: known,
        },
        missing: ids.filter((id) => !catalog.some((entry) => entry.id === id)),
      },
    ]
  })
}

/**
 * The Model a Session runs when none is named, as when a SwitchModel names none: the first the
 * Hub lists that pi has.
 */
export const defaultModel = (
  providers: ModProviders,
  has: (provider: ModelProvider, id: string) => boolean,
): { readonly provider: ModelProvider; readonly id: string } | undefined => {
  const model = providers.models.find((entry) => has(entry.provider, entry.id))
  return model === undefined ? undefined : { provider: model.provider, id: model.id }
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
 * Asks the Hub for the Creator's Models, trying a few times while it can't answer, since pi waits
 * for them to start; undefined when it never answers, or refuses the token.
 */
export const fetchProviders = async (options: {
  readonly hubUrl: string
  readonly modToken: string
  readonly fetch: HubFetch
  readonly wait: (ms: number) => Promise<void>
  readonly log?: (text: string) => void
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
        options.log?.(`kndl: the Hub refused the mod token (${response.status})`)
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
      options.log?.(`kndl: couldn't get the Session's Models: ${why}`)
      return undefined
    }
    await options.wait(delay)
  }
}
