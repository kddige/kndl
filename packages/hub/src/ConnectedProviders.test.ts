// Connected providers (ADR 0029), end to end: a real Hub and web clients over WebSockets.
// ProviderApis.layerTest stands in for OpenAI, xAI and Anthropic, and for pi-ai's sign-in flows, so
// every key and token here is a fake.

import { afterEach, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { join } from "node:path"
import type { AuthPrompt, OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai"
import { ParticipantId, ProviderIds } from "@kndl/protocol"
import { Clock, Duration, Effect, Fiber, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { ConnectedProviders, ProviderApis } from "./ConnectedProviders.ts"
import { databaseAt } from "./Database.ts"
import { ModelCatalog } from "./ModelCatalog.ts"
import { generateSecretsKey, Secrets } from "./Secrets.ts"
import { type Connection, openWeb, stopAll, type Web } from "./testChannels.ts"
import {
  ensureSetupToken,
  setupTokenOf,
  startHub,
  type TestHub,
  testDatabaseDir,
} from "./testSupport.ts"

const dirs: Array<string> = []

afterEach(async () => {
  await stopAll()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const withKey = { devLogin: true, secretsKey: Option.some(Redacted.make(generateSecretsKey())) }
const alice = ParticipantId.make("dev:alice")

const goodKey = "sk-proj-FAKE_KEY_FOR_TESTS_ONLY_good"
const badKey = "sk-proj-FAKE_KEY_FOR_TESTS_ONLY_bad1"

let requests = 0

/** Sends `message` with a fresh requestId, and the answer to it. */
async function request(
  web: Connection<Web>,
  message: { readonly _tag: string } & Record<string, unknown>,
) {
  const requestId = `p-${++requests}`
  web.send({ ...message, requestId })
  return web.takeWhere(
    (each): each is Web =>
      "requestId" in each &&
      each.requestId === requestId &&
      each._tag !== "SignInStepped" &&
      each._tag !== "SignInEnded",
    `answer to ${requestId}`,
  )
}

/** What a fake Provider was sent. */
interface Seen {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
}

/**
 * Fake Providers: OpenAI's and xAI's model lists, by the bearer they're sent, and Anthropic's, as
 * the test sets them; a sign-in flow per Provider, and a refresh, as the test sets them.
 */
function fakeProviders() {
  const seen: Array<Seen> = []
  const fakes = {
    seen,
    /** Anthropic's answer to its model list; by default it fails. */
    anthropic: (): Response => new Response("down", { status: 503 }),
    /** What OpenAI's and xAI's model lists answer instead, when set. */
    modelsStatus: undefined as number | undefined,
    /** What every other Provider answers; by default, nothing there. */
    other: (_request: Request): Response | Promise<Response> =>
      new Response("not here", { status: 404 }),
    signIn: async (
      _provider: string,
      _interaction: ProviderAuthInteraction,
      _options: { readonly getDeviceId?: () => string },
    ): Promise<OAuthCredential> => {
      throw new Error("No sign-in here")
    },
    refresh: async (_provider: string, _credential: OAuthCredential): Promise<OAuthCredential> => {
      throw new Error("No refresh here")
    },
  }
  const layer = ProviderApis.layerTest({
    fetch: async (input) => {
      const url = new URL(input.url)
      seen.push({
        method: input.method,
        url: input.url,
        headers: Object.fromEntries(input.headers),
      })
      const auth = input.headers.get("authorization") ?? ""
      if (url.host === "api.anthropic.com") return fakes.anthropic()
      if (url.host !== "api.openai.com" && url.host !== "api.x.ai") return fakes.other(input)
      if (url.pathname !== "/v1/models") return fakes.other(input)
      if (fakes.modelsStatus !== undefined)
        return new Response("{}", { status: fakes.modelsStatus })
      if (auth === `Bearer ${goodKey}` || auth === "Bearer xai-key") {
        return Response.json({
          object: "list",
          data: [
            { id: "gpt-5.6-luna", created: 1 },
            { id: "gpt-6-sol", created: 3 },
            { id: "not-in-pi-ai", created: 9 },
            { id: "grok-4.7", created: 2 },
          ],
        })
      }
      if (auth.startsWith("Bearer access-")) {
        return Response.json({
          models: [
            {
              slug: "gpt-6.1-sol",
              display_name: "GPT-6.1-Sol",
              visibility: "list",
              context_window: 500000,
              supported_reasoning_levels: [
                { effort: "low" },
                { effort: "max" },
                { effort: "ultra" },
              ],
            },
            {
              slug: "gpt-reserve",
              display_name: "GPT-Reserve",
              visibility: "hide",
              supported_reasoning_levels: [],
            },
            { slug: "not-in-pi-ai", display_name: "?", visibility: "list" },
            {
              slug: "gpt-6-luna",
              display_name: "GPT-6-Luna",
              visibility: "list",
              context_window: 272000,
              supported_reasoning_levels: [],
            },
          ],
        })
      }
      return Response.json({ error: { message: "Incorrect API key provided" } }, { status: 401 })
    },
    signIn: (provider, interaction, options) => fakes.signIn(provider, interaction, options),
    refresh: (provider, credential) => fakes.refresh(provider, credential),
  })
  return { fakes, layer }
}

/** A Hub with fake Providers, and alice on the web without a Claude credential. */
async function scene(options: { readonly setupToken?: boolean } = {}) {
  const { fakes, layer } = fakeProviders()
  const hub = await startHub({ config: withKey, providerApis: layer })
  const web = await openWeb(hub, "alice", undefined, { setupToken: options.setupToken ?? false })
  const welcomed = await web.take("ProvidersState")
  return { hub, web, fakes, welcomed }
}

const storedText = (hub: TestHub) =>
  hub.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return JSON.stringify(yield* sql`SELECT * FROM connected_providers`)
    }),
  )

const oauth = (access: string, expiresIn = 60 * 60 * 1000): OAuthCredential => ({
  type: "oauth",
  access,
  refresh: `refresh-of-${access}`,
  expires: Date.now() + expiresIn,
})

/** Whether `check` holds within half a second. */
async function eventually(check: () => boolean) {
  for (let tries = 0; tries < 50; tries++) {
    if (check()) return true
    await Bun.sleep(10)
  }
  return check()
}

/** A sign-in the test drives: the prompts it asked, answered when the test says. */
function drivenSignIn() {
  const prompts: Array<AuthPrompt> = []
  const deviceIds: Array<string | undefined> = []
  let signal: AbortSignal | undefined
  const flow = async (
    provider: string,
    interaction: ProviderAuthInteraction,
    options: { readonly getDeviceId?: () => string },
  ): Promise<OAuthCredential> => {
    signal = interaction.signal
    deviceIds.push(options.getDeviceId?.())
    if (provider === "xai") {
      interaction.notify({
        type: "device_code",
        userCode: "ABCD-1234",
        verificationUri: "https://accounts.x.ai/device",
      })
      await new Promise<void>((_resolve, reject) =>
        interaction.signal.addEventListener("abort", () => reject(new Error("Login cancelled"))),
      )
    }
    interaction.notify({
      type: "auth_url",
      url: "https://auth.openai.com/api/accounts/authorize?x=1",
      instructions: "Complete sign-in in your browser.",
    })
    const prompt: AuthPrompt = {
      type: "manual_code",
      message: "Paste the final redirect URL here:",
      placeholder: "http://127.0.0.1:1455/auth/callback",
    }
    prompts.push(prompt)
    const pasted = await interaction.prompt(prompt)
    if (!pasted.includes("code=")) throw new Error("Paste the full callback URL from the browser")
    interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." })
    return oauth("access-1")
  }
  return {
    flow,
    prompts,
    deviceIds,
    get signal() {
      return signal
    },
  }
}

describe("connecting a Provider with an API key", () => {
  test("lists its Models with it first, and keeps the key write-only", async () => {
    const { hub, web, fakes, welcomed } = await scene()
    expect(welcomed).toEqual({
      _tag: "ProvidersState",
      connected: [],
      connectable: expect.any(Array),
      models: [],
      claudeHarness: "ClaudeCode",
    })
    // The most used first, each as pi-ai names it and signs in to it.
    expect(welcomed.connectable.slice(0, 5)).toEqual([
      {
        provider: "openai",
        name: "OpenAI",
        signIn: "Sign in with ChatGPT",
        apiKey: true,
        keyName: "OpenAI API key",
      },
      {
        provider: "xai",
        name: "xAI",
        signIn: "Sign in with SuperGrok or X Premium",
        apiKey: true,
        keyName: "xAI API key",
      },
      // Copilot's sign-in alone: pi-ai's token for it is the one the sign-in gets.
      {
        provider: "github-copilot",
        name: "GitHub Copilot",
        signIn: "Sign in with GitHub Copilot",
        apiKey: false,
      },
      {
        provider: "openrouter",
        name: "OpenRouter",
        signIn: "Sign in with OpenRouter",
        apiKey: true,
        keyName: "OpenRouter API key",
      },
      { provider: "google", name: "Google", apiKey: true, keyName: "Gemini API key" },
    ])
    expect(welcomed.connectable.map((each) => each.provider)).toEqual([...ProviderIds])
    const elsewhere = await openWeb(hub, "alice", web.cookie)
    await elsewhere.take("ProvidersState")
    const bob = await openWeb(hub, "bob", undefined, { setupToken: false })
    await bob.take("ProvidersState")

    const answer = await request(web, {
      _tag: "ConnectProviderKey",
      provider: "openai",
      apiKey: `  ${goodKey}\n`,
    })
    // Its Models, those pi-ai knows, newest first.
    const models: Array<unknown> = [
      {
        provider: "openai",
        id: "gpt-6-sol",
        label: "GPT-6 Sol",
        thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
        contextWindow: expect.any(Number),
      },
      {
        provider: "openai",
        id: "gpt-5.6-luna",
        label: "GPT-5.6 Luna",
        thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
        contextWindow: expect.any(Number),
      },
    ]
    expect(answer as unknown).toEqual({
      _tag: "ProvidersState",
      requestId: expect.any(String),
      connected: [
        {
          provider: "openai",
          kind: "ApiKey",
          label: "good",
          connectedAt: expect.any(Number),
          models,
          modelsCheckedAt: expect.any(Number),
        },
      ],
      connectable: expect.any(Array),
      models,
      claudeHarness: "ClaudeCode",
    })
    expect(fakes.seen).toContainEqual(
      expect.objectContaining({
        method: "GET",
        url: "https://api.openai.com/v1/models",
        headers: expect.objectContaining({ authorization: `Bearer ${goodKey}` }),
      }),
    )
    // alice's other tab hears of it; bob doesn't.
    expect(
      (await elsewhere.take("ProvidersState", (m) => m.connected.length > 0)).connected,
    ).toHaveLength(1)
    expect(await bob.untaken("ProvidersState")).toEqual([])
    // Write-only: never sent back, nor stored in the clear.
    for (const connection of [web, elsewhere, bob]) {
      expect(connection.texts.join("\n")).not.toContain(goodKey)
    }
    expect(await storedText(hub)).not.toContain(goodKey)
    // Redacted from what Sessions print.
    const values = await hub.run(Effect.map(ConnectedProviders, (p) => p.values()))
    expect(values).toContain(goodKey)

    // A new connection is told what alice has.
    const later = await openWeb(hub, "alice", web.cookie)
    expect((await later.take("ProvidersState")).connected).toMatchObject([
      { provider: "openai", kind: "ApiKey", label: "good" },
    ])
  })

  test("refuses a key the Provider rejects, and keeps none", async () => {
    const { hub, web } = await scene()
    const answer = await request(web, {
      _tag: "ConnectProviderKey",
      provider: "openai",
      apiKey: badKey,
    })
    expect(answer).toMatchObject({
      _tag: "CommandFailed",
      command: "ConnectProviderKey",
      message: expect.stringContaining("OpenAI rejected this key"),
    })
    expect(await storedText(hub)).toBe("[]")
  })

  test("refuses a key for a Provider that takes none, as GitHub Copilot's sign-in alone connects it", async () => {
    const { hub, web, fakes } = await scene()
    fakes.other = () => Response.json({ data: [{ id: "gpt-6-sol" }] })
    const answer = await request(web, {
      _tag: "ConnectProviderKey",
      provider: "github-copilot",
      apiKey: "ghu_FAKE_TOKEN_FOR_TESTS_ONLY",
    })
    expect(answer).toMatchObject({ _tag: "CommandFailed", command: "ConnectProviderKey" })
    expect(await storedText(hub)).toBe("[]")
    expect(fakes.seen).toEqual([])
  })

  test("waiting on the Provider holds up none of the connection's other commands", async () => {
    const { web, fakes } = await scene()
    const listed = Promise.withResolvers<void>()
    fakes.other = async () => {
      await listed.promise
      return Response.json({ data: [{ id: "MiniMax-M2" }] })
    }
    web.send({
      _tag: "ConnectProviderKey",
      requestId: "slow-key",
      provider: "minimax",
      apiKey: "minimax-key",
    })
    // Answered while MiniMax is still asked.
    expect(await request(web, { _tag: "GetProviders" })).toMatchObject({ connected: [] })
    listed.resolve()
    expect(await web.take("ProvidersState", (m) => m.requestId === "slow-key")).toMatchObject({
      connected: [{ provider: "minimax" }],
    })

    const relisted = Promise.withResolvers<void>()
    fakes.other = async () => {
      await relisted.promise
      return Response.json({ data: [{ id: "MiniMax-M2" }] })
    }
    web.send({ _tag: "RefreshProviderModels", requestId: "slow-refresh", provider: "minimax" })
    expect(await request(web, { _tag: "GetProviders" })).toMatchObject({
      connected: [{ provider: "minimax" }],
    })
    relisted.resolve()
    await web.take("ProvidersState", (m) => m.requestId === "slow-refresh")
  })

  test("an xAI key keeps xAI's Models alone", async () => {
    const { web } = await scene()
    const answer = await request(web, {
      _tag: "ConnectProviderKey",
      provider: "xai",
      apiKey: "xai-key",
    })
    if (answer._tag !== "ProvidersState") throw new Error(JSON.stringify(answer))
    expect(answer.models.map((model) => `${model.provider}/${model.id}`)).toEqual(["xai/grok-4.7"])
  })

  test("a Gemini key goes in Google's header, and lists Google's Models", async () => {
    const { web, fakes } = await scene()
    fakes.other = (sent) =>
      sent.headers.get("x-goog-api-key") === "gemini-key"
        ? Response.json({
            models: [
              {
                name: "models/gemini-2.5-flash",
                displayName: "Gemini 2.5 Flash",
                inputTokenLimit: 1048576,
                supportedGenerationMethods: ["generateContent", "countTokens"],
              },
              { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
              { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
            ],
          })
        : Response.json(
            { error: { code: 400, message: "API key not valid. Please pass a valid API key." } },
            { status: 400 },
          )
    const refused = await request(web, {
      _tag: "ConnectProviderKey",
      provider: "google",
      apiKey: "wrong-key",
    })
    expect(refused).toMatchObject({
      _tag: "CommandFailed",
      message: expect.stringContaining("Google rejected this key"),
    })
    const answer = await request(web, {
      _tag: "ConnectProviderKey",
      provider: "google",
      apiKey: "gemini-key",
    })
    if (answer._tag !== "ProvidersState") throw new Error(JSON.stringify(answer))
    expect(answer.models.map((model) => [model.id, model.label])).toEqual([
      ["gemini-2.5-pro", "Gemini 2.5 Pro"],
      ["gemini-2.5-flash", "Gemini 2.5 Flash"],
    ])
    expect(fakes.seen.at(-1)).toMatchObject({
      url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
      headers: expect.not.objectContaining({ authorization: expect.anything() }),
    })
  })

  test("a Provider that doesn't list its Models offers pi-ai's, and says so", async () => {
    const { web } = await scene()
    const answer = await request(web, {
      _tag: "ConnectProviderKey",
      provider: "minimax",
      apiKey: "minimax-key",
    })
    if (answer._tag !== "ProvidersState") throw new Error(JSON.stringify(answer))
    const [minimax] = answer.connected
    expect(minimax?.models.length).toBeGreaterThan(0)
    expect(minimax?.models.every((model) => model.provider === "minimax")).toBe(true)
    expect(minimax?.modelsProblem).toBe(
      "MiniMax answered 404, so these are all the Models pi-ai knows for MiniMax.",
    )
  })

  test("disconnecting forgets the key", async () => {
    const { hub, web } = await scene()
    await request(web, { _tag: "ConnectProviderKey", provider: "openai", apiKey: goodKey })
    const answer = await request(web, { _tag: "DisconnectProvider", provider: "openai" })
    expect(answer).toMatchObject({ _tag: "ProvidersState", connected: [], models: [] })
    expect(await storedText(hub)).toBe("[]")
    // Still redacted: a Session may have printed it before.
    const values = await hub.run(Effect.map(ConnectedProviders, (p) => p.values()))
    expect(values).toContain(goodKey)
  })
})

describe("signing in to a Provider", () => {
  test("Sign in with ChatGPT: each step, the URL pasted, then Connected with its Models", async () => {
    const { hub, web, fakes } = await scene()
    const driven = drivenSignIn()
    fakes.signIn = driven.flow
    web.send({ _tag: "StartSignIn", requestId: "s-1", provider: "openai" })

    const opened = await web.take("SignInStepped", (m) => m.step._tag === "OpenUrl")
    expect(opened).toEqual({
      _tag: "SignInStepped",
      requestId: "s-1",
      provider: "openai",
      step: {
        _tag: "OpenUrl",
        url: "https://auth.openai.com/api/accounts/authorize?x=1",
        instructions: expect.stringMatching(/paste/i),
      },
    })
    const paste = await web.take("SignInStepped", (m) => m.step._tag === "Paste")
    expect(paste.step).toEqual({
      _tag: "Paste",
      message: expect.stringMatching(/address|URL/),
      placeholder: "http://127.0.0.1:1455/auth/callback",
    })

    web.send({
      _tag: "AnswerSignIn",
      requestId: "s-1",
      value: "http://127.0.0.1:1455/auth/callback?code=c&state=s",
    })
    expect((await web.take("SignInStepped", (m) => m.step._tag === "Progress")).step).toMatchObject(
      { message: expect.stringContaining("Exchanging") },
    )
    expect(await web.take("SignInEnded")).toEqual({
      _tag: "SignInEnded",
      requestId: "s-1",
      provider: "openai",
      outcome: "Connected",
    })
    const state = await web.take("ProvidersState", (m) => m.connected.length > 0)
    // Listed under the account, those shown, and pi-ai knows, in the Provider's order.
    expect(state.connected).toEqual([
      {
        provider: "openai",
        kind: "SignIn",
        label: "ChatGPT subscription",
        connectedAt: expect.any(Number),
        models: [
          {
            provider: "openai",
            id: "gpt-6.1-sol",
            label: "GPT-6.1-Sol",
            thinkingLevels: ["low", "max"],
            contextWindow: 500000,
          },
          {
            provider: "openai",
            id: "gpt-6-luna",
            label: "GPT-6-Luna",
            thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
            contextWindow: 272000,
          },
        ],
        modelsCheckedAt: expect.any(Number),
      },
    ])
    expect(fakes.seen.at(-1)?.headers.authorization).toBe("Bearer access-1")

    // One device id for the Hub, a UUID, the same for every sign-in.
    expect(driven.deviceIds[0]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    web.send({ _tag: "StartSignIn", requestId: "s-2", provider: "openai" })
    await web.take("SignInStepped", (m) => m.requestId === "s-2" && m.step._tag === "Paste")
    expect(driven.deviceIds[1]).toBe(driven.deviceIds[0])
    web.send({ _tag: "CancelSignIn", requestId: "s-2" })
    expect(await web.take("SignInEnded", (m) => m.requestId === "s-2")).toMatchObject({
      outcome: "Cancelled",
    })

    // The tokens are never sent, nor stored in the clear, and are redacted.
    expect(web.texts.join("\n")).not.toContain("access-1")
    expect(await storedText(hub)).not.toContain("access-1")
    const values = await hub.run(Effect.map(ConnectedProviders, (p) => p.values()))
    expect(values).toEqual(expect.arrayContaining(["access-1", "refresh-of-access-1"]))
  })

  test("a flow that fails ends Failed, with the Provider's reason", async () => {
    const { web, fakes } = await scene()
    fakes.signIn = drivenSignIn().flow
    web.send({ _tag: "StartSignIn", requestId: "s-3", provider: "openai" })
    await web.take("SignInStepped", (m) => m.step._tag === "Paste")
    web.send({ _tag: "AnswerSignIn", requestId: "s-3", value: "not a url" })
    expect(await web.take("SignInEnded")).toEqual({
      _tag: "SignInEnded",
      requestId: "s-3",
      provider: "openai",
      outcome: "Failed",
      message: "Paste the full callback URL from the browser",
    })
  })

  test("xAI's device code; a new sign-in cancels the last; closing the tab cancels it", async () => {
    const { hub, web, fakes } = await scene()
    const driven = drivenSignIn()
    fakes.signIn = driven.flow
    web.send({ _tag: "StartSignIn", requestId: "x-1", provider: "xai" })
    expect((await web.take("SignInStepped")).step).toEqual({
      _tag: "EnterCode",
      url: "https://accounts.x.ai/device",
      code: "ABCD-1234",
    })
    const first = driven.signal

    // One sign-in per Member at a time.
    const elsewhere = await openWeb(hub, "alice", web.cookie)
    elsewhere.send({ _tag: "StartSignIn", requestId: "x-2", provider: "xai" })
    expect(await web.take("SignInEnded")).toMatchObject({ requestId: "x-1", outcome: "Cancelled" })
    expect(first?.aborted).toBe(true)
    await elsewhere.take("SignInStepped", (m) => m.requestId === "x-2")
    const second = driven.signal
    expect(second?.aborted).toBe(false)

    await elsewhere.close()
    expect(await eventually(() => second?.aborted === true)).toBe(true)
  })

  test("GitHub Copilot's: which GitHub, a device code, then its Models from the account's own endpoint", async () => {
    const { web, fakes } = await scene()
    // A Copilot token names the account's endpoint, which pi-ai's toAuth reads.
    const token = "tid=1;exp=9999999999;sku=business;proxy-ep=proxy.business.githubcopilot.com"
    const answers: Array<string> = []
    fakes.signIn = async (_provider, interaction) => {
      answers.push(
        await interaction.prompt({
          type: "text",
          message: "GitHub Enterprise URL/domain (blank for github.com)",
          placeholder: "company.ghe.com",
        }),
      )
      interaction.notify({
        type: "device_code",
        userCode: "WXYZ-9876",
        verificationUri: "https://github.com/login/device",
      })
      return oauth(token)
    }
    fakes.other = (sent) => {
      const url = new URL(sent.url)
      if (url.host !== "api.business.githubcopilot.com" || url.pathname !== "/models") {
        return new Response("not here", { status: 404 })
      }
      return Response.json({
        data: [
          { id: "gpt-6-sol", model_picker_enabled: true, policy: { state: "enabled" } },
          { id: "claude-opus-5", model_picker_enabled: true, policy: { state: "unconfigured" } },
          { id: "gpt-5-mini", model_picker_enabled: false },
          { id: "grok-4.7", model_picker_enabled: true, policy: { state: "disabled" } },
          { id: "not-in-pi-ai", model_picker_enabled: true },
          {
            id: "gpt-6-luna",
            model_picker_enabled: true,
            capabilities: { supports: { tool_calls: false } },
          },
        ],
      })
    }

    web.send({ _tag: "StartSignIn", requestId: "c-1", provider: "github-copilot" })
    // Which GitHub, as a choice: pi-ai asks for a domain, blank for github.com.
    expect((await web.take("SignInStepped")).step).toEqual({
      _tag: "Choose",
      message: expect.any(String),
      options: [
        { id: "github.com", label: "GitHub.com" },
        { id: "enterprise", label: "GitHub Enterprise" },
      ],
    })
    web.send({ _tag: "AnswerSignIn", requestId: "c-1", value: "github.com" })
    expect((await web.take("SignInStepped")).step).toEqual({
      _tag: "EnterCode",
      url: "https://github.com/login/device",
      code: "WXYZ-9876",
    })
    expect(await web.take("SignInEnded")).toMatchObject({ outcome: "Connected" })
    expect(answers).toEqual([""])

    const state = await web.take("ProvidersState", (m) => m.connected.length > 0)
    expect(state.connected).toMatchObject([
      { provider: "github-copilot", kind: "SignIn", label: "GitHub Copilot subscription" },
    ])
    // Those its picker offers, that call tools and pi-ai knows, the most capable first.
    expect(state.connected[0]?.models.map((model) => model.id)).toEqual([
      "claude-opus-5",
      "gpt-6-sol",
    ])
    expect(state.connected[0]?.modelsProblem).toBeUndefined()
    const listed = fakes.seen.find((seen) => seen.url.includes("githubcopilot"))
    expect(listed?.url).toBe("https://api.business.githubcopilot.com/models")
    expect(listed?.headers).toMatchObject({
      authorization: `Bearer ${token}`,
      "copilot-integration-id": "vscode-chat",
      "editor-version": expect.any(String),
    })
  })

  test("GitHub Copilot Enterprise on any domain, as pi-ai's sign-in takes it, its calls to its address", async () => {
    const { hub, web, fakes } = await scene()
    fakes.other = () => Response.json({ data: [] })
    const asked: Array<string> = []
    fakes.signIn = async (_provider, interaction) => {
      const domain = await interaction.prompt({
        type: "text",
        message: "GitHub Enterprise URL/domain (blank for github.com)",
      })
      asked.push(domain)
      // A token that names no address: pi-ai's toAuth takes the Enterprise's own.
      return { ...oauth("tid=1;exp=9999999999;sku=enterprise"), enterpriseUrl: domain }
    }
    web.send({ _tag: "StartSignIn", requestId: "e-1", provider: "github-copilot" })
    await web.take("SignInStepped", (m) => m.step._tag === "Choose")
    web.send({ _tag: "AnswerSignIn", requestId: "e-1", value: "enterprise" })
    await web.take("SignInStepped", (m) => m.step._tag === "Paste")
    web.send({ _tag: "AnswerSignIn", requestId: "e-1", value: "github.example.com" })
    expect(await web.take("SignInEnded", (m) => m.requestId === "e-1")).toMatchObject({
      outcome: "Connected",
    })
    expect(asked).toEqual(["github.example.com"])

    fakes.seen.length = 0
    await hub.run(
      Effect.flatMap(ConnectedProviders, (providers) =>
        providers.call(alice, "github-copilot", {
          method: "POST",
          path: "/chat/completions",
          headers: new Headers({ "content-type": "application/json" }),
          keyHeader: "authorization",
          body: new TextEncoder().encode("{}"),
        }),
      ),
    )
    expect(fakes.seen.map((seen) => seen.url)).toEqual([
      "https://copilot-api.github.example.com/chat/completions",
    ])
  })

  test("a sign-in that takes longer than 10 minutes fails, and its flow is stopped", async () => {
    const { hub, fakes } = await scene()
    let signal: AbortSignal | undefined
    fakes.signIn = async (_provider, interaction) => {
      signal = interaction.signal
      return new Promise<OAuthCredential>((_resolve, reject) =>
        interaction.signal.addEventListener("abort", () => reject(new Error("Login cancelled"))),
      )
    }
    const failed = await hub.run(
      Effect.flatMap(ConnectedProviders, (providers) =>
        providers.signIn(alice, "openai", {
          notify: () => {},
          prompt: () => new Promise(() => {}),
        }),
      ).pipe(onClock(0, Duration.minutes(10)), Effect.flip),
    )
    expect(failed).toMatchObject({
      _tag: "ProviderRefusal",
      message: "The sign-in took too long; start again.",
    })
    // ChatGPT's frees the port it listens on.
    expect(signal?.aborted).toBe(true)
  })

  test("an answer with no step waiting is refused", async () => {
    const { web } = await scene()
    const answer = await request(web, { _tag: "AnswerSignIn", value: "x" })
    expect(answer).toMatchObject({ _tag: "CommandFailed", command: "AnswerSignIn" })
  })
})

/** A model call of alice's to OpenAI, as the Gateway makes one: its answer's status. */
const modelCall = () =>
  Effect.flatMap(ConnectedProviders, (providers) =>
    providers.call(alice, "openai", {
      method: "POST",
      path: "/v1/responses",
      headers: new Headers({ "content-type": "application/json" }),
      keyHeader: "authorization",
      body: new TextEncoder().encode("{}"),
    }),
  ).pipe(
    Effect.flatMap((called) =>
      called._tag === "Answered"
        ? Effect.promise(async () => {
            await called.response.body?.cancel()
            return called.response.status
          })
        : Effect.succeed(0),
    ),
  )

/** The bearer each model call was sent with, leaving out the Model lists asked for. */
const sentWith = (fakes: { readonly seen: ReadonlyArray<Seen> }) =>
  fakes.seen
    .filter((seen) => new URL(seen.url).pathname === "/v1/responses")
    .map((seen) => seen.headers.authorization)

/**
 * Runs `effect` on a clock read `millis` ahead of the time it is, whose sleeps of `fastFrom` or
 * longer take a moment instead.
 */
const onClock =
  (millis: number, fastFrom?: Duration.Duration) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Clock.clockWith((clock) =>
      Effect.provideService(effect, Clock.Clock, {
        currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe() + millis,
        currentTimeMillis: Effect.map(clock.currentTimeMillis, (now) => now + millis),
        currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe() + BigInt(millis) * 1_000_000n,
        currentTimeNanos: Effect.map(
          clock.currentTimeNanos,
          (now) => now + BigInt(millis) * 1_000_000n,
        ),
        monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: clock.monotonicTimeNanos,
        sleep: (duration) =>
          clock.sleep(
            fastFrom !== undefined && Duration.isGreaterThanOrEqualTo(duration, fastFrom)
              ? Duration.millis(50)
              : duration,
          ),
      }),
    )

/** alice's OpenAI credential as the Hub stored it, decrypted. */
const storedCredential = (hub: TestHub) =>
  hub.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const secrets = yield* Secrets
      const [row] = yield* sql<{ readonly credential: string }>`
        SELECT credential FROM connected_providers WHERE provider = 'openai'
      `
      if (row === undefined) return ""
      return Redacted.value(
        yield* secrets.decrypt(row.credential, "connected-provider:dev:alice:openai"),
      )
    }),
  )

/** alice signed in to ChatGPT with `credential`. */
async function signedIn(credential: OAuthCredential) {
  const s = await scene()
  s.fakes.signIn = async () => credential
  s.web.send({ _tag: "StartSignIn", requestId: "t-1", provider: "openai" })
  await s.web.take("SignInEnded")
  await s.web.take("ProvidersState", (m) => m.connected.length > 0)
  return s
}

describe("a sign-in's tokens", () => {
  test("one that expires within 5 minutes is refreshed for a call, and the new one kept", async () => {
    const { hub, fakes } = await signedIn(oauth("access-old", 60 * 1000))
    const refreshed: Array<string> = []
    fakes.refresh = async (_provider, credential) => {
      refreshed.push(credential.refresh)
      await Bun.sleep(20)
      return oauth("access-new")
    }
    fakes.seen.length = 0
    // Two at once refresh once.
    await hub.run(Effect.all([modelCall(), modelCall()], { concurrency: 2 }))
    expect(sentWith(fakes)).toEqual(["Bearer access-new", "Bearer access-new"])
    expect(refreshed).toEqual(["refresh-of-access-old"])
    expect(await storedText(hub)).not.toContain("access-new")
    const values = await hub.run(Effect.map(ConnectedProviders, (p) => p.values()))
    expect(values).toEqual(expect.arrayContaining(["access-old", "access-new"]))

    // Kept: the next call needs no refresh.
    fakes.seen.length = 0
    await hub.run(modelCall())
    expect(sentWith(fakes)).toEqual(["Bearer access-new"])
    expect(refreshed).toHaveLength(1)
  })

  test("one the Provider refused is refreshed, once for many refusals, and the call sent again", async () => {
    const { hub, fakes } = await signedIn(oauth("access-old"))
    let refreshes = 0
    fakes.refresh = async () => {
      refreshes++
      await Bun.sleep(20)
      return oauth("access-new")
    }
    fakes.other = (sent) =>
      sent.headers.get("authorization") === "Bearer access-old"
        ? Response.json({ error: { message: "expired" } }, { status: 401 })
        : Response.json({ ok: true })
    fakes.seen.length = 0
    const statuses = await hub.run(Effect.all([modelCall(), modelCall()], { concurrency: 2 }))
    expect(statuses).toEqual([200, 200])
    expect(sentWith(fakes).toSorted()).toEqual([
      "Bearer access-new",
      "Bearer access-new",
      "Bearer access-old",
      "Bearer access-old",
    ])
    expect(refreshes).toBe(1)
  })

  test("one refused within a minute of its refresh isn't refreshed again, and is after it", async () => {
    const { hub, fakes } = await signedIn(oauth("access-0"))
    let refreshes = 0
    fakes.refresh = async () => oauth(`access-${++refreshes}`)
    fakes.other = () => Response.json({ error: { message: "nope" } }, { status: 401 })

    // Refused: refreshed, and sent once more.
    fakes.seen.length = 0
    expect(await hub.run(modelCall())).toBe(401)
    expect(sentWith(fakes)).toEqual(["Bearer access-0", "Bearer access-1"])
    expect(refreshes).toBe(1)

    // Refused again at once: the refusal stands, with no refresh.
    fakes.seen.length = 0
    expect(await hub.run(modelCall())).toBe(401)
    expect(sentWith(fakes)).toEqual(["Bearer access-1"])
    expect(refreshes).toBe(1)

    // A minute on, it's refreshed again.
    fakes.seen.length = 0
    expect(await hub.run(modelCall().pipe(onClock(61_000)))).toBe(401)
    expect(sentWith(fakes)).toEqual(["Bearer access-1", "Bearer access-2"])
    expect(refreshes).toBe(2)
  })

  test("those it replaced are redacted until they expire, then forgotten", async () => {
    const { hub, fakes } = await signedIn(oauth("access-0", 60 * 1000))
    let refreshes = 0
    fakes.refresh = async () => oauth(`access-${++refreshes}`, 60 * 1000)
    fakes.other = () => Response.json({ ok: true })
    const values = () => hub.run(Effect.map(ConnectedProviders, (p) => p.values()))

    await hub.run(modelCall())
    expect(await values()).toEqual(
      expect.arrayContaining(["access-0", "refresh-of-access-0", "access-1"]),
    )
    // Two hours on, both expired long ago: the next refresh lets them go.
    await hub.run(modelCall().pipe(onClock(2 * 60 * 60 * 1000)))
    const now = await values()
    expect(now).toContain("access-2")
    expect(now).not.toContain("access-0")
    expect(now).not.toContain("refresh-of-access-0")
    expect(now).not.toContain("access-1")
  })

  test("one refreshed for a call given up meanwhile is kept all the same", async () => {
    const { hub, fakes } = await signedIn(oauth("access-old", 60 * 1000))
    const refreshing = Promise.withResolvers<void>()
    const rotate = Promise.withResolvers<void>()
    const refreshed: Array<string> = []
    fakes.refresh = async (_provider, credential) => {
      refreshed.push(credential.refresh)
      refreshing.resolve()
      // The Provider rotated it, its old refresh token spent: its answer comes all the same.
      await rotate.promise
      return oauth("access-rotated")
    }
    fakes.other = () => Response.json({ ok: true })
    await hub.run(
      Effect.gen(function* () {
        const call = yield* Effect.forkChild(modelCall())
        yield* Effect.promise(() => refreshing.promise)
        // As when pi gives the call up, and the Hub's server interrupts it.
        yield* Fiber.interrupt(call)
      }),
    )
    rotate.resolve()

    fakes.seen.length = 0
    expect(await hub.run(modelCall())).toBe(200)
    expect(sentWith(fakes)).toEqual(["Bearer access-rotated"])
    expect(refreshed).toEqual(["refresh-of-access-old"])
    expect(await storedCredential(hub)).toContain("access-rotated")
  })

  test("one refreshed is kept for calls even when the Hub couldn't store it", async () => {
    const { hub, fakes } = await signedIn(oauth("access-old", 60 * 1000))
    const refreshed: Array<string> = []
    fakes.refresh = async (_provider, credential) => {
      refreshed.push(credential.refresh)
      return oauth("access-rotated")
    }
    fakes.other = () => Response.json({ ok: true })
    // The database refuses to store it.
    await hub.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`
          CREATE TRIGGER no_rotation BEFORE UPDATE OF credential ON connected_providers
          BEGIN SELECT RAISE(ABORT, 'disk full'); END
        `
      }),
    )
    fakes.seen.length = 0
    expect(await hub.run(modelCall())).toBe(200)
    expect(await hub.run(modelCall())).toBe(200)
    expect(sentWith(fakes)).toEqual(["Bearer access-rotated", "Bearer access-rotated"])
    expect(refreshed).toEqual(["refresh-of-access-old"])
  })

  test("a refresh that ends after the connection was replaced keeps the new one", async () => {
    const { hub, web, fakes } = await signedIn(oauth("access-old", 60 * 1000))
    const refreshing = Promise.withResolvers<void>()
    const rotate = Promise.withResolvers<void>()
    fakes.refresh = async () => {
      refreshing.resolve()
      await rotate.promise
      return oauth("access-rotated")
    }
    fakes.other = () => Response.json({ ok: true })
    fakes.seen.length = 0
    const called = hub.run(modelCall())
    await refreshing.promise

    // Signed in again meanwhile.
    fakes.signIn = async () => oauth("access-fresh")
    web.send({ _tag: "StartSignIn", requestId: "r-2", provider: "openai" })
    expect(await web.take("SignInEnded")).toMatchObject({ outcome: "Connected" })
    rotate.resolve()
    expect(await called).toBe(200)

    // The call went with the new sign-in, and the rotated tokens weren't kept over it.
    expect(sentWith(fakes)).toEqual(["Bearer access-fresh"])
    expect(await storedCredential(hub)).toContain("access-fresh")
    fakes.seen.length = 0
    await hub.run(modelCall())
    expect(sentWith(fakes)).toEqual(["Bearer access-fresh"])
  })

  test("a refused refresh that ends after the connection was replaced leaves the new one be", async () => {
    const { hub, web, fakes } = await signedIn(oauth("access-old", 60 * 1000))
    const refreshing = Promise.withResolvers<void>()
    const refuse = Promise.withResolvers<void>()
    fakes.refresh = async () => {
      refreshing.resolve()
      await refuse.promise
      throw new Error("OpenAI OAuth token request failed (400): invalid_grant")
    }
    fakes.other = () => Response.json({ ok: true })
    const called = hub.run(modelCall().pipe(Effect.result))
    await refreshing.promise

    fakes.signIn = async () => oauth("access-fresh")
    web.send({ _tag: "StartSignIn", requestId: "r-3", provider: "openai" })
    expect(await web.take("SignInEnded")).toMatchObject({ outcome: "Connected" })
    refuse.resolve()
    await called

    const state = await request(web, { _tag: "GetProviders" })
    if (state._tag !== "ProvidersState") throw new Error(`Expected ProvidersState: ${state._tag}`)
    expect(state.connected).toMatchObject([{ provider: "openai" }])
    expect(state.connected[0]?.problem).toBeUndefined()
    expect(await storedText(hub)).not.toContain("refused")
    fakes.seen.length = 0
    expect(await hub.run(modelCall())).toBe(200)
    expect(sentWith(fakes)).toEqual(["Bearer access-fresh"])
  })

  test("a refresh the Provider refuses says to connect again", async () => {
    const { hub, web, fakes } = await signedIn(oauth("access-old", 1000))
    fakes.refresh = async () => {
      throw new Error("OpenAI OAuth token request failed (400): invalid_grant")
    }
    const failed = await hub.run(modelCall().pipe(Effect.flip))
    expect(failed.reason).toBe("Broken")
    const state = await web.take("ProvidersState", (m) => m.connected[0]?.problem !== undefined)
    expect(state.connected[0]?.problem).toMatch(/connect it again/i)
    // A Session can't run on it now.
    expect(state.models).toEqual([])
  })
})

describe("the Models", () => {
  test("Claude's are listed with a Claude credential, from Anthropic, kept to pi-ai's", async () => {
    const { hub, web, fakes } = await scene()
    fakes.anthropic = () =>
      Response.json({
        data: [
          { id: "claude-opus-5-5", display_name: "Claude Opus 5.5" },
          { id: "claude-unknown-9", display_name: "?" },
          { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" },
        ],
        has_more: false,
      })
    await ensureSetupToken(hub, "alice")
    const models = await hub.run(
      Effect.gen(function* () {
        const catalog = yield* ModelCatalog
        yield* catalog.modelsFor(alice)
        // The list is asked off the call, which answers at once.
        for (let tries = 0; tries < 100; tries++) {
          const found = yield* catalog.modelsFor(alice)
          if (found.length === 2) return found
          yield* Effect.sleep(10)
        }
        return yield* catalog.modelsFor(alice)
      }),
    )
    expect(models.map((model) => `${model.provider}/${model.id}`)).toEqual([
      "anthropic/claude-opus-5-5",
      "anthropic/claude-sonnet-5-5",
    ])
    expect(models[0]).toMatchObject({
      label: "Claude Opus 5.5",
      thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    })
    const asked = fakes.seen.find((seen) =>
      seen.url.startsWith("https://api.anthropic.com/v1/models"),
    )
    expect(asked?.headers).toMatchObject({
      authorization: `Bearer ${setupTokenOf("alice")}`,
      "anthropic-beta": "oauth-2025-04-20",
    })
    // alice's web hears of them.
    const state = await web.take("ProvidersState", (m) => m.models.length === 2)
    expect(state.connected).toEqual([])
  })

  test("Claude's are pi-ai's current ones when Anthropic can't say", async () => {
    const { hub } = await scene()
    await ensureSetupToken(hub, "alice")
    const models = await hub.run(Effect.flatMap(ModelCatalog, (c) => c.modelsFor(alice)))
    const ids = models.map((model) => model.id)
    expect(ids).toContain("claude-opus-5-5")
    expect(ids).not.toContain("claude-opus-4-5-20251101")
    expect(models.every((model) => model.provider === "anthropic")).toBe(true)
  })

  test("a list that doesn't come in time is given up, its answer let go", async () => {
    const { hub, web, fakes } = await scene()
    await request(web, { _tag: "ConnectProviderKey", provider: "minimax", apiKey: "minimax-key" })
    const cancelled = Promise.withResolvers<void>()
    // MiniMax answers, then never finishes saying its Models.
    fakes.other = () =>
      new Response(
        new ReadableStream({
          start: (controller) => controller.enqueue(new TextEncoder().encode('{"data":[')),
          cancel: () => cancelled.resolve(),
        }),
      )
    await hub.run(
      Effect.flatMap(ConnectedProviders, (providers) =>
        providers.refreshModels(alice, "minimax"),
      ).pipe(onClock(0, Duration.seconds(15))),
    )
    const state = await request(web, { _tag: "GetProviders" })
    if (state._tag !== "ProvidersState") throw new Error(JSON.stringify(state))
    expect(state.connected[0]?.modelsProblem).toMatch(/MiniMax couldn't be reached/)
    expect(await Promise.race([cancelled.promise.then(() => true), Bun.sleep(500)])).toBe(true)
  })

  test("RefreshProviderModels asks again, and a failure keeps the Models found before", async () => {
    const { web, fakes } = await scene()
    await request(web, { _tag: "ConnectProviderKey", provider: "openai", apiKey: goodKey })
    const asked = fakes.seen.length
    const answer = await request(web, { _tag: "RefreshProviderModels", provider: "openai" })
    expect(fakes.seen.length).toBe(asked + 1)
    expect(answer).toMatchObject({ _tag: "ProvidersState", connected: [{ provider: "openai" }] })

    // OpenAI fails meanwhile: the Models from before stay, with why the ask failed.
    fakes.modelsStatus = 500
    const failed = await request(web, { _tag: "RefreshProviderModels" })
    if (failed._tag !== "ProvidersState") throw new Error(JSON.stringify(failed))
    expect(failed.connected[0]?.models).toHaveLength(2)
    expect(failed.connected[0]?.modelsProblem).toMatch(/OpenAI answered 500/)
    expect(failed.models).toHaveLength(2)

    // Once it answers again, the problem goes.
    fakes.modelsStatus = undefined
    const fine = await request(web, { _tag: "RefreshProviderModels", provider: "openai" })
    if (fine._tag !== "ProvidersState") throw new Error(JSON.stringify(fine))
    expect(fine.connected[0]?.modelsProblem).toBeUndefined()
  })
})

describe("the Harness for Claude's Models (ADR 0030)", () => {
  test("is Claude Code until the Member chooses pi, on each of their connections, and kept", async () => {
    const dir = testDatabaseDir("kndl-providers-")
    dirs.push(dir)
    const database = databaseAt(join(dir, "hub.db"))
    const hub = await startHub({ config: withKey, providerApis: fakeProviders().layer, database })
    const web = await openWeb(hub, "alice", undefined, { setupToken: false })
    expect((await web.take("ProvidersState")).claudeHarness).toBe("ClaudeCode")
    const elsewhere = await openWeb(hub, "alice", web.cookie)
    await elsewhere.take("ProvidersState")
    const bob = await openWeb(hub, "bob", undefined, { setupToken: false })
    await bob.take("ProvidersState")

    expect(await request(web, { _tag: "SetClaudeHarness", harness: "Pi" })).toMatchObject({
      _tag: "ProvidersState",
      claudeHarness: "Pi",
    })
    expect((await elsewhere.take("ProvidersState")).claudeHarness).toBe("Pi")
    // Each Member's own.
    expect(await bob.untaken("ProvidersState")).toEqual([])
    expect((await request(bob, { _tag: "GetProviders" })) as unknown).toMatchObject({
      claudeHarness: "ClaudeCode",
    })
    await stopAll()

    const later = await startHub({ config: withKey, providerApis: fakeProviders().layer, database })
    const again = await openWeb(later, "alice", undefined, { setupToken: false })
    expect((await again.take("ProvidersState")).claudeHarness).toBe("Pi")
    expect(await request(again, { _tag: "SetClaudeHarness", harness: "ClaudeCode" })).toMatchObject(
      { claudeHarness: "ClaudeCode" },
    )
  })
})

describe("a Hub that restarts", () => {
  test("keeps each Connected provider, and asks for Models a day old again", async () => {
    const dir = testDatabaseDir("kndl-providers-")
    dirs.push(dir)
    const database = databaseAt(join(dir, "hub.db"))
    const first = fakeProviders()
    const hub = await startHub({ config: withKey, providerApis: first.layer, database })
    const web = await openWeb(hub, "alice", undefined, { setupToken: false })
    await request(web, { _tag: "ConnectProviderKey", provider: "openai", apiKey: goodKey })
    await stopAll()

    // A day later.
    const second = fakeProviders()
    const later = await startHub({
      config: withKey,
      providerApis: second.layer,
      database,
      clockAhead: Duration.hours(25),
    })
    const again = await openWeb(later, "alice", undefined, { setupToken: false })
    const welcomed = await again.take("ProvidersState")
    expect(welcomed.connected).toMatchObject([
      { provider: "openai", kind: "ApiKey", label: "good" },
    ])
    expect(welcomed.models).toHaveLength(2)
    await later.run(modelCall())
    expect(sentWith(second.fakes)).toEqual([`Bearer ${goodKey}`])
    // Asked off the welcome, with the key kept; alice hears once it answered.
    const checked = welcomed.connected[0]?.modelsCheckedAt ?? 0
    const refreshed = await again.take(
      "ProvidersState",
      (m) => (m.connected[0]?.modelsCheckedAt ?? 0) > checked,
    )
    expect(refreshed.connected[0]?.models).toHaveLength(2)
    expect(second.fakes.seen).toContainEqual(
      expect.objectContaining({
        url: "https://api.openai.com/v1/models",
        headers: expect.objectContaining({ authorization: `Bearer ${goodKey}` }),
      }),
    )
  })

  test("asks a sign-in's Models a day old once, when its refresh can't be had just now", async () => {
    const dir = testDatabaseDir("kndl-providers-")
    dirs.push(dir)
    const database = databaseAt(join(dir, "hub.db"))
    const first = fakeProviders()
    const hub = await startHub({ config: withKey, providerApis: first.layer, database })
    const web = await openWeb(hub, "alice", undefined, { setupToken: false })
    await web.take("ProvidersState")
    first.fakes.signIn = async () => oauth("access-old")
    web.send({ _tag: "StartSignIn", requestId: "t-1", provider: "openai" })
    await web.take("SignInEnded")
    await stopAll()

    // A day later its token has expired, and OpenAI's token endpoint is down.
    const second = fakeProviders()
    let refreshes = 0
    second.fakes.refresh = async () => {
      refreshes++
      throw new Error("fetch failed")
    }
    const later = await startHub({
      config: withKey,
      providerApis: second.layer,
      database,
      clockAhead: Duration.hours(25),
    })
    const again = await openWeb(later, "alice", undefined, { setupToken: false })
    const welcomed = await again.take("ProvidersState")
    const checked = welcomed.connected[0]?.modelsCheckedAt ?? 0
    const told = await again.take(
      "ProvidersState",
      (m) => (m.connected[0]?.modelsCheckedAt ?? 0) > checked,
    )
    // The Models found before stay, saying why they weren't asked for again.
    expect(told.connected[0]?.models).toEqual(welcomed.connected[0]?.models)
    expect(told.connected[0]?.modelsProblem).toMatch(/couldn't refresh the sign-in just now/)
    // Asked once: neither alice's web nor anything else asking for her Models asks OpenAI again.
    for (let i = 0; i < 3; i++) await request(again, { _tag: "GetProviders" })
    await later.run(Effect.flatMap(ModelCatalog, (catalog) => catalog.modelsFor(alice)))
    await Bun.sleep(100)
    expect(refreshes).toBe(1)
    expect(await again.untaken("ProvidersState")).toEqual([])
  })
})

describe("removing a Member", () => {
  test("forgets their Connected providers", async () => {
    const { hub, web } = await scene()
    await request(web, { _tag: "ConnectProviderKey", provider: "openai", apiKey: goodKey })
    await hub.run(
      Effect.gen(function* () {
        const providers = yield* ConnectedProviders
        yield* providers.forget(alice)
      }),
    )
    expect(await storedText(hub)).toBe("[]")
    const models = await hub.run(Effect.flatMap(ModelCatalog, (c) => c.modelsFor(alice)))
    expect(models).toEqual([])
  })
})
