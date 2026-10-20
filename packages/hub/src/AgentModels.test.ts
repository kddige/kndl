// What every Session's durable agent runs on (docs/design/durable-harness.md), through the module's
// interface, on a Hub stood in for by plain data: its Runners and its Members' Models.

import { describe, expect, test } from "bun:test"
import { type Participant, ParticipantId, type ProviderModel, RunnerId } from "@kndl/protocol"
import { Effect } from "effect"
import { claudeCodeModelText, makeAgentModels, noModelsText } from "./AgentModels.ts"
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
 * A Hub where mac said it can run the agent, old said it can't, away hasn't said hello since the
 * Hub started, and alice has `models`.
 */
const hub = (models: ReadonlyArray<ProviderModel>) =>
  makeAgentModels({
    runner: (id) =>
      Effect.succeed(
        id === mac
          ? { name: "mac", runsAgent: true }
          : id === old
            ? { name: "old", runsAgent: false }
            : id === away
              ? { name: "away", runsAgent: null }
              : undefined,
      ),
    modelsFor: (creator) => Effect.succeed(creator === alice.id ? models : []),
  })

const check = (agentModels: ReturnType<typeof makeAgentModels>, asked: ModelSetting) =>
  Effect.runPromise(agentModels.check(asked, { creatorId: alice.id }))

describe("the Runner", () => {
  test("runs the agent when its hello said so; one whose bundle isn't ready is told why", async () => {
    const agentModels = hub([])
    const refusal = (runnerId: RunnerId) => Effect.runPromise(agentModels.runnerRefusal(runnerId))
    expect(await refusal(mac)).toBeUndefined()
    expect(await refusal(old)).toBe(
      "old can't run the durable agent: it couldn't prepare Node.js and the agent's packages. Its log says why; restart it once that is fixed.",
    )
    // One not heard from since the Hub started isn't told to fix anything.
    expect(await refusal(away)).toBe(
      "away hasn't connected since the Hub started, so it isn't known to run the durable agent.",
    )
    // One the Hub doesn't know is the same.
    expect(await refusal(RunnerId.make("r-gone"))).toBe(
      "The Runner hasn't connected since the Hub started, so it isn't known to run the durable agent.",
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
    const agentModels = hub([gpt, grok])
    expect(await check(agentModels, { model: "anthropic/claude-opus-5-5" })).toBe(
      "Model 'anthropic/claude-opus-5-5' not found",
    )
    expect(await check(agentModels, { model: "xai/grok-5", thinkingLevel: "low" })).toBe(
      "Grok 5 takes no thinking level.",
    )
    expect(await check(agentModels, { model: "openai/gpt-6-sol", thinkingLevel: "max" })).toBe(
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
  Effect.runPromise(hub([gpt]).whyNotRunnable(creator, you))

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
