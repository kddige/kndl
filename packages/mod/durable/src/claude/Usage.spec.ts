// Ported from pi-claude-bridge 0.9.3's unit-usage test (MIT, Copyright (c) 2026 Eli Dickinson):
// see THIRD_PARTY_NOTICES.md. Reasoning comes only from output_tokens_details.thinking_tokens, stays
// out of the total, and a partial frame overwrites only what it carries.

import { describe, expect, test } from "bun:test"
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai"
import { newAssistantOutput } from "./QueryState.ts"
import { testModel } from "./testing/StreamHarness.ts"
import { updateUsage } from "./Usage.ts"
import type { SdkUsage } from "./Usage.ts"

const model = testModel("claude-haiku-4-5")

// pi-ai prices by the million, so a rate of 1_000_000 makes one token cost 1.
const pricedModel: Model<Api> = {
  ...model,
  cost: { input: 1_000_000, output: 2_000_000, cacheRead: 0, cacheWrite: 0 },
}

const emptyOutput = (): AssistantMessage => newAssistantOutput(model, "", "stop")

describe("updateUsage", () => {
  test("reads the nested thinking count onto usage.reasoning", () => {
    const output = emptyOutput()
    updateUsage(
      output,
      { output_tokens: 100, output_tokens_details: { thinking_tokens: 40 } },
      model,
    )
    expect(output.usage.reasoning).toBe(40)
  })

  test("ignores a flat thinking_tokens, which no SDK version sends", () => {
    const output = emptyOutput()
    updateUsage(output, { output_tokens: 100, thinking_tokens: 40 } as SdkUsage, model)
    expect(output.usage.reasoning).toBeUndefined()
  })

  test("ignores reasoning_tokens, a field of no SDK version", () => {
    const output = emptyOutput()
    updateUsage(output, { output_tokens: 100, reasoning_tokens: 40 } as SdkUsage, model)
    expect(output.usage.reasoning).toBeUndefined()
  })

  test("leaves reasoning alone when the frame has no details", () => {
    const output = emptyOutput()
    updateUsage(output, { input_tokens: 10, output_tokens: 20 }, model)
    expect(output.usage.reasoning).toBeUndefined()
  })

  test("maps the four flat counters", () => {
    const output = emptyOutput()
    updateUsage(
      output,
      {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
      },
      model,
    )
    expect(output.usage).toMatchObject({
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      totalTokens: 100,
    })
  })

  test("keeps reasoning out of the total: it's part of the output", () => {
    const output = emptyOutput()
    updateUsage(
      output,
      { output_tokens: 100, output_tokens_details: { thinking_tokens: 40 } },
      model,
    )
    expect(output.usage.totalTokens).toBe(100)
  })

  test("reports the cache's share of the prompt", () => {
    expect(
      updateUsage(emptyOutput(), { input_tokens: 25, cache_read_input_tokens: 75 }, model),
    ).toEqual({
      cachePct: 75,
    })
  })

  test("reports no cache share with no prompt", () => {
    expect(updateUsage(emptyOutput(), { output_tokens: 10 }, model).cachePct).toBe(0)
  })

  test("overwrites only the counters the frame carries", () => {
    const output = emptyOutput()
    output.usage.input = 5
    updateUsage(output, { output_tokens: 7 }, model)
    expect(output.usage.input).toBe(5)
  })

  test("prices the counters, never the reasoning tokens on their own", () => {
    const output = emptyOutput()
    updateUsage(
      output,
      { input_tokens: 10, output_tokens: 100, output_tokens_details: { thinking_tokens: 40 } },
      pricedModel,
    )
    // 10 input at 1, 100 output at 2; adding the 40 reasoning tokens would make it 290.
    expect(output.usage.cost.total).toBe(210)
  })

  test("costs nothing at the price the bridge registers Claude's Models at", () => {
    const output = emptyOutput()
    updateUsage(output, { input_tokens: 1_000, output_tokens: 500 }, model)
    expect(output.usage.cost.total).toBe(0)
  })

  test("reports this frame's thinking count", () => {
    const report = updateUsage(
      emptyOutput(),
      { output_tokens: 100, output_tokens_details: { thinking_tokens: 40 } },
      model,
    )
    expect(report.reasoning).toBe(40)
  })

  test("reports none for a frame with none, even after one that had some", () => {
    const output = emptyOutput()
    updateUsage(
      output,
      { output_tokens: 100, output_tokens_details: { thinking_tokens: 40 } },
      model,
    )
    const report = updateUsage(output, { output_tokens: 120 }, model)
    expect(report.reasoning).toBeUndefined()
    expect(output.usage.reasoning).toBe(40)
  })
})
