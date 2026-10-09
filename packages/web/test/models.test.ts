import { describe, expect, test } from "bun:test"
import type { ModelSwitched, RunnerModels } from "@kndl/protocol"
import { fakeModels } from "../src/hub/fake/script.ts"
import {
  effortsOf,
  fitSetting,
  modelName,
  modelSwitchedText,
  otherTurnModel,
  settingLabel,
  sharedModels,
} from "../src/session/models.ts"

const alice = { id: "u-alice", login: "alice", name: "Alice Kim" } as ModelSwitched["by"]

describe("settingLabel", () => {
  test("names the model, and the effort only when one is set, as set when the Runner hasn't said", () => {
    expect(settingLabel(fakeModels, {})).toBe("Opus 5.5")
    expect(settingLabel(fakeModels, { model: "sonnet", effort: "xhigh" })).toBe(
      "Sonnet 5.5 · Extra",
    )
    // A full name or a [1m] variant finds its alias's name.
    expect(settingLabel(fakeModels, { model: "claude-sonnet-5-5" })).toBe("Sonnet 5.5")
    expect(settingLabel(fakeModels, { model: "opus[1m]" })).toBe("Opus 5.5 (1M context)")
    // Without the Runner's list, the model as set.
    expect(settingLabel(undefined, { model: "sonnet", effort: "low" })).toBe("sonnet · Low")
    expect(modelName(undefined, {})).toBe("Default model")
  })
})

test("effortsOf keeps the CLI's order and only what the Runner has", () => {
  expect(effortsOf({ ...fakeModels, efforts: ["max", "low"] })).toEqual(["low", "max"])
  expect(effortsOf(undefined)).toEqual([])
})

test("modelSwitchedText says who switched to what", () => {
  expect(
    modelSwitchedText({
      _tag: "ModelSwitched",
      by: alice,
      model: "sonnet",
      modelLabel: "Sonnet 5.5",
      effort: "high",
    }),
  ).toBe("Alice Kim switched to Sonnet 5.5, High")
  expect(modelSwitchedText({ _tag: "ModelSwitched", by: alice, modelLabel: "Opus 5.5" })).toBe(
    "Alice Kim switched to the default model (Opus 5.5)",
  )
  expect(modelSwitchedText({ _tag: "ModelSwitched", by: alice, effort: "max" })).toBe(
    "Alice Kim switched to the default model, Max",
  )
})

test("otherTurnModel names a Turn's model only when it isn't the Session's", () => {
  expect(otherTurnModel(fakeModels, {}, "claude-opus-5-5")).toBeUndefined()
  expect(otherTurnModel(fakeModels, { model: "sonnet" }, "claude-sonnet-5-5")).toBeUndefined()
  expect(otherTurnModel(fakeModels, { model: "sonnet" }, "claude-opus-5-5")).toBe("Opus 5.5")
  expect(otherTurnModel(fakeModels, {}, "claude-unknown-1")).toBe("claude-unknown-1")
  // Not knowing the Session's model, it can't say.
  expect(otherTurnModel(undefined, {}, "claude-opus-5-5")).toBeUndefined()
})

describe("sharedModels", () => {
  const fewer: RunnerModels = {
    ...fakeModels,
    models: fakeModels.models.filter((option) => option.alias !== "fable"),
    efforts: ["low", "medium", "high"],
  }

  test("offers what every Runner has", () => {
    const shared = sharedModels([fakeModels, fewer])
    expect(shared?.models.map((option) => option.alias)).not.toContain("fable")
    expect(shared?.efforts).toEqual(["low", "medium", "high"])
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
  expect(fitSetting(fakeModels, { model: "sonnet", effort: "max" })).toEqual({
    model: "sonnet",
    effort: "max",
  })
  expect(fitSetting(fakeModels, { model: "haiku", effort: "max" })).toEqual({ model: "haiku" })
  expect(fitSetting(fakeModels, { model: "gpt", effort: "low" })).toEqual({ effort: "low" })
  expect(fitSetting({ ...fakeModels, efforts: ["low"] }, { effort: "max" })).toEqual({})
  expect(fitSetting(undefined, { model: "sonnet" })).toEqual({})
})
