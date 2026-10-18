// What runs a Session's agent (ADR 0029): Claude Code or pi, for the Session's life. The Session
// relay asks a Session's Harness, or a new Session's, instead of branching on which it is:
//
// - What it is called, in what a Session says of its start and exit: "Claude Code", "pi".
// - Which Harness a new Session gets: pi where its Runner's hello says it runs pi, unless Claude
//   Code is asked for; pi asked for on a Runner that doesn't run it is refused.
// - Its model and thinking level (#128), checked: Claude Code's against what its Runner's Claude
//   Code said in its hello, in Claude Code's words; pi's against its Creator's Models, as
//   ModelCatalog has them, named `<provider>/<id>`, the default Model (`defaultProviderModel`)
//   when none is asked for, since a pi Session always names its model.
// - What it runs on, and why it can't: Claude Code on its Creator's setup token (ADR 0026), pi on
//   their Models, of a Connected provider or Claude's (ADR 0029). Whether its Creator is still a
//   Member is the relay's: it holds for every Harness.

import {
  defaultProviderModel,
  findModel,
  findProviderModel,
  type Harness,
  modelNotFoundText,
  type Participant,
  type ParticipantId,
  type ProviderModel,
  providerModelName,
  type RunnerId,
  type RunnerModels,
  thinkingLevelRefusal,
} from "@kndl/protocol"
import { Effect } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import type { ModelSetting } from "./Sessions.ts"

/** A model and thinking level as checked for a Session (#128). */
export interface CheckedModel {
  readonly setting: ModelSetting
  /** What the model is called; for Claude Code's default, the model it runs, if its Runner says. */
  readonly label: string | undefined
}

/** Why a Session on a Harness can't run for its Creator. */
export interface NotRunnable {
  /** Why it can't start or wake, told to whoever asked. */
  readonly refusal: string
  /** Why one that runs is put to sleep, as its history says. */
  readonly sleep: string
}

/** One Harness, as the Session relay asks it. */
export interface SessionHarness {
  readonly harness: Harness
  /** What it is called in what a Session says of it: "Claude Code", "pi". */
  readonly name: string
  /**
   * StartSession's and a stored Session's `harness`: said for pi alone, as a Session from before
   * pi, which runs Claude Code, says none.
   */
  readonly flag: { readonly harness?: "Pi" }
  /**
   * A model and thinking level as asked for, for a Session on the Runner for the Creator: the
   * setting it runs with and the model's label, or why it is refused.
   */
  readonly check: (
    asked: ModelSetting,
    on: { readonly runnerId: RunnerId; readonly creatorId: ParticipantId },
  ) => Effect.Effect<CheckedModel | string, SqlError>
  /**
   * Why a Session on it can't run for `creator` now, as they have nothing it runs on, or undefined
   * while it can. `you` is who is told, when it is the Creator.
   */
  readonly whyNotRunnable: (
    creator: Participant,
    you?: Participant,
  ) => Effect.Effect<NotRunnable | undefined>
}

/** What a Harness asks of the Hub. */
export interface HarnessDependencies {
  /** A Runner the Hub knows: its name, and the models its Claude Code last said it has. */
  readonly runner: (
    id: RunnerId,
  ) => Effect.Effect<
    { readonly name: string; readonly models: RunnerModels | null } | undefined,
    SqlError
  >
  /** The Models a Member's pi Sessions can run now (ModelCatalog). */
  readonly modelsFor: (creator: ParticipantId) => Effect.Effect<ReadonlyArray<ProviderModel>>
  /** Whether a Member has a Claude credential now (ClaudeCredentials). */
  readonly hasClaudeCredential: (creator: ParticipantId) => boolean
}

export interface Harnesses {
  /** The Session's Harness: Claude Code unless it says pi. */
  readonly of: (session: { readonly harness?: Harness }) => SessionHarness
  /**
   * A new Session's Harness on the Runner: the one asked for, else pi where the Runner runs it,
   * else Claude Code. Refused, saying why, for pi on a Runner that doesn't run it.
   */
  readonly forNew: (
    asked: Harness | undefined,
    runner: { readonly name: string; readonly runsPi: boolean },
  ) => SessionHarness | string
}

/** Why a pi Session can't start for its Creator, told to them (ADR 0029). */
export const noModelsText =
  "You have no Models to run a pi Session on: connect a Provider on the Account page."

export const makeHarnesses = (hub: HarnessDependencies): Harnesses => {
  const claudeCode: SessionHarness = {
    harness: "ClaudeCode",
    name: "Claude Code",
    flag: {},
    /**
     * Against what the Runner's Claude Code takes, as it last said in its hello. A model it
     * doesn't list is refused with Claude Code's own words. With no list, as from a Runner whose
     * Claude Code couldn't say, only Claude Code's default is taken.
     */
    check: Effect.fn("Harnesses.claudeCode.check")(function* (asked, on) {
      const known = yield* hub.runner(on.runnerId)
      const models = known?.models ?? null
      if (models === null) {
        if (asked.model === undefined && asked.thinkingLevel === undefined) {
          return { setting: {}, label: undefined }
        }
        return `${known?.name ?? "The Runner"} hasn't said which models its Claude Code has: only Claude Code's default model can be used there.`
      }
      const model = asked.model === undefined ? models.default : findModel(models, asked.model)
      if (model === undefined) return modelNotFoundText(asked.model ?? "")
      if (asked.thinkingLevel !== undefined) {
        if (!model.reasoning) return `${model.label} takes no thinking level.`
        if (!models.thinkingLevels.includes(asked.thinkingLevel)) {
          return `Claude Code on ${known?.name ?? "the Runner"} has no thinking level '${asked.thinkingLevel}'.`
        }
      }
      return {
        setting: {
          // The `default` alias is no setting: Claude Code's default, whatever it is then.
          ...(model !== models.default && asked.model !== undefined && { model: asked.model }),
          ...(asked.thinkingLevel !== undefined && { thinkingLevel: asked.thinkingLevel }),
        },
        label: model.label,
      }
    }),
    // On the Creator's setup token, and no other (ADR 0026).
    whyNotRunnable: (creator, you) =>
      Effect.succeed(
        hub.hasClaudeCredential(creator.id)
          ? undefined
          : {
              refusal:
                you?.id === creator.id
                  ? "You have no Claude credential: add your setup token on the Account page."
                  : `${creator.login}, who started this Session, has no Claude credential: they can add theirs on the Account page.`,
              sleep: `Put to sleep: it runs on the Claude credential of ${creator.login}, who started it, and they have none`,
            },
      ),
  }

  const pi: SessionHarness = {
    harness: "Pi",
    name: "pi",
    flag: { harness: "Pi" },
    // Against the Creator's Models; the default Model when none is asked for.
    check: Effect.fn("Harnesses.pi.check")(function* (asked, on) {
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
    whyNotRunnable: Effect.fn("Harnesses.pi.whyNotRunnable")(function* (creator, you) {
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
    of: (session) => (session.harness === "Pi" ? pi : claudeCode),
    forNew: (asked, runner) => {
      const harness = asked ?? (runner.runsPi ? "Pi" : "ClaudeCode")
      if (harness === "Pi" && !runner.runsPi) {
        return `${runner.name} doesn't run pi: update it, or start a Claude Code Session there.`
      }
      return harness === "Pi" ? pi : claudeCode
    },
  }
}
