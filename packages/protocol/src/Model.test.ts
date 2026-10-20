import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { ModelName, modelNotFoundText, sameModel } from "./Model.ts"
import { expectRejected } from "./testSupport.ts"

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

test("modelNotFoundText says what Claude Code says of a model it doesn't know", () => {
  expect(modelNotFoundText("bogus")).toBe("Model 'bogus' not found")
})

describe("sameModel", () => {
  test("ignores the context window Claude Code's id carries and the API's doesn't", () => {
    expect(sameModel("claude-opus-5-5[1m]", "claude-opus-5-5")).toBe(true)
    expect(sameModel("claude-opus-5-5", "claude-opus-5-5")).toBe(true)
    expect(sameModel("claude-opus-5-5", "claude-sonnet-5-5")).toBe(false)
  })
})
