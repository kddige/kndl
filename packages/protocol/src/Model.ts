import { Schema } from "effect"

// Which model a Session's Claude Code runs, and at what effort (#128). A Runner finds out what its
// Claude Code takes when it starts and says so in its hello; the Hub keeps each Session's setting,
// and starts Claude Code with `--model` and `--effort` from it, restarting it between Turns when
// the setting changes.

/** The longest model name the Hub takes, in characters. */
export const MaxModelNameLength = 200

/**
 * A model as Claude Code's `--model` takes it: an alias, such as `sonnet` or `opus[1m]`, or a
 * full model name, such as `claude-sonnet-5-5`. It goes on Claude Code's command line, so it
 * can't start with a dash or hold spaces.
 */
export const ModelName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]*$/),
  Schema.isMaxLength(MaxModelNameLength),
)
export type ModelName = typeof ModelName.Type

/**
 * Claude Code's effort levels, as its `--effort` takes them (Claude Code 2.1.289). Claude Code
 * picks the level itself when none is given; its own pickers call that the default, Medium.
 * 2.1.296's `/effort` lists `auto` and `ultracode` besides, which aren't offered.
 */
export const EffortLevel = Schema.Literals(["low", "medium", "high", "xhigh", "max"])
export type EffortLevel = typeof EffortLevel.Type

/** Every effort level, lowest first. */
export const EffortLevels: ReadonlyArray<EffortLevel> = EffortLevel.literals

/** A model a Runner's Claude Code takes, as it resolves it on that Runner. */
export const ModelOption = Schema.Struct({
  /** What `--model` is given for it: an alias, such as `sonnet`. */
  alias: ModelName,
  /** The model it runs now, as Claude Code resolves the alias: `claude-sonnet-5-5`. */
  id: Schema.NonEmptyString,
  /** What Claude Code calls it: `Sonnet 5.5`. */
  label: Schema.NonEmptyString,
  /** One line on what it is good for; absent for an alias the Runner has no words for. */
  description: Schema.optionalKey(Schema.String),
  /** Whether it takes an effort level: Claude Code ignores `--effort` for one that doesn't. */
  effort: Schema.Boolean,
})
export type ModelOption = typeof ModelOption.Type

/**
 * The models and effort levels a Runner's Claude Code takes, as the Runner found when it started:
 * the aliases its `/model` lists, each resolved, and the levels its `/effort` lists.
 */
export const RunnerModels = Schema.Struct({
  /**
   * What Claude Code runs when no model is given, the `default` alias: a Session whose model is
   * not set runs it.
   */
  default: ModelOption,
  /** The other aliases, most capable first, without ones that are another's double. */
  models: Schema.Array(ModelOption),
  /** The effort levels it takes, lowest first. */
  efforts: Schema.Array(EffortLevel),
})
export type RunnerModels = typeof RunnerModels.Type

/** What Claude Code says of a model it doesn't know, as its `/model` says it. */
export const modelNotFoundText = (model: string) => `Model '${model}' not found`

/**
 * The model of a Runner's that `model` names, by alias or by id: undefined when it has none, which
 * a Hub refuses with {@link modelNotFoundText}. The `default` alias is its default.
 */
export function findModel(models: RunnerModels, model: string): ModelOption | undefined {
  if (model === models.default.alias) return models.default
  return (
    models.models.find((option) => option.alias === model) ??
    models.models.find((option) => option.id === model)
  )
}

/**
 * Whether two model ids name the same model: a Turn's usage, from the API, leaves out the `[1m]`
 * that Claude Code's id of an alias such as `opus[1m]` ends with.
 */
export const sameModel = (a: string, b: string) =>
  a.replace(/\[[^\]]*\]$/, "") === b.replace(/\[[^\]]*\]$/, "")
