// The durable agent as every Session's Harness (docs/design/durable-harness.md), through the
// module's interface, on a Hub stood in for by plain data: its Runners and its Members' Models.

import { describe, expect, test } from "bun:test"
import { type Participant, ParticipantId, type ProviderModel, RunnerId } from "@kndl/protocol"
import { Effect } from "effect"
import { claudeCodeModelText, makeHarnesses, noModelsText } from "./Harnesses.ts"
import type { ModelSetting } from "./Sessions.ts"

const alice: Participant = { id: ParticipantId.make("p-alice"), login: "alice", name: "Alice" }
const bob: Participant = { id: ParticipantId.make("p-bob"), login: "bob", name: "Bob" }
const mac = RunnerId.make("r-mac")
const old = RunnerId.make("r-old")
const away = RunnerId.make("r-away")

const gpt: ProviderModel = {
  provider: "openai",
  id: "gpt-6-sol",
  label: "GPT-6-Sol",
  thinkingLevels: ["low", "high"],
}
const grok: ProviderModel = { provider: "xai", id: "grok-5", label: "Grok 5", thinkingLevels: [] }
const claude: ProviderModel = {
  provider: "anthropic",
  id: "claude-opus-5-5",
  label: "Claude Opus 5.5",
  thinkingLevels: ["low", "max"],
}

/**
 * A Hub where mac said it runs pi, old said it runs Claude Code alone, away hasn't said hello
 * since the Hub started, and alice has `models`.
 */
const hub = (models: ReadonlyArray<ProviderModel>) =>
  makeHarnesses({
    runner: (id) =>
      Effect.succeed(
        id === mac
          ? { name: "mac", harnesses: ["ClaudeCode", "Pi"] as const }
          : id === old
            ? { name: "old", harnesses: ["ClaudeCode"] as const }
            : id === away
              ? { name: "away", harnesses: null }
              : undefined,
      ),
    modelsFor: (creator) => Effect.succeed(creator === alice.id ? models : []),
  })

const check = (harnesses: ReturnType<typeof makeHarnesses>, asked: ModelSetting) =>
  Effect.runPromise(harnesses.agent.check(asked, { creatorId: alice.id }))

describe("the durable agent", () => {
  test("is every Session's Harness, said as Pi", () => {
    expect(hub([]).agent).toMatchObject({
      harness: "Pi",
      name: "the agent",
      flag: { harness: "Pi" },
    })
  })

  test("runs on a Runner that said it runs pi; any other is told to update", async () => {
    const harnesses = hub([])
    const refusal = (runnerId: RunnerId) => Effect.runPromise(harnesses.runnerRefusal(runnerId))
    expect(await refusal(mac)).toBeUndefined()
    expect(await refusal(old)).toBe(
      "old runs a version from before the durable agent: update it on the Runners page.",
    )
    // One not heard from since the Hub started isn't told to update.
    expect(await refusal(away)).toBe(
      "away hasn't connected since the Hub started, so it isn't known to run the durable agent.",
    )
  })
})

describe("its model, against its Creator's Models (ADR 0029)", () => {
  test("always names one: the default, Claude's first, else the first", async () => {
    expect(await check(hub([gpt, claude]), {})).toEqual({
      setting: { model: "anthropic/claude-opus-5-5" },
      label: "Claude Opus 5.5",
    })
    expect(await check(hub([grok, gpt]), {})).toEqual({
      setting: { model: "xai/grok-5" },
      label: "Grok 5",
    })
    expect(await check(hub([gpt]), { model: "openai/gpt-6-sol", thinkingLevel: "low" })).toEqual({
      setting: { model: "openai/gpt-6-sol", thinkingLevel: "low" },
      label: "GPT-6-Sol",
    })
  })

  test("refuses a Model or level the Creator doesn't have, and anything without Models", async () => {
    const harnesses = hub([gpt, grok])
    expect(await check(harnesses, { model: "anthropic/claude-opus-5-5" })).toBe(
      "Model 'anthropic/claude-opus-5-5' not found",
    )
    expect(await check(harnesses, { model: "xai/grok-5", thinkingLevel: "low" })).toBe(
      "Grok 5 takes no thinking level.",
    )
    expect(await check(harnesses, { model: "openai/gpt-6-sol", thinkingLevel: "max" })).toBe(
      "GPT-6-Sol has no thinking level 'max'.",
    )
    expect(await check(hub([]), {})).toBe(noModelsText)
  })

  test("refuses Claude Code's names for its models, saying no Session runs on it", async () => {
    for (const model of ["sonnet", "opus", "default", "claude-haiku-4-5"]) {
      expect(await check(hub([claude]), { model })).toBe(claudeCodeModelText(model))
    }
    expect(claudeCodeModelText("sonnet")).toBe(
      "'sonnet' is Claude Code's name for a model, and Sessions no longer run on Claude Code: pick one of your Models, named <provider>/<id>, such as anthropic/claude-opus-5-5.",
    )
  })
})

/** Why a Session can't run for `creator`, on a Hub where alice has Models. */
const whyNot = (creator: Participant, you?: Participant) =>
  Effect.runPromise(hub([gpt]).agent.whyNotRunnable(creator, you))

describe("what a Session runs on", () => {
  test("its Creator's Models, Claude credential or not (ADR 0029)", async () => {
    expect(await whyNot(alice)).toBeUndefined()
    expect(await whyNot(bob, bob)).toEqual({
      refusal: noModelsText,
      sleep: "Put to sleep: it runs on the Models of bob, who started it, and they have none",
    })
    expect((await whyNot(bob))?.refusal).toBe(
      "bob, who started this Session, has no Models to run it on: they can connect a Provider on the Account page.",
    )
  })
})
