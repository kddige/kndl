// Live voice (spike, ADR 0033), end to end: a real Hub, a fake Runner, alice on the web, and a
// fake OpenAI that answers `POST /v1/live/sessions` as GPT-Live does, reached with her own
// Connected provider.

import { afterEach, describe, expect, test } from "bun:test"
import type { OAuthCredential } from "@earendil-works/pi-ai"
import { liveVoicePath } from "@kndl/protocol"
import { Option, Redacted } from "effect"
import { ProviderApis } from "./ConnectedProviders.ts"
import { generateSecretsKey } from "./Secrets.ts"
import {
  type Connection,
  issueRunnerToken,
  openRunner,
  openWeb,
  stopAll,
  type Web,
} from "./testChannels.ts"
import { seedEnvironment, startHub, type TestHub, webOrigin } from "./testSupport.ts"

afterEach(stopAll)

const repo = "kddige/kndl"

let requests = 0

async function ask(web: Connection<Web>, command: Record<string, unknown> & { _tag: string }) {
  const requestId = `v-${++requests}`
  web.send({ ...command, requestId })
  return web.takeWhere(
    (message): message is Web =>
      "requestId" in message &&
      message.requestId === requestId &&
      message._tag !== "SignInStepped" &&
      message._tag !== "SignInEnded",
    `answer to ${command._tag}`,
  )
}

interface Seen {
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: string
}

/** A Codex sign-in's access token, as a JWT whose claims name its account, `n` for each refresh. */
const codexToken = (n: number) =>
  [
    "e30",
    Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-alice" }, n }),
    ).toString("base64url"),
    "sig",
  ].join(".")

const credential = (access: string): OAuthCredential => ({
  type: "oauth",
  access,
  refresh: `refresh-of-${access.length}`,
  expires: Date.now() + 60 * 60 * 1000,
})

async function scene() {
  const seen: Array<Seen> = []
  const fakes = {
    /** What the Codex backend answers a call with first: as the test says. */
    codexStatus: [] as Array<number>,
    /** What the Codex sign-in was asked to choose, and answered. */
    chosen: [] as Array<string>,
    refreshes: 0,
  }
  // kndl's own ChatGPT sign-in: OpenAI's Sign in with ChatGPT for apps.
  const oauth = credential("access-siwc")
  const hub = await startHub({
    config: { devLogin: true, secretsKey: Option.some(Redacted.make(generateSecretsKey())) },
    providerApis: ProviderApis.layerTest({
      fetch: async (input) => {
        const url = new URL(input.url)
        seen.push({
          url: input.url,
          headers: Object.fromEntries(input.headers),
          body: await input.clone().text(),
        })
        if (url.host === "api.anthropic.com") return new Response("down", { status: 503 })
        if (url.pathname === "/v1/models") {
          return Response.json({
            models: [{ slug: "gpt-6-sol", display_name: "GPT-6-Sol", visibility: "list" }],
          })
        }
        // Through ChatGPT's backend, the SDP answer alone, as Codex has it.
        if (url.host === "chatgpt.com" && url.pathname === "/backend-api/codex/realtime/calls") {
          const status = fakes.codexStatus.shift()
          if (status !== undefined) return new Response("Unauthorized", { status })
          return new Response("v=0 codex answer\r\na=ice-pwd:x\r\n", {
            status: 201,
            headers: { "content-type": "application/sdp", location: "/v1/live/rtc_1" },
          })
        }
        if (url.pathname === "/v1/live/sessions") {
          return Response.json(
            { session: { id: "live_123" }, transport: { type: "webrtc", sdp: "v=0 answer" } },
            { status: 201 },
          )
        }
        return new Response("no", { status: 404 })
      },
      signIn: async () => oauth,
      refresh: async () => oauth,
      // The Codex CLI's sign-in: device code, chosen by the Hub, then its code shown.
      codexSignIn: async (interaction) => {
        const chosen = await interaction.prompt({
          type: "select",
          message: "Select OpenAI Codex login method:",
          options: [
            { id: "browser", label: "Browser login (default)" },
            { id: "device_code", label: "Device code login (headless)" },
          ],
        } as never)
        fakes.chosen.push(chosen)
        interaction.notify({
          type: "device_code",
          verificationUri: "https://auth.openai.com/codex/device",
          userCode: "ABCD-1234",
        } as never)
        return credential(codexToken(0))
      },
      codexRefresh: async () => credential(codexToken(++fakes.refreshes)),
    }),
  })
  const runner = await openRunner(hub, (await issueRunnerToken(hub)).token)
  const web = await openWeb(hub, "alice")
  await seedEnvironment(hub, repo, "dev:alice")
  web.send({
    _tag: "CreateSession",
    requestId: `v-${++requests}`,
    repo,
    branch: { _tag: "Existing", name: "main", newWorkBranch: true },
  })
  const start = await runner.take("StartSession")
  runner.send({ _tag: "SessionStarted", sessionId: start.sessionId, environmentVersion: 1 })
  return { hub, web, start, seen, fakes }
}

const talk = (hub: TestHub, sessionId: string, cookie: string, origin = webOrigin) =>
  fetch(`${hub.url}${liveVoicePath(sessionId)}`, {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify({ sdp: "v=0 offer" }),
  })

describe("live voice", () => {
  test("signs in for live voice as the Codex CLI does, and starts GPT-Live through ChatGPT", async () => {
    const { hub, web, start, seen, fakes } = await scene()
    web.send({
      _tag: "StartSignIn",
      requestId: `v-${++requests}`,
      provider: "openai",
      for: "LiveVoice",
    })
    // By device code, chosen by the Hub, whose code the Member is shown.
    expect(await web.take("SignInStepped")).toMatchObject({
      for: "LiveVoice",
      step: { _tag: "EnterCode", code: "ABCD-1234" },
    })
    expect(await web.take("SignInEnded")).toMatchObject({ outcome: "Connected", for: "LiveVoice" })
    expect(fakes.chosen).toEqual(["device_code"])
    const state = await web.take("ProvidersState", (m) => m.liveVoiceConnection !== undefined)
    // Apart from the Connected providers: nothing there, no Models.
    expect(state.connected).toEqual([])
    expect(state.liveVoiceConnection).toMatchObject({ connectedAt: expect.any(Number) })

    // Not chosen yet: the Model for it, in its default voice.
    const response = await talk(hub, start.sessionId, web.cookie)
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({
      // Byte for byte: its last line's CRLF too.
      sdp: "v=0 codex answer\r\na=ice-pwd:x\r\n",
      model: "openai/gpt-live-1-codex",
      voice: "cove",
      protocol: "Codex",
      mode: "Reasoning",
    })
    const sent = seen.find((request) => request.url.includes("/realtime/calls"))
    expect(sent?.url).toBe(
      "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas",
    )
    expect(sent?.headers).toMatchObject({
      authorization: `Bearer ${codexToken(0)}`,
      "chatgpt-account-id": "acct-alice",
      "openai-alpha": "quicksilver=v2",
      "content-type": "application/json",
    })
    const body = JSON.parse(sent?.body ?? "{}")
    expect(body).toMatchObject({
      sdp: "v=0 offer",
      session: {
        model: "gpt-live-1-codex",
        audio: { output: { voice: "cove" } },
        // By default, a reasoning model behind the voice, with kndl's tools and web search.
        delegation: {
          type: "responses",
          responses: {
            model: "gpt-6-luna",
            tool_choice: "auto",
            parallel_tool_calls: false,
          },
        },
      },
    })
    expect(body.session.instructions).toContain("on kddige/kndl")
    const reasoning = body.session.delegation.responses
    expect(
      reasoning.tools.map((tool: { type: string; name?: string }) => tool.name ?? tool.type),
    ).toEqual([
      "send_to_agent",
      "agent_status",
      "read_agent_history",
      "answer_agent_question",
      "stop_agent",
      "web_search",
    ])
    expect(reasoning.instructions).toContain("use send_to_agent")
    // The voice hands work to the reasoning model; the history is the reasoning model's.
    expect(body.session.instructions).toContain("Behind you is a reasoning assistant")
    // What its channels mean, that the agent's answers are no requests, and nothing made up.
    expect(body.session.instructions).toContain("speakable channel is what to say now")
    expect(body.session.instructions).toContain("are not requests: never delegate them")
    expect(body.session.instructions).toContain("never make up what was done")

    // A 401 has the sign-in refreshed, and the call sent once more with the new token.
    fakes.codexStatus.push(401)
    seen.length = 0
    expect((await talk(hub, start.sessionId, web.cookie)).status).toBe(201)
    const calls = seen.filter((request) => request.url.includes("/realtime/calls"))
    expect(calls.map((call) => call.headers.authorization)).toEqual([
      `Bearer ${codexToken(0)}`,
      `Bearer ${codexToken(1)}`,
    ])
  })

  test("kndl's own ChatGPT sign-in doesn't start live voice: it says to sign in for it", async () => {
    const { hub, web, start, seen } = await scene()
    web.send({ _tag: "StartSignIn", requestId: `v-${++requests}`, provider: "openai" })
    expect(await web.take("SignInEnded")).toMatchObject({ outcome: "Connected" })
    const refused = await talk(hub, start.sessionId, web.cookie)
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { error: string }).error).toContain(
      "sign in with ChatGPT (Codex)",
    )
    // Nothing was sent to OpenAI's voice endpoints with it.
    expect(seen.some((request) => /realtime|live/.test(request.url))).toBe(false)
  })

  test("starts GPT-Live through OpenAI's API for an API key", async () => {
    const { hub, web, start, seen } = await scene()
    await ask(web, {
      _tag: "ConnectProviderKey",
      provider: "openai",
      apiKey: "sk-proj-FAKE_KEY_FOR_TESTS_ONLY_voice",
    })
    const set = await ask(web, {
      _tag: "SetLiveVoice",
      setting: { model: "openai/gpt-live-1", voice: "quartz", mode: "Talk" },
    })
    expect(set).toMatchObject({ _tag: "ProvidersState", liveVoice: { voice: "quartz" } })

    const response = await talk(hub, start.sessionId, web.cookie)
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({
      sdp: "v=0 answer",
      model: "openai/gpt-live-1",
      voice: "quartz",
      protocol: "Live",
      mode: "Talk",
    })
    const sent = seen.find((request) => request.url.endsWith("/v1/live/sessions"))
    expect(sent?.url).toBe("https://api.openai.com/v1/live/sessions")
    expect(sent?.headers.authorization).toBe("Bearer sk-proj-FAKE_KEY_FOR_TESTS_ONLY_voice")
    expect(sent?.headers["chatgpt-account-id"]).toBeUndefined()
    const body = JSON.parse(sent?.body ?? "{}")
    expect(body).toMatchObject({
      session: { model: "gpt-live-1", audio: { output: { voice: "quartz" } } },
      transport: { type: "webrtc", sdp: "v=0 offer" },
    })
    // Talk only: straight to the Session's agent.
    expect(body.session.delegation).toEqual({ type: "client" })
    // The API's channels, by its events' names.
    expect(body.session.instructions).toContain("session.commentary.append is an update to say")
    // It answers nothing about the code or the agent itself, nor claims a hand-off it didn't make.
    expect(body.session.instructions).toContain("never make up what the agent did")
    expect(body.session.instructions).toContain(
      "Never say you passed something on unless you delegated it",
    )
    expect(body.session.instructions).not.toContain("say in a few words that you are passing it on")
  })

  test("is the Creator's alone, and needs their OpenAI connection", async () => {
    const { hub, web, start } = await scene()
    // Not connected to OpenAI yet.
    const unconnected = await talk(hub, start.sessionId, web.cookie)
    expect(unconnected.status).toBe(409)
    expect(((await unconnected.json()) as { error: string }).error).toContain("Account page")

    const bob = await openWeb(hub, "bob")
    expect((await talk(hub, start.sessionId, bob.cookie)).status).toBe(403)
    // Only from the web UI.
    expect((await talk(hub, start.sessionId, web.cookie, "https://evil.test")).status).toBe(403)
  })
})
