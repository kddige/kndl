// Claude Code and pi as a Session's Harness (ADR 0029), through the module's interface, on a Hub
// stood in for by plain data: its Runners' models, its Members' Models and Claude credentials.

import { describe, expect, test } from "bun:test"
import {
  type Participant,
  ParticipantId,
  type ProviderModel,
  RunnerId,
  type RunnerModels,
} from "@kndl/protocol"
import { Effect } from "effect"
import { makeHarnesses, noModelsText } from "./Harnesses.ts"
import type { ModelSetting } from "./Sessions.ts"

const alice: Participant = { id: ParticipantId.make("p-alice"), login: "alice", name: "Alice" }
const bob: Participant = { id: ParticipantId.make("p-bob"), login: "bob", name: "Bob" }
const mac = RunnerId.make("r-mac")
const old = RunnerId.make("r-old")

const opus = { alias: "opus", id: "claude-opus-5-5", label: "Opus 5.5", reasoning: true }
const runnerModels: RunnerModels = {
  default: { ...opus, alias: "default" },
  models: [opus, { alias: "haiku", id: "claude-haiku-4-5", label: "Haiku 4.5", reasoning: false }],
  thinkingLevels: ["low", "high"],
}

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

/** A Hub where mac said its models and old didn't, alice has `models`, and bob a Claude credential. */
const hub = (models: ReadonlyArray<ProviderModel>) =>
  makeHarnesses({
    runner: (id) =>
      Effect.succeed(
        id === mac
          ? { name: "mac", models: runnerModels }
          : id === old
            ? { name: "old", models: null }
            : undefined,
      ),
    modelsFor: (creator) => Effect.succeed(creator === alice.id ? models : []),
    hasClaudeCredential: (creator) => creator === bob.id,
  })

const check = (
  harnesses: ReturnType<typeof makeHarnesses>,
  harness: "ClaudeCode" | "Pi",
  asked: ModelSetting,
  runnerId = mac,
) => Effect.runPromise(harnesses.of({ harness }).check(asked, { runnerId, creatorId: alice.id }))

describe("which Harness", () => {
  test("a Session is Claude Code unless it says pi, and only pi is said", () => {
    const harnesses = hub([])
    expect(harnesses.of({})).toMatchObject({ harness: "ClaudeCode", name: "Claude Code", flag: {} })
    expect(harnesses.of({ harness: "ClaudeCode" }).flag).toEqual({})
    expect(harnesses.of({ harness: "Pi" })).toMatchObject({
      harness: "Pi",
      name: "pi",
      flag: { harness: "Pi" },
    })
  })

  test("a new Session is pi where its Runner runs it, unless Claude Code is asked for", () => {
    const harnesses = hub([])
    const piRunner = { name: "mac", runsPi: true }
    const before = { name: "old", runsPi: false }
    expect(harnesses.forNew(undefined, piRunner)).toBe(harnesses.of({ harness: "Pi" }))
    expect(harnesses.forNew("ClaudeCode", piRunner)).toBe(harnesses.of({}))
    expect(harnesses.forNew("Pi", piRunner)).toBe(harnesses.of({ harness: "Pi" }))
    expect(harnesses.forNew(undefined, before)).toBe(harnesses.of({}))
    expect(harnesses.forNew("Pi", before)).toBe(
      "old doesn't run pi: update it, or start a Claude Code Session there.",
    )
  })
})

describe("Claude Code's model, against its Runner's (#128)", () => {
  test("takes the default, an alias or an id, with a level its Claude Code has", async () => {
    const harnesses = hub([])
    expect(await check(harnesses, "ClaudeCode", {})).toEqual({ setting: {}, label: "Opus 5.5" })
    expect(await check(harnesses, "ClaudeCode", { model: "default" })).toEqual({
      setting: {},
      label: "Opus 5.5",
    })
    expect(await check(harnesses, "ClaudeCode", { model: "opus", thinkingLevel: "high" })).toEqual({
      setting: { model: "opus", thinkingLevel: "high" },
      label: "Opus 5.5",
    })
    expect(await check(harnesses, "ClaudeCode", { model: "claude-haiku-4-5" })).toEqual({
      setting: { model: "claude-haiku-4-5" },
      label: "Haiku 4.5",
    })
  })

  test("refuses what it doesn't have, in Claude Code's words", async () => {
    const harnesses = hub([gpt])
    expect(await check(harnesses, "ClaudeCode", { model: "openai/gpt-6-sol" })).toBe(
      "Model 'openai/gpt-6-sol' not found",
    )
    expect(await check(harnesses, "ClaudeCode", { model: "haiku", thinkingLevel: "low" })).toBe(
      "Haiku 4.5 takes no thinking level.",
    )
    expect(await check(harnesses, "ClaudeCode", { thinkingLevel: "max" })).toBe(
      "Claude Code on mac has no thinking level 'max'.",
    )
  })

  test("takes only the default from a Runner that hasn't said its models", async () => {
    const harnesses = hub([])
    expect(await check(harnesses, "ClaudeCode", {}, old)).toEqual({
      setting: {},
      label: undefined,
    })
    expect(await check(harnesses, "ClaudeCode", { model: "opus" }, old)).toBe(
      "old hasn't said which models its Claude Code has: only Claude Code's default model can be used there.",
    )
  })
})

describe("pi's model, against its Creator's Models (ADR 0029)", () => {
  test("always names one: the default, Claude's first, else the first", async () => {
    expect(await check(hub([gpt, claude]), "Pi", {})).toEqual({
      setting: { model: "anthropic/claude-opus-5-5" },
      label: "Claude Opus 5.5",
    })
    expect(await check(hub([grok, gpt]), "Pi", {})).toEqual({
      setting: { model: "xai/grok-5" },
      label: "Grok 5",
    })
    expect(
      await check(hub([gpt]), "Pi", { model: "openai/gpt-6-sol", thinkingLevel: "low" }),
    ).toEqual({ setting: { model: "openai/gpt-6-sol", thinkingLevel: "low" }, label: "GPT-6-Sol" })
  })

  test("refuses a Model or level the Creator doesn't have, and anything without Models", async () => {
    const harnesses = hub([gpt, grok])
    expect(await check(harnesses, "Pi", { model: "opus" })).toBe("Model 'opus' not found")
    expect(await check(harnesses, "Pi", { model: "xai/grok-5", thinkingLevel: "low" })).toBe(
      "Grok 5 takes no thinking level.",
    )
    expect(await check(harnesses, "Pi", { model: "openai/gpt-6-sol", thinkingLevel: "max" })).toBe(
      "GPT-6-Sol has no thinking level 'max'.",
    )
    expect(await check(hub([]), "Pi", {})).toBe(noModelsText)
  })
})

/** Why a Session on `harness` can't run for `creator`, on a Hub where alice has Models. */
const whyNot = (harness: "ClaudeCode" | "Pi", creator: Participant, you?: Participant) =>
  Effect.runPromise(hub([gpt]).of({ harness }).whyNotRunnable(creator, you))

describe("what a Session runs on", () => {
  test("Claude Code runs on its Creator's Claude credential (ADR 0026)", async () => {
    expect(await whyNot("ClaudeCode", bob)).toBeUndefined()
    expect(await whyNot("ClaudeCode", alice, alice)).toEqual({
      refusal: "You have no Claude credential: add your setup token on the Account page.",
      sleep:
        "Put to sleep: it runs on the Claude credential of alice, who started it, and they have none",
    })
    expect((await whyNot("ClaudeCode", alice, bob))?.refusal).toBe(
      "alice, who started this Session, has no Claude credential: they can add theirs on the Account page.",
    )
  })

  test("pi runs on its Creator's Models, Claude credential or not (ADR 0029)", async () => {
    expect(await whyNot("Pi", alice)).toBeUndefined()
    expect(await whyNot("Pi", bob, bob)).toEqual({
      refusal: noModelsText,
      sleep: "Put to sleep: it runs on the Models of bob, who started it, and they have none",
    })
    expect((await whyNot("Pi", bob))?.refusal).toBe(
      "bob, who started this Session, has no Models to run it on: they can connect a Provider on the Account page.",
    )
  })
})
