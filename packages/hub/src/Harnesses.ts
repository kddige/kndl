// What runs a Session's agent. In the Pi Durable spike (docs/design/durable-harness.md) every
// Session runs the durable agent, the `Pi` Harness, on its Creator's Models: Claude Code (ADR 0029,
// 0030) runs none. The Session relay asks it:
//
// - What it is called, in what a Session says of its start and exit: "the agent".
// - Its model and thinking level (#128), checked against its Creator's Models, as ModelCatalog has
//   them, named `<provider>/<id>`, the default Model (`defaultProviderModel`) when none is asked
//   for, since a Session always names its model. Claude Code's names for its models, which have no
//   Provider, are refused, saying so.
// - What it runs on, and why it can't: its Creator's Models, of a Connected provider or Claude's
//   (ADR 0029). Whether its Creator is still a Member is the relay's.
// - Whether a Runner runs it: one whose hello since the Hub started said it runs pi.

import {
  defaultProviderModel,
  findProviderModel,
  type Harness,
  modelNotFoundText,
  type ModelName,
  type Participant,
  type ParticipantId,
  type ProviderModel,
  providerModelName,
  type RunnerId,
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

/** The Harness every Session runs, as the Session relay asks it. */
export interface SessionHarness {
  readonly harness: Harness
  /** What it is called in what a Session says of it, mid-sentence: "the agent". */
  readonly name: string
  /** StartSession's and RelaunchSession's `harness`, and a stored Session's. */
  readonly flag: { readonly harness: "Pi" }
  /**
   * A model and thinking level as asked for, for a Session of the Creator: the setting it runs
   * with and the model's label, or why it is refused.
   */
  readonly check: (
    asked: ModelSetting,
    on: { readonly creatorId: ParticipantId },
  ) => Effect.Effect<CheckedModel | string, SqlError>
  /**
   * Why a Session can't run for `creator` now, as they have no Models, or undefined while it can.
   * `you` is who is told, when it is the Creator.
   */
  readonly whyNotRunnable: (
    creator: Participant,
    you?: Participant,
  ) => Effect.Effect<NotRunnable | undefined>
}

/** What the Harness asks of the Hub. */
export interface HarnessDependencies {
  /**
   * A Runner the Hub knows: its name, and the Harnesses it runs, as its last hello since the Hub
   * started said; null before then.
   */
  readonly runner: (id: RunnerId) => Effect.Effect<
    | {
        readonly name: string
        readonly harnesses: ReadonlyArray<Harness> | null
      }
    | undefined,
    SqlError
  >
  /** The Models a Member's Sessions can run now (ModelCatalog). */
  readonly modelsFor: (creator: ParticipantId) => Effect.Effect<ReadonlyArray<ProviderModel>>
}

export interface Harnesses {
  /** The durable agent, which every Session runs. */
  readonly agent: SessionHarness
  /**
   * Why no Session can start or wake on the Runner, or undefined when they can: it runs the
   * durable agent once its hello since the Hub started said it runs pi.
   */
  readonly runnerRefusal: (runnerId: RunnerId) => Effect.Effect<string | undefined, SqlError>
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

export const makeHarnesses = (hub: HarnessDependencies): Harnesses => {
  const agent: SessionHarness = {
    harness: "Pi",
    name: "the agent",
    flag: { harness: "Pi" },
    // Against the Creator's Models; the default Model when none is asked for.
    check: Effect.fn("Harnesses.agent.check")(function* (asked, on) {
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
      }
    }),
    // On the Creator's Models, of a Connected provider or Claude's (ADR 0029).
    whyNotRunnable: Effect.fn("Harnesses.agent.whyNotRunnable")(function* (creator, you) {
      if ((yield* hub.modelsFor(creator.id)).length > 0) return undefined
      return {
        refusal:
          you?.id === creator.id
            ? noModelsText
            : `${creator.login}, who started this Session, has no Models to run it on: they can connect a Provider on the Account page.`,
        sleep: `Put to sleep: it runs on the Models of ${creator.login}, who started it, and they have none`,
      }
    }),
  }

  return {
    agent,
    runnerRefusal: Effect.fn("Harnesses.runnerRefusal")(function* (runnerId) {
      const known = yield* hub.runner(runnerId)
      const name = known?.name ?? "The Runner"
      const runs = known?.harnesses ?? null
      if (runs !== null && runs.includes("Pi")) return undefined
      if (runs === null) {
        return `${name} hasn't connected since the Hub started, so it isn't known to run the durable agent.`
      }
      return `${name} runs a version from before the durable agent: update it on the Runners page.`
    }),
  }
}
