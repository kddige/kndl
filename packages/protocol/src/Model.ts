import { Schema } from "effect"

// Which model a Session's Harness runs, and at what thinking level (#128, ADR 0029). The Hub keeps
// each Session's setting, and starts its Harness on it: Claude Code with `--model` and `--effort`,
// pi with `--model` and `--thinking`. A change between Turns restarts Claude Code, and pi switches
// in place; a model of the other Harness switches the Session to it (ADR 0030). A Runner finds out
// what its Claude Code takes when it starts and says so in its hello; a pi Session's Models are its
// Creator's (Provider.ts).

/**
 * What runs a Session's agent in its Sandbox (ADR 0029): Claude Code, on Claude Models alone, or
 * pi, on any Model of its Creator's Connected providers and Claude's.
 */
export const Harness = Schema.Literals(["ClaudeCode", "Pi"])
export type Harness = typeof Harness.Type

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
 * How hard a model thinks, as pi-ai names the levels. Claude Code takes `low` to `max` as its
 * `--effort`; absent, the Harness picks the level itself, which Claude Code's pickers call the
 * default, Medium.
 */
export const ThinkingLevel = Schema.Literals([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
])
export type ThinkingLevel = typeof ThinkingLevel.Type

/** Every thinking level, lowest first. */
export const ThinkingLevels: ReadonlyArray<ThinkingLevel> = ThinkingLevel.literals

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
  /** Whether it takes a thinking level: Claude Code ignores `--effort` for one that doesn't. */
  reasoning: Schema.Boolean,
})
export type ModelOption = typeof ModelOption.Type

/**
 * The models and thinking levels a Runner's Claude Code takes, as the Runner found when it started:
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
  /** The thinking levels it takes, lowest first. */
  thinkingLevels: Schema.Array(ThinkingLevel),
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
