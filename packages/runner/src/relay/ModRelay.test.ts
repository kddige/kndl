import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Logger, Redacted, Scope } from "effect"
import { sessionId } from "../testSupport.ts"
import { serveModRelay } from "./ModRelay.ts"
import { makeSessionTokens, SessionTokenPrefix, SessionTokens } from "./SessionTokens.ts"

// Fake only: shaped like a mod token, valid nowhere.
const modToken = "chm_mod.FAKE-0005"

interface Seen {
  readonly method: string
  readonly path: string
  readonly search: string
  readonly headers: Record<string, string>
  readonly body: string
}

/** Stands in for the Hub's mod endpoints, and its Gateway (#221). */
const hub = {
  seen: [] as Array<Seen>,
  /** Holds an MCP answer's second event back until resolved. */
  gate: Promise.withResolvers<void>(),
}

const fakeHub = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  fetch: async (request) => {
    const url = new URL(request.url)
    hub.seen.push({
      method: request.method,
      path: url.pathname,
      search: url.search,
      headers: Object.fromEntries(request.headers),
      body: await request.text(),
    })
    if (request.headers.get("authorization") !== `Bearer ${modToken}`)
      return Response.json({ message: "unknown mod token" }, { status: 401 })
    if (url.pathname === "/mod/commands") {
      await Bun.sleep(Number(url.searchParams.get("waitMs") ?? 0))
      return Response.json({ messages: [] })
    }
    if (url.pathname === "/mod/hello")
      return Response.json({ _tag: "ModWelcome", protocolVersion: 1 })
    if (url.pathname.startsWith("/gateway/") && request.method === "POST") {
      const encoder = new TextEncoder()
      const gate = hub.gate.promise
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(encoder.encode('data: {"first":true}\n\n'))
            await gate
            controller.enqueue(encoder.encode('data: {"second":true}\n\n'))
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream", "mcp-session-id": "mcp-1" } },
      )
    }
    return new Response(null, { status: 204 })
  },
})

afterAll(async () => {
  await fakeHub.stop(true)
})

let logs: Array<string> = []

beforeEach(() => {
  hub.seen = []
  hub.gate.resolve()
  hub.gate = Promise.withResolvers<void>()
  logs = []
})

/** Every log line, with its cause, as text. */
const captured = Logger.layer([
  Logger.make(({ logLevel, message, cause }) => {
    const text = Array.isArray(message) ? message.join(" ") : String(message)
    logs.push(`${logLevel}: ${text}${cause.reasons.length === 0 ? "" : ` ${Cause.pretty(cause)}`}`)
  }),
])

interface Relay {
  readonly url: string
  readonly tokens: SessionTokens["Service"]
  readonly issue: (id: string) => Promise<string>
}

/** Runs `body` against a relay on a free port to `hubUrl`, then checks nothing secret was logged. */
const withRelay = async (body: (relay: Relay) => Promise<void>, hubUrl: URL = fakeHub.url) => {
  const tokens = makeSessionTokens()
  const scope = Effect.runSync(Scope.make())
  const issued: Array<string> = []
  const port = await Effect.runPromise(
    serveModRelay({ port: 0, hubUrl }).pipe(
      Scope.provide(scope),
      Effect.provideService(SessionTokens, tokens),
      Effect.provide(captured),
    ),
  )
  try {
    await body({
      url: `http://127.0.0.1:${port}`,
      tokens,
      issue: async (id) => {
        const token = await Effect.runPromise(
          tokens.issue({ sessionId: sessionId(id), modToken: Redacted.make(modToken) }),
        )
        issued.push(Redacted.value(token))
        return Redacted.value(token)
      },
    })
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
  for (const line of logs)
    for (const secret of [modToken, ...issued]) expect(line).not.toContain(secret)
}

const hello = (url: string, token: string | undefined) =>
  fetch(`${url}/mod/hello`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: '{"protocolVersion":1}',
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
  test("answers 401 to a request with no token, or one that isn't live", () =>
    withRelay(async ({ url, issue }) => {
      await issue("s-1")
      for (const token of [undefined, "chp_guessed", modToken]) {
        const response = await hello(url, token)
        expect(response.status).toBe(401)
        expect(await response.json()).toEqual({ message: "no live Session token" })
      }
      expect(hub.seen).toEqual([])
    }))

  test("refuses a revoked token, and a Session's earlier one once it has a new one", () =>
    withRelay(async ({ url, issue, tokens }) => {
      const first = await issue("s-1")
      const second = await issue("s-1")
      expect((await hello(url, first)).status).toBe(401)
      expect((await hello(url, second)).status).toBe(200)
      await Effect.runPromise(tokens.revoke(sessionId("s-1")))
      expect((await hello(url, second)).status).toBe(401)
      expect(hub.seen).toHaveLength(1)
    }))

  test("asks a held token to retry, and relays it once the Hub sends a mod token (#157)", () =>
    withRelay(async ({ url, tokens, issue }) => {
      const kept = `${SessionTokenPrefix}${"k".repeat(43)}`
      expect(await Effect.runPromise(tokens.hold(sessionId("s-1"), kept))).toBe(true)

      const retry = await hello(url, kept)
      expect(retry.status).toBe(503)
      expect(retry.headers.get("retry-after")).toBe("1")
      expect(hub.seen).toEqual([])

      expect(await issue("s-1")).toBe(kept)
      expect((await hello(url, kept)).status).toBe(200)
      expect(hub.seen[0]?.headers.authorization).toBe(`Bearer ${modToken}`)
    }))
})

describe("paths", () => {
  test("relays nothing for Anthropic, or anything else that isn't the mod's or the Gateway's", () =>
    withRelay(async ({ url, issue }) => {
      const token = await issue("s-1")
      const headers = { authorization: `Bearer ${token}` }
      for (const [method, path] of [
        ["POST", "/v1/messages"],
        ["GET", "/v1/models"],
        ["HEAD", "/api/hello"],
        ["GET", "/api/oauth/profile"],
        ["DELETE", "/mod/commands"],
        ["GET", "/modding"],
      ] as const) {
        const response = await fetch(`${url}${path}`, { method, headers })
        expect(response.status).toBe(404)
      }
      expect(hub.seen).toEqual([])
    }))

  test("checks a path once its dot segments are resolved", () =>
    withRelay(async ({ url, issue }) => {
      const token = await issue("s-1")
      const port = new URL(url).port
      expect(await raw(port, "GET", "/v1/../mod/commands", token)).toBe(200)
      expect(await raw(port, "GET", "/mod/../v1/models", token)).toBe(404)
      expect(await raw(port, "GET", "/mod/%2e%2e/api/oauth/usage", token)).toBe(404)
      expect(hub.seen.map((seen) => seen.path)).toEqual(["/mod/commands"])
    }))
})

describe("mod relay", () => {
  test("relays the mod's calls to the Hub with the Session's mod token", () =>
    withRelay(async ({ url, issue }) => {
      const token = await issue("s-1")
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
      const welcome = await hello(url, token)
      expect(await welcome.json()).toEqual({ _tag: "ModWelcome", protocolVersion: 1 })
      const events = await fetch(`${url}/mod/events`, { method: "POST", headers, body: "[]" })
      expect(events.status).toBe(204)
      expect(hub.seen.map((seen) => [seen.method, seen.path, seen.body])).toEqual([
        ["POST", "/mod/hello", '{"protocolVersion":1}'],
        ["POST", "/mod/events", "[]"],
      ])
      for (const seen of hub.seen) {
        expect(seen.headers.authorization).toBe(`Bearer ${modToken}`)
        expect(JSON.stringify(seen.headers)).not.toContain(token)
      }
    }))

  test("passes a long poll through, waiting as long as the Hub does", () =>
    withRelay(async ({ url, issue }) => {
      const token = await issue("s-1")
      const started = Date.now()
      const response = await fetch(`${url}/mod/commands?after=3&waitMs=300`, {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(await response.json()).toEqual({ messages: [] })
      expect(Date.now() - started).toBeGreaterThanOrEqual(290)
      expect(hub.seen[0]?.search).toBe("?after=3&waitMs=300")
    }))

  test("answers 502 when the Hub can't be reached", async () => {
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
    const dead = closed.url
    await closed.stop(true)
    await withRelay(async ({ url, issue }) => {
      const response = await hello(url, await issue("s-1"))
      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({ message: "the Runner could not reach the Hub" })
    }, dead)
  })
})

describe("Gateway relay", () => {
  test("relays Claude Code's MCP traffic to the Hub's Gateway with the mod token, streaming", () =>
    withRelay(async ({ url, issue }) => {
      const token = await issue("s-1")
      const headers = {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      }
      const body = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
      const answer = await fetch(`${url}/gateway/inst-1`, { method: "POST", headers, body })
      expect(answer.status).toBe(200)
      expect(answer.headers.get("mcp-session-id")).toBe("mcp-1")
      const reader = answer.body?.getReader()
      if (reader === undefined) throw new Error("No body")
      const decoder = new TextDecoder()
      // The first event arrives while the second is held back.
      expect(decoder.decode((await reader.read()).value)).toContain('{"first":true}')
      hub.gate.resolve()
      let rest = ""
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
        rest += decoder.decode(chunk.value)
      expect(rest).toContain('{"second":true}')

      // Any method: Streamable HTTP ends its session with DELETE.
      const ended = await fetch(`${url}/gateway/inst-1`, { method: "DELETE", headers })
      expect(ended.status).toBe(204)

      expect(hub.seen.map((seen) => [seen.method, seen.path, seen.body])).toEqual([
        ["POST", "/gateway/inst-1", body],
        ["DELETE", "/gateway/inst-1", ""],
      ])
      for (const seen of hub.seen) {
        expect(seen.headers.authorization).toBe(`Bearer ${modToken}`)
        expect(seen.headers["mcp-protocol-version"]).toBe("2025-06-18")
        expect(JSON.stringify(seen.headers)).not.toContain(token)
      }
    }))

  test("refuses MCP traffic without a live Session token", () =>
    withRelay(async ({ url }) => {
      const refused = await fetch(`${url}/gateway/inst-1`, {
        method: "POST",
        headers: { authorization: "Bearer chp_guessed" },
        body: "{}",
      })
      expect(refused.status).toBe(401)
      expect(hub.seen).toEqual([])
    }))
})
