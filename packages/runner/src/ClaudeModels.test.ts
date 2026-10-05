import { describe, expect, test } from "bun:test"
import { type ModelProbe, parseEfforts, parseModelProbe, runnerModels } from "./ClaudeModels.ts"

// What `claude --output-format stream-json --verbose -p /model` prints, trimmed to what is read,
// as Claude Code 2.1.289 prints it.
const available =
  "Usage: /model <name>. Available: sonnet, opus, haiku, fable, best, sonnet[1m], opus[1m], fable[1m], opusplan, default, or a full model ID."

const modelRun = (model: string, label: string, effort?: boolean) =>
  [
    JSON.stringify({
      type: "system",
      subtype: "init",
      model,
      ...(effort === undefined ? {} : { per_turn_effort_active: effort }),
      claude_code_version: "2.1.289",
    }),
    JSON.stringify({ type: "assistant", message: { model: "<synthetic>", content: [] } }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      result: `Current model: \`${label}\`\n${available}`,
      total_cost_usd: 0,
    }),
    "",
  ].join("\n")

const effortRun = [
  JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5-5" }),
  JSON.stringify({
    type: "result",
    subtype: "success",
    result: "Usage: /effort <low|medium|high|xhigh|max|auto>",
  }),
].join("\n")

describe("parseModelProbe", () => {
  test("reads the model, its name, whether it takes an effort level, and the aliases", () => {
    expect(parseModelProbe(modelRun("claude-opus-5-5", "Opus 5.5 (default)", true))).toEqual({
      id: "claude-opus-5-5",
      label: "Opus 5.5",
      effort: true,
      aliases: [
        "sonnet",
        "opus",
        "haiku",
        "fable",
        "best",
        "sonnet[1m]",
        "opus[1m]",
        "fable[1m]",
        "opusplan",
        "default",
      ],
    })
    expect(
      parseModelProbe(modelRun("claude-haiku-4-5-20251001", "Haiku 4.5", false)),
    ).toMatchObject({ id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", effort: false })
  })

  test("takes an effort level for any model when Claude Code doesn't say", () => {
    expect(parseModelProbe(modelRun("claude-opus-5-5", "Opus 5.5"))?.effort).toBe(true)
  })

  test("reads past lines that aren't events", () => {
    const run = `Warning: something\n${modelRun("claude-opus-5-5", "Opus 5.5", true)}`
    expect(parseModelProbe(run)?.id).toBe("claude-opus-5-5")
  })

  test("is undefined for output that isn't Claude Code's", () => {
    expect(parseModelProbe("")).toBeUndefined()
    expect(parseModelProbe("Not logged in\n")).toBeUndefined()
    expect(
      parseModelProbe(JSON.stringify({ type: "result", result: "Current model: `Opus 5.5`" })),
    ).toBeUndefined()
  })
})

describe("parseEfforts", () => {
  test("reads the levels /effort lists, without auto, which is no level", () => {
    expect(parseEfforts(effortRun)).toEqual(["low", "medium", "high", "xhigh", "max"])
  })

  test("leaves out levels the Hub doesn't know, and is empty for anything else", () => {
    const fewer = effortRun.replace("low|medium|high|xhigh|max|auto", "low|medium|high|ultra")
    expect(parseEfforts(fewer)).toEqual(["low", "medium", "high"])
    expect(parseEfforts("")).toEqual([])
  })
})

const probe = (id: string, label: string, effort = true): ModelProbe => ({
  id,
  label,
  effort,
  aliases: [],
})

describe("runnerModels", () => {
  // As Claude Code 2.1.289 resolved each alias.
  const probes = new Map([
    ["sonnet", probe("claude-sonnet-5-5", "Sonnet 5.5")],
    ["opus", probe("claude-opus-5-5", "Opus 5.5")],
    ["haiku", probe("claude-haiku-4-5-20251001", "Haiku 4.5", false)],
    ["fable", probe("claude-fable-5-1", "Fable 5.1")],
    ["best", probe("claude-fable-5-1", "Fable 5.1")],
    ["sonnet[1m]", probe("claude-sonnet-5-5[1m]", "Sonnet 5.5")],
    ["opus[1m]", probe("claude-opus-5-5[1m]", "Opus 5.5 (1M context)")],
    ["fable[1m]", probe("claude-fable-5-1", "Fable 5.1")],
    ["opusplan", probe("claude-sonnet-5-5", "Opus in plan mode, else Sonnet")],
    ["default", probe("claude-opus-5-5", "Opus 5.5")],
    ["mythos", probe("claude-mythos-1", "Mythos 1")],
  ])
  const models = runnerModels(probe("claude-opus-5-5", "Opus 5.5"), probes, ["low", "max"])

  test("lists the aliases most capable first, then ones it has no line for", () => {
    expect(models.models.map((model) => model.alias)).toEqual([
      "opus",
      "fable",
      "sonnet",
      "haiku",
      "opus[1m]",
      "sonnet[1m]",
      "opusplan",
      "mythos",
    ])
  })

  test("leaves out an alias that is another's double: best and fable[1m] are fable", () => {
    expect(models.models.filter((model) => model.id === "claude-fable-5-1")).toHaveLength(1)
  })

  test("names a 1M-context model as such when Claude Code doesn't", () => {
    const sonnet1m = models.models.find((model) => model.alias === "sonnet[1m]")
    expect(sonnet1m?.label).toBe("Sonnet 5.5 (1M context)")
    expect(models.models.find((model) => model.alias === "opus[1m]")?.label).toBe(
      "Opus 5.5 (1M context)",
    )
  })

  test("gives each its line, the default the line of the model it is, and keeps the levels", () => {
    expect(models.models[0]).toEqual({
      alias: "opus",
      id: "claude-opus-5-5",
      label: "Opus 5.5",
      description: "Best for everyday, complex tasks",
      effort: true,
    })
    expect(models.models.find((model) => model.alias === "mythos")).not.toHaveProperty(
      "description",
    )
    expect(models.models.find((model) => model.alias === "haiku")?.effort).toBe(false)
    expect(models.default).toEqual({
      alias: "default",
      id: "claude-opus-5-5",
      label: "Opus 5.5",
      description: "Best for everyday, complex tasks",
      effort: true,
    })
    expect(models.efforts).toEqual(["low", "max"])
  })
})
