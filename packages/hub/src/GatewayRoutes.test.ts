// The Gateway (#221, ADR 0020), end to end: a real Hub, a fake Runner that relays MCP servers, the
// web UI over WebSockets, and a remote MCP server of the test's own, reached as a Session's Claude
// Code reaches it, through `/gateway/<installation id>` with the Session's mod token.

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { ProtocolVersion } from "@kndl/protocol"
import { Effect, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
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
/** The status the server answers everything with, when set: as a credential revoked meanwhile. */
let refuseWith: number | undefined
/** Requests to `/hang`, which the server answers only once the test is over. */
const hanging: Array<() => void> = []
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
      if (refuseWith !== undefined) return new Response(null, { status: refuseWith })
      if (url.pathname === "/unauthorized") return new Response(null, { status: 401 })
      if (url.pathname === "/hang") {
        await new Promise<void>((resolve) => hanging.push(resolve))
        return new Response(null, { status: 504 })
      }
      if (url.pathname === "/redirect") return Response.redirect("https://example.com/", 302)
      if (request.method !== "POST") return new Response(null, { status: 405 })
      if (seen.at(-1)?.body.includes('"method":"initialize"')) {
        return Response.json(
          { jsonrpc: "2.0", id: 0, result: { protocolVersion: "2025-06-18", capabilities: {} } },
          { headers: { "mcp-session-id": "mcp-check" } },
        )
      }
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
// No answer is left waiting on its second event, or at all.
afterEach(() => {
  sendSecond()
  refuseWith = undefined
  for (const answer of hanging.splice(0)) answer()
})

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
 * Creates an MCP server at the server's `path`, with the header secrets of `auth`, and an
 * Installation of it on the Repos with the `values` given.
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
    _tag: "CreateMcpServer",
    name,
    url: serverUrl(path),
    auth: options.auth ?? { _tag: "None" },
  })
  if (created._tag !== "McpServersState") throw new Error(JSON.stringify(created))
  const mcpServerId = created.mcpServers.find((mcpServer) => mcpServer.name === name)?.id
  const answer = await ask(web, {
    _tag: "CreateInstallation",
    mcpServerId,
    name,
    repos,
    ...(options.values !== undefined && { values: options.values }),
  })
  if (answer._tag !== "McpServersState") throw new Error(JSON.stringify(answer))
  const installation = answer.installations.find((found) => found.mcpServerId === mcpServerId)
  if (installation === undefined) throw new Error("No Installation created")
  return installation
}

/**
 * A Hub with a secrets key, a Runner that relays MCP servers, alice on the web, and `repo`'s
 * Environment.
 */
async function gatewayScene() {
  const hub = await startHub({
    config: {
      devLogin: true,
      secretsKey: Option.some(Redacted.make(generateSecretsKey())),
      // The start's check of each MCP server gives up quickly (#216).
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

/** Creates a Session of `repo` and plays its Runner's start: the StartSession it was sent. */
async function startSession(web: Connection<Web>, runner: Connection<ToRunner>) {
  web.send({
    _tag: "CreateSession",
    requestId: `g-${++requests}`,
    repo,
    branch: { _tag: "Existing", name: "main", newWorkBranch: true },
  })
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
    expect(start.mcpServers).toEqual([{ installationId: docs.id, server: "docs" }])

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

  test("reaches a global Installation, but not where it is turned off or overridden (#219)", async () => {
    const { hub, runner, web } = await gatewayScene()
    await hub.run(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql`UPDATE participants SET owner = 1`),
    )
    // Made global once created: on in every Repo, listing none.
    const docs = await install(web, "Docs", [other])
    const global = await ask(web, {
      _tag: "EditInstallation",
      installationId: docs.id,
      name: "Docs",
      repos: [],
      global: true,
    })
    expect(global).toMatchObject({ _tag: "McpServersState", installations: [{ global: true }] })
    const start = await startSession(web, runner)
    expect(start.mcpServers).toEqual([{ installationId: docs.id, server: "docs" }])
    const token = bearer(start.modToken)
    const status = async () => {
      const response = await through(hub, docs.id, { headers: token })
      sendSecond()
      await response.body?.cancel()
      return response.status
    }
    expect(await status()).toBe(200)

    // Turned off for the Repo: stopped at once, and back once turned on.
    const turn = (on: boolean) =>
      ask(web, { _tag: "TurnGlobalInstallation", installationId: docs.id, repo, on })
    await turn(false)
    expect(await status()).toBe(403)
    await turn(true)
    expect(await status()).toBe(200)

    // A Repo-scoped Installation of its MCP server on the Repo takes its place: stopped at once
    // too.
    await ask(web, {
      _tag: "CreateInstallation",
      mcpServerId: docs.mcpServerId,
      name: "Team docs",
      repos: [repo],
    })
    expect(await status()).toBe(403)
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
      (m) => m.session.id === sessionId && m.session.mcpServersChanged === true,
    )
    expect(changed.session.mcpServers).toEqual([
      {
        id: docs.id,
        name: "Docs",
        mcpServerId: docs.mcpServerId,
        mcpServerName: "Docs",
        server: "docs",
      },
    ])

    // A Restart starts it with them.
    web.send({ _tag: "RestartSession", sessionId })
    await runner.take("StopSession")
    runner.send({ _tag: "SessionStopped", sessionId, reason: "Requested", exitCode: 143 })
    const again = await runner.take("StartSession")
    expect(again.mcpServers?.map((relayed) => relayed.server)).toEqual(["docs", "linear"])
    runner.send({ _tag: "SessionStarted", sessionId, environmentVersion: 1 })
    const restarted = await web.take(
      "SessionUpdated",
      (m) =>
        m.session.id === sessionId && !m.session.starting && m.session.restarting === undefined,
    )
    expect(restarted.session.mcpServersChanged).toBeUndefined()
    expect(restarted.session.mcpServers?.map((installation) => installation.name)).toEqual([
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
    expect(start.mcpServers).toBeUndefined()
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

describe("an MCP server's header secrets", () => {
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

  /** Edits the MCP server of `installation` to `url` and `auth`, as alice. */
  const editMcpServer = (
    web: Connection<Web>,
    installation: { readonly mcpServerId: string },
    url: string,
    edited: Record<string, unknown> = auth,
  ) =>
    ask(web, {
      _tag: "EditMcpServer",
      mcpServerId: installation.mcpServerId,
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
    expect(edited._tag).toBe("McpServersState")
    await web.take(
      "SessionUpdated",
      (m) => m.session.id === sessionId && m.session.mcpServersChanged === true,
    )
    // The running Session goes on with the value it started with.
    seen.length = 0
    await (await through(hub, linear.id, { headers: bearer(start.modToken) })).body?.cancel()
    expect(lastHeaders().authorization).toBe(`Bearer ${apiKey}`)

    // The Repo's log says which was set, never the value.
    const log = await ask(web, { _tag: "GetMcpServerLog", repo })
    if (log._tag !== "McpServerLog") throw new Error(log._tag)
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
    expect(restarted.session.mcpServersChanged).toBeUndefined()
    await (await through(hub, linear.id, { headers: bearer(again.modToken) })).body?.cancel()
    expect(lastHeaders().authorization).toBe(`Bearer ${rotated}`)
    expect(web.texts.join("\n")).not.toContain(rotated)
  })

  test("keep their values when the MCP server's path changes, and lose them to another origin", async () => {
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
    const moved = await editMcpServer(web, linear, serverUrl("/v2/mcp"), renamed)
    if (moved._tag !== "McpServersState") throw new Error(JSON.stringify(moved))
    expect(moved.installations[0]?.values.map((value) => value.key)).toEqual(["api_key", "team"])
    seen.length = 0
    await (await through(hub, linear.id, { headers: token })).body?.cancel()
    expect(seen.at(-1)?.path).toBe("/v2/mcp")
    expect(lastHeaders().authorization).toBe(`Token ${apiKey}`)

    // Another host, though the same server: every value is cleared, the Session's too.
    const elsewhere = await editMcpServer(web, linear, serverUrl("/v2/mcp", "localhost"), renamed)
    if (elsewhere._tag !== "McpServersState") throw new Error(JSON.stringify(elsewhere))
    expect(elsewhere.installations[0]?.values).toEqual([])
    seen.length = 0
    const refused = await through(hub, linear.id, { headers: token })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({
      error: "Linear needs a value for Key: enter it on the MCP page, then Restart the Session.",
    })
    expect(seen).toEqual([])
    // The Session says so, once, and runs on (#216).
    await through(hub, linear.id, { headers: token })
    expect(await notesOf(web, start.sessionId)).toEqual([
      {
        _tag: "SandboxNoted",
        message:
          "Linear needs a value for Key and Team. Its tools fail until the Installation is fixed and the Session restarted.",
        installationFailed: {
          installationId: linear.id,
          installation: "Linear",
          reason: "ValueNeeded",
          secrets: ["Key", "Team"],
        },
      },
    ])
    const log = await ask(web, { _tag: "GetMcpServerLog", repo })
    if (log._tag !== "McpServerLog") throw new Error(log._tag)
    expect(log.entries.slice(0, 2).map((entry) => [entry.change, entry.secrets])).toEqual([
      ["ValuesCleared", ["Key", "Team"]],
      ["McpServerEdited", undefined],
    ])
  })

  test("lose a value when its header changes, or its key goes", async () => {
    const { web } = await gatewayScene()
    const linear = await install(web, "Linear", [repo], "/mcp", { auth, values })
    const reheadered = {
      _tag: "Headers",
      headers: [{ ...auth.headers[0], header: "X-Api-Key" }, auth.headers[1]],
    }
    const edited = await editMcpServer(web, linear, serverUrl(), reheadered)
    if (edited._tag !== "McpServersState") throw new Error(JSON.stringify(edited))
    expect(edited.installations[0]?.values.map((value) => value.key)).toEqual(["team"])
    const dropped = await editMcpServer(web, linear, serverUrl(), { _tag: "None" })
    if (dropped._tag !== "McpServersState") throw new Error(JSON.stringify(dropped))
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
        _tag: "CreateMcpServer",
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

const asleep = (web: Connection<Web>, sessionId: string) =>
  web.take("SessionUpdated", (m) => m.session.id === sessionId && m.session.state === "Asleep")

describe("a Session's start (#216)", () => {
  const apiKey = "lin_api_SECRET_7f3a9c"
  const auth = {
    _tag: "Headers",
    headers: [
      { key: "api_key", title: "API key", header: "Authorization", template: "Bearer {value}" },
    ],
  }
  const values = [{ key: "api_key", value: apiKey }]
  const wayOut = `Fix the Installation on the MCP page, or take ${repo} off it, then wake the Session.`

  test("waits for an Installation's missing value, says which and why, then runs what was queued", async () => {
    const { hub, runner, web } = await gatewayScene()
    await install(web, "Docs", [repo])
    const linear = await install(web, "Linear", [repo], "/mcp", { auth })
    seen.length = 0
    const sessionId = await createSession(web)
    await asleep(web, sessionId)
    expect(await runner.untaken("StartSession")).toEqual([])
    expect(await lastChangeOf(web, sessionId)).toEqual({
      _tag: "SessionStateChanged",
      state: "Asleep",
      message: `The agent could not start: Linear needs a value for API key. ${wayOut}`,
      installationsFailed: [
        {
          installationId: linear.id,
          installation: "Linear",
          reason: "ValueNeeded",
          secrets: ["API key"],
        },
      ],
    })
    // A value missing is sure: no server was asked anything.
    expect(seen).toEqual([])

    // A prompt sent meanwhile waits in the queue: the wake it asks for fails the same way.
    web.send({ _tag: "SendPrompt", sessionId, text: "Look up the open issues" })
    await web.take(
      "SessionEventLogged",
      (m) => m.entry.event._tag === "SessionStateChanged" && m.entry.event.state === "Asleep",
    )
    expect(await runner.untaken("StartSession")).toEqual([])

    // Fixed, a Retry starts it, and the prompt runs.
    await ask(web, {
      _tag: "EditInstallation",
      installationId: linear.id,
      name: "Linear",
      repos: [repo],
      values,
    })
    web.send({ _tag: "WakeSession", sessionId })
    const start = await runner.take("StartSession")
    expect(start.mcpServers?.map((relayed) => relayed.server).toSorted()).toEqual([
      "docs",
      "linear",
    ])
    runner.send({ _tag: "SessionStarted", sessionId, environmentVersion: 1 })
    const mod = (path: string, body?: unknown) =>
      fetch(`${hub.url}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { ...bearer(start.modToken), "content-type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      })
    await mod("/mod/hello", {
      _tag: "ModHello",
      protocolVersion: ProtocolVersion,
      sessionId,
      conversationId: "0b6d6c1e-2f4a-4c3b-9d8e-7a6b5c4d3e2f",
      model: "claude-opus",
    })
    const commands = (await (await mod("/mod/commands?after=0&waitMs=1000")).json()) as {
      messages: Array<{ message: { _tag: string; text?: string } }>
    }
    expect(
      commands.messages.map(({ message }) => message).filter((m) => m._tag === "DeliverPrompt"),
    ).toMatchObject([{ text: "Look up the open issues" }])
  })

  test("doesn't start when a server refuses its credential, nor show the credential", async () => {
    const { runner, web } = await gatewayScene()
    const linear = await install(web, "Linear", [repo], "/unauthorized", { auth, values })
    seen.length = 0
    let sessionId = ""
    const logged = await logsOf(async () => {
      sessionId = await createSession(web)
      await asleep(web, sessionId)
    })
    expect(await runner.untaken("StartSession")).toEqual([])
    // Checked once, as Claude Code starts with it: an MCP initialize, with the credential.
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ method: "POST", path: "/unauthorized" })
    expect(JSON.parse(seen[0]?.body ?? "{}")).toMatchObject({ method: "initialize" })
    expect(lastHeaders().authorization).toBe(`Bearer ${apiKey}`)
    expect(await lastChangeOf(web, sessionId)).toEqual({
      _tag: "SessionStateChanged",
      state: "Asleep",
      message: `The agent could not start: Linear's MCP server refused its credential (401). ${wayOut}`,
      installationsFailed: [
        { installationId: linear.id, installation: "Linear", reason: "Rejected", status: 401 },
      ],
    })
    expect(web.texts.join("\n")).not.toContain(apiKey)
    expect(logged).not.toContain(apiKey)

    // Taken off the Repo, the Session starts without it.
    await ask(web, { _tag: "DeleteInstallation", installationId: linear.id })
    web.send({ _tag: "WakeSession", sessionId })
    expect((await runner.take("StartSession")).mcpServers).toBeUndefined()
  })

  test("goes ahead past a server that doesn't answer, and says so", async () => {
    const { runner, web } = await gatewayScene()
    const down = await install(web, "Down", [repo], "/hang")
    const sessionId = await createSession(web)
    // Once the check gives up.
    const started = await runner.take("StartSession")
    expect(started.sessionId).toBe(sessionId)
    expect(await notesOf(web, sessionId)).toEqual([
      {
        _tag: "SandboxNoted",
        message:
          "Down's MCP server could not be reached. The agent started all the same: its tools fail until it answers.",
        installationFailed: {
          installationId: down.id,
          installation: "Down",
          reason: "Unreachable",
        },
      },
    ])
  })

  test("asks no server anything for a Session without Installations", async () => {
    const { runner, web } = await gatewayScene()
    seen.length = 0
    await createSession(web)
    expect((await runner.take("StartSession")).mcpServers).toBeUndefined()
    expect(seen).toEqual([])
  })
})

describe("an Installation failing mid-Session (#216)", () => {
  test("shows as an error in the Session, once, which runs on", async () => {
    const { hub, runner, web } = await gatewayScene()
    const docs = await install(web, "Docs", [repo])
    const start = await startSession(web, runner)
    const token = bearer(start.modToken)
    refuseWith = 403
    expect((await through(hub, docs.id, { headers: token })).status).toBe(403)
    expect((await through(hub, docs.id, { headers: token })).status).toBe(403)
    expect(await notesOf(web, start.sessionId)).toEqual([
      {
        _tag: "SandboxNoted",
        message:
          "Docs's MCP server refused its credential (403). Its tools fail until the Installation is fixed and the Session restarted.",
        installationFailed: {
          installationId: docs.id,
          installation: "Docs",
          reason: "Rejected",
          status: 403,
        },
      },
    ])
    expect(await runner.untaken("StopSession")).toEqual([])

    // Once it works again, a new failure is said again.
    refuseWith = undefined
    await (await through(hub, docs.id, { headers: token })).body?.cancel()
    refuseWith = 401
    await through(hub, docs.id, { headers: token })
    const notes = await notesOf(web, start.sessionId)
    expect(notes).toHaveLength(2)
    expect(notes[1]).toMatchObject({ installationFailed: { reason: "Rejected", status: 401 } })
  })
})
