// The Providers a pi Session runs on (ADR 0029, docs/design/pi-harness.md, "The Gateway
// forwards"): at load, the extension asks the Hub for its Creator's Models (`GET /mod/providers`),
// and points each of pi's own providers for them at the Gateway, so pi-ai's own API code talks to
// the Hub, with the Session's token as its key, and the Hub adds the Creator's credential.
//
// pi composes a provider registered by its built-in name over the built-in one
// (pi-coding-agent's provider-composer): its streams stay pi-ai's own for the built-in API, the
// given `models` replace the built-in list, and the given key and headers are what its requests
// carry. A model's own `baseUrl` wins over the provider's, so each listed model is pointed at the
// Gateway too.

import type { ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent"
import { modelGatewayPath, ModProviders } from "@kndl/protocol"
import type { ModelProvider } from "@kndl/protocol"
import { Exit, Schema } from "effect"
import type { HubFetch } from "../../src/HubLink.ts"

/** A model of pi-ai's built-in catalogue, as `getModels(provider)` lists it. */
export interface CatalogModel {
  readonly id: string
}

/** A provider for pi to register: its name, as pi-ai has it, and its configuration. */
export interface GatewayProvider {
  readonly name: ModelProvider
  readonly config: ProviderConfig
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
 * What a Provider's sign-in refuses that its API keys take: pi-ai leaves these out itself only for
 * a request it sees going to OpenAI directly (`isChatGPTSignIn`), never one to the Gateway.
 */
const signInCompat = {
  supportsMaxOutputTokens: false,
  supportsMidConvoEffort: false,
  supportsLongCacheRetention: false,
  supportsExplicitPromptCacheMode: false,
}

/**
 * pi's provider for each Provider among the Models the Hub lists, but Claude's, which runs
 * through the Claude bridge (see `registerClaude`): the built-in one, at the Gateway, with only
 * the listed Models, in the Hub's order.
 */
export const gatewayProviders = (
  providers: ModProviders,
  options: {
    readonly hubUrl: string
    readonly modToken: string
    readonly catalog: (provider: ModelProvider) => ReadonlyArray<CatalogModel>
  },
): Array<GatewayProvider> => {
  const hubUrl = options.hubUrl.replace(/\/+$/, "")
  const listed = new Map<ModelProvider, Array<string>>()
  for (const model of providers.models) {
    if (model.provider === "anthropic") continue
    listed.set(model.provider, [...(listed.get(model.provider) ?? []), model.id])
  }
  return [...listed].flatMap(([name, ids]) => {
    const baseUrl = `${hubUrl}${modelGatewayPath(name)}`
    const catalog = options.catalog(name)
    const signedIn = (providers.signedIn ?? []).some((provider) => provider === name)
    const known = ids.flatMap((id) => {
      const model = catalog.find((entry) => entry.id === id)
      if (model === undefined) return []
      const compat = signedIn
        ? { ...(model as { readonly compat?: object }).compat, ...signInCompat }
        : (model as { readonly compat?: object }).compat
      return [
        {
          ...model,
          baseUrl,
          ...(compat !== undefined && { compat }),
        } as unknown as ProviderModelConfig,
      ]
    })
    if (known.length === 0) return []
    return [
      {
        name,
        config: {
          baseUrl,
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
