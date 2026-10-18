// How the web UI names a Session's model and thinking level (#128): a Claude Code Session's from
// what its Runner said its Claude Code has, and a pi Session's from its Creator's Models, the ones
// their ProvidersState lists (ADR 0029), which only they are sent.

import {
  type ConnectableProvider,
  defaultProviderModel,
  findModel,
  findProviderModel,
  type Harness,
  type ModelName,
  type ModelOption,
  type ModelProvider,
  type ModelSwitched,
  parseProviderModelName,
  type ProviderModel,
  providerModelName,
  type RunnerModels,
  sameModel,
  takesThinkingLevel,
  type SessionLogEntry,
  type ThinkingLevel,
  ThinkingLevels,
} from "@kndl/protocol"

/** A Session's model and thinking level: absent ones are the Harness's default. */
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

/** The levels a Runner's Claude Code takes, lowest first: none before it has said. */
export function thinkingLevelsOf(models: RunnerModels | undefined): ReadonlyArray<ThinkingLevel> {
  if (models === undefined) return []
  return ThinkingLevels.filter((level) => models.thinkingLevels.includes(level))
}

/** The model a setting runs: undefined when the Runner hasn't said, or doesn't have it. */
export function modelOf(
  models: RunnerModels | undefined,
  setting: ModelSetting,
): ModelOption | undefined {
  if (models === undefined) return undefined
  return setting.model === undefined ? models.default : findModel(models, setting.model)
}

/** The model's name for a setting: the Runner's name for it, else the alias as set. */
export function modelName(models: RunnerModels | undefined, setting: ModelSetting): string {
  return modelOf(models, setting)?.label ?? setting.model ?? "Default model"
}

/**
 * What the transcript says of a change: `Alice switched to Sonnet 5.5, High`, and where a switch
 * moved the Session to the other Harness (ADR 0030), which: `Alice switched to GPT-6-Sol on pi`.
 */
export function modelSwitchedText(event: ModelSwitched): string {
  const model =
    event.model === undefined
      ? event.modelLabel === undefined
        ? "the default model"
        : `the default model (${event.modelLabel})`
      : (event.modelLabel ?? event.model)
  const harness = event.harness === undefined ? "" : ` on ${harnessNames[event.harness]}`
  const level =
    event.thinkingLevel === undefined ? "" : `, ${thinkingLevelNames[event.thinkingLevel]}`
  return `${event.by.name} switched to ${model}${harness}${level}`
}

/** What the web UI calls each Harness. */
export const harnessNames: Record<Harness, string> = {
  ClaudeCode: "Claude Code",
  Pi: "pi",
}

/**
 * What the web UI calls a Provider whose Models it groups: as the Hub names it in the Creator's
 * ProvidersState (`ConnectableProvider.name`); Anthropic, whose Models aren't connected as the
 * others' are (ADR 0029), by its own name; and one the Hub hasn't named, by its id.
 */
export function providerName(
  provider: ModelProvider,
  connectable: ReadonlyArray<ConnectableProvider> | undefined,
): string {
  if (provider === "anthropic") return "Anthropic"
  return connectable?.find((each) => each.provider === provider)?.name ?? provider
}

/**
 * The picker's heading for a Provider's models (ADR 0030): Claude's say what runs them, as either
 * Harness can (`Anthropic · Claude Code`, `Anthropic · pi`); every other Provider's run on pi alone.
 */
export function providerGroupLabel(
  provider: ModelProvider,
  harness: Harness,
  connectable?: ReadonlyArray<ConnectableProvider>,
): string {
  const name = providerName(provider, connectable)
  return provider === "anthropic" ? `${name} · ${harnessNames[harness]}` : name
}

/**
 * The name of the model a Turn ran when it isn't the one the Session is set to, as when it ran
 * before a switch: undefined when it is, or when the Session's model isn't known.
 */
export function otherTurnModel(
  models: RunnerModels | undefined,
  setting: ModelSetting,
  turnModel: string,
  /** The Creator's Models, for a Turn that ran on pi before a switch of Harness (ADR 0030). */
  providerModels?: ReadonlyArray<ProviderModel>,
): string | undefined {
  const expected = modelOf(models, setting)
  if (expected === undefined || sameModel(turnModel, expected.id)) return undefined
  const known =
    (models && [models.default, ...models.models].find((m) => sameModel(m.id, turnModel))) ??
    (providerModels && findProviderModel(providerModels, turnModel))
  return known?.label ?? turnModel
}

/**
 * Whether a Turn's model is Claude's: as Anthropic names its Models, `claude-opus-5-5`, on Claude
 * Code, or Anthropic's on pi, `anthropic/claude-opus-5-5` (TurnUsage.model).
 */
export const isClaudeModel = (turnModel: string): boolean =>
  turnModel.startsWith("claude") || parseProviderModelName(turnModel)?.provider === "anthropic"

/**
 * What every one of these Runners' Claude Code has, for a Session the Hub may start on any of
 * them: the aliases and levels they all take. Undefined when one hasn't said, so only Claude Code's
 * default is offered, as the Hub would allow there.
 */
export function sharedModels(
  each: ReadonlyArray<RunnerModels | undefined>,
): RunnerModels | undefined {
  const [first, ...rest] = each
  if (first === undefined || rest.some((models) => models === undefined)) return undefined
  const others = rest as ReadonlyArray<RunnerModels>
  const sameDefault = others.every((models) => models.default.id === first.default.id)
  return {
    // Defaults that differ have no one name: it is whichever the Runner runs.
    default: sameDefault
      ? first.default
      : {
          alias: first.default.alias,
          id: first.default.id,
          label: "Claude Code's default",
          reasoning: others.every((models) => models.default.reasoning) && first.default.reasoning,
        },
    models: first.models.filter((option) =>
      others.every((models) =>
        models.models.some(
          (other) => other.alias === option.alias && other.reasoning === option.reasoning,
        ),
      ),
    ),
    thinkingLevels: first.thinkingLevels.filter((level) =>
      others.every((models) => models.thinkingLevels.includes(level)),
    ),
  }
}

/**
 * A setting with what `models` lacks dropped, as after picking another Runner: a model it doesn't
 * have, and a level it or the model doesn't take.
 */
export function fitSetting(models: RunnerModels | undefined, setting: ModelSetting): ModelSetting {
  if (models === undefined) return {}
  const model =
    setting.model !== undefined && findModel(models, setting.model) !== undefined
      ? setting.model
      : undefined
  const option = modelOf(models, model === undefined ? {} : { model })
  const thinkingLevel =
    setting.thinkingLevel !== undefined &&
    option?.reasoning === true &&
    models.thinkingLevels.includes(setting.thinkingLevel)
      ? setting.thinkingLevel
      : undefined
  return {
    ...(model !== undefined && { model }),
    ...(thinkingLevel !== undefined && { thinkingLevel }),
  }
}

// ── pi Sessions (ADR 0029) ─────────────────────────────────────────────────

/**
 * The Model a pi Session's setting runs, among its Creator's: the Hub's pick without one, and
 * undefined before they are known, or for a Model they no longer have.
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
 * A pi Session's Model's name: its label among the Creator's Models; else the label the transcript
 * last gave it, for someone who isn't sent them; else the Provider's id for it.
 */
export function providerModelLabel(
  models: ReadonlyArray<ProviderModel> | undefined,
  setting: ModelSetting,
  knownLabel?: string,
): string {
  return (
    providerModelOf(models, setting)?.label ??
    knownLabel ??
    (setting.model === undefined
      ? "Default model"
      : (parseProviderModelName(setting.model)?.id ?? setting.model))
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
 * A pi setting the Creator's Models can run, as for a new Session: a Model they don't have is
 * their default, named, and a level the Model doesn't take is dropped. Empty without Models.
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
 * The label the transcript's latest switch to `model` gave it, which is all someone else in a pi
 * Session knows of its Creator's Model.
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
 * The name of the Model a pi Session's Turn ran, which pi reports as `<provider>/<id>`
 * (TurnUsage.model), when it isn't the one the Session is set to: undefined when it is. Its label
 * among the Creator's Models, else the Provider's id for it.
 */
export function otherProviderTurnModel(
  models: ReadonlyArray<ProviderModel> | undefined,
  setting: ModelSetting,
  turnModel: string,
): string | undefined {
  if (setting.model === undefined || setting.model === turnModel) return undefined
  return (
    (models && findProviderModel(models, turnModel))?.label ??
    parseProviderModelName(turnModel)?.id ??
    turnModel
  )
}
