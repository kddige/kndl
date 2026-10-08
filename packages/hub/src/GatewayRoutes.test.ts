// The Gateway (#221, ADR 0020), end to end: a real Hub, a fake Runner that relays Plugins, the web
// UI over WebSockets, and a remote MCP server of the test's own, reached as a Session's Claude Code
// reaches it, through `/gateway/<installation id>` with the Session's mod token.

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { Option, Redacted } from "effect"
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

/** The stand-in server's URL at `path`, on `host`. */
const serverUrl = (path = "/mcp", host = "127.0.0.1") => `http://${host}:${server.port}${path}`

/**
 * Creates a Plugin at the server's `path`, with the header secrets of `auth`, and an Installation
 * of it on the Repos with the `values` given.
 */
async function install(
  web: Connection<Web>,
  name: string,
  repos: ReadonlyArray<string>,
  path = "/mcp",
  options: {
    readonly auth?: Record<string, unknown>
    readonly values?: ReadonlyArray<{ readonly key: string; readonly value: string }>
  } = {},
) {
  const created = await ask(web, {
    _tag: "CreatePlugin",
    name,
    url: serverUrl(path),
    auth: options.auth ?? { _tag: "None" },
  })
  if (created._tag !== "PluginsState") throw new Error(JSON.stringify(created))
  const pluginId = created.plugins.find((plugin) => plugin.name === name)?.id
  const answer = await ask(web, {
    _tag: "CreateInstallation",
    pluginId,
    name,
    repos,
    ...(options.values !== undefined && { values: options.values }),
  })
  if (answer._tag !== "PluginsState") throw new Error(JSON.stringify(answer))
  const installation = answer.installations.find((found) => found.pluginId === pluginId)
  if (installation === undefined) throw new Error("No Installation created")
  return installation
}

/** A Hub with a secrets key, a Runner that relays Plugins, alice on the web, and `repo`'s Environment. */
async function gatewayScene() {
  const hub = await startHub({
    config: { devLogin: true, secretsKey: Option.some(Redacted.make(generateSecretsKey())) },
  })
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

/** Everything the Hub logs while `run` runs. */
async function logsOf(run: () => Promise<void>) {
  const logs: Array<string> = []
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
    spyOn(console, level).mockImplementation((...args: Array<unknown>) => {
      logs.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "))
    }),
  )
  try {
    await run()
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
  return logs.join("\n")
}

/** What the server was sent last, of the headers. */
const lastHeaders = () => seen.at(-1)?.headers ?? {}

describe("a Plugin's header secrets", () => {
  const apiKey = "lin_api_SECRET_7f3a9c"
  const team = "team_SECRET_51b2"
  const auth = {
    _tag: "Headers",
    headers: [
      { key: "api_key", title: "API key", header: "Authorization", template: "Bearer {value}" },
      { key: "team", title: "Team", header: "X-Team", template: "{value}" },
    ],
  }
  const values = [
    { key: "api_key", value: apiKey },
    { key: "team", value: team },
  ]

  /** Edits the Plugin of `installation` to `url` and `auth`, as alice. */
  const editPlugin = (
    web: Connection<Web>,
    installation: { readonly pluginId: string },
    url: string,
    edited: Record<string, unknown> = auth,
  ) =>
    ask(web, {
      _tag: "EditPlugin",
      pluginId: installation.pluginId,
      name: "Linear",
      url,
      auth: edited,
    })

  test("are added by the Gateway from the Installation's values, over any the Sandbox sent", async () => {
    const { hub, runner, web } = await gatewayScene()
    const linear = await install(web, "Linear", [repo], "/mcp", { auth, values })
    // The web is told which are set, by whom and when: never the values.
    expect(linear.values.map((value) => [value.key, value.setBy.login])).toEqual([
      ["api_key", "alice"],
      ["team", "alice"],
    ])
    const start = await startSession(web, runner)
    seen.length = 0
    const logged = await logsOf(async () => {
      const response = await through(hub, linear.id, {
        headers: { ...bearer(start.modToken), "x-team": "forged", "X-TEAM": "forged-again" },
      })
      expect(response.status).toBe(200)
      await response.body?.cancel()
    })
    expect(lastHeaders().authorization).toBe(`Bearer ${apiKey}`)
    expect(lastHeaders()["x-team"]).toBe(team)
    expect(JSON.stringify(seen)).not.toContain("forged")
    expect(logged).toContain("Gateway POST 200")

    // No value went to the web, to the Runner, or into the Hub's logs.
    for (const value of [apiKey, team]) {
      expect(web.texts.join("\n")).not.toContain(value)
      expect(runner.texts.join("\n")).not.toContain(value)
      expect(logged).not.toContain(value)
    }
  })

  test("are redacted from what Sessions print", async () => {
    const { runner, web } = await gatewayScene()
    await install(web, "Linear", [repo], "/mcp", { auth, values })
    const start = await startSession(web, runner)
    web.send({ _tag: "JoinSession", sessionId: start.sessionId })
    await web.take("SessionHistory")
    runner.send({ _tag: "SandboxNote", sessionId: start.sessionId, message: `echoed ${apiKey}` })
    const noted = await web.take("SessionEventLogged", (m) => m.entry.event._tag === "SandboxNoted")
    expect(noted.entry.event).toMatchObject({ message: `echoed ${"*".repeat(apiKey.length)}` })
  })

  test("without a value are answered 409, naming the Installation and the header secret", async () => {
    const { hub, runner, web } = await gatewayScene()
    const linear = await install(web, "Linear", [repo], "/mcp", {
      auth,
      values: [{ key: "team", value: team }],
    })
    expect(linear.values.map((value) => value.key)).toEqual(["team"])
    // The Session starts all the same: its other MCP servers work.
    const start = await startSession(web, runner)
    seen.length = 0
    const response = await through(hub, linear.id, { headers: bearer(start.modToken) })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error:
        "Linear needs a value for API key: enter it on the Plugins page, then Restart the Session.",
    })
    expect(seen).toEqual([])
  })

  test("take a new value on the Session's next start, and say so meanwhile", async () => {
    const { hub, runner, web } = await gatewayScene()
    const linear = await install(web, "Linear", [repo], "/mcp", { auth, values })
    const start = await startSession(web, runner)
    const { sessionId } = start
    const rotated = "lin_api_ROTATED_0c4d"
    const edited = await ask(web, {
      _tag: "EditInstallation",
      installationId: linear.id,
      name: "Linear",
      repos: [repo],
      values: [{ key: "api_key", value: rotated }],
    })
    expect(edited._tag).toBe("PluginsState")
    await web.take(
      "SessionUpdated",
      (m) => m.session.id === sessionId && m.session.pluginsChanged === true,
    )
    // The running Session goes on with the value it started with.
    seen.length = 0
    await (await through(hub, linear.id, { headers: bearer(start.modToken) })).body?.cancel()
    expect(lastHeaders().authorization).toBe(`Bearer ${apiKey}`)

    // The Repo's log says which was set, never the value.
    const log = await ask(web, { _tag: "GetPluginLog", repo })
    if (log._tag !== "PluginLog") throw new Error(log._tag)
    expect(log.entries[0]).toMatchObject({ change: "ValuesSet", secrets: ["API key"] })
    expect(JSON.stringify(log)).not.toContain(rotated)

    // A Restart starts it with the new one.
    web.send({ _tag: "RestartSession", sessionId })
    await runner.take("StopSession")
    runner.send({ _tag: "SessionStopped", sessionId, reason: "Requested", exitCode: 143 })
    const again = await runner.take("StartSession")
    runner.send({ _tag: "SessionStarted", sessionId, environmentVersion: 1 })
    const restarted = await web.take(
      "SessionUpdated",
      (m) =>
        m.session.id === sessionId && !m.session.starting && m.session.restarting === undefined,
    )
    expect(restarted.session.pluginsChanged).toBeUndefined()
    await (await through(hub, linear.id, { headers: bearer(again.modToken) })).body?.cancel()
    expect(lastHeaders().authorization).toBe(`Bearer ${rotated}`)
    expect(web.texts.join("\n")).not.toContain(rotated)
  })

  test("keep their values when the Plugin's path changes, and lose them to another origin", async () => {
    const { hub, runner, web } = await gatewayScene()
    const linear = await install(web, "Linear", [repo], "/mcp", { auth, values })
    const start = await startSession(web, runner)
    const token = bearer(start.modToken)

    // Another path, a new title and template: the values stay, and apply at once.
    const renamed = {
      _tag: "Headers",
      headers: [
        { key: "api_key", title: "Key", header: "authorization", template: "Token {value}" },
        auth.headers[1],
      ],
    }
    const moved = await editPlugin(web, linear, serverUrl("/v2/mcp"), renamed)
    if (moved._tag !== "PluginsState") throw new Error(JSON.stringify(moved))
    expect(moved.installations[0]?.values.map((value) => value.key)).toEqual(["api_key", "team"])
    seen.length = 0
    await (await through(hub, linear.id, { headers: token })).body?.cancel()
    expect(seen.at(-1)?.path).toBe("/v2/mcp")
    expect(lastHeaders().authorization).toBe(`Token ${apiKey}`)

    // Another host, though the same server: every value is cleared, the Session's too.
    const elsewhere = await editPlugin(web, linear, serverUrl("/v2/mcp", "localhost"), renamed)
    if (elsewhere._tag !== "PluginsState") throw new Error(JSON.stringify(elsewhere))
    expect(elsewhere.installations[0]?.values).toEqual([])
    seen.length = 0
    const refused = await through(hub, linear.id, { headers: token })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({
      error:
        "Linear needs a value for Key: enter it on the Plugins page, then Restart the Session.",
    })
    expect(seen).toEqual([])
    const log = await ask(web, { _tag: "GetPluginLog", repo })
    if (log._tag !== "PluginLog") throw new Error(log._tag)
    expect(log.entries.slice(0, 2).map((entry) => [entry.change, entry.secrets])).toEqual([
      ["ValuesCleared", ["Key", "Team"]],
      ["PluginEdited", undefined],
    ])
  })

  test("lose a value when its header changes, or its key goes", async () => {
    const { web } = await gatewayScene()
    const linear = await install(web, "Linear", [repo], "/mcp", { auth, values })
    const reheadered = {
      _tag: "Headers",
      headers: [{ ...auth.headers[0], header: "X-Api-Key" }, auth.headers[1]],
    }
    const edited = await editPlugin(web, linear, serverUrl(), reheadered)
    if (edited._tag !== "PluginsState") throw new Error(JSON.stringify(edited))
    expect(edited.installations[0]?.values.map((value) => value.key)).toEqual(["team"])
    const dropped = await editPlugin(web, linear, serverUrl(), { _tag: "None" })
    if (dropped._tag !== "PluginsState") throw new Error(JSON.stringify(dropped))
    expect(dropped.installations[0]?.values).toEqual([])
  })

  test("refuse a value too short to redact, naming the header secret only", async () => {
    const { web } = await gatewayScene()
    const linear = await install(web, "Linear", [repo], "/mcp", { auth })
    expect(
      await ask(web, {
        _tag: "EditInstallation",
        installationId: linear.id,
        name: "Linear",
        repos: [repo],
        values: [{ key: "api_key", value: "abc" }],
      }),
    ).toMatchObject({
      _tag: "CommandFailed",
      message: "The value of API key is under 4 characters: too short to redact from output.",
    })
    expect(
      await ask(web, {
        _tag: "CreatePlugin",
        name: "Bad",
        url: serverUrl(),
        auth: { _tag: "Headers", headers: [{ ...auth.headers[0], template: "Bearer" }] },
      }),
    ).toMatchObject({
      _tag: "CommandFailed",
      message: "API key's template must hold {value} exactly once, as in Bearer {value}.",
    })
  })
})
