import { Schema } from "effect"

// Which model a Session's agent runs, and at what thinking level (#128, ADR 0029). The Hub keeps
// each Session's setting, and starts the agent on it; a change between Turns switches it in place.
// A Session's Models are its Creator's (Provider.ts).

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

/** What Claude Code says of a model it doesn't know, as its `/model` says it. */
export const modelNotFoundText = (model: string) => `Model '${model}' not found`

/**
 * Whether two model ids name the same model: a Turn's usage, from the API, leaves out the `[1m]`
 * that Claude Code's id of an alias such as `opus[1m]` ends with.
 */
export const sameModel = (a: string, b: string) =>
  a.replace(/\[[^\]]*\]$/, "") === b.replace(/\[[^\]]*\]$/, "")
