import type { EffortLevel, ModelOption, RunnerModels } from "@claude-hub/protocol"
import { EffortLevels } from "@claude-hub/protocol"
import { Clock, Context, Duration, Effect, Layer, Semaphore } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { runCommand } from "./Process.ts"
import { RunnerConfig } from "./RunnerConfig.ts"

// Which models and effort levels the Runner's Claude Code takes (#128), for its hello: the Hub
// offers its Sessions those, and refuses others.
//
// Claude Code has no command that lists its models with their names. What it does have, without
// an API call or a conversation saved, is `claude -p /model`: its init event says which model it
// runs and whether that model takes an effort level, and its answer names the model and lists
// the aliases `--model` takes. So the Runner runs it once bare, for the default and the aliases,
// then once per alias with `--model`, and `claude -p /effort` for the levels. Each run takes under
// a second, and they run a few at a time.
//
// Claude Code's own `/model` picker has a line on each model, but `-p /model` doesn't print it, so
// those lines are kept here, by alias, from that picker (Claude Code 2.1.289). An alias the table
// doesn't know is still offered, with its name and no line.

/** A line on each alias, in the order the picker lists them: most capable first. */
export const ModelDescriptions: ReadonlyArray<readonly [alias: string, description: string]> = [
  ["opus", "Best for everyday, complex tasks"],
  ["fable", "Most capable for your hardest and longest-running tasks"],
  ["sonnet", "Efficient for routine tasks"],
  ["haiku", "Fastest for quick answers"],
  ["opus[1m]", "Opus with a 1M-token context, for long sessions"],
  ["sonnet[1m]", "Sonnet with a 1M-token context, for long sessions"],
  ["fable[1m]", "Fable with a 1M-token context, for long sessions"],
  ["opusplan", "Plans with Opus, then carries the plan out with Sonnet"],
  ["best", "The most capable model there is"],
]

/** How long a Runner trusts what it found before asking Claude Code again, as it may update. */
export const ModelsTtl = Duration.hours(1)
/** How long it waits after finding nothing, before asking again. */
export const ModelsRetryAfter = Duration.minutes(5)
/** How long one `claude -p` may take. */
const ProbeTimeout = Duration.seconds(20)

/** What one `claude -p /model` said. */
export interface ModelProbe {
  /** The model it ran, `claude-opus-5-5`. */
  readonly id: string
  /** What it called it: `Opus 5.5`, without the ` (default)` it adds when no model is given. */
  readonly label: string
  /** Whether the model takes an effort level; Claude Code ignores `--effort` for one that doesn't. */
  readonly effort: boolean
  /** The aliases `--model` takes, as it listed them. */
  readonly aliases: ReadonlyArray<string>
}

/** The JSON lines of a `--output-format stream-json` run, those that parse as objects. */
function events(stdout: string): ReadonlyArray<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue
    try {
      const value: unknown = JSON.parse(line)
      if (typeof value === "object" && value !== null) out.push(value as Record<string, unknown>)
    } catch {
      // Not an event: Claude Code may print a warning among them.
    }
  }
  return out
}

function resultText(stdout: string): string | undefined {
  const result = events(stdout).find((event) => event["type"] === "result")
  return typeof result?.["result"] === "string" ? result["result"] : undefined
}

/** Reads a `claude -p /model` run's output; undefined when it isn't what Claude Code prints. */
export function parseModelProbe(stdout: string): ModelProbe | undefined {
  const init = events(stdout).find(
    (event) => event["type"] === "system" && event["subtype"] === "init",
  )
  const id = init?.["model"]
  const text = resultText(stdout)
  if (typeof id !== "string" || id === "" || text === undefined) return undefined
  const label = /Current model: `([^`]+)`/.exec(text)?.[1]?.replace(/ \(default\)$/, "")
  if (label === undefined || label === "") return undefined
  const available = /Available: (.*?)(?:, or a full model ID)?\.?$/m.exec(text)?.[1] ?? ""
  return {
    id,
    label,
    // Older builds don't say: they take an effort level for any model.
    effort: init?.["per_turn_effort_active"] !== false,
    aliases: available
      .split(",")
      .map((alias) => alias.trim())
      .filter((alias) => alias !== ""),
  }
}

/** Reads a `claude -p /effort` run's output: the levels its usage lists that the Hub knows. */
export function parseEfforts(stdout: string): ReadonlyArray<EffortLevel> {
  const usage = /\/effort <([^>]+)>/.exec(resultText(stdout) ?? "")?.[1]
  if (usage === undefined) return []
  const listed = new Set(usage.split("|").map((level) => level.trim()))
  return EffortLevels.filter((level) => listed.has(level))
}

const descriptionOf = new Map(ModelDescriptions)
const tableOrder = new Map(ModelDescriptions.map(([alias], index) => [alias, index]))

/**
 * What the Runner says its Claude Code takes, from the bare probe, each alias's, and the levels.
 * An alias that names the same model by the same name as one before it, as `best` does `fable`,
 * is left out; `default` is the bare probe's.
 */
export function runnerModels(
  bare: ModelProbe,
  probes: ReadonlyMap<string, ModelProbe>,
  efforts: ReadonlyArray<EffortLevel>,
): RunnerModels {
  const ordered = [...probes.keys()]
    .filter((alias) => alias !== "default")
    .map((alias, index) => ({ alias, index, rank: tableOrder.get(alias) ?? Infinity }))
    .toSorted((a, b) => a.rank - b.rank || a.index - b.index)
  const models: Array<ModelOption> = []
  for (const { alias } of ordered) {
    const probe = probes.get(alias)
    if (probe === undefined) continue
    const label =
      probe.id.endsWith("[1m]") && !/1M/i.test(probe.label)
        ? `${probe.label} (1M context)`
        : probe.label
    if (models.some((model) => model.id === probe.id && model.label === label)) continue
    const description = descriptionOf.get(alias)
    models.push({
      alias,
      id: probe.id,
      label,
      ...(description === undefined ? {} : { description }),
      effort: probe.effort,
    })
  }
  const same = models.find((model) => model.id === bare.id)
  return {
    default: {
      alias: "default",
      id: bare.id,
      label: bare.label,
      ...(same?.description === undefined ? {} : { description: same.description }),
      effort: bare.effort,
    },
    models,
    efforts,
  }
}

/** What the Runner's Claude Code takes, found when it is first asked and kept a while. */
export class ClaudeModels extends Context.Service<
  ClaudeModels,
  {
    /**
     * The models and effort levels, or undefined when Claude Code couldn't say: the hello then
     * leaves them out. Never fails.
     */
    readonly current: Effect.Effect<RunnerModels | undefined>
  }
>()("@claude-hub/runner/ClaudeModels") {}

/** Asks the Runner's Claude Code, `claudeBin`, from the sessions root. */
export const ClaudeModelsLive = Layer.effect(
  ClaudeModels,
  Effect.gen(function* () {
    const config = yield* RunnerConfig
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const lock = yield* Semaphore.make(1)
    let cached: { readonly value: RunnerModels | undefined; readonly until: number } | undefined

    const probe = (args: ReadonlyArray<string>) =>
      runCommand(
        config.claudeBin,
        [
          "--setting-sources",
          "",
          "--no-session-persistence",
          "--output-format",
          "stream-json",
          "--verbose",
          ...args,
        ],
        { cwd: config.sessionsRoot },
      ).pipe(
        Effect.timeoutOrElse({
          duration: ProbeTimeout,
          orElse: () => Effect.fail(new Error(`claude ${args.join(" ")} took too long`)),
        }),
        Effect.map((result) => result.stdout),
      )

    const discover = Effect.gen(function* () {
      const bare = parseModelProbe(yield* probe(["-p", "/model"]))
      if (bare === undefined) {
        return yield* Effect.fail(new Error("claude -p /model printed no model"))
      }
      const efforts = parseEfforts(yield* probe(["-p", "/effort"]))
      const found = yield* Effect.forEach(
        bare.aliases,
        (alias) =>
          probe(["--model", alias, "-p", "/model"]).pipe(
            Effect.map((stdout) => [alias, parseModelProbe(stdout)] as const),
            Effect.catchCause((cause) =>
              Effect.as(
                Effect.logWarning(`Claude Code's model ${alias} could not be looked up`, cause),
                [alias, undefined] as const,
              ),
            ),
          ),
        { concurrency: 4 },
      )
      const probes = new Map<string, ModelProbe>()
      for (const [alias, result] of found) if (result !== undefined) probes.set(alias, result)
      const models = runnerModels(bare, probes, efforts)
      yield* Effect.logInfo(
        `Claude Code takes ${models.models.map((model) => model.alias).join(", ")}; ` +
          `its default is ${models.default.label}`,
      )
      return models
    })

    const current = lock.withPermit(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        if (cached !== undefined && now < cached.until) return cached.value
        const value = yield* discover.pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.catchCause((cause) =>
            Effect.as(
              Effect.logWarning(
                "Could not find out which models Claude Code takes: its Sessions run its default model only",
                cause,
              ),
              undefined,
            ),
          ),
        )
        cached = {
          value,
          until: now + Duration.toMillis(value === undefined ? ModelsRetryAfter : ModelsTtl),
        }
        return value
      }),
    )

    return ClaudeModels.of({ current })
  }),
)

/** Says the given models, for tests. */
export const StaticClaudeModels = (models: RunnerModels | undefined) =>
  Layer.succeed(ClaudeModels, ClaudeModels.of({ current: Effect.succeed(models) }))
