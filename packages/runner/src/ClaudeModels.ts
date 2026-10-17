import type { ModelOption, RunnerModels, ThinkingLevel } from "@kndl/protocol"
import { ThinkingLevels } from "@kndl/protocol"
import { Config, Context, Data, Effect, Layer } from "effect"
import { PinnedClaudeVersion } from "./sandbox/SandboxClaude.ts"

// Which models and thinking levels a Session's Claude Code takes (#128), for the Runner's hello: the
// Hub offers its Sessions those, and refuses others.
//
// Sessions run the pinned build of Claude Code in their Sandboxes (ADR 0013), so what they take
// is known with the build: PinnedClaudeModels says it, and the Runner's host needs no Claude Code
// to find out. `bun run --filter @kndl/runner probe-models` writes the table from the pinned build,
// and the smoke test (SandboxClaude.integration.test.ts) checks it against the build in a real
// Sandbox, both by asking the build the same way:
//
// Claude Code has no command that lists its models with their names. What it does have, without
// an API call or a conversation saved, is `claude -p /model`: its init event says which model it
// runs and whether that model takes a thinking level, and its answer names the model and lists
// the aliases `--model` takes. So the smoke test runs it once bare, for the default and the
// aliases, then once per alias with `--model`, and `claude -p /effort` for the levels.
//
// Claude Code's own `/model` picker has a line on each model, but `-p /model` doesn't print it, so
// the table's lines are from that picker.

/**
 * What Claude Code {@link PinnedClaudeVersion} takes: its default, its aliases most capable first,
 * as its picker lists them, without ones that are another's double, and its thinking levels.
 */
export const PinnedClaudeModels: RunnerModels = {
  default: {
    alias: "default",
    id: "claude-opus-5-5",
    label: "Opus 5.5",
    description: "Best for everyday, complex tasks",
    reasoning: true,
  },
  models: [
    {
      alias: "opus",
      id: "claude-opus-5-5",
      label: "Opus 5.5",
      description: "Best for everyday, complex tasks",
      reasoning: true,
    },
    {
      alias: "fable",
      id: "claude-fable-5-1",
      label: "Fable 5.1",
      description: "Most capable for your hardest and longest-running tasks",
      reasoning: true,
    },
    {
      alias: "sonnet",
      id: "claude-sonnet-5-5",
      label: "Sonnet 5.5",
      description: "Efficient for routine tasks",
      reasoning: true,
    },
    {
      alias: "haiku",
      id: "claude-haiku-5-5",
      label: "Haiku 5.5",
      description: "Fastest for quick answers",
      reasoning: true,
    },
    {
      alias: "opus[1m]",
      id: "claude-opus-5-5[1m]",
      label: "Opus 5.5 (1M context)",
      description: "Opus with a 1M-token context, for long sessions",
      reasoning: true,
    },
    {
      alias: "sonnet[1m]",
      id: "claude-sonnet-5-5[1m]",
      label: "Sonnet 5.5 (1M context)",
      description: "Sonnet with a 1M-token context, for long sessions",
      reasoning: true,
    },
    {
      alias: "opusplan",
      id: "claude-sonnet-5-5",
      label: "Opus in plan mode, else Sonnet",
      description: "Plans with Opus, then carries the plan out with Sonnet",
      reasoning: true,
    },
  ],
  thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
}

/** The flags every probe runs Claude Code with: no settings, no conversation kept, events out. */
export const modelProbeFlags: ReadonlyArray<string> = [
  "--setting-sources",
  "",
  "--no-session-persistence",
  "--output-format",
  "stream-json",
  "--verbose",
]

/** What one `claude -p /model` said. */
export interface ModelProbe {
  /** The model it ran, `claude-opus-5-5`. */
  readonly id: string
  /** What it called it: `Opus 5.5`, without the ` (default)` it adds when no model is given. */
  readonly label: string
  /** Whether the model takes a thinking level; Claude Code ignores `--effort` for one that doesn't. */
  readonly reasoning: boolean
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
    // Older builds don't say: they take a thinking level for any model.
    reasoning: init?.["per_turn_effort_active"] !== false,
    aliases: available
      .split(",")
      .map((alias) => alias.trim())
      .filter((alias) => alias !== ""),
  }
}

/** Reads a `claude -p /effort` run's output: the levels its usage lists that the Hub knows. */
export function parseThinkingLevels(stdout: string): ReadonlyArray<ThinkingLevel> {
  const usage = /\/effort <([^>]+)>/.exec(resultText(stdout) ?? "")?.[1]
  if (usage === undefined) return []
  const listed = new Set(usage.split("|").map((level) => level.trim()))
  return ThinkingLevels.filter((level) => listed.has(level))
}

const descriptionOf = new Map(
  PinnedClaudeModels.models.map((model) => [model.alias, model.description]),
)
const tableOrder = new Map(PinnedClaudeModels.models.map((model, index) => [model.alias, index]))

/**
 * What the probes say Claude Code takes, as {@link PinnedClaudeModels} says it: the bare probe,
 * each alias's, and the levels. Ordered as the table is, with its lines; an alias the table
 * doesn't know comes last, with no line. An alias that names the same model by the same name as
 * one before it, as `best` does `fable`, is left out; `default` is the bare probe's.
 */
export function runnerModels(
  bare: ModelProbe,
  probes: ReadonlyMap<string, ModelProbe>,
  thinkingLevels: ReadonlyArray<ThinkingLevel>,
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
      reasoning: probe.reasoning,
    })
  }
  const same = models.find((model) => model.id === bare.id)
  return {
    default: {
      alias: "default",
      id: bare.id,
      label: bare.label,
      ...(same?.description === undefined ? {} : { description: same.description }),
      reasoning: bare.reasoning,
    },
    models,
    thinkingLevels,
  }
}

export class ModelProbeError extends Data.TaggedError("ModelProbeError")<{
  readonly message: string
}> {}

/**
 * What a Claude Code build takes, as {@link runnerModels} says it: `probe` runs the build with
 * {@link modelProbeFlags} and the given arguments, and gives back its output. Asks `/model` bare,
 * `/effort`, then `/model` with each alias the bare one lists, four at a time. Fails for an answer
 * it can't read, naming the alias, rather than leave the alias out.
 */
export const probeModels = <E, R>(
  probe: (args: ReadonlyArray<string>) => Effect.Effect<string, E, R>,
) =>
  Effect.gen(function* () {
    const said = (args: ReadonlyArray<string>) =>
      Effect.flatMap(probe(args), (stdout) => {
        const found = parseModelProbe(stdout)
        return found === undefined
          ? Effect.fail(new ModelProbeError({ message: `claude ${args.join(" ")} said no model` }))
          : Effect.succeed(found)
      })
    const bare = yield* said(["-p", "/model"])
    const thinkingLevels = parseThinkingLevels(yield* probe(["-p", "/effort"]))
    const probes = yield* Effect.forEach(
      bare.aliases,
      (alias) =>
        Effect.map(said(["--model", alias, "-p", "/model"]), (found) => [alias, found] as const),
      { concurrency: 4 },
    )
    return runnerModels(bare, new Map(probes), thinkingLevels)
  })

/** What a Session's Claude Code takes. */
export class ClaudeModels extends Context.Service<
  ClaudeModels,
  {
    /**
     * The models and thinking levels, or undefined when they aren't known: the hello then leaves
     * them out. Never fails.
     */
    readonly current: Effect.Effect<RunnerModels | undefined>
  }
>()("@kndl/runner/ClaudeModels") {}

/**
 * {@link PinnedClaudeModels}, while Sessions run the pinned build. Sessions on another, through
 * `RUNNER_SANDBOX_CLAUDE_VERSION`, run Claude Code's default model only, as what that build takes
 * isn't known.
 */
export const ClaudeModelsLive = Layer.effect(
  ClaudeModels,
  Effect.gen(function* () {
    const version = yield* Config.NonEmptyString("RUNNER_SANDBOX_CLAUDE_VERSION").pipe(
      Config.withDefault(PinnedClaudeVersion),
    )
    if (version === PinnedClaudeVersion) {
      return ClaudeModels.of({ current: Effect.succeed(PinnedClaudeModels) })
    }
    yield* Effect.logWarning(
      `Sessions run Claude Code ${version}, not the pinned ${PinnedClaudeVersion}: which models it takes isn't known, so they run its default model only`,
    )
    return ClaudeModels.of({ current: Effect.succeed(undefined) })
  }),
)

/** Says the given models, for tests. */
export const StaticClaudeModels = (models: RunnerModels | undefined) =>
  Layer.succeed(ClaudeModels, ClaudeModels.of({ current: Effect.succeed(models) }))
