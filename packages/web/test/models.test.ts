import { describe, expect, test } from "bun:test"
import { type ModelSwitched, type ThreadModelChanged, ThinkingLevels } from "@kndl/protocol"
import {
  fitProviderSetting,
  groupByProvider,
  modelLabel,
  modelSwitchedText,
  otherProviderTurnModel,
  providerModelLabel,
  providerName,
  thinkingLevelNames,
  threadModelChangedText,
} from "../src/session/models.ts"

const alice = { id: "u-alice", login: "alice", name: "Alice Kim" } as ModelSwitched["by"]

const gpt = {
  provider: "openai",
  id: "gpt-6-sol",
  label: "GPT-6-Sol",
  thinkingLevels: ["low", "high"],
} as const
const opus = {
  provider: "anthropic",
  id: "claude-opus-5-5",
  label: "Claude Opus 5.5",
  thinkingLevels: ["low", "high", "max"],
} as const
const mini = {
  provider: "openai",
  id: "gpt-6-sol-mini",
  label: "GPT-6-Sol mini",
  thinkingLevels: [],
} as const
const models = [gpt, opus, mini]

test("the thinking levels are named as claude.ai's composer names them, and two more", () => {
  expect(ThinkingLevels.map((level) => thinkingLevelNames[level])).toEqual([
    "Off",
    "Minimal",
    "Low",
    "Medium",
    "High",
    "Extra",
    "Max",
  ])
})

test("modelSwitchedText says who switched to what, and no Harness", () => {
  expect(
    modelSwitchedText({
      _tag: "ModelSwitched",
      by: alice,
      model: "anthropic/claude-sonnet-5-5",
      modelLabel: "Claude Sonnet 5.5",
      thinkingLevel: "high",
      // From before the durable agent: no longer said.
      harness: "Pi",
    }),
  ).toBe("Alice Kim switched to Claude Sonnet 5.5, High")
  expect(modelSwitchedText({ _tag: "ModelSwitched", by: alice, model: "openai/gpt-6-sol" })).toBe(
    "Alice Kim switched to gpt-6-sol",
  )
  expect(modelSwitchedText({ _tag: "ModelSwitched", by: alice, modelLabel: "Opus 5.5" })).toBe(
    "Alice Kim switched to the default model (Opus 5.5)",
  )
  expect(modelSwitchedText({ _tag: "ModelSwitched", by: alice, thinkingLevel: "max" })).toBe(
    "Alice Kim switched to the default model, Max",
  )
})

test("threadModelChangedText says who switched the thread to what", () => {
  const event = {
    _tag: "ThreadModelChanged",
    threadId: "thr-1",
    by: alice,
    model: "openai/gpt-6-sol",
    thinkingLevel: "low",
  } as unknown as ThreadModelChanged
  expect(threadModelChangedText(event, (model) => modelLabel(models, model))).toBe(
    "Alice Kim switched this thread to GPT-6-Sol, Low",
  )
})

test("providerName names Anthropic, and others as the Hub names them, or by id", () => {
  const connectable = [{ provider: "openai", name: "OpenAI", apiKey: true }] as const
  expect(providerName("anthropic", undefined)).toBe("Anthropic")
  expect(providerName("openai", connectable)).toBe("OpenAI")
  expect(providerName("xai", connectable)).toBe("xai")
})

test("groupByProvider keeps each Provider where its first Model is", () => {
  expect(groupByProvider(models).map((group) => [group.provider, group.models.length])).toEqual([
    ["openai", 2],
    ["anthropic", 1],
  ])
})

test("a setting's Model is named by its label, else as the transcript knew it, else its id", () => {
  expect(providerModelLabel(models, { model: "openai/gpt-6-sol" })).toBe("GPT-6-Sol")
  // No model is the Hub's pick: Claude's first.
  expect(providerModelLabel(models, {})).toBe("Claude Opus 5.5")
  expect(providerModelLabel(undefined, { model: "openai/gpt-6-sol" }, "GPT-6-Sol")).toBe(
    "GPT-6-Sol",
  )
  expect(providerModelLabel(undefined, { model: "openai/gpt-6-sol" })).toBe("gpt-6-sol")
  expect(providerModelLabel(undefined, {})).toBe("Default model")
})

test("fitProviderSetting names the Model, and drops a level it doesn't take", () => {
  expect(fitProviderSetting(models, {})).toEqual({ model: "anthropic/claude-opus-5-5" })
  expect(fitProviderSetting(models, { model: "openai/gpt-6-sol", thinkingLevel: "high" })).toEqual({
    model: "openai/gpt-6-sol",
    thinkingLevel: "high",
  })
  expect(
    fitProviderSetting(models, { model: "openai/gpt-6-sol-mini", thinkingLevel: "high" }),
  ).toEqual({ model: "openai/gpt-6-sol-mini" })
  // A Model the Creator no longer has is their default.
  expect(fitProviderSetting(models, { model: "xai/grok-5" })).toEqual({
    model: "anthropic/claude-opus-5-5",
  })
  expect(fitProviderSetting([], {})).toEqual({})
})

// A Turn's model is its `<provider>/<id>` (TurnUsage.model).
describe("a Turn's model", () => {
  test("isn't named on a Session set to it", () => {
    const setting = { model: "openai/gpt-6-sol" }
    expect(otherProviderTurnModel(models, setting, "openai/gpt-6-sol")).toBeUndefined()
    expect(otherProviderTurnModel(undefined, setting, "openai/gpt-6-sol")).toBeUndefined()
  })

  test("is named by its label when it isn't the Session's, or by its id without one", () => {
    const setting = { model: "openai/gpt-6-sol" }
    expect(otherProviderTurnModel(models, setting, "anthropic/claude-opus-5-5")).toBe(
      "Claude Opus 5.5",
    )
    expect(otherProviderTurnModel(undefined, setting, "anthropic/claude-opus-5-5")).toBe(
      "claude-opus-5-5",
    )
  })
})
