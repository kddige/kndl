// What every Session's durable agent runs on (docs/design/durable-harness.md): its Creator's Models,
// on a Runner that can run it. The Session relay asks:
//
// - A model and thinking level (#128), checked against the Creator's Models, as ModelCatalog has
//   them, named `<provider>/<id>`, the default Model (`defaultProviderModel`) when none is asked
//   for, since a Session always names its model. Claude Code's names for its models, which have no
//   Provider, are refused, saying so.
// - What the Session runs on, and why it can't: its Creator's Models, of a Connected provider or
//   Claude's (ADR 0029). Whether its Creator is still a Member is the relay's.
// - Whether a Runner can run the agent: its hello since the Hub started said its bundle is ready.

import {
  defaultProviderModel,
  findProviderModel,
  modelNotFoundText,
  type ModelName,
  type Participant,
  type ParticipantId,
  type ProviderModel,
  providerModelName,
  type RunnerId,
  type ThinkingLevel,
  thinkingLevelRefusal,
} from "@kndl/protocol"
import { Effect } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import type { ModelSetting } from "./Sessions.ts"

/** A model and thinking level as checked for a Session (#128). */
export interface CheckedModel {
  /** The agent's check always names a model: the default Model when none is asked for. */
  readonly setting: ModelSetting & { readonly model: ModelName }
  /** What the model is called. */
  readonly label: string | undefined
}

/** Why a Session can't run for its Creator. */
export interface NotRunnable {
  /** Why it can't start or wake, told to whoever asked. */
  readonly refusal: string
  /** Why one that runs is put to sleep, as its history says. */
  readonly sleep: string
}

/** What the checks ask of the Hub. */
export interface AgentModelsDependencies {
  /**
   * A Runner the Hub knows: its name, and whether it can run the agent, as its last hello since the
   * Hub started said; null before then.
   */
  readonly runner: (id: RunnerId) => Effect.Effect<
    | {
        readonly name: string
        readonly runsAgent: boolean | null
      }
    | undefined,
    SqlError
  >
  /** The Models a Member's Sessions can run now (ModelCatalog). */
  readonly modelsFor: (creator: ParticipantId) => Effect.Effect<ReadonlyArray<ProviderModel>>
}

/** Why a Session can't start for its Creator, told to them (ADR 0029). */
export const noModelsText =
  "You have no Models to run a Session on: connect a Provider on the Account page."

/**
 * Why a model of Claude Code's own names, with no Provider (`sonnet`, `default`), is refused: no
 * Session runs on Claude Code now.
 */
export const claudeCodeModelText = (model: string) =>
  `'${model}' is Claude Code's name for a model, and Sessions no longer run on Claude Code: pick one of your Models, named <provider>/<id>, such as anthropic/claude-opus-5-5.`

/**
 * After the agent couldn't switch a Session's or a thread's model: the setting it goes back to, or
 * none if it stays as it is. The conversation runs on what it ran on (`failed.model`), at the
 * thinking level set, which the agent kept, but only when its setting is still the one asked for,
 * not a model set since, whose own switch follows, and only if that is one of its Creator's Models,
 * since the Sandbox says it.
 */
export const settingAfterFailedSwitch = (
  creatorModels: ReadonlyArray<ProviderModel>,
  current: {
    readonly model?: ModelName | undefined
    readonly thinkingLevel?: ThinkingLevel | undefined
  },
  failed: { readonly asked?: ModelName | undefined; readonly model: ModelName },
): (ModelSetting & { readonly model: ModelName }) | undefined => {
  if (current.model !== failed.asked) return undefined
  if (findProviderModel(creatorModels, failed.model) === undefined) return undefined
  return {
    model: failed.model,
    ...(current.thinkingLevel !== undefined && { thinkingLevel: current.thinkingLevel }),
  }
}

/**
 * What the history says of a switch the agent couldn't make, of the Session's model or, with the
 * `thread`'s title, of that thread's.
 */
export const modelSwitchFailedText = (
  failed: {
    readonly asked?: ModelName | undefined
    readonly model: ModelName
    readonly message: string
  },
  thread?: string,
): string =>
  thread === undefined
    ? `Couldn't switch to ${failed.asked ?? "the default model"}: ${failed.message}. It still runs on ${failed.model}.`
    : `Couldn't switch the Thread “${thread}” to ${failed.asked ?? "another model"}: ${failed.message}. It still runs on ${failed.model}.`

export const makeAgentModels = (hub: AgentModelsDependencies) => {
  /**
   * A model and thinking level as asked for, for a Session of the Creator: the setting it runs
   * with and the model's label, or why it is refused. Against the Creator's Models; the default
   * Model when none is asked for.
   */
  const check = Effect.fn("AgentModels.check")(function* (
    asked: ModelSetting,
    on: { readonly creatorId: ParticipantId },
  ) {
    if (asked.model !== undefined && !asked.model.includes("/")) {
      return claudeCodeModelText(asked.model)
    }
    const models = yield* hub.modelsFor(on.creatorId)
    if (models.length === 0) return noModelsText
    const model =
      asked.model === undefined
        ? defaultProviderModel(models)
        : findProviderModel(models, asked.model)
    if (model === undefined) return modelNotFoundText(asked.model ?? "")
    const level = asked.thinkingLevel
    const refused = thinkingLevelRefusal(model, level)
    if (refused !== undefined) return refused
    return {
      setting: {
        model: providerModelName(model),
        ...(level !== undefined && { thinkingLevel: level }),
      },
      label: model.label,
    } satisfies CheckedModel
  })

  /**
   * Why a Session can't run for `creator` now, as they have no Models, or undefined while it can:
   * it runs on the Creator's Models, of a Connected provider or Claude's (ADR 0029). `you` is who
   * is told, when it is the Creator.
   */
  const whyNotRunnable = Effect.fn("AgentModels.whyNotRunnable")(function* (
    creator: Participant,
    you?: Participant,
  ) {
    if ((yield* hub.modelsFor(creator.id)).length > 0) return undefined
    return {
      refusal:
        you?.id === creator.id
          ? noModelsText
          : `${creator.login}, who started this Session, has no Models to run it on: they can connect a Provider on the Account page.`,
      sleep: `Put to sleep: it runs on the Models of ${creator.login}, who started it, and they have none`,
    } satisfies NotRunnable
  })

  /**
   * Why no Session can start or wake on the Runner, or undefined when they can: its hello since
   * the Hub started said it can run the agent. A Runner whose bundle failed to prepare says so,
   * and says why in its own log.
   */
  const runnerRefusal = Effect.fn("AgentModels.runnerRefusal")(function* (runnerId: RunnerId) {
    const known = yield* hub.runner(runnerId)
    const name = known?.name ?? "The Runner"
    const runsAgent = known?.runsAgent ?? null
    if (runsAgent === true) return undefined
    if (runsAgent === null) {
      return `${name} hasn't connected since the Hub started, so it isn't known to run the durable agent.`
    }
    return `${name} can't run the durable agent: it couldn't prepare Node.js and the agent's packages. Its log says why; restart it once that is fixed.`
  })

  return { check, whyNotRunnable, runnerRefusal }
}

export type AgentModels = ReturnType<typeof makeAgentModels>
