// Sending a request through an Installation (#254), end to end, by both the Hub's paths that do:
// the Gateway, as a Session's Claude Code reaches an MCP server through `/gateway/<id>`, and a
// Session's start, which checks each server with an MCP `initialize` first (#216). A real Hub, a
// fake Runner that relays MCP servers, the web UI over WebSockets, and a stand-in MCP server that
// takes header secrets, or OAuth tokens of its own authorization server's (#217).

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { Option, Redacted } from "effect"
import { OAuthCallbackPath } from "./McpServerOAuth.ts"
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
const apiKey = "lin_api_SECRET_254"

/** What the stand-in MCP server was sent: each request's method, path, credential and body. */
interface Seen {
  readonly method: string
  readonly path: string
  readonly authorization: string | null
  readonly session: string | null
  readonly body: string
}
const seen: Array<Seen> = []

/** The stand-in's authorization server: the access tokens its MCP server takes, and its refreshes. */
const as = {
  valid: new Set<string>(),
  issued: 0,
  refreshes: 0,
  /** Seconds each token issued from now on lives. */
  expiresIn: 3600,
  /** The status its token endpoint answers a refresh with, when set: as one that is down. */
  refreshStatus: undefined as number | undefined,
  /** Its MCP server refuses every token, refreshed ones too. */
  refuseAll: false,
}
/** Requests to `/hang`, answered only once the test is over; and whether each was aborted. */
const hanging: Array<() => void> = []
const aborted: Array<Promise<void>> = []
let sendSecond: () => void = () => {}

let server: ReturnType<typeof Bun.serve>
const origin = () => `http://127.0.0.1:${server.port}`

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = request.method === "GET" ? "" : await request.text()
      const authorization = request.headers.get("authorization")
      if (!url.pathname.startsWith("/as") && !url.pathname.startsWith("/.well-known")) {
        seen.push({
          method: request.method,
          path: url.pathname,
          authorization,
          session: request.headers.get("mcp-session-id"),
          body,
        })
      }
      switch (url.pathname) {
        case "/.well-known/oauth-protected-resource/oauth":
          return Response.json({
            resource: `${origin()}/oauth`,
            authorization_servers: [`${origin()}/as`],
          })
        case "/.well-known/oauth-authorization-server/as":
          return Response.json({
            issuer: `${origin()}/as`,
            authorization_endpoint: `${origin()}/as/authorize`,
            token_endpoint: `${origin()}/as/token`,
            registration_endpoint: `${origin()}/as/register`,
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["client_secret_basic"],
          })
        case "/as/register":
          return Response.json(
            {
              client_id: "kndl-client",
              client_secret: "cs-SECRET",
              token_endpoint_auth_method: "client_secret_basic",
            },
            { status: 201 },
          )
        case "/as/token": {
          if (new URLSearchParams(body).get("grant_type") === "refresh_token") {
            as.refreshes++
            if (as.refreshStatus !== undefined) {
              return new Response(null, { status: as.refreshStatus })
            }
          }
          const n = ++as.issued
          as.valid.add(`at-${n}`)
          return Response.json({
            access_token: `at-${n}`,
            token_type: "Bearer",
            expires_in: as.expiresIn,
            refresh_token: `rt-${n}`,
          })
        }
        case "/oauth":
          if (as.refuseAll || !as.valid.has(authorization?.replace(/^Bearer /, "") ?? "")) {
            return new Response("refused", {
              status: 401,
              headers: { "www-authenticate": 'Bearer realm="mcp"' },
            })
          }
          return answer(request, body)
        case "/headers":
          return answer(request, body)
        case "/forbidden":
          return new Response(null, { status: 403 })
        case "/failing":
          return new Response(null, { status: 500 })
        case "/redirect":
          return Response.redirect("https://example.com/", 302)
        case "/hang": {
          const { promise, resolve } = Promise.withResolvers<void>()
          aborted.push(promise)
          request.signal.addEventListener("abort", () => resolve())
          await new Promise<void>((done) => hanging.push(done))
          return new Response(null, { status: 504 })
        }
        default:
          return new Response(null, { status: 404 })
      }
    },
  })
})
afterAll(() => server.stop(true))
afterEach(() => {
  seen.length = 0
  as.valid.clear()
  as.issued = 0
  as.refreshes = 0
  as.expiresIn = 3600
  as.refreshStatus = undefined
  as.refuseAll = false
  sendSecond()
  for (const done of hanging.splice(0)) done()
  aborted.length = 0
})

/**
 * An MCP server's answer: to `initialize`, JSON with an MCP session to end; to a DELETE, nothing;
 * to anything else, server-sent events, the second only once the test says so.
 */
function answer(request: Request, body: string) {
  if (request.method === "DELETE") return new Response(null, { status: 200 })
  if (body.includes('"method":"initialize"')) {
    return Response.json(
      { jsonrpc: "2.0", id: 0, result: { protocolVersion: "2025-06-18", capabilities: {} } },
      { headers: { "mcp-session-id": "mcp-check" } },
    )
  }
  const second = Promise.withResolvers<void>()
  sendSecond = second.resolve
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode('event: message\ndata: {"first":true}\n\n'))
        await second.promise
        controller.enqueue(encoder.encode('event: message\ndata: {"second":true}\n\n'))
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream", "set-cookie": "tracker=1" } },
  )
}

let requests = 0

/** Sends `command` with a fresh request id, and returns the Hub's answer to it. */
async function ask(web: Connection<Web>, command: Record<string, unknown> & { _tag: string }) {
  const requestId = `gw-${++requests}`
  web.send({ ...command, requestId })
  return web.takeWhere(
    (message): message is Web => "requestId" in message && message.requestId === requestId,
    `answer to ${command._tag}`,
  )
}

/** A Hub with a secrets key, a Runner that relays MCP servers, alice on the web, `repo`'s Environment. */
async function scene() {
  const hub = await startHub({
    config: {
      devLogin: true,
      secretsKey: Option.some(Redacted.make(generateSecretsKey())),
      mcpServerCheckTimeoutMs: 150,
    },
  })
  const runner = await openRunner(hub, (await issueRunnerToken(hub)).token, [], undefined, true, {
    relaysMcpServers: true,
  })
  const web = await openWeb(hub, "alice")
  await seedEnvironment(hub, repo, "dev:alice")
  return { hub, runner, web }
}

const headerAuth = {
  _tag: "Headers",
  headers: [
    { key: "api_key", title: "API key", header: "Authorization", template: "Bearer {value}" },
  ],
}

/**
 * An MCP server named `name` at the stand-in's `path`, or `url`, and an Installation of it on
 * `repos`: by header secret, with its value, or by OAuth, not connected yet.
 */
async function install(
  web: Connection<Web>,
  name: string,
  path: string,
  { url = `${origin()}${path}`, repos = [repo] }: { url?: string; repos?: Array<string> } = {},
) {
  const oauth = path === "/oauth"
  const created = await ask(web, {
    _tag: "CreateMcpServer",
    name,
    url,
    auth: oauth ? { _tag: "OAuth" } : headerAuth,
  })
  if (created._tag !== "McpServersState") throw new Error(JSON.stringify(created))
  const mcpServerId = created.mcpServers.find((one) => one.name === name)?.id
  const installed = await ask(web, {
    _tag: "CreateInstallation",
    mcpServerId,
    name,
    repos,
    ...(!oauth && { values: [{ key: "api_key", value: apiKey }] }),
  })
  if (installed._tag !== "McpServersState") throw new Error(JSON.stringify(installed))
  const installation = installed.installations.find((one) => one.mcpServerId === mcpServerId)
  if (installation === undefined) throw new Error("Not installed")
  return installation.id
}

/** Connects the OAuth Installation, as its Connect button and the authorization server do. */
async function connect(hub: TestHub, web: Connection<Web> & { cookie: string }, id: string) {
  const begun = await ask(web, { _tag: "ConnectInstallation", installationId: id })
  if (begun._tag !== "InstallationAuthorizing") throw new Error(JSON.stringify(begun))
  const state = new URL(begun.url).searchParams.get("state") ?? ""
  const back = await fetch(
    `${hub.url}${OAuthCallbackPath}?${new URLSearchParams({ code: "c", state, iss: `${origin()}/as` })}`,
    { headers: { cookie: web.cookie }, redirect: "manual" },
  )
  expect(back.headers.get("location")).toContain("connected=1")
}

/** Creates a Session of `repo` without playing its Runner's start: its id. */
async function createSession(web: Connection<Web>) {
  const created = await ask(web, {
    _tag: "CreateSession",
    repo,
    branch: { _tag: "Existing", name: "main", newWorkBranch: true },
  })
  if (created._tag !== "SessionCreated") throw new Error(JSON.stringify(created))
  return created.session.id
}

/** Creates a Session of `repo` and plays its Runner's start: the StartSession it was sent. */
async function startSession(web: Connection<Web>, runner: Connection<ToRunner>) {
  const sessionId = await createSession(web)
  const start = await runner.take("StartSession")
  expect(start.sessionId).toBe(sessionId)
  runner.send({ _tag: "SessionStarted", sessionId, environmentVersion: 1 })
  await web.take("SessionUpdated", (m) => m.session.id === sessionId && !m.session.starting)
  return start
}

/** The Session's history, as a web client joining it now is sent it. */
async function historyOf(web: Connection<Web>, sessionId: string) {
  web.send({ _tag: "JoinSession", sessionId })
  const history = await web.take("SessionHistory", (m) => m.sessionId === sessionId)
  return history.entries.map((entry) => entry.event)
}

/** What the Session's history notes besides its Turns: its SandboxNoted events. */
const notesOf = async (web: Connection<Web>, sessionId: string) =>
  (await historyOf(web, sessionId)).filter((event) => event._tag === "SandboxNoted")

/** The Session's last state change. */
const lastChangeOf = async (web: Connection<Web>, sessionId: string) =>
  (await historyOf(web, sessionId)).filter((event) => event._tag === "SessionStateChanged").at(-1)

const asleep = (web: Connection<Web>, sessionId: string) =>
  web.take("SessionUpdated", (m) => m.session.id === sessionId && m.session.state === "Asleep")

/** A request through the Gateway, as Claude Code makes it through the Runner's relay. */
const through = (hub: TestHub, id: string, modToken: string, init: RequestInit = {}) =>
  fetch(`${hub.url}/gateway/${encodeURIComponent(id)}`, {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    ...init,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...bearer(modToken),
      ...init.headers,
    },
  })

/** The Gateway's answer: its status and JSON error, its body read. */
const refusalOf = async (response: Response) => ({
  status: response.status,
  body: (await response.json()) as unknown,
})

const notConnected = (name: string) =>
  `${name} isn't connected to its account: reconnect it on the MCP page.`

describe("the Gateway, sending a request through an Installation (#254)", () => {
  test("aborts the request to the server when the Sandbox's is aborted", async () => {
    const { hub, runner, web } = await scene()
    const id = await install(web, "Slow", "/hang")
    // The start's check gives up on it, and starts the Session all the same.
    const start = await startSession(web, runner)
    aborted.length = 0
    const controller = new AbortController()
    const sent = through(hub, id, start.modToken, { signal: controller.signal }).catch(
      () => "aborted",
    )
    while (aborted.length === 0) await Bun.sleep(5)
    controller.abort()
    expect(await sent).toBe("aborted")
    await aborted[0]
  })

  test("answers what can't be reached, or redirects, with 502", async () => {
    const { hub, runner, web } = await scene()
    const redirecting = await install(web, "Moved", "/redirect")
    const closed = Bun.serve({ port: 0, fetch: () => new Response(null) })
    const gone = await install(web, "Gone", "/gone", { url: `http://127.0.0.1:${closed.port}/mcp` })
    closed.stop(true)
    const start = await startSession(web, runner)
    // The start's check noted each: Moved answered 302, and Gone couldn't be reached.
    const checked = await notesOf(web, start.sessionId)
    expect(checked).toHaveLength(2)
    expect(await refusalOf(await through(hub, redirecting, start.modToken))).toEqual({
      status: 502,
      body: { error: "The MCP server redirected, which the Gateway doesn't follow." },
    })
    expect(await refusalOf(await through(hub, gone, start.modToken))).toEqual({
      status: 502,
      body: { error: "The MCP server could not be reached." },
    })
    // The Gateway notes neither in the Session.
    expect(await notesOf(web, start.sessionId)).toEqual(checked)
  })

  test("refreshes once more a token refreshed after a refusal, once it worked", async () => {
    const { hub, runner, web } = await scene()
    const id = await install(web, "Tracker", "/oauth")
    await connect(hub, web, id)
    const start = await startSession(web, runner)
    const sent = async () => {
      const response = await through(hub, id, start.modToken)
      sendSecond()
      await response.text()
      return response.status
    }
    // Refused, its token is refreshed: the new one works.
    as.valid.clear()
    expect(await sent()).toBe(200)

    // Refused later, the token that worked is refreshed again, not taken for a lost connection.
    as.valid.clear()
    seen.length = 0
    expect(await sent()).toBe(200)
    expect(seen.map((one) => one.authorization)).toEqual(["Bearer at-2", "Bearer at-3"])
    expect(as.refreshes).toBe(2)
    expect(await notesOf(web, start.sessionId)).toEqual([])
  })

  test("refused the refreshed token too, answers 409 and notes it isn't connected", async () => {
    const { hub, runner, web } = await scene()
    const id = await install(web, "Tracker", "/oauth")
    await connect(hub, web, id)
    const start = await startSession(web, runner)
    seen.length = 0
    // Refuses every token, the refreshed ones too.
    as.refuseAll = true
    const answered = await through(hub, id, start.modToken)
    expect(answered.headers.get("www-authenticate")).toBeNull()
    expect(await refusalOf(answered)).toEqual({
      status: 409,
      body: { error: notConnected("Tracker") },
    })
    expect(seen.map((one) => one.authorization)).toEqual(["Bearer at-1", "Bearer at-2"])
    expect(as.refreshes).toBe(1)
    expect(await notesOf(web, start.sessionId)).toEqual([
      {
        _tag: "SandboxNoted",
        message:
          "Tracker isn't connected to its account. Its tools fail until it is reconnected on the MCP page.",
        installationFailed: { installationId: id, installation: "Tracker", reason: "NotConnected" },
      },
    ])
  })

  test("answers 503, unnoted, for an OAuth token that expired and can't be refreshed now", async () => {
    const { hub, runner, web } = await scene()
    // Its tokens are refreshed before each request, as each expires within a minute.
    as.expiresIn = 30
    const id = await install(web, "Tracker", "/oauth")
    await connect(hub, web, id)
    const start = await startSession(web, runner)
    // Its authorization server down.
    as.refreshStatus = 503
    seen.length = 0
    expect(await refusalOf(await through(hub, id, start.modToken))).toEqual({
      status: 503,
      body: {
        error:
          "Tracker's token expired, and its authorization server could not be reached to refresh it: try again.",
      },
    })
    expect(seen).toEqual([])
    expect(await notesOf(web, start.sessionId)).toEqual([])
  })
})

describe("a Session's start, checking each Installation through the Gateway's path (#254)", () => {
  test("sends initialize with the credential, then ends the MCP session it opened", async () => {
    const { runner, web } = await scene()
    await install(web, "Linear", "/headers")
    const sessionId = await createSession(web)
    expect((await runner.take("StartSession")).sessionId).toBe(sessionId)
    expect(
      seen.map(({ method, authorization, session }) => [method, authorization, session]),
    ).toEqual([
      ["POST", `Bearer ${apiKey}`, null],
      ["DELETE", `Bearer ${apiKey}`, "mcp-check"],
    ])
    expect(await notesOf(web, sessionId)).toEqual([])
  })

  test("refreshes an OAuth token refused once, and checks once more with it", async () => {
    const { hub, runner, web } = await scene()
    const id = await install(web, "Tracker", "/oauth")
    await connect(hub, web, id)
    as.valid.clear()
    seen.length = 0
    const sessionId = await createSession(web)
    expect((await runner.take("StartSession")).sessionId).toBe(sessionId)
    expect(seen.map(({ method, authorization }) => [method, authorization])).toEqual([
      ["POST", "Bearer at-1"],
      ["POST", "Bearer at-2"],
      ["DELETE", "Bearer at-2"],
    ])
    expect(as.refreshes).toBe(1)
  })

  test("refused the refreshed OAuth token too, doesn't start: it isn't connected", async () => {
    const { hub, runner, web } = await scene()
    const id = await install(web, "Tracker", "/oauth")
    await connect(hub, web, id)
    as.refuseAll = true
    seen.length = 0
    const sessionId = await createSession(web)
    await asleep(web, sessionId)
    expect(await lastChangeOf(web, sessionId)).toMatchObject({
      state: "Asleep",
      installationsFailed: [
        { installationId: id, installation: "Tracker", reason: "NotConnected" },
      ],
    })
    expect(seen.map((one) => one.authorization)).toEqual(["Bearer at-1", "Bearer at-2"])
    expect(as.refreshes).toBe(1)
    expect(await runner.untaken("StartSession")).toEqual([])
  })

  test("doesn't start with an OAuth Installation not connected, asking no server", async () => {
    const { runner, web } = await scene()
    const id = await install(web, "Tracker", "/oauth")
    await install(web, "Linear", "/headers")
    const sessionId = await createSession(web)
    await asleep(web, sessionId)
    expect(await lastChangeOf(web, sessionId)).toMatchObject({
      installationsFailed: [{ installationId: id, reason: "NotConnected" }],
    })
    expect(seen).toEqual([])
    expect(await runner.untaken("StartSession")).toEqual([])
  })

  test("starts past an OAuth token that can't be refreshed now, noting it unreachable", async () => {
    const { hub, runner, web } = await scene()
    as.expiresIn = 30
    const id = await install(web, "Tracker", "/oauth")
    await connect(hub, web, id)
    as.refreshStatus = 503
    seen.length = 0
    const sessionId = await createSession(web)
    expect((await runner.take("StartSession")).sessionId).toBe(sessionId)
    expect(seen).toEqual([])
    expect(await notesOf(web, sessionId)).toEqual([
      expect.objectContaining({
        installationFailed: { installationId: id, installation: "Tracker", reason: "Unreachable" },
      }),
    ])
  })

  test("doesn't start past a 403; starts past a redirect or another error, noting each", async () => {
    const { runner, web } = await scene()
    const forbidden = await install(web, "Forbidden", "/forbidden")
    const sessionId = await createSession(web)
    await asleep(web, sessionId)
    expect(await lastChangeOf(web, sessionId)).toMatchObject({
      installationsFailed: [{ installationId: forbidden, reason: "Rejected", status: 403 }],
    })
    await ask(web, { _tag: "DeleteInstallation", installationId: forbidden })

    const moved = await install(web, "Moved", "/redirect")
    const failing = await install(web, "Failing", "/failing")
    const next = await createSession(web)
    expect((await runner.take("StartSession")).sessionId).toBe(next)
    const failures = (await notesOf(web, next)).map((note) =>
      note._tag === "SandboxNoted" ? note.installationFailed : undefined,
    )
    expect(failures).toHaveLength(2)
    expect(failures).toEqual(
      expect.arrayContaining([
        { installationId: moved, installation: "Moved", reason: "Errored", status: 302 },
        { installationId: failing, installation: "Failing", reason: "Errored", status: 500 },
      ]),
    )
  })
})
