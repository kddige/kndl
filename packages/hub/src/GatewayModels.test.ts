// The Gateway's model calls (ADR 0029), end to end: a real Hub, a fake Runner, the web UI over
// WebSockets, and fake Providers (ProviderApis.layerTest), reached as a pi Session reaches them,
// through `/gateway/models/<provider>/…` with the Session's mod token, and `/mod/providers`.

import { afterEach, describe, expect, test } from "bun:test"
import { connect } from "node:net"
import type { OAuthCredential } from "@earendil-works/pi-ai"
import { SessionId } from "@kndl/protocol"
import { Effect, Fiber, Option, Redacted } from "effect"
import { ProviderApis } from "./ConnectedProviders.ts"
import { Gateway, type ModelCallLimits } from "./Gateway.ts"
import type { HubConfigInput } from "./HubConfig.ts"
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
 * Session: its StartSession, with the mod token. A pi Session unless `harness` says Claude Code.
 */
async function scene(
  options: {
    readonly harness?: "Pi" | "ClaudeCode"
    readonly limits?: Partial<ModelCallLimits>
    readonly idleTimeout?: number
    readonly config?: Partial<HubConfigInput>
  } = {},
) {
  const seen: Array<Seen> = []
  const fakes = {
    seen,
    /** The Provider's answer to a model call. */
    answer: (_request: Request): Response | Promise<Response> => Response.json({ ok: true }),
    refresh: async (_credential: OAuthCredential): Promise<OAuthCredential> => {
      throw new Error("No refresh here")
    },
    signIn: async (): Promise<OAuthCredential> => oauth("access-1"),
    /** What the Hub's fetch was given besides the request. */
    inits: [] as Array<unknown>,
  }
  const hub = await startHub({
    config: {
      devLogin: true,
      secretsKey: Option.some(Redacted.make(generateSecretsKey())),
      ...options.config,
    },
    ...(options.limits !== undefined && { modelCallLimits: options.limits }),
    ...(options.idleTimeout !== undefined && { idleTimeout: options.idleTimeout }),
    providerApis: ProviderApis.layerTest({
      fetch: async (input, init) => {
        const url = new URL(input.url)
        fakes.inits.push(init)
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
  const runner = await openRunner(hub, (await issueRunnerToken(hub)).token, [], undefined, true, {
    harnesses: options.harness === "ClaudeCode" ? ["ClaudeCode"] : ["ClaudeCode", "Pi"],
  })
  const web = await openWeb(hub, "alice")
  await seedEnvironment(hub, repo, "dev:alice")
  const start = await startSession(web, runner, options.harness ?? "Pi")
  return { hub, runner, web, start, fakes }
}

/** Creates a Session of `repo` and plays its Runner's start: the StartSession it was sent. */
async function startSession(
  web: Connection<Web>,
  runner: Connection<ToRunner>,
  harness: "Pi" | "ClaudeCode",
) {
  web.send({
    _tag: "CreateSession",
    requestId: `m-${++requests}`,
    repo,
    branch: { _tag: "Existing", name: "main", newWorkBranch: true },
    // alice's first Model is Claude's, which runs on Claude Code unless pi is asked for (ADR 0030).
    harness,
  })
  const start = await runner.take("StartSession")
  runner.send({ _tag: "SessionStarted", sessionId: start.sessionId, environmentVersion: 1 })
  await web.take("SessionUpdated", (m) => m.session.id === start.sessionId && !m.session.starting)
  return start
}

/** alice signs in to the Provider, ChatGPT by default, and the Hub keeps `credential`. */
async function signIn(
  web: Connection<Web>,
  fakes: { signIn: () => Promise<OAuthCredential> },
  credential: OAuthCredential,
  provider = "openai",
) {
  fakes.signIn = async () => credential
  web.send({ _tag: "StartSignIn", requestId: `m-${++requests}`, provider })
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

/** Whether `check` holds within two seconds. */
async function eventually(check: () => boolean | Promise<boolean>) {
  for (let tries = 0; tries < 100; tries++) {
    if (await check()) return true
    await Bun.sleep(20)
  }
  return check()
}

/**
 * A model call's status, sent over a socket with its path exactly as written: fetch would tidy
 * away `..` and its encodings.
 */
const rawPost = (hub: TestHub, path: string, token: string) =>
  new Promise<number>((resolve, reject) => {
    const { hostname, port } = new URL(hub.url)
    const socket = connect(Number(port), hostname, () => {
      socket.write(
        `POST ${path} HTTP/1.1\r\nHost: ${hostname}\r\nAuthorization: Bearer ${token}\r\n` +
          `Content-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
      )
    })
    let answer = ""
    socket.on("data", (chunk) => {
      answer += chunk.toString()
    })
    socket.on("end", () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(answer)?.[1] ?? 0)))
    socket.on("error", reject)
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

    const response = await call(hub, "/openai/v1/responses?api-version=2", start.modToken)
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

  test("put the Creator's key where pi put the Session's: Google's header, Anthropic's, or a bearer", async () => {
    const { hub, web, start, fakes } = await scene()
    for (const provider of ["google", "minimax", "groq"]) {
      await ask(web, { _tag: "ConnectProviderKey", provider, apiKey: `${provider}-key` })
    }
    fakes.seen.length = 0

    // Google's API: pi's SDK sends the key as `x-goog-api-key`, and the relay's bearer besides.
    const google = await call(
      hub,
      "/google/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
      start.modToken,
      { headers: { "x-goog-api-key": start.modToken } },
    )
    expect(google.status).toBe(200)
    // Anthropic's Messages API, as MiniMax serves it: `x-api-key`.
    const minimax = await call(hub, "/minimax/anthropic/v1/messages", start.modToken, {
      headers: { "x-api-key": start.modToken, "anthropic-version": "2023-06-01" },
    })
    expect(minimax.status).toBe(200)
    // An OpenAI-style API: a bearer.
    const groq = await call(hub, "/groq/openai/v1/chat/completions", start.modToken)
    expect(groq.status).toBe(200)

    const [toGoogle, toMinimax, toGroq] = fakes.seen
    expect(toGoogle?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
    )
    expect(toGoogle?.headers["x-goog-api-key"]).toBe("google-key")
    expect(toGoogle?.headers.authorization).toBeUndefined()
    expect(toMinimax?.url).toBe("https://api.minimax.io/anthropic/v1/messages")
    expect(toMinimax?.headers["x-api-key"]).toBe("minimax-key")
    expect(toMinimax?.headers["anthropic-version"]).toBe("2023-06-01")
    expect(toMinimax?.headers.authorization).toBeUndefined()
    expect(toGroq?.url).toBe("https://api.groq.com/openai/v1/chat/completions")
    expect(toGroq?.headers.authorization).toBe("Bearer groq-key")
    expect(toGroq?.headers["x-api-key"]).toBeUndefined()
    expect(JSON.stringify(fakes.seen)).not.toContain(start.modToken)
  })

  test("send a sign-in's call as pi-ai's toAuth says: to its account's address, with its own headers", async () => {
    const { hub, web, start, fakes } = await scene()
    // A Copilot token names the account's endpoint: a Business seat's here.
    const copilot = oauth(
      "tid=1;exp=9999999999;sku=business;proxy-ep=proxy.business.githubcopilot.com",
    )
    await signIn(web, fakes, copilot, "github-copilot")
    await signIn(web, fakes, oauth("kimi-access"), "kimi-coding")
    fakes.seen.length = 0

    const toCopilot = await call(hub, "/github-copilot/chat/completions", start.modToken, {
      headers: { "copilot-integration-id": "vscode-chat" },
    })
    expect(toCopilot.status).toBe(200)
    const toKimi = await call(hub, "/kimi-coding/coding/v1/chat/completions", start.modToken)
    expect(toKimi.status).toBe(200)

    expect(fakes.seen.map((seen) => [seen.url, seen.headers.authorization])).toEqual([
      ["https://api.business.githubcopilot.com/chat/completions", `Bearer ${copilot.access}`],
      // Kimi's sign-in says a bearer header of its own, not a key.
      ["https://api.kimi.com/coding/v1/chat/completions", "Bearer kimi-access"],
    ])
    expect(fakes.seen[0]?.headers["copilot-integration-id"]).toBe("vscode-chat")
  })

  test("answer a Provider's redirect with a 502, as the MCP Gateway does: it isn't followed", async () => {
    const { hub, web, start, fakes } = await scene()
    await ask(web, { _tag: "ConnectProviderKey", provider: "openai", apiKey })
    fakes.answer = () =>
      new Response(null, { status: 307, headers: { location: "https://elsewhere.example/v1" } })
    const response = await call(hub, "/openai/v1/responses", start.modToken)
    expect(response.status).toBe(502)
    expect(response.headers.get("location")).toBeNull()
    expect(await response.json()).toEqual({
      error: { message: "OpenAI redirected the call, which the Gateway doesn't follow." },
    })
  })

  test("refuse a request without a live Session token", async () => {
    const { hub, web } = await scene()
    await ask(web, { _tag: "ConnectProviderKey", provider: "openai", apiKey })
    const response = await call(hub, "/openai/v1/responses", "not-a-token")
    expect(response.status).toBe(401)
  })

  test("refuse a Provider the Creator hasn't connected, in the Provider's error shape", async () => {
    const { hub, start, fakes } = await scene()
    for (const provider of ["openai", "xai", "anthropic"]) {
      const response = await call(hub, `/${provider}/v1/responses`, start.modToken)
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: { message: expect.any(String) } })
    }
    const unknown = await call(hub, "/amazon-bedrock/v1/models", start.modToken)
    expect(unknown.status).toBe(404)
    expect(fakes.seen.filter((seen) => !seen.url.includes("anthropic"))).toEqual([])
  })

  test("refresh a sign-in that expires soon before the call", async () => {
    const { hub, web, start, fakes } = await scene()
    await signIn(web, fakes, oauth("access-1", 60 * 1000))
    let refreshes = 0
    fakes.refresh = async () => oauth(`access-${++refreshes + 1}`)
    fakes.seen.length = 0

    const first = await call(hub, "/openai/v1/responses", start.modToken)
    expect(first.status).toBe(200)
    expect(fakes.seen.map((seen) => seen.headers.authorization)).toEqual(["Bearer access-2"])
  })

  test("refresh a sign-in the Provider refuses and send the call once more, but not again within a minute", async () => {
    const { hub, web, start, fakes } = await scene()
    await signIn(web, fakes, oauth("access-1"))
    let refreshes = 0
    fakes.refresh = async () => oauth(`access-${++refreshes + 1}`)
    fakes.seen.length = 0

    // The Provider refuses the token: refreshed, and the call sent once more, body and all.
    fakes.answer = (request) =>
      request.headers.get("authorization") === "Bearer access-1"
        ? Response.json({ error: { message: "expired" } }, { status: 401 })
        : Response.json({ ok: true })
    const first = await call(hub, "/openai/v1/responses", start.modToken)
    expect(first.status).toBe(200)
    expect(fakes.seen.map((seen) => [seen.headers.authorization, seen.body])).toEqual([
      ["Bearer access-1", body],
      ["Bearer access-2", body],
    ])
    expect(refreshes).toBe(1)

    // Refused again, within a minute of its refresh: the Provider's 401 is the answer, with no
    // refresh, so a Sandbox can't hammer the Provider's token endpoint.
    fakes.seen.length = 0
    fakes.answer = () => Response.json({ error: { message: "nope" } }, { status: 401 })
    for (let each = 0; each < 3; each++) {
      const refused = await call(hub, "/openai/v1/responses", start.modToken)
      expect(refused.status).toBe(401)
      expect(await refused.json()).toEqual({ error: { message: "nope" } })
    }
    expect(fakes.seen).toHaveLength(3)
    expect(refreshes).toBe(1)
  })

  test("send only the inference and model-listing calls pi makes: anything else is a 403", async () => {
    const { hub, web, start, fakes } = await scene()
    await ask(web, { _tag: "ConnectProviderKey", provider: "openai", apiKey })
    await ask(web, { _tag: "ConnectProviderKey", provider: "google", apiKey: "google-key" })
    fakes.seen.length = 0
    for (const [method, path] of [
      ["POST", "/openai/v1/files"],
      ["GET", "/openai/v1/files"],
      ["POST", "/openai/v1/batches"],
      ["POST", "/openai/v1/fine_tuning/jobs"],
      ["DELETE", "/openai/v1/models/ft:gpt-6"],
      ["GET", "/openai/v1/responses"],
      ["POST", "/google/v1beta/files"],
      ["POST", "/google/v1beta/cachedContents"],
    ] as const) {
      const refused = await call(hub, path, start.modToken, {
        method,
        ...(method !== "POST" && { body: null }),
      })
      expect([method, path, refused.status]).toEqual([method, path, 403])
      expect(await refused.json()).toEqual({
        error: { message: expect.stringMatching(/only.*model calls/i) },
      })
    }
    expect(fakes.seen).toEqual([])

    const listed = await call(hub, "/openai/v1/models", start.modToken, {
      method: "GET",
      body: null,
    })
    expect(listed.status).toBe(200)
    expect(fakes.seen.map((seen) => seen.url)).toEqual(["https://api.openai.com/v1/models"])
  })

  test("never send a call off the Provider's origin, however its path is written", async () => {
    const { hub, web, start, fakes } = await scene()
    await ask(web, { _tag: "ConnectProviderKey", provider: "openai", apiKey })
    fakes.seen.length = 0
    for (const path of [
      "/openai//evil.example/v1/responses",
      "/openai/%2F%2Fevil.example/v1/responses",
      "/openai/v1/%2fresponses",
      "/openai/@evil.example/v1/responses",
      "/openai@evil.example/v1/responses",
    ]) {
      const refused = await call(hub, path, start.modToken)
      expect([path, refused.status >= 400 && refused.status < 500]).toEqual([path, true])
    }
    expect(fakes.seen).toEqual([])

    // Sent as written, past what fetch would tidy: the Hub's server resolves the dot segments
    // before the Gateway sees the path, which is checked and sent as resolved.
    for (const path of [
      "/gateway/models/openai/v1/responses/../files",
      "/gateway/models/openai/v1/%2e%2e/v1/files",
      "/gateway/models/openai/../../gateway/models/openai/v1/batches",
    ]) {
      const status = await rawPost(hub, path, start.modToken)
      expect([path, status >= 400 && status < 500]).toEqual([path, true])
    }
    expect(fakes.seen).toEqual([])
    const resolved = await rawPost(hub, "/gateway/models/openai/v1/x/../responses", start.modToken)
    expect(resolved).toBe(200)
    expect(fakes.seen.map((seen) => seen.url)).toEqual(["https://api.openai.com/v1/responses"])
  })

  test("refuse a Claude Code Session's model calls: only pi Sessions spend Connected providers", async () => {
    const { hub, web, start, fakes } = await scene({ harness: "ClaudeCode" })
    await ask(web, { _tag: "ConnectProviderKey", provider: "openai", apiKey })
    fakes.seen.length = 0
    const refused = await call(hub, "/openai/v1/responses", start.modToken)
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({
      error: { message: expect.stringMatching(/pi Session/) },
    })
    expect(fakes.seen).toEqual([])
  })

  test("run a few model calls of a Session at once, and answer more with a 429", async () => {
    const { hub, web, start, fakes } = await scene({ limits: { perSession: 2 } })
    await ask(web, { _tag: "ConnectProviderKey", provider: "openai", apiKey })
    const ends: Array<() => void> = []
    fakes.answer = () => {
      const end = Promise.withResolvers<void>()
      ends.push(end.resolve)
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode("data: {}\n\n"))
            await end.promise
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    }
    const first = await call(hub, "/openai/v1/responses", start.modToken)
    const second = await call(hub, "/openai/v1/responses", start.modToken)
    expect([first.status, second.status]).toEqual([200, 200])

    const third = await call(hub, "/openai/v1/responses", start.modToken)
    expect(third.status).toBe(429)
    expect(await third.json()).toEqual({
      error: { message: expect.stringMatching(/2 model calls/) },
    })

    // One ends: there's room for another.
    ends[0]?.()
    await first.text()
    expect(
      await eventually(async () => {
        const next = await call(hub, "/openai/v1/responses", start.modToken)
        if (next.status === 200) await next.body?.cancel()
        return next.status === 200
      }),
    ).toBe(true)

    // The client gives one up: there's room again.
    await second.body?.cancel()
    expect(
      await eventually(async () => {
        const next = await call(hub, "/openai/v1/responses", start.modToken)
        if (next.status === 200) await next.body?.cancel()
        return next.status === 200
      }),
    ).toBe(true)
    for (const end of ends) end()
  })

  test("hold a sign-in's request bodies, to send again, up to what the Hub holds at once", async () => {
    const { hub, web, start, fakes } = await scene({
      limits: { heldBytes: 1000, requestBytes: 800 },
    })
    await signIn(web, fakes, oauth("access-1"))
    const big = JSON.stringify({ input: "x".repeat(580) })
    const answered = Promise.withResolvers<void>()
    let calls = 0
    fakes.answer = async () => {
      if (++calls === 1) await answered.promise
      return Response.json({ ok: true })
    }
    // The first call's body is held while its Provider thinks.
    const first = call(hub, "/openai/v1/responses", start.modToken, { body: big })
    await eventually(() => calls === 1)
    const second = await call(hub, "/openai/v1/responses", start.modToken, { body: big })
    expect(second.status).toBe(503)
    expect(await second.json()).toEqual({ error: { message: expect.stringMatching(/holding/i) } })
    answered.resolve()
    expect((await first).status).toBe(200)
    // Let go once its answer came.
    const third = await call(hub, "/openai/v1/responses", start.modToken, { body: big })
    expect(third.status).toBe(200)
  })

  test("let go of a held body once its call is given up, however much more of it comes", async () => {
    const { hub, web, start, fakes } = await scene({
      limits: { heldBytes: 1000, requestBytes: 800 },
    })
    await signIn(web, fakes, oauth("access-1"))
    const chunk = new TextEncoder().encode("x".repeat(300))
    const sent = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
    const streamed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk)
        sent.resolve(controller)
      },
    })
    await hub.run(
      Effect.gen(function* () {
        const gateway = yield* Gateway
        const given = yield* Effect.forkChild(
          gateway.model(SessionId.make(start.sessionId), "openai", {
            method: "POST",
            path: "/v1/responses",
            headers: new Headers({ "content-type": "application/json" }),
            keyHeader: "authorization",
            body: streamed,
          }),
        )
        yield* Effect.sleep(50)
        yield* Fiber.interrupt(given)
      }),
    )
    // The rest of its body comes after it was given up, if the Hub still reads it.
    const more = await sent.promise
    try {
      more.enqueue(chunk)
      more.enqueue(chunk)
      more.close()
    } catch {
      // It doesn't: the body was cancelled.
    }
    await Bun.sleep(50)

    // The Hub holds nothing of it: a call as large as it holds goes through.
    const big = JSON.stringify({ input: "x".repeat(580) })
    const next = await call(hub, "/openai/v1/responses", start.modToken, { body: big })
    expect(next.status).toBe(200)
  })

  test("refuse a Provider the Creator must connect again before reading the call's body", async () => {
    const { hub, web, start, fakes } = await scene()
    await signIn(web, fakes, oauth("access-1", 1000))
    fakes.refresh = async () => {
      throw new Error("OpenAI OAuth token request failed (401): invalid_grant")
    }
    expect((await call(hub, "/openai/v1/responses", start.modToken)).status).toBe(403)
    let pulled = 0
    const pulling = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++pulled > 3) controller.close()
        else controller.enqueue(new TextEncoder().encode("{}"))
      },
    })
    const refused = await hub.run(
      Effect.flatMap(Gateway, (gateway) =>
        gateway.model(SessionId.make(start.sessionId), "openai", {
          method: "POST",
          path: "/v1/responses",
          headers: new Headers({ "content-type": "application/json" }),
          keyHeader: "authorization",
          body: pulling,
        }),
      ),
    )
    expect(refused).toMatchObject({ _tag: "NotConnected" })
    // Nothing of it was read, beyond what a stream asks for at once.
    expect(pulled).toBeLessThanOrEqual(1)
  })

  test("stream an API key's request bodies, which are never sent again, so the Hub holds none", async () => {
    const { hub, web, start, fakes } = await scene({
      limits: { heldBytes: 1000, requestBytes: 800 },
    })
    await ask(web, { _tag: "ConnectProviderKey", provider: "openai", apiKey })
    const big = JSON.stringify({ input: "x".repeat(580) })
    const answered = Promise.withResolvers<void>()
    let calls = 0
    fakes.answer = async () => {
      if (++calls === 1) await answered.promise
      return Response.json({ ok: true })
    }
    const first = call(hub, "/openai/v1/responses", start.modToken, { body: big })
    await eventually(() => calls === 1)
    const second = await call(hub, "/openai/v1/responses", start.modToken, { body: big })
    expect(second.status).toBe(200)
    answered.resolve()
    expect((await first).status).toBe(200)
  })

  test("refuse a request body larger than the Gateway takes, said or streamed", async () => {
    const { hub, web, start, fakes } = await scene({ limits: { requestBytes: 800 } })
    await ask(web, { _tag: "ConnectProviderKey", provider: "openai", apiKey })
    const tooBig = JSON.stringify({ input: "x".repeat(900) })
    const said = await call(hub, "/openai/v1/responses", start.modToken, { body: tooBig })
    expect(said.status).toBe(413)
    expect(await said.json()).toEqual({ error: { message: expect.any(String) } })

    const streamed = await call(hub, "/openai/v1/responses", start.modToken, {
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (let each = 0; each < 10; each++) {
            controller.enqueue(new TextEncoder().encode("x".repeat(100)))
          }
          controller.close()
        },
      }),
    })
    expect(streamed.status).toBe(413)

    await signIn(web, fakes, oauth("access-1"))
    const held = await call(hub, "/openai/v1/responses", start.modToken, { body: tooBig })
    expect(held.status).toBe(413)
  })

  test("keep a model stream past the Hub's idle timeout, with no timeout of its own upstream", async () => {
    const { hub, web, start, fakes } = await scene({ idleTimeout: 1 })
    await ask(web, { _tag: "ConnectProviderKey", provider: "openai", apiKey })
    fakes.inits.length = 0
    fakes.answer = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            // Longer than Bun's idle timeout of 1 second, as it counts it.
            await Bun.sleep(5500)
            controller.enqueue(new TextEncoder().encode('data: {"late":true}\n\n'))
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    const response = await call(hub, "/openai/v1/responses", start.modToken)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('{"late":true}')
    expect(fakes.inits).toEqual([expect.objectContaining({ timeout: false, decompress: false })])
  }, 20_000)

  test("a refresh the Provider refuses is a 403 saying to connect again", async () => {
    const { hub, web, start, fakes } = await scene()
    await signIn(web, fakes, oauth("access-1", 1000))
    fakes.refresh = async () => {
      throw new Error("OpenAI OAuth token request failed (401): invalid_grant")
    }
    const response = await call(hub, "/openai/v1/responses", start.modToken)
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

  test("lists no Claude Models on a Hub with the Claude bridge off (HUB_CLAUDE_MODELS=off)", async () => {
    const { hub, web, start } = await scene({
      harness: "ClaudeCode",
      config: { claudeModels: false },
    })
    await ask(web, { _tag: "ConnectProviderKey", provider: "openai", apiKey })
    const answer = (await (
      await fetch(`${hub.url}/mod/providers`, { headers: bearer(start.modToken) })
    ).json()) as { models: Array<{ provider: string; id: string }> }
    expect(answer.models.length).toBeGreaterThan(0)
    expect(answer.models.filter((model) => model.provider === "anthropic")).toEqual([])
    const state = await ask(web, { _tag: "GetProviders" })
    expect(state).toMatchObject({ _tag: "ProvidersState" })
    const models = (state as unknown as { models: Array<{ provider: string }> }).models
    expect(models.filter((model) => model.provider === "anthropic")).toEqual([])
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
