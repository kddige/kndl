import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { credentialFromSecret, type ClaudeCredential } from "@claude-hub/protocol"
import { Cause, Effect, Exit, Logger, Redacted, Scope } from "effect"
import { sessionId } from "../testSupport.ts"
import { OAuthBeta, serveCredentialProxy, upstreamHeaders } from "./CredentialProxy.ts"
import { NoClaudeCredential, RunnerCredential } from "./RunnerCredential.ts"
import { makeSessionTokens, SessionTokenPrefix, SessionTokens } from "./SessionTokens.ts"

// Fake credentials only: none of these is a real one.
const sessionOAuth = "sk-ant-oat01-session-FAKE-0001"
const sessionApiKey = "sk-ant-api03-session-FAKE-0002"
const runnerOAuth = "sk-ant-oat01-runner-FAKE-0003"
const runnerRotated = "sk-ant-oat01-runner-FAKE-0004"
const modToken = "chm_mod.FAKE-0005"

interface Seen {
  readonly method: string
  readonly path: string
  readonly search: string
  readonly headers: Record<string, string>
  readonly body: string
}

/** Stands in for Anthropic's API: records what it is sent, and refuses tokens it's told to. */
const anthropic = {
  seen: [] as Array<Seen>,
  refused: new Set<string>(),
  /** Holds a streamed Turn's second event back until resolved. */
  gate: Promise.withResolvers<void>(),
}

const record = async (request: Request, into: Array<Seen>) => {
  const url = new URL(request.url)
  into.push({
    method: request.method,
    path: url.pathname,
    search: url.search,
    headers: Object.fromEntries(request.headers),
    body: await request.text(),
  })
  return url
}

const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  fetch: async (request) => {
    const url = await record(request, anthropic.seen)
    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "")
    if (bearer !== undefined && anthropic.refused.has(bearer))
      return Response.json({ type: "error" }, { status: 401 })
    if (url.searchParams.get("stream") === "1") {
      const encoder = new TextEncoder()
      const gate = anthropic.gate.promise
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(encoder.encode("event: one\n\n"))
            await gate
            controller.enqueue(encoder.encode("event: two\n\n"))
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream", "request-id": "req_1" } },
      )
    }
    return Response.json({ answered: url.pathname }, { headers: { "request-id": "req_2" } })
  },
})

/** Stands in for the Hub's mod endpoints. */
const hub = {
  seen: [] as Array<Seen>,
}

const fakeHub = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  fetch: async (request) => {
    const url = await record(request, hub.seen)
    if (request.headers.get("authorization") !== `Bearer ${modToken}`)
      return Response.json({ message: "unknown mod token" }, { status: 401 })
    if (url.pathname === "/mod/commands") {
      await Bun.sleep(Number(url.searchParams.get("waitMs") ?? 0))
      return Response.json({ messages: [] })
    }
    if (url.pathname === "/mod/hello")
      return Response.json({ _tag: "ModWelcome", protocolVersion: 1 })
    return new Response(null, { status: 204 })
  },
})

afterAll(async () => {
  await upstream.stop(true)
  await fakeHub.stop(true)
})

/**
 * The Runner's credential as the real one behaves: `current` is what it read last, and `reread`
 * reads what's on the host now, `runner.onHost`.
 */
const runner = {
  held: runnerOAuth as string | undefined,
  onHost: runnerOAuth as string | undefined,
  rereads: 0,
}

const held = Effect.suspend(() => {
  const credential = runner.held === undefined ? undefined : credentialFromSecret(runner.held)
  return credential === undefined
    ? Effect.fail(new NoClaudeCredential({ message: "there is no Keychain item" }))
    : Effect.succeed(credential)
})

const runnerCredential = RunnerCredential.of({
  current: held,
  reread: Effect.suspend(() => {
    runner.rereads++
    runner.held = runner.onHost
    return held
  }),
  describe: Effect.map(held, (credential) => ({ credential, from: "a test" })),
})

let logs: Array<string> = []

beforeEach(() => {
  anthropic.seen = []
  anthropic.refused.clear()
  anthropic.gate = Promise.withResolvers<void>()
  hub.seen = []
  runner.held = runnerOAuth
  runner.onHost = runnerOAuth
  runner.rereads = 0
  logs = []
})

/** Every log line, with its cause, as text. */
const captured = Logger.layer([
  Logger.make(({ logLevel, message, cause }) => {
    const text = Array.isArray(message) ? message.join(" ") : String(message)
    logs.push(`${logLevel}: ${text}${cause.reasons.length === 0 ? "" : ` ${Cause.pretty(cause)}`}`)
  }),
])

interface Proxy {
  readonly url: string
  readonly tokens: SessionTokens["Service"]
  readonly issue: (id: string, credential?: ClaudeCredential) => Promise<string>
}

/** Runs `body` against a proxy on a free port, then checks nothing secret was logged. */
const withProxy = async (body: (proxy: Proxy) => Promise<void>) => {
  const tokens = makeSessionTokens()
  const scope = Effect.runSync(Scope.make())
  const issued: Array<string> = []
  const port = await Effect.runPromise(
    serveCredentialProxy({
      port: 0,
      hubUrl: fakeHub.url,
      upstream: upstream.url.href,
    }).pipe(
      Scope.provide(scope),
      Effect.provideService(SessionTokens, tokens),
      Effect.provideService(RunnerCredential, runnerCredential),
      Effect.provide(captured),
    ),
  )
  try {
    await body({
      url: `http://127.0.0.1:${port}`,
      tokens,
      issue: async (id, credential) => {
        const token = await Effect.runPromise(
          tokens.issue({
            sessionId: sessionId(id),
            modToken: Redacted.make(modToken),
            ...(credential === undefined ? {} : { credential }),
          }),
        )
        issued.push(Redacted.value(token))
        return Redacted.value(token)
      },
    })
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
  const secrets = [sessionOAuth, sessionApiKey, runnerOAuth, runnerRotated, modToken, ...issued]
  for (const line of logs) for (const secret of secrets) expect(line).not.toContain(secret)
}

const oauth = (secret: string) => credentialFromSecret(secret) as ClaudeCredential

const messages = (url: string, token: string | undefined, init: RequestInit = {}) =>
  fetch(`${url}/v1/messages?beta=true`, {
    method: "POST",
    ...init,
    headers: {
      "content-type": "application/json",
      "anthropic-beta": `${OAuthBeta},claude-code-20250219`,
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...init.headers,
    },
    body: init.body ?? JSON.stringify({ model: "claude-haiku", max_tokens: 1 }),
  })

/** Sends a request as written, without fetch resolving its path first. */
const raw = async (port: string, method: string, path: string, token: string) => {
  const { promise, resolve } = Promise.withResolvers<string>()
  let text = ""
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port: Number(port),
    socket: {
      data: (_socket, chunk) => void (text += new TextDecoder().decode(chunk)),
      close: () => resolve(text),
    },
  })
  socket.write(
    `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\nConnection: close\r\n\r\n`,
  )
  const response = await promise
  return Number(response.split(" ")[1])
}

describe("authentication", () => {
  test("answers Claude Code's connectivity check itself, without a token", () =>
    withProxy(async ({ url }) => {
      const response = await fetch(`${url}/api/hello`, { method: "HEAD" })
      expect(response.status).toBe(200)
      expect(anthropic.seen).toEqual([])
    }))

  test("answers 401 to a request with no token, or one that isn't live, as Anthropic would", () =>
    withProxy(async ({ url, issue }) => {
      await issue("s-1")
      for (const token of [undefined, "chp_guessed", sessionOAuth]) {
        const response = await messages(url, token)
        expect(response.status).toBe(401)
        expect(await response.json()).toMatchObject({
          type: "error",
          error: { type: "authentication_error" },
        })
      }
      expect(anthropic.seen).toEqual([])
    }))

  test("takes the Session token as an API key too", () =>
    withProxy(async ({ url, issue }) => {
      const token = await issue("s-1", oauth(sessionOAuth))
      const response = await fetch(`${url}/v1/models`, { headers: { "x-api-key": token } })
      expect(response.status).toBe(200)
      expect(anthropic.seen[0]?.headers.authorization).toBe(`Bearer ${sessionOAuth}`)
    }))

  test("refuses a revoked token, and a Session's earlier one once it has a new one", () =>
    withProxy(async ({ url, issue, tokens }) => {
      const first = await issue("s-1")
      const second = await issue("s-1")
      expect((await messages(url, first)).status).toBe(401)
      expect((await messages(url, second)).status).toBe(200)
      await Effect.runPromise(tokens.revoke(sessionId("s-1")))
      expect((await messages(url, second)).status).toBe(401)
      expect(anthropic.seen).toHaveLength(1)
    }))
})

describe("paths", () => {
  test("forwards Claude Code's three requests, with their query, and nothing else", () =>
    withProxy(async ({ url, issue }) => {
      const token = await issue("s-1")
      const headers = { authorization: `Bearer ${token}` }
      expect((await messages(url, token)).status).toBe(200)
      const count = await fetch(`${url}/v1/messages/count_tokens`, { method: "POST", headers })
      expect(count.status).toBe(200)
      expect((await fetch(`${url}/v1/models?limit=1000`, { headers })).status).toBe(200)
      expect(anthropic.seen.map((seen) => `${seen.method} ${seen.path}${seen.search}`)).toEqual([
        "POST /v1/messages?beta=true",
        "POST /v1/messages/count_tokens",
        "GET /v1/models?limit=1000",
      ])

      for (const [method, path] of [
        ["GET", "/v1/messages"],
        ["POST", "/v1/complete"],
        ["GET", "/api/oauth/profile"],
        ["POST", "/v1/files"],
        ["DELETE", "/v1/models"],
        ["GET", "/v1/models/claude-haiku"],
      ] as const) {
        const response = await fetch(`${url}${path}`, { method, headers })
        expect(response.status).toBe(404)
        expect(await response.json()).toMatchObject({ error: { type: "not_found_error" } })
      }
      expect(anthropic.seen).toHaveLength(3)
    }))

  test("checks a path once its dot segments are resolved", () =>
    withProxy(async ({ url, issue }) => {
      const token = await issue("s-1")
      const port = new URL(url).port
      expect(await raw(port, "GET", "/v1/messages/../models", token)).toBe(200)
      expect(await raw(port, "GET", "/v1/messages/%2e%2e/models", token)).toBe(200)
      expect(await raw(port, "GET", "/v1/models/../../api/oauth/profile", token)).toBe(404)
      expect(await raw(port, "GET", "/v1/%2E%2E/api/oauth/usage", token)).toBe(404)
      expect(anthropic.seen.map((seen) => seen.path)).toEqual(["/v1/models", "/v1/models"])
    }))
})

describe("credentials", () => {
  test("sends a Session's subscription token as a bearer, with the beta flag once", () =>
    withProxy(async ({ url, issue }) => {
      const token = await issue("s-1", oauth(sessionOAuth))
      const response = await messages(url, token, { body: '{"model":"x","stream":false}' })
      expect(await response.json()).toEqual({ answered: "/v1/messages" })
      expect(response.headers.get("request-id")).toBe("req_2")
      const [seen] = anthropic.seen
      expect(seen?.headers.authorization).toBe(`Bearer ${sessionOAuth}`)
      expect(seen?.headers["x-api-key"]).toBeUndefined()
      expect(seen?.headers["anthropic-beta"]).toBe(`claude-code-20250219,${OAuthBeta}`)
      expect(seen?.body).toBe('{"model":"x","stream":false}')
    }))

  test("sends a Session's API key as x-api-key, without the subscription's beta flag", () =>
    withProxy(async ({ url, issue }) => {
      const token = await issue("s-1", credentialFromSecret(sessionApiKey))
      expect((await messages(url, token)).status).toBe(200)
      const models = await fetch(`${url}/v1/models`, {
        headers: { authorization: `Bearer ${token}`, "anthropic-beta": OAuthBeta },
      })
      expect(models.status).toBe(200)
      const [turn, list] = anthropic.seen
      expect(turn?.headers["x-api-key"]).toBe(sessionApiKey)
      expect(turn?.headers.authorization).toBeUndefined()
      expect(turn?.headers["anthropic-beta"]).toBe("claude-code-20250219")
      expect(list?.headers["anthropic-beta"]).toBeUndefined()
    }))

  test("uses the Runner's credential for a Session without its own", () =>
    withProxy(async ({ url, issue }) => {
      const token = await issue("s-1")
      expect((await messages(url, token)).status).toBe(200)
      expect(anthropic.seen[0]?.headers.authorization).toBe(`Bearer ${runnerOAuth}`)
      expect(logs).toContainEqual(
        expect.stringMatching(
          /^Info: Session s-1: POST \/v1\/messages 200 in \d+ ms, on the Runner's credential$/,
        ),
      )
    }))

  test("reads the Runner's credential again when Anthropic refuses it, and retries once", () =>
    withProxy(async ({ url, issue }) => {
      const token = await issue("s-1")
      anthropic.refused.add(runnerOAuth)
      // Unchanged on the host: the refusal is passed back, not sent again.
      expect((await messages(url, token)).status).toBe(401)
      expect(runner.rereads).toBe(1)
      expect(anthropic.seen).toHaveLength(1)

      // Replaced on the host meanwhile: sent once more, with the new one.
      anthropic.seen = []
      runner.onHost = runnerRotated
      expect((await messages(url, token)).status).toBe(200)
      expect(runner.rereads).toBe(2)
      expect(anthropic.seen.map((seen) => seen.headers.authorization)).toEqual([
        `Bearer ${runnerOAuth}`,
        `Bearer ${runnerRotated}`,
      ])
    }))

  test("passes a refusal of a Session's own credential back, without retrying", () =>
    withProxy(async ({ url, issue }) => {
      const token = await issue("s-1", oauth(sessionOAuth))
      anthropic.refused.add(sessionOAuth)
      expect((await messages(url, token)).status).toBe(401)
      expect(runner.rereads).toBe(0)
      expect(anthropic.seen).toHaveLength(1)
    }))

  test("answers 401 when neither the Session nor the Runner has a credential", () =>
    withProxy(async ({ url, issue }) => {
      runner.held = undefined
      const token = await issue("s-1")
      const response = await messages(url, token)
      expect(response.status).toBe(401)
      expect(await response.json()).toMatchObject({ error: { type: "authentication_error" } })
      expect(anthropic.seen).toEqual([])
    }))
})

describe("streaming", () => {
  test("streams a response as it comes, before Anthropic has finished it", () =>
    withProxy(async ({ url, issue }) => {
      const token = await issue("s-1")
      const response = await fetch(`${url}/v1/messages?stream=1`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "{}",
      })
      expect(response.headers.get("content-type")).toBe("text/event-stream")
      expect(response.headers.get("request-id")).toBe("req_1")
      const reader = (response.body as ReadableStream<Uint8Array>).getReader()
      const decoder = new TextDecoder()
      const first = await reader.read()
      expect(decoder.decode(first.value)).toBe("event: one\n\n")
      anthropic.gate.resolve()
      let rest = ""
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
        rest += decoder.decode(chunk.value)
      expect(rest).toBe("event: two\n\n")
    }))

  test("answers 502 when Anthropic can't be reached", async () => {
    const tokens = makeSessionTokens()
    const scope = Effect.runSync(Scope.make())
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
    const dead = closed.url.href
    await closed.stop(true)
    const port = await Effect.runPromise(
      serveCredentialProxy({ port: 0, hubUrl: new URL(dead), upstream: dead }).pipe(
        Scope.provide(scope),
        Effect.provideService(SessionTokens, tokens),
        Effect.provideService(RunnerCredential, runnerCredential),
        Effect.provide(captured),
      ),
    )
    try {
      const token = await Effect.runPromise(
        tokens.issue({ sessionId: sessionId("s-1"), modToken: Redacted.make(modToken) }),
      )
      const response = await messages(`http://127.0.0.1:${port}`, Redacted.value(token))
      expect(response.status).toBe(502)
      expect(await response.json()).toMatchObject({ error: { type: "api_error" } })
      const hello = await fetch(`http://127.0.0.1:${port}/mod/hello`, {
        method: "POST",
        headers: { authorization: `Bearer ${Redacted.value(token)}` },
      })
      expect(hello.status).toBe(502)
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void))
    }
  })
})

describe("mod relay", () => {
  test("relays the mod's calls to the Hub with the Session's mod token", () =>
    withProxy(async ({ url, issue }) => {
      const token = await issue("s-1")
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
      const hello = await fetch(`${url}/mod/hello`, {
        method: "POST",
        headers,
        body: '{"protocolVersion":1}',
      })
      expect(await hello.json()).toEqual({ _tag: "ModWelcome", protocolVersion: 1 })
      const events = await fetch(`${url}/mod/events`, { method: "POST", headers, body: "[]" })
      expect(events.status).toBe(204)
      expect(hub.seen.map((seen) => [seen.method, seen.path, seen.body])).toEqual([
        ["POST", "/mod/hello", '{"protocolVersion":1}'],
        ["POST", "/mod/events", "[]"],
      ])
      for (const seen of hub.seen) expect(seen.headers.authorization).toBe(`Bearer ${modToken}`)
      expect(anthropic.seen).toEqual([])
    }))

  test("passes a long poll through, waiting as long as the Hub does", () =>
    withProxy(async ({ url, issue }) => {
      const token = await issue("s-1")
      const started = Date.now()
      const response = await fetch(`${url}/mod/commands?after=3&waitMs=300`, {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(await response.json()).toEqual({ messages: [] })
      expect(Date.now() - started).toBeGreaterThanOrEqual(290)
      expect(hub.seen[0]?.search).toBe("?after=3&waitMs=300")
    }))

  test("asks a held token to retry, and relays it once the Hub sends a mod token (#157)", () =>
    withProxy(async ({ url, tokens, issue }) => {
      const kept = `${SessionTokenPrefix}${"k".repeat(43)}`
      expect(await Effect.runPromise(tokens.hold(sessionId("s-1"), kept))).toBe(true)
      const hello = () =>
        fetch(`${url}/mod/hello`, {
          method: "POST",
          headers: { authorization: `Bearer ${kept}`, "content-type": "application/json" },
          body: '{"protocolVersion":1}',
        })

      const retry = await hello()
      expect(retry.status).toBe(503)
      expect(retry.headers.get("retry-after")).toBe("1")
      expect((await messages(url, kept)).status).toBe(503)
      expect(hub.seen).toEqual([])
      expect(anthropic.seen).toEqual([])

      expect(await issue("s-1")).toBe(kept)
      expect((await hello()).status).toBe(200)
      expect(hub.seen[0]?.headers.authorization).toBe(`Bearer ${modToken}`)
      expect((await messages(url, kept)).status).toBe(200)
    }))

  test("refuses the mod without a live token, and methods the mod doesn't use", () =>
    withProxy(async ({ url, issue }) => {
      const token = await issue("s-1")
      const unknown = await fetch(`${url}/mod/hello`, {
        method: "POST",
        headers: { authorization: "Bearer chp_guessed" },
      })
      expect(unknown.status).toBe(401)
      const deleted = await fetch(`${url}/mod/commands`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      })
      expect(deleted.status).toBe(404)
      expect(hub.seen).toEqual([])
    }))
})

describe("upstreamHeaders", () => {
  test("drops the client's credentials and connection headers", () => {
    const headers = upstreamHeaders(
      new Headers({
        authorization: "Bearer chp_session",
        "x-api-key": "chp_session",
        cookie: "a=b",
        "accept-encoding": "gzip",
        "content-length": "3",
        "anthropic-version": "2023-06-01",
        "user-agent": "claude-cli/2.1.289",
      }),
      oauth(sessionOAuth),
    )
    expect(Object.fromEntries(headers)).toEqual({
      authorization: `Bearer ${sessionOAuth}`,
      "anthropic-beta": OAuthBeta,
      "anthropic-version": "2023-06-01",
      "user-agent": "claude-cli/2.1.289",
    })
  })
})
