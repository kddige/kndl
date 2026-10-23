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

/** A ChatGPT sign-in's access token, as a JWT whose claims name its account. */
const chatgptToken = [
  "e30",
  Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-alice" } }),
  ).toString("base64url"),
  "sig",
].join(".")

async function scene() {
  const seen: Array<Seen> = []
  const oauth: OAuthCredential = {
    type: "oauth",
    access: chatgptToken,
    refresh: "refresh-chatgpt",
    expires: Date.now() + 60 * 60 * 1000,
  }
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
          return new Response("v=0 codex answer", {
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
  return { hub, web, start, seen }
}

const talk = (hub: TestHub, sessionId: string, cookie: string, origin = webOrigin) =>
  fetch(`${hub.url}${liveVoicePath(sessionId)}`, {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify({ sdp: "v=0 offer" }),
  })

describe("live voice", () => {
  test("starts GPT-Live through ChatGPT for a ChatGPT sign-in, with client delegation", async () => {
    const { hub, web, start, seen } = await scene()
    web.send({ _tag: "StartSignIn", requestId: `v-${++requests}`, provider: "openai" })
    expect(await web.take("SignInEnded")).toMatchObject({ outcome: "Connected" })

    // Not chosen yet: the Model for a sign-in, in its default voice.
    const response = await talk(hub, start.sessionId, web.cookie)
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({
      sdp: "v=0 codex answer",
      model: "openai/gpt-live-1-codex",
      voice: "cove",
      protocol: "Codex",
    })
    const sent = seen.find((request) => request.url.includes("/realtime/calls"))
    expect(sent?.url).toBe(
      "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas",
    )
    expect(sent?.headers).toMatchObject({
      authorization: `Bearer ${chatgptToken}`,
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
        delegation: { type: "client" },
      },
    })
    expect(body.session.instructions).toContain("on kddige/kndl")

    // The API's Model takes a key alone: chosen with a sign-in, it says what to do.
    await ask(web, { _tag: "SetLiveVoice", setting: { model: "openai/gpt-live-1" } })
    const mismatched = await talk(hub, start.sessionId, web.cookie)
    expect(mismatched.status).toBe(409)
    expect(((await mismatched.json()) as { error: string }).error).toContain(
      "pick GPT-Live 1 (ChatGPT)",
    )
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
      setting: { model: "openai/gpt-live-1", voice: "quartz" },
    })
    expect(set).toMatchObject({ _tag: "ProvidersState", liveVoice: { voice: "quartz" } })

    const response = await talk(hub, start.sessionId, web.cookie)
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({
      sdp: "v=0 answer",
      model: "openai/gpt-live-1",
      voice: "quartz",
      protocol: "Live",
    })
    const sent = seen.find((request) => request.url.endsWith("/v1/live/sessions"))
    expect(sent?.url).toBe("https://api.openai.com/v1/live/sessions")
    expect(sent?.headers.authorization).toBe("Bearer sk-proj-FAKE_KEY_FOR_TESTS_ONLY_voice")
    expect(sent?.headers["chatgpt-account-id"]).toBeUndefined()
    expect(JSON.parse(sent?.body ?? "{}")).toMatchObject({
      session: { model: "gpt-live-1", audio: { output: { voice: "quartz" } } },
      transport: { type: "webrtc", sdp: "v=0 offer" },
    })
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
