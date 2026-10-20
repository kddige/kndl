import { afterEach, describe, expect, test } from "bun:test"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai/models"
import type { ModProviders, ProviderModel } from "@kndl/protocol"
import { textReply, toolCallReply } from "../test/FakeHub.ts"
import { TestAgent, ada, eventually, modToken, say } from "../test/TestAgent.ts"
import { builtinProvider } from "./Builtins.ts"
import type { ClaudeBridgeOptions, ClaudeBridgeProvider } from "./claude/index.ts"
import { installClaude } from "./ClaudeModels.ts"
import { gatewayCatalog, gatewayModels, gatewayProvider } from "./Providers.ts"

let agent: TestAgent | undefined
afterEach(async () => {
  await agent?.dispose()
  agent = undefined
})

const hubUrl = "http://relay.test:7778"

describe("Gateway providers", () => {
  test("keep pi-ai's own models, at the Gateway, under the path of their own address", () => {
    const openrouter = builtinProvider("openrouter")
    if (openrouter === undefined) throw new Error("no openrouter")
    const claude = openrouter.getModels().find((model) => model.api === "anthropic-messages")
    const other = openrouter.getModels().find((model) => model.api !== "anthropic-messages")
    if (claude === undefined || other === undefined) throw new Error("no models")
    const { models, missing } = gatewayModels(openrouter, [claude.id, other.id, "no-such-model"], {
      hubUrl,
      provider: "openrouter",
      signedIn: false,
    })
    expect(missing).toEqual(["no-such-model"])
    expect(models.map((model) => model.baseUrl)).toEqual([
      `${hubUrl}/gateway/models/openrouter/api`,
      `${hubUrl}/gateway/models/openrouter/api/v1`,
    ])
    expect(models.map((model) => model.provider)).toEqual(["openrouter", "openrouter"])
  })

  test("leave out what ChatGPT's sign-in refuses, for a signed-in OpenAI", () => {
    const openai = builtinProvider("openai")
    if (openai === undefined) throw new Error("no openai")
    const { models } = gatewayModels(openai, ["gpt-4.1"], {
      hubUrl,
      provider: "openai",
      signedIn: true,
    })
    expect(models[0]?.compat).toMatchObject({
      supportsMaxOutputTokens: false,
      supportsMidConvoEffort: false,
    })
    const key = gatewayModels(openai, ["gpt-4.1"], { hubUrl, provider: "openai", signedIn: false })
    expect(key.models[0]?.compat).toEqual(
      openai.getModels().find((model) => model.id === "gpt-4.1")?.compat,
    )
  })

  test("put the Session token where the Gateway takes it", async () => {
    const openai = builtinProvider("openai")
    if (openai === undefined) throw new Error("no openai")
    const { models } = gatewayModels(openai, ["gpt-4.1"], {
      hubUrl,
      provider: "openai",
      signedIn: false,
    })
    const registry = createModels()
    registry.setProvider(gatewayProvider(openai, models, modToken))
    const model = registry.getModel("openai", "gpt-4.1")
    if (model === undefined) throw new Error("not registered")
    const auth = await registry.getAuth(model)
    expect(auth?.auth).toMatchObject({
      apiKey: modToken,
      headers: { Authorization: `Bearer ${modToken}` },
    })
  })

  test("run a Turn through the Gateway, with no credential of the Provider's in the agent", async () => {
    agent = new TestAgent({ gateway: true, model: "openai/gpt-4.1", reply: () => say("unused") })
    agent.hub.providers = {
      models: [{ provider: "openai", id: "gpt-4.1", label: "GPT-4.1", thinkingLevels: [] }],
    }
    agent.hub.scripts.push(
      toolCallReply("bash", { command: "echo through" }, { input: 10, output: 5 }),
      textReply("Through the Gateway.", { input: 20, output: 4, cached: 8 }),
    )
    await agent.start()
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Hi", sender: ada })
    const events = await agent.until((event) => event._tag === "TurnEnded")
    expect(events.at(-1)).toMatchObject({
      reason: "stop",
      usage: { model: "openai/gpt-4.1", output: 9, cacheRead: 8 },
    })
    expect(
      events
        .filter((event) => event._tag === "TextDelta")
        .map((event) => event.text)
        .join(""),
    ).toBe("Through the Gateway.")
    expect(agent.hub.gatewayRequests.map((request) => request.path)).toEqual([
      "/gateway/models/openai/v1/responses",
      "/gateway/models/openai/v1/responses",
    ])
    expect(agent.hub.gatewayRequests[0]?.authorization).toBe(`Bearer ${modToken}`)
  })
})

/** A catalogue over a Hub that answers `/mod/providers` as `answer` says, each try in turn. */
const catalogOver = (answer: (attempt: number) => ModProviders | undefined) => {
  let attempts = 0
  const waits: Array<number> = []
  const catalog = gatewayCatalog({
    hubUrl,
    modToken,
    env: {},
    cwd: "/workspace",
    log: () => {},
    // Waits end at once, so the backoff is recorded and not slept.
    wait: async (ms) => void waits.push(ms),
    fetch: async () => {
      const providers = answer(attempts++)
      return providers === undefined
        ? { status: 503, text: "" }
        : { status: 200, text: JSON.stringify(providers) }
    },
  })
  return { catalog, waits, attempts: () => attempts }
}

describe("the Gateway's catalogue", () => {
  const gpt = { provider: "openai" as const, id: "gpt-4.1", label: "GPT-4.1", thinkingLevels: [] }
  test("keeps asking the Hub in the background when it can't answer at startup", async () => {
    // The first four tries are the startup's own; the Hub is back for the fifth.
    const { catalog: made, waits } = catalogOver((attempt) =>
      attempt < 4 ? undefined : { models: [gpt] },
    )
    const catalog = await made
    const changes: Array<ReadonlyArray<string>> = []
    catalog.onChange(() => changes.push(catalog.names()))
    await eventually(() => catalog.names().length > 0 || undefined)
    expect(catalog.names()).toEqual(["openai/gpt-4.1"])
    expect(changes).toEqual([["openai/gpt-4.1"]])
    expect(await catalog.resolve(undefined)).toEqual({
      model: { provider: "openai", modelId: "gpt-4.1" },
    })
    // Three waits between the startup's four tries, then one before the background's first.
    expect(waits).toEqual([500, 1_000, 2_000, 1_000])
    await catalog.close()
  })

  test("keeps asking while the Hub lists no Models, and stops once it lists some", async () => {
    const { catalog: made, attempts } = catalogOver((attempt) =>
      attempt < 2 ? { models: [] } : { models: [gpt] },
    )
    const catalog = await made
    await eventually(() => catalog.names().length > 0 || undefined)
    expect(attempts()).toBe(3)
    await Bun.sleep(20)
    expect(attempts()).toBe(3)
    await catalog.close()
  })

  test("tells a listener when asking again finds Models", async () => {
    let listed: ModProviders = { models: [gpt] }
    const { catalog: made } = catalogOver(() => listed)
    const catalog = await made
    let changes = 0
    catalog.onChange(() => changes++)
    expect(await catalog.refresh()).toBe(true)
    expect(changes).toBe(0)
    listed = { models: [gpt, { ...gpt, id: "gpt-4.1-mini" }] }
    expect(await catalog.refresh()).toBe(true)
    expect(changes).toBe(1)
    await catalog.close()
  })
})

describe("switching the Session's model", () => {
  test("runs the next Turn on it, and says why it can't when it can't", async () => {
    agent = new TestAgent({ reply: () => say("Ok.") })
    await agent.start()
    agent.send({ _tag: "SwitchModel", model: "openai/gpt-other", thinkingLevel: "high" })
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Hi", sender: ada })
    expect(await agent.event((event) => event._tag === "TurnEnded")).toMatchObject({
      usage: { model: "openai/gpt-other" },
    })
    agent.send({ _tag: "SwitchModel", model: "openai/nope" })
    expect(await agent.event((event) => event._tag === "ModelSwitchFailed")).toMatchObject({
      asked: "openai/nope",
      model: "openai/gpt-other",
    })
    // The Hub hears the model it runs on, as the hello says after a Hub restart.
    agent.hub.forget()
    await agent.hub.until(() => (agent?.hub.hellos.length ?? 0) > 1 || undefined)
    expect(agent.hub.hellos.at(-1)).toMatchObject({ model: "openai/gpt-other" })
  })

  test("asks the Hub again for a model of a Provider connected since the agent started", async () => {
    agent = new TestAgent({ reply: () => say("Ok.") })
    agent.listed = ["openai/gpt-test"]
    agent.connectedLater = ["openai/gpt-later"]
    await agent.start()
    agent.send({ _tag: "SwitchModel", model: "openai/gpt-later" })
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Hi", sender: ada })
    expect(await agent.event((event) => event._tag === "TurnEnded")).toMatchObject({
      usage: { model: "openai/gpt-later" },
    })
    expect(agent.refreshes).toBe(1)
  })

  test("takes the Session's thinking level on restart, even when the model didn't change", async () => {
    agent = new TestAgent({ reply: () => say("Ok.") })
    await agent.start({ thinkingLevel: "high" })
    await agent.stop()
    let restarted = await agent.start({ thinkingLevel: "low" })
    expect(
      (await (await restarted.harness.root(BACKGROUND_CONTEXT)).agent(BACKGROUND_CONTEXT))
        .thinkingLevel,
    ).toBe("low")
    await agent.stop()
    restarted = await agent.start()
    expect(
      (await (await restarted.harness.root(BACKGROUND_CONTEXT)).agent(BACKGROUND_CONTEXT))
        .thinkingLevel,
    ).toBe("off")
  })

  test("starts on the Session's model, taking it over a stored one", async () => {
    agent = new TestAgent({ reply: () => say("Ok.") })
    await agent.start()
    await agent.stop()
    await agent.start({ model: "xai/grok-test" })
    agent.send({ _tag: "DeliverPrompt", promptId: "q1", text: "Hi", sender: ada })
    expect(await agent.event((event) => event._tag === "TurnEnded")).toMatchObject({
      usage: { model: "xai/grok-test" },
    })
    expect(agent.hub.hellos.at(-1)).toMatchObject({ model: "xai/grok-test" })
  })
})

describe("Claude's Models", () => {
  const listed = [
    { provider: "anthropic" as const, id: "claude-fable-5", label: "Fable", thinkingLevels: [] },
    { provider: "openai" as const, id: "gpt-4.1", label: "GPT", thinkingLevels: [] },
  ]
  const env = {
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test-token",
    KNDL_CLAUDE_CODE: "/opt/claude",
    CLAUDE_CONFIG_DIR: "/tmp/claude-config",
  }

  test("go to the Claude bridge, for the Claude Models the Hub lists", async () => {
    const made: Array<ClaudeBridgeOptions> = []
    const closed: Array<string> = []
    const served: Array<Array<string>> = []
    const models = createModels()
    const anthropic = builtinProvider("anthropic")
    if (anthropic === undefined) throw new Error("no anthropic")
    const install = installClaude(models, listed, {
      env,
      cwd: "/workspace",
      log: () => {},
      create: (options) => {
        made.push(options)
        const provider: ClaudeBridgeProvider = Object.assign(
          { ...anthropic },
          {
            models: [],
            missing: [],
            withModels: (next: ReadonlyArray<ProviderModel>) => {
              served.push(next.map((model) => model.id))
              return provider
            },
            runSettled: () => {},
            close: async () => void closed.push("closed"),
          },
        )
        return provider
      },
    })
    expect(install).toBeDefined()
    expect(made[0]).toMatchObject({
      claudeCodePath: "/opt/claude",
      configDir: "/tmp/claude-config",
      oauthToken: "sk-ant-oat-test-token",
      cwd: "/workspace",
    })
    expect(made[0]?.models.map((model) => model.id)).toEqual(["claude-fable-5"])
    expect(models.getProvider("anthropic")).toBeDefined()
    install?.update(listed)
    expect(made).toHaveLength(1)
    // Other Claude Models are served around the same bridge, which only the agent's end closes.
    install?.update([
      ...listed,
      { provider: "anthropic" as const, id: "claude-haiku-5", label: "Haiku", thinkingLevels: [] },
    ])
    expect(made).toHaveLength(1)
    expect(served).toEqual([["claude-fable-5", "claude-haiku-5"]])
    install?.update(listed.slice(1))
    expect(models.getProvider("anthropic")).toBeUndefined()
    expect(closed).toEqual([])
    await install?.close()
    expect(closed).toEqual(["closed"])
  })

  test("hear of a conversation's run settling through the Gateway's catalogue, when there is a bridge", async () => {
    const anthropic = builtinProvider("anthropic")
    if (anthropic === undefined) throw new Error("no anthropic")
    const settled: Array<string> = []
    const gateway = (withClaude: boolean) =>
      gatewayCatalog({
        hubUrl,
        modToken,
        env: withClaude ? env : {},
        cwd: "/workspace",
        log: () => {},
        wait: async () => {},
        fetch: async () => ({ status: 200, text: JSON.stringify({ models: listed }) }),
        createClaude: () =>
          Object.assign(
            { ...anthropic },
            {
              models: [],
              missing: [],
              withModels: () => anthropic as unknown as ClaudeBridgeProvider,
              runSettled: (sessionId: string) => void settled.push(sessionId),
              close: async () => {},
            },
          ),
      })
    const catalog = await gateway(true)
    catalog.runSettled("session-1")
    expect(settled).toEqual(["session-1"])
    await catalog.close()
    // Without the Creator's Claude credential there is no bridge to tell.
    const without = await gateway(false)
    expect(() => without.runSettled("session-2")).not.toThrow()
    expect(settled).toEqual(["session-1"])
    await without.close()
  })

  test("aren't there without the Creator's Claude credential", () => {
    const models = createModels()
    expect(
      installClaude(models, listed, { env: {}, cwd: "/workspace", log: () => {} }),
    ).toBeUndefined()
    expect(models.getProvider("anthropic")).toBeUndefined()
  })
})
