import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { findModel, ModelName, modelNotFoundText, RunnerModels, sameModel } from "./Model.ts"
import { expectRejected, expectRoundTrips, runnerModels } from "./testSupport.ts"

describe("ModelName", () => {
  test("takes Claude Code's aliases and full model names", () => {
    for (const name of [
      "sonnet",
      "opus[1m]",
      "opusplan",
      "claude-sonnet-4-5",
      "claude-haiku-4-5-20251001",
      "us.anthropic.claude-sonnet-4-5-v1:0",
      "claude-opus-5-5@20260101",
    ]) {
      expect(Schema.decodeUnknownSync(ModelName)(name)).toBe(name)
    }
  })

  test("refuses what could be read as another flag, or as more than one argument", () => {
    for (const name of ["", "-p", "--model", "opus plan", "opus\nplan", "x".repeat(201)]) {
      expectRejected(ModelName, name)
    }
  })
})

describe("RunnerModels", () => {
  test("round-trips, and refuses an effort level Claude Code doesn't have", () => {
    expectRoundTrips(RunnerModels, [runnerModels, { ...runnerModels, models: [], efforts: [] }])
    expectRejected(RunnerModels, { ...runnerModels, efforts: ["low", "auto"] })
  })
})

describe("findModel", () => {
  const models = Schema.decodeUnknownSync(RunnerModels)(runnerModels)

  test("finds a model by alias, by id, or the default, and nothing it doesn't list", () => {
    expect(findModel(models, "sonnet")?.label).toBe("Sonnet 5.5")
    expect(findModel(models, "claude-haiku-4-5-20251001")?.alias).toBe("haiku")
    expect(findModel(models, "default")).toBe(models.default)
    expect(findModel(models, "bogus")).toBeUndefined()
    expect(modelNotFoundText("bogus")).toBe("Model 'bogus' not found")
  })
})

describe("sameModel", () => {
  test("ignores the context window Claude Code's id carries and the API's doesn't", () => {
    expect(sameModel("claude-opus-5-5[1m]", "claude-opus-5-5")).toBe(true)
    expect(sameModel("claude-opus-5-5", "claude-opus-5-5")).toBe(true)
    expect(sameModel("claude-opus-5-5", "claude-sonnet-5-5")).toBe(false)
  })
})
