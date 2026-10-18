// How the web UI names a Session's model and thinking level (#128), from what the Session's Runner
// said its Claude Code has.

import {
  findModel,
  type ModelName,
  type ModelOption,
  type ModelSwitched,
  type RunnerModels,
  sameModel,
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

/** What the transcript says of a change: `Alice switched to Sonnet 5.5, High`. */
export function modelSwitchedText(event: ModelSwitched): string {
  const model =
    event.model === undefined
      ? event.modelLabel === undefined
        ? "the default model"
        : `the default model (${event.modelLabel})`
      : (event.modelLabel ?? event.model)
  const level =
    event.thinkingLevel === undefined ? "" : `, ${thinkingLevelNames[event.thinkingLevel]}`
  return `${event.by.name} switched to ${model}${level}`
}

/**
 * The name of the model a Turn ran when it isn't the one the Session is set to, as when it ran
 * before a switch: undefined when it is, or when the Session's model isn't known.
 */
export function otherTurnModel(
  models: RunnerModels | undefined,
  setting: ModelSetting,
  turnModel: string,
): string | undefined {
  const expected = modelOf(models, setting)
  if (expected === undefined || sameModel(turnModel, expected.id)) return undefined
  const known = models && [models.default, ...models.models].find((m) => sameModel(m.id, turnModel))
  return known?.label ?? turnModel
}

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
