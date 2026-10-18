// The Gateway's model calls (ADR 0029), end to end: a real Hub, a fake Runner, the web UI over
// WebSockets, and fake Providers (ProviderApis.layerTest), reached as a pi Session reaches them,
// through `/gateway/models/<provider>/…` with the Session's mod token, and `/mod/providers`.

import { afterEach, describe, expect, test } from "bun:test"
import type { OAuthCredential } from "@earendil-works/pi-ai"
import { Option, Redacted } from "effect"
import { ProviderApis } from "./ConnectedProviders.ts"
import { generateSecretsKey } from "./Secrets.ts"
import {
  type Connection,
  issueRunnerToken,
  openRunner,
  openWeb,
  stopAll,
  type ToRunner,
  type Web,
} from "./testChannels.ts"
import { bearer, seedEnvironment, startHub, type TestHub } from "./testSupport.ts"

afterEach(stopAll)

const repo = "kddige/kndl"
const apiKey = "sk-proj-FAKE_KEY_FOR_TESTS_ONLY_gate"

/** What a fake Provider was sent. */
interface Seen {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: string
}

let requests = 0

/** Sends `command` with a fresh request id, and returns the Hub's answer to it. */
async function ask(web: Connection<Web>, command: Record<string, unknown> & { _tag: string }) {
  const requestId = `m-${++requests}`
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

const oauth = (access: string, expiresIn = 60 * 60 * 1000): OAuthCredential => ({
  type: "oauth",
  access,
  refresh: `refresh-of-${access}`,
  expires: Date.now() + expiresIn,
})

/**
 * A Hub whose Providers are fakes, a Runner, and alice on the web with a Claude credential and a
 * Session: its StartSession, with the mod token.
 */
async function scene() {
  const seen: Array<Seen> = []
  const fakes = {
    seen,
    /** The Provider's answer to a model call. */
    answer: (_request: Request): Response | Promise<Response> => Response.json({ ok: true }),
    refresh: async (_credential: OAuthCredential): Promise<OAuthCredential> => {
      throw new Error("No refresh here")
    },
    signIn: async (): Promise<OAuthCredential> => oauth("access-1"),
  }
  const hub = await startHub({
    config: { devLogin: true, secretsKey: Option.some(Redacted.make(generateSecretsKey())) },
    providerApis: ProviderApis.layerTest({
      fetch: async (input) => {
        const url = new URL(input.url)
        seen.push({
          method: input.method,
          url: input.url,
          headers: Object.fromEntries(input.headers),
          body: await input.clone().text(),
        })
        if (url.host === "api.anthropic.com") return new Response("down", { status: 503 })
        if (url.pathname === "/v1/models") {
          const auth = input.headers.get("authorization") ?? ""
          return auth.startsWith("Bearer access-")
            ? Response.json({
                models: [{ slug: "gpt-6-sol", display_name: "GPT-6-Sol", visibility: "list" }],
              })
            : Response.json({ data: [{ id: "gpt-6-sol" }] })
        }
        return fakes.answer(input)
      },
      signIn: () => fakes.signIn(),
      refresh: (_provider, credential) => fakes.refresh(credential),
    }),
  })
  const runner = await openRunner(hub, (await issueRunnerToken(hub)).token)
  const web = await openWeb(hub, "alice")
  await seedEnvironment(hub, repo, "dev:alice")
  const start = await startSession(web, runner)
  return { hub, runner, web, start, fakes }
}

/** Creates a Session of `repo` and plays its Runner's start: the StartSession it was sent. */
async function startSession(web: Connection<Web>, runner: Connection<ToRunner>) {
  web.send({
    _tag: "CreateSession",
    requestId: `m-${++requests}`,
    repo,
    branch: { _tag: "Existing", name: "main", newWorkBranch: true },
  })
  const start = await runner.take("StartSession")
  runner.send({ _tag: "SessionStarted", sessionId: start.sessionId, environmentVersion: 1 })
  await web.take("SessionUpdated", (m) => m.session.id === start.sessionId && !m.session.starting)
  return start
}

/** alice signs in to ChatGPT, and the Hub keeps `credential`. */
async function signIn(
  web: Connection<Web>,
  fakes: { signIn: () => Promise<OAuthCredential> },
  credential: OAuthCredential,
) {
  fakes.signIn = async () => credential
  web.send({ _tag: "StartSignIn", requestId: `m-${++requests}`, provider: "openai" })
  expect(await web.take("SignInEnded")).toMatchObject({ outcome: "Connected" })
}

const body = JSON.stringify({ model: "gpt-6-sol", input: "hi", stream: true })

/** A model call through the Gateway, as pi makes it through the Runner's relay. */
const call = (hub: TestHub, path: string, token: string, init: RequestInit = {}) =>
  fetch(`${hub.url}/gateway/models${path}`, {
    method: "POST",
    body,
    ...init,
    headers: {
      "content-type": "application/json",
      ...bearer(token),
      ...init.headers,
    },
  })

describe("the Gateway's model calls", () => {
  test("send a call to the Provider on the Creator's key, and stream its answer back", async () => {
    const { hub, web, start, fakes } = await scene()
    await ask(web, { _tag: "ConnectProviderKey", provider: "openai", apiKey })
    fakes.seen.length = 0
    const second = Promise.withResolvers<void>()
    fakes.answer = () => {
      const encoder = new TextEncoder()
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode('data: {"first":true}\n\n'))
            await second.promise
            controller.enqueue(encoder.encode('data: {"second":true}\n\n'))
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream", "x-request-id": "req-1" } },
      )
    }

    const response = await call(hub, "/openai/responses?api-version=2", start.modToken, {
      headers: { "x-api-key": start.modToken, "x-goog-api-key": start.modToken },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    expect(response.headers.get("x-request-id")).toBe("req-1")
    const reader = response.body?.getReader()
    if (reader === undefined) throw new Error("No body")
    const decoder = new TextDecoder()
    // The first event arrives before the Provider sends the second.
    expect(decoder.decode((await reader.read()).value)).toContain('{"first":true}')
    second.resolve()
    let rest = ""
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      rest += decoder.decode(chunk.value)
    }
    expect(rest).toContain('{"second":true}')

    // To pi-ai's own URL for the Provider, with the Creator's key in place of the Session's.
    expect(fakes.seen).toHaveLength(1)
    const sent = fakes.seen[0]
    expect(sent).toMatchObject({
      method: "POST",
      url: "https://api.openai.com/v1/responses?api-version=2",
      body,
    })
    expect(sent?.headers.authorization).toBe(`Bearer ${apiKey}`)
    expect(sent?.headers["x-api-key"]).toBeUndefined()
    expect(sent?.headers["x-goog-api-key"]).toBeUndefined()
    expect(sent?.headers["content-type"]).toBe("application/json")
    expect(JSON.stringify(sent?.headers)).not.toContain(start.modToken)
  })

  test("refuse a request without a live Session token", async () => {
    const { hub, web } = await scene()
    await ask(web, { _tag: "ConnectProviderKey", provider: "openai", apiKey })
    const response = await call(hub, "/openai/responses", "not-a-token")
    expect(response.status).toBe(401)
  })

  test("refuse a Provider the Creator hasn't connected, in the Provider's error shape", async () => {
    const { hub, start, fakes } = await scene()
    for (const provider of ["openai", "xai", "anthropic"]) {
      const response = await call(hub, `/${provider}/responses`, start.modToken)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: { message: expect.any(String) } })
    }
    const unknown = await call(hub, "/google/models", start.modToken)
    expect(unknown.status).toBe(404)
    expect(fakes.seen.filter((seen) => !seen.url.includes("anthropic"))).toEqual([])
  })

  test("refresh a sign-in that expires soon before the call, and once more after a 401", async () => {
    const { hub, web, start, fakes } = await scene()
    await signIn(web, fakes, oauth("access-1", 60 * 1000))
    let refreshes = 0
    fakes.refresh = async () => oauth(`access-${++refreshes + 1}`)
    fakes.seen.length = 0

    // Near expiry: refreshed first.
    const first = await call(hub, "/openai/responses", start.modToken)
    expect(first.status).toBe(200)
    expect(fakes.seen.map((seen) => seen.headers.authorization)).toEqual(["Bearer access-2"])

    // The Provider refuses the token: refreshed, and the call sent once more, body and all.
    fakes.seen.length = 0
    fakes.answer = (request) =>
      request.headers.get("authorization") === "Bearer access-2"
        ? Response.json({ error: { message: "expired" } }, { status: 401 })
        : Response.json({ ok: true })
    const second = await call(hub, "/openai/responses", start.modToken)
    expect(second.status).toBe(200)
    expect(fakes.seen.map((seen) => [seen.headers.authorization, seen.body])).toEqual([
      ["Bearer access-2", body],
      ["Bearer access-3", body],
    ])

    // Refused again: the Provider's 401 is the answer, and it isn't sent a third time.
    fakes.seen.length = 0
    fakes.answer = () => Response.json({ error: { message: "nope" } }, { status: 401 })
    const third = await call(hub, "/openai/responses", start.modToken)
    expect(third.status).toBe(401)
    expect(fakes.seen).toHaveLength(2)
  })

  test("a refresh the Provider refuses is a 403 saying to connect again", async () => {
    const { hub, web, start, fakes } = await scene()
    await signIn(web, fakes, oauth("access-1", 1000))
    fakes.refresh = async () => {
      throw new Error("OpenAI OAuth token request failed (401): invalid_grant")
    }
    const response = await call(hub, "/openai/responses", start.modToken)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: { message: expect.stringMatching(/connect/i) },
    })
  })

  test("an MCP Installation's path is still the MCP Gateway's", async () => {
    const { hub, start } = await scene()
    // Installation ids are random hex, never `models`.
    const installation = await fetch(`${hub.url}/gateway/0123456789abcdef01234567`, {
      method: "POST",
      headers: bearer(start.modToken),
    })
    expect(installation.status).toBe(403)
    const below = await fetch(`${hub.url}/gateway/0123456789abcdef01234567/.well-known/x`, {
      headers: bearer(start.modToken),
    })
    expect(below.status).toBe(404)
  })
})

describe("GET /mod/providers", () => {
  test("answers the Creator's Models, Claude's among them", async () => {
    const { hub, web, start } = await scene()
    const before = await fetch(`${hub.url}/mod/providers`, { headers: bearer(start.modToken) })
    expect(before.status).toBe(200)
    const claude = (await before.json()) as { models: Array<{ provider: string; id: string }> }
    expect(claude.models.length).toBeGreaterThan(0)
    expect(claude.models.every((model) => model.provider === "anthropic")).toBe(true)

    await ask(web, { _tag: "ConnectProviderKey", provider: "openai", apiKey })
    const after = (await (
      await fetch(`${hub.url}/mod/providers`, { headers: bearer(start.modToken) })
    ).json()) as { models: Array<{ provider: string; id: string }> }
    expect(after.models).toContainEqual(
      expect.objectContaining({ provider: "openai", id: "gpt-6-sol" }),
    )
    expect(after.models[0]?.provider).toBe("anthropic")

    expect(after).not.toHaveProperty("signedIn")

    const refused = await fetch(`${hub.url}/mod/providers`, { headers: bearer("nope") })
    expect(refused.status).toBe(401)
  })

  test("says which Providers are signed in, whose requests the extension keeps to what a sign-in takes", async () => {
    const { hub, web, start, fakes } = await scene()
    await signIn(web, fakes, oauth("access-1"))
    const answer = (await (
      await fetch(`${hub.url}/mod/providers`, { headers: bearer(start.modToken) })
    ).json()) as { signedIn?: Array<string> }
    expect(answer.signedIn).toEqual(["openai"])
  })
})
