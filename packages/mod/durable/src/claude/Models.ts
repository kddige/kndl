// Claude's Models as the bridge's provider lists them: the ones the Hub listed for the Session's
// Creator (`provider: "anthropic"` in `/mod/providers`), in its order, from pi-ai's `anthropic`
// catalogue, at the context window Claude Code will really serve them at, and at no price.
//
// Ported from pi-claude-bridge 0.9.3 (MIT, Copyright (c) 2026 Eli Dickinson): see
// THIRD_PARTY_NOTICES.md.

import type { Api, Model, ThinkingLevelMap } from "@earendil-works/pi-ai"
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all"
import { ClaudeApi, ClaudeBaseUrl, ClaudeProvider } from "./Names.ts"

const TwoHundredK = 200_000
const OneMillion = 1_000_000

/** A model of pi-ai's `anthropic` catalogue, as {@link anthropicCatalogue} lists it. */
export interface CatalogueModel {
  readonly id: string
  readonly name: string
  readonly reasoning: boolean
  readonly input: ReadonlyArray<"text" | "image">
  readonly contextWindow: number
  readonly maxTokens: number
  readonly thinkingLevelMap?: ThinkingLevelMap
}

/**
 * What decides whether a Model gets 1M context. kndl can't tell the Creator's plan from their
 * setup token, so it takes Pro without Extra Usage, the plan the fewest Models need anything more
 * than: Opus 4.6 and Sonnet 4.6 run at 200K, every other measured Model at 1M on any plan.
 */
export interface LongContextSettings {
  readonly plan: "pro" | "max"
  readonly longContextExtraUsage: boolean
}

export const defaultLongContext: LongContextSettings = { plan: "pro", longContextExtraUsage: false }

/** pi-ai's own `anthropic` catalogue. */
export const anthropicCatalogue = (): ReadonlyArray<CatalogueModel> =>
  getBuiltinModels(ClaudeProvider)

export interface ClaudeCodeRuntimeModel {
  /** The id Claude Code is given, with `[1m]` for 1M context. */
  readonly cliModelId: string
  readonly contextWindow: number
}

// Measured Agent SDK behaviour (the reference's diag/CONTEXT-SIZE.md): `[1m]` is the only
// reliable way to ask for 1M context, bare ids serve 200K, and an unentitled `[1m]` is refused
// outright, failing every turn. So a Model serves 200K until it's measured at 1M, and the
// listed context window has to match what's asked for, or the compaction threshold is wrong.
const MeasuredOneMillion = new Set([
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
])

/** Models measured at 1M only on some plans. */
const PlanGatedOneMillion: Readonly<Record<string, (settings: LongContextSettings) => boolean>> = {
  "claude-opus-4-6": (settings) => settings.plan === "max" || settings.longContextExtraUsage,
  "claude-sonnet-4-6": (settings) => settings.longContextExtraUsage,
}

export function resolveClaudeCodeRuntimeModel(
  model: { readonly id: string },
  settings: LongContextSettings,
): ClaudeCodeRuntimeModel {
  const modelId = model.id
  if (MeasuredOneMillion.has(modelId))
    return { cliModelId: `${modelId}[1m]`, contextWindow: OneMillion }
  const planGate = PlanGatedOneMillion[modelId]
  if (planGate) {
    const oneMillion = planGate(settings)
    return {
      cliModelId: oneMillion ? `${modelId}[1m]` : modelId,
      contextWindow: oneMillion ? OneMillion : TwoHundredK,
    }
  }
  return { cliModelId: modelId, contextWindow: TwoHundredK }
}

export const claudeCodeModelId = (model: { readonly id: string }, settings: LongContextSettings) =>
  resolveClaudeCodeRuntimeModel(model, settings).cliModelId

/** A Model the Hub listed: its id, and its Provider when it says (one not `anthropic` is skipped). */
export interface ListedModel {
  readonly id: string
  readonly provider?: string | undefined
}

/**
 * The Models to list, in the Hub's order, and the ids the Hub listed that pi-ai's catalogue
 * doesn't know, which the bridge can't run. Their prices are zero: Claude Code bills the Creator's
 * plan, not by the token. None carries pi-ai's transport (its address, headers, or prompt cache,
 * whose warming would send requests through Claude Code on the plan).
 */
export function claudeModels(
  listed: ReadonlyArray<ListedModel>,
  catalogue: ReadonlyArray<CatalogueModel>,
  settings: LongContextSettings = defaultLongContext,
): { readonly models: Array<Model<Api>>; readonly missing: Array<string> } {
  const models: Array<Model<Api>> = []
  const missing: Array<string> = []
  for (const { provider, id } of listed) {
    if (provider !== undefined && provider !== ClaudeProvider) continue
    const entry = catalogue.find((model) => model.id === id)
    if (entry === undefined) {
      missing.push(id)
      continue
    }
    const { contextWindow } = resolveClaudeCodeRuntimeModel(entry, settings)
    const name =
      contextWindow > TwoHundredK && !/\b1M\b/i.test(entry.name) ? `${entry.name} 1M` : entry.name
    models.push({
      id: entry.id,
      name,
      api: ClaudeApi,
      provider: ClaudeProvider,
      baseUrl: ClaudeBaseUrl,
      reasoning: entry.reasoning,
      input: [...entry.input],
      contextWindow,
      maxTokens: entry.maxTokens,
      // pi-ai's per-model effort overrides, for effortForReasoning.
      ...(entry.thinkingLevelMap === undefined
        ? {}
        : { thinkingLevelMap: { ...entry.thinkingLevelMap } }),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })
  }
  return { models, missing }
}
