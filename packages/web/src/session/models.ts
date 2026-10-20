// How the web UI names a Session's model and thinking level (#128). Every Session runs on the
// durable agent (docs/design/durable-harness.md), on one of its Creator's Models: Claude's through
// the Claude bridge, as `anthropic/<id>`, and every other Provider's as `<provider>/<id>`. The Hub
// sends everyone who joins a Session its Creator's Models (SessionModels), so anyone can name and
// switch them; New Session and the Account page use the signed-in person's own (ProvidersState).

import {
  type ConnectableProvider,
  defaultProviderModel,
  findProviderModel,
  type ModelName,
  type ModelProvider,
  type ModelSwitched,
  parseProviderModelName,
  type ProviderModel,
  providerModelName,
  takesThinkingLevel,
  type SessionLogEntry,
  type ThinkingLevel,
  type ThreadModelChanged,
} from "@kndl/protocol"
import { createContext, useCallback } from "react"

/** A Session's or a thread's model and thinking level: an absent model is the Hub's pick. */
export interface ModelSetting {
  readonly model?: ModelName
  readonly thinkingLevel?: ThinkingLevel
}

/** What the pickers call each thinking level, as claude.ai's composer does the ones it has. */
export const thinkingLevelNames: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra",
  max: "Max",
}

/** The line some levels get under their name. */
export const thinkingLevelNotes: Partial<Record<ThinkingLevel, string>> = {
  medium: "Recommended",
  max: "4× or more usage",
}

/** What the transcript says of a change: `Alice switched to Sonnet 5.5, High`. */
export function modelSwitchedText(event: ModelSwitched): string {
  const model =
    event.model === undefined
      ? event.modelLabel === undefined
        ? "the default model"
        : `the default model (${event.modelLabel})`
      : (event.modelLabel ?? modelIdOf(event.model))
  const level =
    event.thinkingLevel === undefined ? "" : `, ${thinkingLevelNames[event.thinkingLevel]}`
  return `${event.by.name} switched to ${model}${level}`
}

/** What a thread says of a change of its model: `Bob switched this thread to GPT-6-Sol, High`. */
export function threadModelChangedText(
  event: ThreadModelChanged,
  nameModel: (model: string) => string,
): string {
  const level =
    event.thinkingLevel === undefined ? "" : `, ${thinkingLevelNames[event.thinkingLevel]}`
  return `${event.by.name} switched this Thread to ${nameModel(event.model)}${level}`
}

/**
 * What the web UI calls a Provider whose Models it groups: as the Hub names it in the signed-in
 * person's ProvidersState (`ConnectableProvider.name`); Anthropic, whose Models run through the
 * Claude bridge, by its own name; and one the Hub hasn't named, by its id.
 */
export function providerName(
  provider: ModelProvider,
  connectable: ReadonlyArray<ConnectableProvider> | undefined,
): string {
  if (provider === "anthropic") return "Anthropic"
  return connectable?.find((each) => each.provider === provider)?.name ?? provider
}

/** The Provider's id for a model name: `gpt-6-sol` for `openai/gpt-6-sol`. */
const modelIdOf = (model: string): string => parseProviderModelName(model)?.id ?? model

/**
 * A model's name: its label among the Session's Models, else the Provider's id for it, as for a
 * Model its Creator no longer has.
 */
export function modelLabel(
  models: ReadonlyArray<ProviderModel> | undefined,
  model: string,
): string {
  return (models && findProviderModel(models, model))?.label ?? modelIdOf(model)
}

/** Names a model by its `provider/id`, as the Session's Models label it. */
export type NameModel = (model: string) => string

/** How a Session's Models are named below its view, such as in a Turn's threads. */
export const ModelNamesContext = createContext<NameModel>((model) => model)

/**
 * Names who answers a Turn, for the Session's conversation and a thread's alike: the Model the
 * Turn ran, by its label, or `own`, the Model the conversation runs on now.
 */
export function useNameReplier(
  models: ReadonlyArray<ProviderModel> | undefined,
  own: string,
): (turnModel: string | undefined) => string {
  return useCallback(
    (turnModel) => (turnModel === undefined ? own : modelLabel(models, turnModel)),
    [models, own],
  )
}

/**
 * The Model a setting runs, among the Session's: the Hub's pick without one, and undefined before
 * they are known, or for a Model its Creator no longer has.
 */
export function providerModelOf(
  models: ReadonlyArray<ProviderModel> | undefined,
  setting: ModelSetting,
): ProviderModel | undefined {
  if (models === undefined) return undefined
  if (setting.model === undefined) return defaultProviderModel(models)
  return findProviderModel(models, setting.model)
}

/**
 * A setting's Model's name: its label among the Session's Models; else the label the transcript
 * last gave it, before the Models have come; else the Provider's id for it.
 */
export function providerModelLabel(
  models: ReadonlyArray<ProviderModel> | undefined,
  setting: ModelSetting,
  knownLabel?: string,
): string {
  return (
    providerModelOf(models, setting)?.label ??
    knownLabel ??
    (setting.model === undefined ? "Default model" : modelIdOf(setting.model))
  )
}

/** Models by Provider, each Provider where its first Model is, its Models in the order given. */
export function groupByProvider(
  models: ReadonlyArray<ProviderModel>,
): ReadonlyArray<{ readonly provider: ModelProvider; readonly models: Array<ProviderModel> }> {
  const groups = new Map<ModelProvider, Array<ProviderModel>>()
  for (const model of models) {
    const group = groups.get(model.provider)
    if (group) group.push(model)
    else groups.set(model.provider, [model])
  }
  return [...groups].map(([provider, each]) => ({ provider, models: each }))
}

/**
 * A setting the Creator's Models can run, as for a new Session: a Model they don't have is their
 * default, named, and a level the Model doesn't take is dropped. Empty without Models.
 */
export function fitProviderSetting(
  models: ReadonlyArray<ProviderModel> | undefined,
  setting: ModelSetting,
): ModelSetting {
  const model = providerModelOf(models, setting) ?? (models && defaultProviderModel(models))
  if (model === undefined) return {}
  const thinkingLevel = takesThinkingLevel(model, setting.thinkingLevel)
    ? setting.thinkingLevel
    : undefined
  return {
    model: providerModelName(model),
    ...(thinkingLevel !== undefined && { thinkingLevel }),
  }
}

/**
 * The label the transcript's latest switch to `model` gave it, which names the Session's Model
 * before its Models have come.
 */
export function knownModelLabel(
  log: ReadonlyArray<SessionLogEntry>,
  model: ModelName | undefined,
): string | undefined {
  if (model === undefined) return undefined
  for (let index = log.length - 1; index >= 0; index--) {
    const event = log[index]?.event
    if (event?._tag === "ModelSwitched" && event.model === model) return event.modelLabel
  }
  return undefined
}

/**
 * The name of the Model a Turn ran, reported as `<provider>/<id>` (TurnUsage.model), when it
 * isn't the one the Session is set to, as for a Turn before a switch: undefined when it is.
 */
export function otherProviderTurnModel(
  models: ReadonlyArray<ProviderModel> | undefined,
  setting: ModelSetting,
  turnModel: string,
): string | undefined {
  if (setting.model === undefined || setting.model === turnModel) return undefined
  return modelLabel(models, turnModel)
}
