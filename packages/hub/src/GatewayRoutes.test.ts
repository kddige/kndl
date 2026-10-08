// The Gateway (#221, ADR 0020), end to end: a real Hub, a fake Runner that relays Plugins, the web
// UI over WebSockets, and a remote MCP server of the test's own, reached as a Session's Claude Code
// reaches it, through `/gateway/<installation id>` with the Session's mod token.

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test"
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
const other = "kddige/other"

/** What the remote MCP server was sent. */
interface Seen {
  readonly method: string
  readonly path: string
  readonly headers: Record<string, string>
  readonly body: string
}

/**
 * A stand-in remote MCP server: answers a POST with server-sent events, the second only once the
 * test says so, to show the answer streams; a GET with 405, as a server without its own stream.
 */
let server: ReturnType<typeof Bun.serve>
const seen: Array<Seen> = []
let sendSecond: () => void = () => {}
beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      seen.push({
        method: request.method,
        path: url.pathname + url.search,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      })
      if (url.pathname === "/redirect") return Response.redirect("https://example.com/", 302)
      if (request.method !== "POST") return new Response(null, { status: 405 })
      const second = Promise.withResolvers<void>()
      sendSecond = second.resolve
      const encoder = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode('event: message\ndata: {"first":true}\n\n'))
          await second.promise
          controller.enqueue(encoder.encode('event: message\ndata: {"second":true}\n\n'))
          controller.close()
        },
      })
      return new Response(body, {
        headers: {
          "content-type": "text/event-stream",
          "mcp-session-id": "mcp-1",
          "set-cookie": "tracker=1",
        },
      })
    },
  })
})
afterAll(() => server.stop(true))
// No answer is left waiting on its second event.
afterEach(() => sendSecond())

let requests = 0

/** Sends `command` with a fresh request id, and returns the Hub's answer to it. */
async function ask(web: Connection<Web>, command: Record<string, unknown> & { _tag: string }) {
  const requestId = `g-${++requests}`
  web.send({ ...command, requestId })
  return web.takeWhere(
    (message): message is Web => "requestId" in message && message.requestId === requestId,
    `answer to ${command._tag}`,
  )
}

/** Creates a Plugin at the server's `path`, and an Installation of it on the Repos. */
async function install(
  web: Connection<Web>,
  name: string,
  repos: ReadonlyArray<string>,
  path = "/mcp",
) {
  const created = await ask(web, {
    _tag: "CreatePlugin",
    name,
    url: `http://127.0.0.1:${server.port}${path}`,
  })
  if (created._tag !== "PluginsState") throw new Error(JSON.stringify(created))
  const pluginId = created.plugins.find((plugin) => plugin.name === name)?.id
  const answer = await ask(web, { _tag: "CreateInstallation", pluginId, name, repos })
  if (answer._tag !== "PluginsState") throw new Error(JSON.stringify(answer))
  const installation = answer.installations.find((found) => found.pluginId === pluginId)
  if (installation === undefined) throw new Error("No Installation created")
  return installation
}

/** A Hub, a Runner that relays Plugins, alice on the web, and `repo`'s Environment. */
async function gatewayScene() {
  const hub = await startHub({ config: { devLogin: true } })
  const runner = await openRunner(hub, (await issueRunnerToken(hub)).token, [], undefined, true, {
    relaysPlugins: true,
  })
  const web = await openWeb(hub, "alice")
  await seedEnvironment(hub, repo, "dev:alice")
  return { hub, runner, web }
}

/** Creates a Session of `repo` and plays its Runner's start: the StartSession it was sent. */
async function startSession(web: Connection<Web>, runner: Connection<ToRunner>) {
  web.send({ _tag: "CreateSession", requestId: `g-${++requests}`, repo, baseBranch: "main" })
  const start = await runner.take("StartSession")
  runner.send({ _tag: "SessionStarted", sessionId: start.sessionId, environmentVersion: 1 })
  await web.take("SessionUpdated", (m) => m.session.id === start.sessionId && !m.session.starting)
  return start
}

const mcpRequest = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })

/** A request through the Gateway, as Claude Code makes it through the Runner's relay. */
const through = (hub: TestHub, installationId: string, init: RequestInit = {}) =>
  fetch(`${hub.url}/gateway/${encodeURIComponent(installationId)}`, {
    method: "POST",
    body: mcpRequest,
    ...init,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...init.headers,
    },
  })

describe("the Gateway", () => {
  test("streams a Session's MCP traffic to its Installation's server, both ways", async () => {
    const { hub, runner, web } = await gatewayScene()
    const docs = await install(web, "Docs", [repo, other])
    const start = await startSession(web, runner)
    expect(start.plugins).toEqual([{ installationId: docs.id, server: "docs" }])

    seen.length = 0
    const logs: Array<string> = []
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      spyOn(console, level).mockImplementation((...args: Array<unknown>) => {
        logs.push(
          args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
        )
      }),
    )
    try {
      const response = await through(hub, docs.id, {
        headers: { ...bearer(start.modToken), cookie: "kndl_session=secret" },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("text/event-stream")
      expect(response.headers.get("mcp-session-id")).toBe("mcp-1")
      expect(response.headers.get("set-cookie")).toBeNull()

      // The first event arrives before the server sends the second.
      const reader = response.body?.getReader()
      if (reader === undefined) throw new Error("No body")
      const decoder = new TextDecoder()
      expect(decoder.decode((await reader.read()).value)).toContain('{"first":true}')
      sendSecond()
      let rest = ""
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        rest += decoder.decode(chunk.value)
      }
      expect(rest).toContain('{"second":true}')

      // The server got the request as sent, without the Session token or the cookie.
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({ method: "POST", path: "/mcp", body: mcpRequest })
      expect(seen[0]?.headers).toMatchObject({
        "content-type": "application/json",
        "mcp-protocol-version": "2025-06-18",
      })
      expect(seen[0]?.headers.authorization).toBeUndefined()
      expect(seen[0]?.headers.cookie).toBeUndefined()
      expect(JSON.stringify(seen[0]?.headers)).not.toContain(start.modToken)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    // Logged per Session and Installation, with nothing of what went either way.
    const logged = logs.join("\n")
    expect(logged).toContain("Gateway POST 200")
    expect(logged).toContain(start.sessionId)
    expect(logged).toContain(docs.id)
    expect(logged).not.toContain("tools/list")
    expect(logged).not.toContain("first")
  })

  test("refuses a request without a live Session token", async () => {
    const { hub, runner, web } = await gatewayScene()
    const docs = await install(web, "Docs", [repo])
    const start = await startSession(web, runner)
    seen.length = 0
    expect((await through(hub, docs.id)).status).toBe(401)
    expect((await through(hub, docs.id, { headers: bearer("not-a-token") })).status).toBe(401)
    // Nor a sign-in's cookie.
    expect((await through(hub, docs.id, { headers: { cookie: web.cookie } })).status).toBe(401)

    // Once the Session sleeps, its token is no longer live.
    web.send({ _tag: "SleepSession", sessionId: start.sessionId })
    await runner.take("StopSession")
    runner.send({
      _tag: "SessionStopped",
      sessionId: start.sessionId,
      reason: "Requested",
      exitCode: 143,
    })
    await web.take("SessionUpdated", (m) => m.session.state === "Asleep")
    expect((await through(hub, docs.id, { headers: bearer(start.modToken) })).status).toBe(401)
    expect(seen).toEqual([])
  })

  test("refuses an Installation that isn't on for the Session's Repo", async () => {
    const { hub, runner, web } = await gatewayScene()
    const docs = await install(web, "Docs", [repo])
    const elsewhere = await install(web, "Elsewhere", [other])
    const start = await startSession(web, runner)
    const token = bearer(start.modToken)
    seen.length = 0
    expect((await through(hub, elsewhere.id, { headers: token })).status).toBe(403)
    expect((await through(hub, "no-such-installation", { headers: token })).status).toBe(403)

    // One added to the Repo since the Session started waits for its next wake or Restart.
    const later = await install(web, "Later", [repo])
    expect((await through(hub, later.id, { headers: token })).status).toBe(403)
    expect(seen).toEqual([])

    // One removed from the Repo stops at once.
    await ask(web, {
      _tag: "EditInstallation",
      installationId: docs.id,
      name: "Docs",
      repos: [other],
    })
    expect((await through(hub, docs.id, { headers: token })).status).toBe(403)
    expect(seen).toEqual([])
  })

  test("doesn't follow a redirect", async () => {
    const { hub, runner, web } = await gatewayScene()
    const docs = await install(web, "Docs", [repo], "/redirect")
    const start = await startSession(web, runner)
    expect((await through(hub, docs.id, { headers: bearer(start.modToken) })).status).toBe(502)
  })
})

describe("a Session's Installations", () => {
  test("are shown, and that a Restart applies a change to its Repo's", async () => {
    const { runner, web } = await gatewayScene()
    const docs = await install(web, "Docs", [repo])
    const start = await startSession(web, runner)
    const { sessionId } = start
    await install(web, "Linear", [repo])
    const changed = await web.take(
      "SessionUpdated",
      (m) => m.session.id === sessionId && m.session.pluginsChanged === true,
    )
    expect(changed.session.plugins).toEqual([
      { id: docs.id, name: "Docs", pluginId: docs.pluginId, pluginName: "Docs", server: "docs" },
    ])

    // A Restart starts it with them.
    web.send({ _tag: "RestartSession", sessionId })
    await runner.take("StopSession")
    runner.send({ _tag: "SessionStopped", sessionId, reason: "Requested", exitCode: 143 })
    const again = await runner.take("StartSession")
    expect(again.plugins?.map((relayed) => relayed.server)).toEqual(["docs", "linear"])
    runner.send({ _tag: "SessionStarted", sessionId, environmentVersion: 1 })
    const restarted = await web.take(
      "SessionUpdated",
      (m) =>
        m.session.id === sessionId && !m.session.starting && m.session.restarting === undefined,
    )
    expect(restarted.session.pluginsChanged).toBeUndefined()
    expect(restarted.session.plugins?.map((installation) => installation.name)).toEqual([
      "Docs",
      "Linear",
    ])
  })

  test("are none on a Runner that doesn't relay them", async () => {
    const hub = await startHub({ config: { devLogin: true } })
    const runner = await openRunner(hub, (await issueRunnerToken(hub)).token)
    const web = await openWeb(hub, "alice")
    await seedEnvironment(hub, repo, "dev:alice")
    await install(web, "Docs", [repo])
    const start = await startSession(web, runner)
    expect(start.plugins).toBeUndefined()
  })
})
