import { describe, expect, test } from "bun:test"
import { type ModelSwitched, type RunnerModels, ThinkingLevels } from "@kndl/protocol"
import { fakeModels } from "../src/hub/fake/script.ts"
import {
  fitSetting,
  modelName,
  modelSwitchedText,
  isClaudeModel,
  otherProviderTurnModel,
  otherTurnModel,
  providerGroupLabel,
  sharedModels,
  thinkingLevelNames,
  thinkingLevelsOf,
} from "../src/session/models.ts"

const alice = { id: "u-alice", login: "alice", name: "Alice Kim" } as ModelSwitched["by"]

describe("modelName", () => {
  test("names the model, as set when the Runner hasn't said", () => {
    expect(modelName(fakeModels, {})).toBe("Opus 5.5")
    expect(modelName(fakeModels, { model: "sonnet", thinkingLevel: "xhigh" })).toBe("Sonnet 5.5")
    // A full name or a [1m] variant finds its alias's name.
    expect(modelName(fakeModels, { model: "claude-sonnet-5-5" })).toBe("Sonnet 5.5")
    expect(modelName(fakeModels, { model: "opus[1m]" })).toBe("Opus 5.5 (1M context)")
    // Without the Runner's list, the model as set.
    expect(modelName(undefined, { model: "sonnet", thinkingLevel: "low" })).toBe("sonnet")
    expect(modelName(undefined, {})).toBe("Default model")
  })
})

test("thinkingLevelsOf keeps pi's order and only what the Runner has", () => {
  expect(thinkingLevelsOf({ ...fakeModels, thinkingLevels: ["max", "low"] })).toEqual([
    "low",
    "max",
  ])
  expect(thinkingLevelsOf(undefined)).toEqual([])
})

test("the thinking levels are named as claude.ai's composer names them, and pi's two more", () => {
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

test("modelSwitchedText says who switched to what", () => {
  expect(
    modelSwitchedText({
      _tag: "ModelSwitched",
      by: alice,
      model: "sonnet",
      modelLabel: "Sonnet 5.5",
      thinkingLevel: "high",
    }),
  ).toBe("Alice Kim switched to Sonnet 5.5, High")
  expect(modelSwitchedText({ _tag: "ModelSwitched", by: alice, modelLabel: "Opus 5.5" })).toBe(
    "Alice Kim switched to the default model (Opus 5.5)",
  )
  expect(modelSwitchedText({ _tag: "ModelSwitched", by: alice, thinkingLevel: "max" })).toBe(
    "Alice Kim switched to the default model, Max",
  )
})

test("modelSwitchedText says which Harness a switch moved the Session to (ADR 0030)", () => {
  expect(
    modelSwitchedText({
      _tag: "ModelSwitched",
      by: alice,
      model: "anthropic/claude-opus-5-5",
      modelLabel: "Claude Opus 5.5",
      harness: "Pi",
    }),
  ).toBe("Alice Kim switched to Claude Opus 5.5 on pi")
  expect(
    modelSwitchedText({
      _tag: "ModelSwitched",
      by: alice,
      model: "opus",
      modelLabel: "Opus 5.5",
      thinkingLevel: "high",
      harness: "ClaudeCode",
    }),
  ).toBe("Alice Kim switched to Opus 5.5 on Claude Code, High")
  expect(
    modelSwitchedText({
      _tag: "ModelSwitched",
      by: alice,
      modelLabel: "Opus 5.5",
      harness: "ClaudeCode",
    }),
  ).toBe("Alice Kim switched to the default model (Opus 5.5) on Claude Code")
})

test("providerGroupLabel names Claude's groups by what runs them, and others by their Provider", () => {
  expect(providerGroupLabel("anthropic", "ClaudeCode")).toBe("Anthropic · Claude Code")
  expect(providerGroupLabel("anthropic", "Pi")).toBe("Anthropic · pi")
  expect(providerGroupLabel("openai", "Pi")).toBe("OpenAI")
})

test("otherTurnModel names a Turn's model only when it isn't the Session's", () => {
  expect(otherTurnModel(fakeModels, {}, "claude-opus-5-5")).toBeUndefined()
  expect(otherTurnModel(fakeModels, { model: "sonnet" }, "claude-sonnet-5-5")).toBeUndefined()
  expect(otherTurnModel(fakeModels, { model: "sonnet" }, "claude-opus-5-5")).toBe("Opus 5.5")
  expect(otherTurnModel(fakeModels, {}, "claude-unknown-1")).toBe("claude-unknown-1")
  // Not knowing the Session's model, it can't say.
  expect(otherTurnModel(undefined, {}, "claude-opus-5-5")).toBeUndefined()
})

// pi reports a Turn's model as a pi Session's model name, `<provider>/<id>` (TurnUsage.model).
describe("a pi Turn's model", () => {
  const gpt = {
    provider: "openai",
    id: "gpt-6-sol",
    label: "GPT-6-Sol",
    thinkingLevels: [],
  } as const
  const opus = {
    provider: "anthropic",
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    thinkingLevels: [],
  } as const
  const models = [opus, gpt]

  test("isn't named on a pi Session set to it", () => {
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

  test("is named by its label on a Session that switched to Claude Code since", () => {
    expect(otherTurnModel(fakeModels, {}, "openai/gpt-6-sol", models)).toBe("GPT-6-Sol")
  })

  test("is Claude's when its Provider is Anthropic", () => {
    expect(isClaudeModel("claude-opus-5-5")).toBe(true)
    expect(isClaudeModel("anthropic/claude-opus-5-5")).toBe(true)
    expect(isClaudeModel("openai/gpt-6-sol")).toBe(false)
    expect(isClaudeModel("openrouter/anthropic/claude-sonnet-4")).toBe(false)
  })
})

describe("sharedModels", () => {
  const fewer: RunnerModels = {
    ...fakeModels,
    models: fakeModels.models.filter((option) => option.alias !== "fable"),
    thinkingLevels: ["low", "medium", "high"],
  }

  test("offers what every Runner has", () => {
    const shared = sharedModels([fakeModels, fewer])
    expect(shared?.models.map((option) => option.alias)).not.toContain("fable")
    expect(shared?.thinkingLevels).toEqual(["low", "medium", "high"])
    expect(shared?.default.label).toBe("Opus 5.5")
  })

  test("names no one default when theirs differ", () => {
    const other = { ...fewer, default: { ...fewer.default, id: "claude-sonnet-5-5" } }
    expect(sharedModels([fakeModels, other])?.default.label).toBe("Claude Code's default")
  })

  test("offers only the default when a Runner hasn't said, or none is online", () => {
    expect(sharedModels([fakeModels, undefined])).toBeUndefined()
    expect(sharedModels([])).toBeUndefined()
  })
})

test("fitSetting drops what the Runner or the model doesn't take", () => {
  expect(fitSetting(fakeModels, { model: "sonnet", thinkingLevel: "max" })).toEqual({
    model: "sonnet",
    thinkingLevel: "max",
  })
  expect(fitSetting(fakeModels, { model: "haiku", thinkingLevel: "max" })).toEqual({
    model: "haiku",
  })
  expect(fitSetting(fakeModels, { model: "gpt", thinkingLevel: "low" })).toEqual({
    thinkingLevel: "low",
  })
  expect(fitSetting({ ...fakeModels, thinkingLevels: ["low"] }, { thinkingLevel: "max" })).toEqual(
    {},
  )
  expect(fitSetting(undefined, { model: "sonnet" })).toEqual({})
})
