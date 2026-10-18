// Claude's Models as the bridge registers them: the Hub's, in its order, from pi-ai's catalogue,
// at no price; and the context window Claude Code really serves each at.
//
// Ported in part from pi-claude-bridge 0.9.3's unit-models tests (MIT, Copyright (c) 2026 Eli
// Dickinson): see THIRD_PARTY_NOTICES.md. Its picker sorting, shortcut resolution and
// forceTwoHundredK aren't kndl's: the Hub orders the Models, and there's no config.

import { describe, expect, test } from "bun:test"
import { getModels } from "@earendil-works/pi-ai/compat"
import type { ProviderModel } from "@kndl/protocol"
import {
  claudeCodeModelId,
  claudeModels,
  defaultLongContext,
  resolveClaudeCodeRuntimeModel,
} from "./Models.ts"
import type { CatalogueModel, LongContextSettings } from "./Models.ts"
import { ClaudeApi } from "./Names.ts"

const Pro: LongContextSettings = { plan: "pro", longContextExtraUsage: false }
const Max: LongContextSettings = { plan: "max", longContextExtraUsage: false }
const Extra: LongContextSettings = { plan: "pro", longContextExtraUsage: true }

/** A catalogue entry, with fields pi-ai has that mustn't leak into the registration. */
const entry = (id: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    name: id,
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
    contextWindow: 200_000,
    maxTokens: 8000,
    baseUrl: "https://api.anthropic.com",
    provider: "anthropic",
    headers: { "x-api-key": "LEAK" },
    promptCache: { short: 300 },
    ...extra,
  }) as unknown as CatalogueModel

const oneM = (id: string) => entry(id, { contextWindow: 1_000_000 })

const listed = (...ids: Array<string>): Array<ProviderModel> =>
  ids.map((id) => ({ provider: "anthropic", id, label: id, thinkingLevels: [] }))

/** The registered Models, as the chat models they are. */
const chat = (models: ReadonlyArray<unknown>) =>
  models as ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly contextWindow: number
  }>

const catalogue = getModels("anthropic" as never) as unknown as Array<CatalogueModel>

describe("claudeModels", () => {
  test("registers the Hub's Claude Models, in its order, from pi-ai's own catalogue", () => {
    const { models, missing } = claudeModels(
      [
        ...listed("claude-haiku-5-5", "claude-opus-5"),
        { provider: "openai", id: "gpt-5.6-luna", label: "GPT", thinkingLevels: [] },
        ...listed("claude-sonnet-4-5"),
      ],
      catalogue,
    )
    expect(models.map((model) => model.id)).toEqual([
      "claude-haiku-5-5",
      "claude-opus-5",
      "claude-sonnet-4-5",
    ])
    expect(missing).toEqual([])
    for (const model of models) {
      expect(model.api).toBe(ClaudeApi)
      // Claude Code bills the plan, not by the token: pi reckons no price.
      expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    }
  })

  test("names the Models pi-ai's catalogue doesn't know, and leaves them out", () => {
    const { models, missing } = claudeModels(
      listed("claude-haiku-5-5", "claude-future-9"),
      catalogue,
    )
    expect(models.map((model) => model.id)).toEqual(["claude-haiku-5-5"])
    expect(missing).toEqual(["claude-future-9"])
  })

  test("takes only the fields pi registers, none of pi-ai's transport", () => {
    const [model] = claudeModels(listed("claude-sonnet-5"), [
      entry("claude-sonnet-5", { thinkingLevelMap: { xhigh: "xhigh", max: "max" } }),
    ]).models
    const fields = model as unknown as Record<string, unknown>
    expect(fields.baseUrl).toBeUndefined()
    expect(fields.provider).toBeUndefined()
    expect(fields.headers).toBeUndefined()
    // No cache warming: it would send requests through Claude Code on the plan.
    expect(fields.promptCache).toBeUndefined()
    expect(fields.thinkingLevelMap).toEqual({ xhigh: "xhigh", max: "max" })
  })

  test("leaves an absent thinkingLevelMap absent", () => {
    const [model] = claudeModels(listed("claude-haiku-4-5"), [entry("claude-haiku-4-5")]).models
    expect((model as unknown as Record<string, unknown>).thinkingLevelMap).toBeUndefined()
  })

  test("registers the context window Claude Code will serve, and says 1M in the name", () => {
    const { models } = claudeModels(
      listed("claude-opus-5", "claude-opus-4-6", "claude-sonnet-4-5", "claude-haiku-4-5"),
      catalogue,
    )
    const find = (id: string) => chat(models).find((model) => model.id === id)
    expect(find("claude-opus-5")?.contextWindow).toBe(1_000_000)
    expect(find("claude-opus-5")?.name).toBe("Claude Opus 5 1M")
    // On Pro without Extra Usage, as kndl can't tell the plan.
    expect(find("claude-opus-4-6")?.contextWindow).toBe(200_000)
    expect(find("claude-opus-4-6")?.name).toBe("Claude Opus 4.6")
    expect(find("claude-sonnet-4-5")?.contextWindow).toBe(200_000)
    expect(find("claude-haiku-4-5")?.name).toBe("Claude Haiku 4.5 (latest)")
  })

  test("gates the plan-gated Models on the plan", () => {
    const ids = listed("claude-opus-4-6", "claude-sonnet-4-6")
    const window = (settings: LongContextSettings, id: string) =>
      chat(claudeModels(ids, catalogue, settings).models).find((model) => model.id === id)
        ?.contextWindow
    expect(window(Pro, "claude-opus-4-6")).toBe(200_000)
    expect(window(Pro, "claude-sonnet-4-6")).toBe(200_000)
    expect(window(Max, "claude-opus-4-6")).toBe(1_000_000)
    expect(window(Max, "claude-sonnet-4-6")).toBe(200_000)
    expect(window(Extra, "claude-opus-4-6")).toBe(1_000_000)
    expect(window(Extra, "claude-sonnet-4-6")).toBe(1_000_000)
    expect(
      claudeModels(ids, catalogue, Extra).models.find((m) => m.id === "claude-sonnet-4-6")?.name,
    ).toBe("Claude Sonnet 4.6 1M")
  })

  test("defaults to Pro without Extra Usage", () => {
    expect(defaultLongContext).toEqual(Pro)
  })
})

describe("the context window Claude Code serves", () => {
  test("is 1M, asked for with [1m], for the measured Models on every plan", () => {
    for (const id of [
      "claude-opus-5-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-fable-5",
      "claude-fable-5-1",
      "claude-sonnet-5-5",
      "claude-sonnet-5",
      "claude-haiku-5-5",
    ]) {
      expect(resolveClaudeCodeRuntimeModel(oneM(id), Pro)).toEqual({
        cliModelId: `${id}[1m]`,
        contextWindow: 1_000_000,
      })
    }
  })

  test("is 200K, with the bare id, for one not measured, whatever pi-ai declares", () => {
    expect(resolveClaudeCodeRuntimeModel(oneM("claude-sonnet-4-5"), Pro)).toEqual({
      cliModelId: "claude-sonnet-4-5",
      contextWindow: 200_000,
    })
    expect(resolveClaudeCodeRuntimeModel(entry("claude-haiku-4-5"), Pro)).toEqual({
      cliModelId: "claude-haiku-4-5",
      contextWindow: 200_000,
    })
    expect(resolveClaudeCodeRuntimeModel(entry("claude-future-9-9"), Pro)).toEqual({
      cliModelId: "claude-future-9-9",
      contextWindow: 200_000,
    })
  })

  test("is plan-gated for Opus 4.6", () => {
    expect(resolveClaudeCodeRuntimeModel(oneM("claude-opus-4-6"), Pro)).toEqual({
      cliModelId: "claude-opus-4-6",
      contextWindow: 200_000,
    })
    expect(resolveClaudeCodeRuntimeModel(oneM("claude-opus-4-6"), Max)).toEqual({
      cliModelId: "claude-opus-4-6[1m]",
      contextWindow: 1_000_000,
    })
    expect(resolveClaudeCodeRuntimeModel(oneM("claude-opus-4-6"), Extra)).toEqual({
      cliModelId: "claude-opus-4-6[1m]",
      contextWindow: 1_000_000,
    })
  })

  test("needs Extra Usage for Sonnet 4.6's 1M", () => {
    expect(resolveClaudeCodeRuntimeModel(oneM("claude-sonnet-4-6"), Pro)).toEqual({
      cliModelId: "claude-sonnet-4-6",
      contextWindow: 200_000,
    })
    expect(resolveClaudeCodeRuntimeModel(oneM("claude-sonnet-4-6"), Extra)).toEqual({
      cliModelId: "claude-sonnet-4-6[1m]",
      contextWindow: 1_000_000,
    })
  })

  test("claudeCodeModelId is the id Claude Code is asked for", () => {
    expect(claudeCodeModelId({ id: "claude-opus-5" }, Pro)).toBe("claude-opus-5[1m]")
    expect(claudeCodeModelId({ id: "claude-haiku-4-5" }, Pro)).toBe("claude-haiku-4-5")
  })
})
