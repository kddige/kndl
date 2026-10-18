// A pi Session's SwitchModel (ADR 0029): the Hub asks for one of its Creator's Models, and pi runs
// the next Turns on it. The extension pointed pi at the Gateway for the Models `/mod/providers`
// listed when pi started, so one of a Provider the Creator connected since isn't there yet: when
// pi has no model of that name through kndl, the switch asks the Hub again, registers what it
// lists, and tries once more. When it still can't, it says why (`ModelSwitchFailed`), and the Hub
// keeps the Session on the model it ran on.
//
// pi has built-in models for every Provider, which call the Provider directly with whatever key
// pi finds, such as a Variable's. A Session runs only on those kndl gave pi: the Gateway's, and
// the Claude bridge's.

import { parseProviderModelName } from "@kndl/protocol"
import type { ModelProvider, ModProviders } from "@kndl/protocol"
import { ClaudeApi } from "./claude/Names.ts"
import { defaultModel } from "./Providers.ts"

/**
 * Whether pi runs `model` through kndl: at the Gateway, on the Hub's relay at `hubUrl`, or through
 * the Claude bridge.
 */
export const throughKndl = (
  model: { readonly baseUrl?: string; readonly api?: string },
  hubUrl: string,
): boolean =>
  model.api === ClaudeApi ||
  (model.baseUrl ?? "").startsWith(`${hubUrl.replace(/\/+$/, "")}/gateway/models/`)

export interface ModelSwitchOptions<Model> {
  /** The Creator's Models, as the Hub listed them last. */
  readonly providers: () => ModProviders
  /** The model pi has of that Provider and id through kndl ({@link throughKndl}), if any. */
  readonly find: (provider: ModelProvider, id: string) => Model | undefined
  /**
   * Asks the Hub for the Creator's Models again, and gives pi those it lists; false when the Hub
   * doesn't answer.
   */
  readonly refresh: () => Promise<boolean>
  /** pi's `setModel`: false when pi has no credential for it. */
  readonly setModel: (model: Model) => Promise<boolean>
}

export type ModelSwitch<Model> =
  | { readonly _tag: "Switched"; readonly model: Model }
  /** `message` says why, as the Session's history goes on: "Couldn't switch to X: …". */
  | { readonly _tag: "Failed"; readonly message: string }

/**
 * Switches pi to the model `asked`, `<provider>/<id>`, or to the first of the Creator's that pi
 * has when it names none, asking the Hub again for the Creator's Models when pi doesn't have it.
 */
export const switchModel = async <Model>(
  asked: string | undefined,
  options: ModelSwitchOptions<Model>,
): Promise<ModelSwitch<Model>> => {
  const resolve = (): { readonly model: Model } | { readonly why: string } => {
    const providers = options.providers()
    if (asked === undefined) {
      const target = defaultModel(
        providers,
        (provider, id) => options.find(provider, id) !== undefined,
      )
      const model = target === undefined ? undefined : options.find(target.provider, target.id)
      return model === undefined ? { why: "pi has none of the Creator's Models" } : { model }
    }
    const target = parseProviderModelName(asked)
    if (target === undefined) return { why: "it isn't a model pi names" }
    const listed = providers.models.some(
      (model) => model.provider === target.provider && model.id === target.id,
    )
    if (!listed)
      return {
        why: "it isn't one of the Creator's Models: its Provider isn't connected, or doesn't offer it",
      }
    const model = options.find(target.provider, target.id)
    return model === undefined ? { why: "pi doesn't know that model" } : { model }
  }

  let found = resolve()
  if ("why" in found) {
    if (!(await options.refresh()))
      return { _tag: "Failed", message: "the Hub didn't say which Models the Creator has" }
    found = resolve()
    if ("why" in found) return { _tag: "Failed", message: found.why }
  }
  try {
    if (!(await options.setModel(found.model)))
      return { _tag: "Failed", message: "pi has no credential for it" }
  } catch (error) {
    return {
      _tag: "Failed",
      message: `pi refused it: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return { _tag: "Switched", model: found.model }
}
