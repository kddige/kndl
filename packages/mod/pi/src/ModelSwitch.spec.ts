import { describe, expect, test } from "bun:test"
import type { ModProviders } from "@kndl/protocol"
import { switchModel, throughKndl } from "./ModelSwitch.ts"

interface Model {
  readonly provider: string
  readonly id: string
}

const model = (provider: string, id: string, label = id) =>
  ({ provider, id, label, thinkingLevels: [] }) as ModProviders["models"][number]

/** pi, as the switch sees it: the Hub's list, the models pi has, and what it did. */
const fakePi = (options: {
  listed: ReadonlyArray<ModProviders["models"][number]>
  /** The Hub's list on a refresh; undefined when the Hub doesn't answer. */
  relisted?: ReadonlyArray<ModProviders["models"][number]> | undefined
  /** The models pi has, as `<provider>/<id>`; it gains the relisted ones on a refresh. */
  has: ReadonlyArray<string>
  setModel?: (model: Model) => Promise<boolean>
}) => {
  let providers: ModProviders = { models: options.listed }
  const has = new Set(options.has)
  const calls = { refreshes: 0, set: [] as Array<string> }
  return {
    calls,
    options: {
      providers: () => providers,
      find: (provider: string, id: string): Model | undefined =>
        has.has(`${provider}/${id}`) ? { provider, id } : undefined,
      refresh: async () => {
        calls.refreshes++
        if (options.relisted === undefined) return false
        providers = { models: options.relisted }
        for (const each of options.relisted) has.add(`${each.provider}/${each.id}`)
        return true
      },
      setModel: async (chosen: Model) => {
        calls.set.push(`${chosen.provider}/${chosen.id}`)
        return options.setModel === undefined ? true : options.setModel(chosen)
      },
    },
  }
}

describe("SwitchModel (ADR 0029)", () => {
  test("switches to a Model the Hub listed and pi has, asking the Hub nothing", async () => {
    const pi = fakePi({
      listed: [model("openai", "gpt-4.1"), model("xai", "grok-4.3")],
      has: ["openai/gpt-4.1", "xai/grok-4.3"],
    })
    expect(await switchModel("xai/grok-4.3", pi.options)).toEqual({
      _tag: "Switched",
      model: { provider: "xai", id: "grok-4.3" },
    })
    expect(pi.calls).toEqual({ refreshes: 0, set: ["xai/grok-4.3"] })
  })

  test("a Model of a Provider connected since pi started: asks the Hub again, and switches", async () => {
    const pi = fakePi({
      listed: [model("openai", "gpt-4.1")],
      relisted: [model("openai", "gpt-4.1"), model("xai", "grok-4.3")],
      has: ["openai/gpt-4.1"],
    })
    expect(await switchModel("xai/grok-4.3", pi.options)).toMatchObject({ _tag: "Switched" })
    expect(pi.calls).toEqual({ refreshes: 1, set: ["xai/grok-4.3"] })
  })

  test("a Model pi has built in, but the Hub doesn't list, isn't switched to: it wouldn't go through the Gateway", async () => {
    const pi = fakePi({
      listed: [model("openai", "gpt-4.1")],
      relisted: [model("openai", "gpt-4.1")],
      has: ["openai/gpt-4.1", "xai/grok-4.3"],
    })
    expect(await switchModel("xai/grok-4.3", pi.options)).toEqual({
      _tag: "Failed",
      message:
        "it isn't one of the Creator's Models: its Provider isn't connected, or doesn't offer it",
    })
    expect(pi.calls).toEqual({ refreshes: 1, set: [] })
  })

  test("says why when it still can't", async () => {
    const unanswered = fakePi({ listed: [model("openai", "gpt-4.1")], has: ["openai/gpt-4.1"] })
    expect(await switchModel("xai/grok-4.3", unanswered.options)).toEqual({
      _tag: "Failed",
      message: "the Hub didn't say which Models the Creator has",
    })
    // The Hub listed one pi's catalogue doesn't know: asking again doesn't add it.
    const unknown = fakePi({
      listed: [model("openai", "gpt-4.1"), model("openai", "gpt-from-the-future")],
      has: ["openai/gpt-4.1"],
    })
    unknown.options.refresh = async () => true
    expect(await switchModel("openai/gpt-from-the-future", unknown.options)).toEqual({
      _tag: "Failed",
      message: "pi doesn't know that model",
    })
    expect(await switchModel("nonsense", unknown.options)).toEqual({
      _tag: "Failed",
      message: "it isn't a model pi names",
    })
  })

  test("says so when pi refuses the model", async () => {
    const refused = fakePi({
      listed: [model("xai", "grok-4.3")],
      has: ["xai/grok-4.3"],
      setModel: async () => false,
    })
    expect(await switchModel("xai/grok-4.3", refused.options)).toEqual({
      _tag: "Failed",
      message: "pi has no credential for it",
    })
    const threw = fakePi({
      listed: [model("xai", "grok-4.3")],
      has: ["xai/grok-4.3"],
      setModel: async () => {
        throw new Error("the model is busy")
      },
    })
    expect(await switchModel("xai/grok-4.3", threw.options)).toEqual({
      _tag: "Failed",
      message: "pi refused it: the model is busy",
    })
  })

  test("with no model named, the first the Hub lists that pi has", async () => {
    const pi = fakePi({
      listed: [model("openai", "gpt-from-the-future"), model("xai", "grok-4.3")],
      has: ["xai/grok-4.3"],
    })
    expect(await switchModel(undefined, pi.options)).toMatchObject({
      _tag: "Switched",
      model: { provider: "xai", id: "grok-4.3" },
    })
    const none = fakePi({ listed: [], relisted: [], has: ["xai/grok-4.3"] })
    expect(await switchModel(undefined, none.options)).toEqual({
      _tag: "Failed",
      message: "pi has none of the Creator's Models",
    })
    expect(none.calls.refreshes).toBe(1)
  })
})

describe("the models kndl runs a Session on", () => {
  test("are those at the Gateway and the Claude bridge's, never a built-in provider's own", () => {
    const hubUrl = "http://relay.test:7778"
    expect(
      throughKndl({ baseUrl: "http://relay.test:7778/gateway/models/xai/v1", api: "x" }, hubUrl),
    ).toBe(true)
    expect(throughKndl({ baseUrl: "claude-code", api: "kndl-claude-code" }, hubUrl)).toBe(true)
    expect(throughKndl({ baseUrl: "https://api.x.ai/v1", api: "openai-responses" }, hubUrl)).toBe(
      false,
    )
    expect(
      throughKndl({ baseUrl: "http://relay.test:7778.evil/gateway/models/xai", api: "x" }, hubUrl),
    ).toBe(false)
  })
})
