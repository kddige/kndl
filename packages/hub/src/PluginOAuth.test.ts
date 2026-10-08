// OAuth Installations (#217), end to end: a real Hub, a fake Runner that relays Plugins, the web UI
// over WebSockets, and a stand-in MCP server whose own authorization server offers Dynamic Client
// Registration, or doesn't, for a client entered by hand (#218). Connecting follows the MCP
// authorization spec; only the Hub ever holds a token or a client's secret.

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  globalConnectRefusal,
  InstallationId,
  OAuthConnectTtlMs,
  ParticipantId,
} from "@kndl/protocol"
import { Effect, Layer, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { DatabaseTest } from "./Database.ts"
import { MaxOAuthRequestBytes } from "./GatewayRoutes.ts"
import { HubConfig } from "./HubConfig.ts"
import { OAuthCallbackPath, PluginOAuth } from "./PluginOAuth.ts"
import { Plugins } from "./Plugins.ts"
import { generateSecretsKey, Secrets } from "./Secrets.ts"
import {
  type Connection,
  issueRunnerToken,
  openRunner,
  openWeb,
  stopAll,
  type ToRunner,
  type Web,
} from "./testChannels.ts"
import {
  baseConfig,
  bearer,
  seedEnvironment,
  startHub,
  type TestHub,
  webOrigin,
} from "./testSupport.ts"

afterEach(stopAll)

const repo = "kddige/kndl"
const clientSecret = "cs-CLIENT-SECRET-71f0"

/** What the stand-in authorization server was asked, and what it holds. */
const as = {
  registered: [] as Array<Record<string, unknown>>,
  refreshes: [] as Array<URLSearchParams>,
  codes: new Map<
    string,
    {
      readonly clientId: string
      readonly challenge: string
      readonly redirectUri: string
      readonly resource: string
    }
  >(),
  /** The access tokens the MCP server takes. */
  valid: new Set<string>(),
  /** The one refresh token that works: each refresh rotates it. */
  refresh: undefined as string | undefined,
  issued: 0,
  /** Seconds each token issued from now on lives. */
  expiresIn: 3600,
  /** How long a refresh takes, in milliseconds. */
  refreshDelay: 0,
  /** Every refresh is answered invalid_grant, as a revoked grant is. */
  revoked: false,
  /** Fields put over the authorization server's metadata. */
  metadata: {} as Record<string, unknown>,
  /** The authorization servers the MCP server names, if not the stand-in. */
  servers: undefined as ReadonlyArray<string> | undefined,
  /** The paths answered with a redirect to the same path under `/elsewhere`. */
  redirecting: new Set<string>(),
  /** Each path under `/elsewhere` asked for: none, as no redirect is followed. */
  elsewhere: [] as Array<string>,
  /** The clients registered with it by hand (#218), by id, with their secrets: none if public. */
  manual: new Map<string, string | undefined>(),
  /** How each request to the token endpoint authenticated: `<method>:<client id>`. */
  auth: [] as Array<string>,
}

/** What the MCP server was sent: each request's path and Authorization. */
const mcpSeen: Array<{ readonly path: string; readonly authorization: string | null }> = []

const accessToken = (n: number) => `at-${n}-ACCESS-SECRET`
const refreshToken = (n: number) => `rt-${n}-REFRESH-SECRET`

let server: ReturnType<typeof Bun.serve>
const origin = () => `http://127.0.0.1:${server.port}`
const issuer = () => `${origin()}/as`
const mcpUrl = () => `${origin()}/mcp`

/** Issues the next tokens, with an ID token naming the account, for the client. */
function issue(clientId: string) {
  const n = ++as.issued
  as.valid.add(accessToken(n))
  as.refresh = refreshToken(n)
  const claims = { iss: issuer(), aud: clientId, email: "bot@example.com", sub: "u-1" }
  return Response.json({
    access_token: accessToken(n),
    token_type: "Bearer",
    expires_in: as.expiresIn,
    refresh_token: refreshToken(n),
    id_token: `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`,
  })
}

/**
 * The client a token request authenticated as, by Basic, by its secret in the form, or as a
 * public client, if any: the one the Hub registered, or one registered by hand.
 */
function authenticated(header: string | null, form: URLSearchParams) {
  const clients = new Map([["kndl-client", clientSecret], ...as.manual])
  if (header !== null) {
    const [id = "", secret] = Buffer.from(header.replace(/^Basic /, ""), "base64")
      .toString("utf8")
      .split(":")
      .map((part) => decodeURIComponent(part.replaceAll("+", " ")))
    if (!header.startsWith("Basic ") || secret === undefined || clients.get(id) !== secret) return
    as.auth.push(`client_secret_basic:${id}`)
    return id
  }
  const id = form.get("client_id") ?? ""
  const secret = form.get("client_secret") ?? undefined
  if (!clients.has(id) || clients.get(id) !== secret) return
  as.auth.push(`${secret === undefined ? "none" : "client_secret_post"}:${id}`)
  return id
}

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (as.redirecting.has(url.pathname)) {
        return Response.redirect(`${origin()}/elsewhere${url.pathname}`, 302)
      }
      if (url.pathname.startsWith("/elsewhere/")) {
        as.elsewhere.push(url.pathname)
        return new Response(null, { status: 404 })
      }
      switch (url.pathname) {
        case "/mcp": {
          const authorization = request.headers.get("authorization")
          mcpSeen.push({ path: url.pathname, authorization })
          const body = await request.text()
          if (!as.valid.has(authorization?.replace(/^Bearer /, "") ?? "")) {
            return new Response(null, {
              status: 401,
              headers: {
                "www-authenticate": `Bearer resource_metadata="${origin()}/.well-known/oauth-protected-resource/mcp", scope="read"`,
              },
            })
          }
          if (request.method === "DELETE") return new Response(null, { status: 200 })
          return Response.json(
            body.includes('"initialize"')
              ? { jsonrpc: "2.0", id: 0, result: { protocolVersion: "2025-06-18" } }
              : { jsonrpc: "2.0", id: 1, result: { tools: [] } },
            // A challenge even on success: the Gateway passes none on.
            { headers: { "www-authenticate": 'Bearer realm="mcp"' } },
          )
        }
        case "/.well-known/oauth-protected-resource/mcp":
          return Response.json({
            resource: mcpUrl(),
            authorization_servers: as.servers ?? [issuer()],
            scopes_supported: ["read", "write"],
          })
        case "/.well-known/oauth-authorization-server/as":
          return Response.json({
            issuer: issuer(),
            authorization_endpoint: `${issuer()}/authorize`,
            token_endpoint: `${issuer()}/token`,
            registration_endpoint: `${issuer()}/register`,
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["client_secret_basic"],
            authorization_response_iss_parameter_supported: true,
            ...as.metadata,
          })
        case "/as/register": {
          as.registered.push((await request.json()) as Record<string, unknown>)
          return Response.json(
            {
              client_id: "kndl-client",
              client_secret: clientSecret,
              token_endpoint_auth_method: "client_secret_basic",
            },
            { status: 201 },
          )
        }
        case "/as/token": {
          const form = new URLSearchParams(await request.text())
          const clientId = authenticated(request.headers.get("authorization"), form)
          if (clientId === undefined) {
            return Response.json({ error: "invalid_client" }, { status: 401 })
          }
          if (form.get("grant_type") === "authorization_code") {
            const code = as.codes.get(form.get("code") ?? "")
            as.codes.delete(form.get("code") ?? "")
            const verified =
              code !== undefined &&
              code.clientId === clientId &&
              createHash("sha256")
                .update(form.get("code_verifier") ?? "")
                .digest("base64url") === code.challenge &&
              form.get("redirect_uri") === code.redirectUri &&
              form.get("resource") === code.resource
            return verified
              ? issue(clientId)
              : Response.json({ error: "invalid_grant" }, { status: 400 })
          }
          as.refreshes.push(form)
          await Bun.sleep(as.refreshDelay)
          if (as.revoked || form.get("refresh_token") !== as.refresh) {
            return Response.json({ error: "invalid_grant" }, { status: 400 })
          }
          return issue(clientId)
        }
        default:
          return new Response(null, { status: 404 })
      }
    },
  })
})
afterAll(() => server.stop(true))
afterEach(() => {
  as.registered.length = 0
  as.refreshes.length = 0
  as.codes.clear()
  as.valid.clear()
  as.refresh = undefined
  as.issued = 0
  as.expiresIn = 3600
  as.refreshDelay = 0
  as.revoked = false
  as.metadata = {}
  as.servers = undefined
  as.redirecting.clear()
  as.elsewhere.length = 0
  as.manual.clear()
  as.auth.length = 0
  mcpSeen.length = 0
})

let requests = 0

/** Sends `command` with a fresh request id, and returns the Hub's answer to it. */
async function ask(web: Connection<Web>, command: Record<string, unknown> & { _tag: string }) {
  const requestId = `o-${++requests}`
  web.send({ ...command, requestId })
  return web.takeWhere(
    (message): message is Web => "requestId" in message && message.requestId === requestId,
    `answer to ${command._tag}`,
  )
}

/** The Plugins and Installations in an answer. */
function state(answer: Web) {
  if (answer._tag !== "PluginsState") throw new Error(`Not PluginsState: ${JSON.stringify(answer)}`)
  return answer
}

/** A Hub with a secrets key, a Runner that relays Plugins, alice on the web, and `repo`'s Environment. */
async function scene() {
  const hub = await startHub({
    config: {
      devLogin: true,
      secretsKey: Option.some(Redacted.make(generateSecretsKey())),
      pluginCheckTimeoutMs: 1000,
    },
  })
  const runner = await openRunner(hub, (await issueRunnerToken(hub)).token, [], undefined, true, {
    relaysPlugins: true,
  })
  const web = await openWeb(hub, "alice")
  await seedEnvironment(hub, repo, "dev:alice")
  return { hub, runner, web }
}

/** Makes the person the Hub's Owner (#219). */
const makeOwner = (hub: TestHub, login: string) =>
  hub.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE participants SET owner = 1 WHERE login = ${login}`
    }),
  )

/** Creates an OAuth Plugin of the stand-in server, and an Installation of it on `repo`. */
async function install(web: Connection<Web>) {
  const created = state(
    await ask(web, {
      _tag: "CreatePlugin",
      name: "Tracker",
      url: mcpUrl(),
      auth: { _tag: "OAuth" },
    }),
  )
  const pluginId = created.plugins.find((plugin) => plugin.name === "Tracker")?.id
  const answer = state(
    await ask(web, { _tag: "CreateInstallation", pluginId, name: "Tracker", repos: [repo] }),
  )
  const installation = answer.installations.find((found) => found.pluginId === pluginId)
  if (pluginId === undefined || installation === undefined) throw new Error("Not installed")
  return { pluginId, installationId: installation.id }
}

/**
 * Begins connecting the Installation, as its Connect button does, or its client form, with
 * `client`: where the Hub sends the browser. The stand-in authorization server then "signs the
 * person in", and grants a code.
 */
async function authorize(
  web: Connection<Web>,
  installationId: string,
  client?: { readonly clientId: string; readonly clientSecret?: string },
) {
  const answer = await ask(web, {
    _tag: "ConnectInstallation",
    installationId,
    ...(client !== undefined && { client }),
  })
  if (answer._tag !== "InstallationAuthorizing") throw new Error(JSON.stringify(answer))
  const url = new URL(answer.url)
  const code = `code-${++requests}`
  as.codes.set(code, {
    clientId: url.searchParams.get("client_id") ?? "",
    challenge: url.searchParams.get("code_challenge") ?? "",
    redirectUri: url.searchParams.get("redirect_uri") ?? "",
    resource: url.searchParams.get("resource") ?? "",
  })
  return { url, code, state: url.searchParams.get("state") ?? "" }
}

/** The browser coming back to the Hub's callback, with `cookie`: where the Hub sends it next. */
async function callback(hub: TestHub, cookie: string | undefined, params: Record<string, string>) {
  const response = await fetch(
    `${hub.url}${OAuthCallbackPath}?${new URLSearchParams(params).toString()}`,
    { headers: cookie === undefined ? {} : { cookie }, redirect: "manual" },
  )
  expect(response.status).toBe(302)
  return new URL(response.headers.get("location") ?? "", webOrigin)
}

/** Connects the Installation all the way, as alice, with `client` if one is entered. */
async function connect(
  hub: TestHub,
  web: Connection<Web> & { cookie: string },
  id: string,
  client?: { readonly clientId: string; readonly clientSecret?: string },
) {
  const begun = await authorize(web, id, client)
  const back = await callback(hub, web.cookie, {
    code: begun.code,
    state: begun.state,
    iss: issuer(),
  })
  expect(back.searchParams.get("connectError")).toBeNull()
  return back
}

/** Creates a Session of `repo` and plays its Runner's start: the StartSession it was sent. */
async function startSession(web: Connection<Web>, runner: Connection<ToRunner>) {
  web.send({ _tag: "CreateSession", requestId: `o-${++requests}`, repo, baseBranch: "main" })
  const start = await runner.take("StartSession")
  runner.send({ _tag: "SessionStarted", sessionId: start.sessionId, environmentVersion: 1 })
  await web.take("SessionUpdated", (m) => m.session.id === start.sessionId && !m.session.starting)
  return start
}

/** A request through the Gateway, as Claude Code makes it through the Runner's relay. */
const through = (hub: TestHub, path: string, modToken: string, init: RequestInit = {}) =>
  fetch(`${hub.url}/gateway/${path}`, {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    ...init,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...bearer(modToken),
    },
  })

/** What the Hub logged while `run` ran. */
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

/** Every row of every table in the Hub's database, as text. */
const databaseText = (hub: TestHub) =>
  hub.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table'
      `
      const rows: Array<unknown> = []
      for (const { name } of tables) rows.push(yield* sql.unsafe(`SELECT * FROM "${name}"`))
      return JSON.stringify(rows)
    }),
  )

/** Each token the stand-in issued, and the clients' secrets: none may leave the Hub. */
const everySecret = () => [
  clientSecret,
  ...[...as.manual.values()].filter((secret) => secret !== undefined),
  ...Array.from({ length: as.issued }, (_, i) => [accessToken(i + 1), refreshToken(i + 1)]).flat(),
]

const expectNoSecretIn = (text: string) => {
  for (const secret of everySecret()) expect(text).not.toContain(secret)
}

/** The Repo's Plugin change log, as its changes. */
async function logOf(web: Connection<Web>) {
  const answer = await ask(web, { _tag: "GetPluginLog", repo })
  if (answer._tag !== "PluginLog") throw new Error(JSON.stringify(answer))
  return answer.entries.map((entry) => entry.change).toReversed()
}

/** The Installation as the web is sent it. */
async function installationOf(web: Connection<Web>, id: string) {
  return state(await ask(web, { _tag: "GetPlugins" })).installations.find((one) => one.id === id)
}

/** The Session's history, as its events. */
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

describe("connecting an OAuth Installation", () => {
  test("discovers the server's authorization server, registers the Hub, and uses PKCE", async () => {
    const { hub, web } = await scene()
    const { installationId } = await install(web)
    expect((await installationOf(web, installationId))?.connection).toBeUndefined()

    let back = new URL(webOrigin)
    const logged = await logsOf(async () => {
      const begun = await authorize(web, installationId)
      // Registered once, with the Hub's callback (RFC 7591).
      const redirectUri = `${webOrigin}${OAuthCallbackPath}`
      expect(as.registered).toEqual([
        expect.objectContaining({
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          token_endpoint_auth_method: "client_secret_basic",
        }),
      ])
      // To the authorization server's endpoint, with PKCE S256, the resource (RFC 8707), and the
      // scope the server's challenge asked for.
      expect(`${begun.url.origin}${begun.url.pathname}`).toBe(`${issuer()}/authorize`)
      expect(Object.fromEntries(begun.url.searchParams)).toEqual({
        response_type: "code",
        client_id: "kndl-client",
        redirect_uri: redirectUri,
        code_challenge: expect.stringMatching(/^[\w-]{43}$/),
        code_challenge_method: "S256",
        state: expect.stringMatching(/^.{20,}$/),
        resource: mcpUrl(),
        scope: "read",
      })
      back = await callback(hub, web.cookie, {
        code: begun.code,
        state: begun.state,
        iss: issuer(),
      })
    })
    // Back to the Installation on the Plugins page.
    expect(back.pathname).toBe("/plugins")
    expect(Object.fromEntries(back.searchParams)).toEqual({
      installation: installationId,
      connected: "1",
    })
    expect((await installationOf(web, installationId))?.connection).toEqual({
      connectedBy: { id: "dev:alice", login: "alice", name: "alice" },
      connectedAt: expect.any(Number),
      account: "bot@example.com",
    })
    expect(await logOf(web)).toEqual(["Created", "Connected"])

    // Reconnecting reuses the client the Hub registered.
    await connect(hub, web, installationId)
    expect(as.registered).toHaveLength(1)
    expect(await logOf(web)).toEqual(["Created", "Connected", "Reconnected"])

    // The tokens and client are encrypted at rest, and reach no web client nor any log.
    expect(as.issued).toBe(2)
    expectNoSecretIn(await databaseText(hub))
    expectNoSecretIn(web.texts.join("\n"))
    expectNoSecretIn(logged)
  })

  test("takes each state once, from whoever began it, and sends the browser back saying why not", async () => {
    const { hub, web } = await scene()
    const { installationId } = await install(web)
    const bob = await openWeb(hub, "bob")

    const begun = await authorize(web, installationId)
    const params = { code: begun.code, state: begun.state, iss: issuer() }
    // Without signing in.
    expect((await callback(hub, undefined, params)).searchParams.get("connectError")).toBe(
      "Sign in to kndl, then connect the Installation again.",
    )
    // Someone else's browser, with alice's state: refused, and the state gone.
    const stolen = await callback(hub, bob.cookie, params)
    expect(stolen.searchParams.get("connectError")).toBe(
      "That connection expired or came from elsewhere: connect again.",
    )
    expect((await callback(hub, web.cookie, params)).searchParams.get("connectError")).toBe(
      "That connection expired or came from elsewhere: connect again.",
    )
    // The person turned it down at the authorization server.
    const denied = await authorize(web, installationId)
    const refused = await callback(hub, web.cookie, {
      error: "access_denied",
      state: denied.state,
    })
    expect(Object.fromEntries(refused.searchParams)).toEqual({
      installation: installationId,
      connectError: "The connection wasn't allowed at the authorization server.",
    })
    // An issuer other than the one asked (RFC 9207).
    const mixed = await authorize(web, installationId)
    expect(
      (
        await callback(hub, web.cookie, { code: mixed.code, state: mixed.state, iss: origin() })
      ).searchParams.get("connectError"),
    ).toBe("The authorization server that answered isn't the one asked.")
    // A state that was never begun.
    expect(
      (await callback(hub, web.cookie, { code: "x", state: "forged" })).searchParams.get(
        "connectError",
      ),
    ).toBe("That connection expired or came from elsewhere: connect again.")
    expect((await installationOf(web, installationId))?.connection).toBeUndefined()
    expect(as.issued).toBe(0)
  })

  test("takes a state only within 10 minutes of its beginning", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const oauth = yield* PluginOAuth
        const by = ParticipantId.make("dev:alice")
        const begin = () =>
          oauth
            .begin({
              installationId: InstallationId.make("i-clock"),
              url: mcpUrl(),
              basis: "basis",
              global: false,
              repos: [repo],
              by,
            })
            .pipe(
              Effect.map((begun) =>
                begun._tag === "Authorize"
                  ? (new URL(begun.url).searchParams.get("state") ?? "")
                  : "",
              ),
            )
        const claimOf = (begun: string) =>
          oauth.claim(begun, by).pipe(
            Effect.match({
              onFailure: (refused) => refused.message,
              onSuccess: () => "claimed",
            }),
          )

        const onTime = yield* begin()
        yield* TestClock.adjust(OAuthConnectTtlMs)
        expect(yield* claimOf(onTime)).toBe("claimed")

        const late = yield* begin()
        yield* TestClock.adjust(OAuthConnectTtlMs + 1)
        expect(yield* claimOf(late)).toBe(
          "That connection expired or came from elsewhere: connect again.",
        )
        // Begun again, it is a new state, on time.
        const again = yield* begin()
        expect(again).not.toBe(late)
        expect(yield* claimOf(again)).toBe("claimed")
      }).pipe(
        Effect.provide(
          PluginOAuth.layer.pipe(
            Layer.provideMerge(Secrets.layer),
            Layer.provideMerge(
              Layer.merge(
                DatabaseTest,
                HubConfig.layerFrom({
                  ...baseConfig,
                  secretsKey: Option.some(Redacted.make(generateSecretsKey())),
                }),
              ),
            ),
          ),
        ),
        Effect.provide(TestClock.layer()),
      ),
    ))

  test("follows no redirect from the MCP server's metadata or its authorization server", async () => {
    const { hub, web } = await scene()
    const { installationId } = await install(web)
    const refusal = async () => {
      const answer = await ask(web, { _tag: "ConnectInstallation", installationId })
      if (answer._tag !== "CommandFailed") throw new Error(JSON.stringify(answer))
      return answer.message
    }

    // The Protected Resource Metadata, then the authorization server's: neither is found.
    as.redirecting.add("/.well-known/oauth-protected-resource/mcp")
    expect(await refusal()).toBe(
      `The Hub found no OAuth metadata for the authorization server ${origin()}.`,
    )
    as.redirecting.clear()
    as.redirecting.add("/.well-known/oauth-authorization-server/as")
    expect(await refusal()).toBe(
      `The Hub found no OAuth metadata for the authorization server ${issuer()}.`,
    )
    // Dynamic Client Registration.
    as.redirecting.clear()
    as.redirecting.add("/as/register")
    expect(await refusal()).toBe(
      `The authorization server ${issuer()} refused to register the Hub (302).`,
    )
    expect(as.registered).toEqual([])
    // The token endpoint, trading the code.
    as.redirecting.clear()
    const begun = await authorize(web, installationId)
    as.redirecting.add("/as/token")
    const back = await callback(hub, web.cookie, {
      code: begun.code,
      state: begun.state,
      iss: issuer(),
    })
    expect(back.searchParams.get("connectError")).toBe(
      "The authorization server answered 302, without tokens the Hub can use.",
    )

    expect(as.elsewhere).toEqual([])
    expect(as.issued).toBe(0)
    expect((await installationOf(web, installationId))?.connection).toBeUndefined()
  })

  test("is refused for a server, authorization server or endpoint not on https", async () => {
    const { web } = await scene()
    const { pluginId, installationId } = await install(web)
    const refusal = async () => {
      const answer = await ask(web, { _tag: "ConnectInstallation", installationId })
      if (answer._tag !== "CommandFailed") throw new Error(JSON.stringify(answer))
      return answer.message
    }
    // Loopback is the stand-in's; any other host must be on https. None of these is asked.
    const away = "http://auth.example.test"

    as.servers = [`${away}/as`]
    expect(await refusal()).toBe("The MCP server names no authorization server the Hub can reach.")
    as.servers = undefined

    for (const endpoint of ["authorization_endpoint", "token_endpoint"]) {
      as.metadata = { [endpoint]: `${away}/as/${endpoint}` }
      expect(await refusal()).toBe(
        `The authorization server ${issuer()} lists no authorization or token endpoint on https.`,
      )
    }
    // A registration endpoint not on https is none: a client is entered by hand instead (#218).
    as.metadata = { registration_endpoint: `${away}/as/register` }
    expect(await ask(web, { _tag: "ConnectInstallation", installationId })).toMatchObject({
      _tag: "InstallationNeedsClient",
      issuer: issuer(),
    })
    expect(as.registered).toEqual([])
    as.metadata = {}

    // Nor the MCP server itself, though a header secret Plugin may be on http.
    state(
      await ask(web, {
        _tag: "EditPlugin",
        pluginId,
        name: "Tracker",
        url: "http://mcp.example.test/mcp",
        auth: { _tag: "OAuth" },
      }),
    )
    expect(await refusal()).toBe("The Hub connects only to an MCP server on https.")
    expect(as.issued).toBe(0)
  })

  test("is refused for a Plugin that doesn't use OAuth, or changed meanwhile", async () => {
    const { hub, web } = await scene()
    const { pluginId, installationId } = await install(web)
    const begun = await authorize(web, installationId)
    // The Plugin's server moved meanwhile: the connection begun isn't for it.
    state(
      await ask(web, {
        _tag: "EditPlugin",
        pluginId,
        name: "Tracker",
        url: `http://localhost:${server.port}/mcp`,
        auth: { _tag: "OAuth" },
      }),
    )
    expect(
      (
        await callback(hub, web.cookie, { code: begun.code, state: begun.state, iss: issuer() })
      ).searchParams.get("connectError"),
    ).toBe("Tracker or its Plugin changed meanwhile: connect it again.")

    state(
      await ask(web, {
        _tag: "EditPlugin",
        pluginId,
        name: "Tracker",
        url: mcpUrl(),
        auth: { _tag: "None" },
      }),
    )
    expect(await ask(web, { _tag: "ConnectInstallation", installationId })).toMatchObject({
      _tag: "CommandFailed",
      message: "Tracker doesn't use OAuth: there is no account to connect.",
    })
  })

  test("is cleared, client and all, when its Plugin's server moves to another origin", async () => {
    const { hub, web } = await scene()
    const { pluginId, installationId } = await install(web)
    await connect(hub, web, installationId)
    // Another path at the same origin keeps the connection.
    state(
      await ask(web, {
        _tag: "EditPlugin",
        pluginId,
        name: "Tracker",
        url: `${mcpUrl()}/`,
        auth: { _tag: "OAuth", scopes: ["read"] },
      }),
    )
    expect((await installationOf(web, installationId))?.connection).toBeDefined()
    // Another origin could take the tokens: they go, and the client registered for them.
    state(
      await ask(web, {
        _tag: "EditPlugin",
        pluginId,
        name: "Tracker",
        url: `http://localhost:${server.port}/mcp`,
        auth: { _tag: "OAuth" },
      }),
    )
    expect((await installationOf(web, installationId))?.connection).toBeUndefined()
    const rows = await hub.run(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM installation_oauth`,
      ),
    )
    expect(rows).toEqual([{ count: 0 }])
    expect(await logOf(web)).toEqual([
      "Created",
      "Connected",
      "PluginEdited",
      "PluginEdited",
      "Disconnected",
    ])
  })

  test("is disconnected on request, and logged", async () => {
    const { hub, runner, web } = await scene()
    const { installationId } = await install(web)
    expect(await ask(web, { _tag: "DisconnectInstallation", installationId })).toMatchObject({
      _tag: "CommandFailed",
      message: "Tracker isn't connected.",
    })
    await connect(hub, web, installationId)
    const start = await startSession(web, runner)
    expect(
      state(await ask(web, { _tag: "DisconnectInstallation", installationId })).installations[0]
        ?.connection,
    ).toBeUndefined()
    expect(await logOf(web)).toEqual(["Created", "Connected", "Disconnected"])
    // Live: the running Session's requests stop at once.
    const answer = await through(hub, installationId, start.modToken)
    expect(answer.status).toBe(409)
    expect(await answer.json()).toEqual({
      error: "Tracker isn't connected to its account: reconnect it on the Plugins page.",
    })
  })

  test("is connected or disconnected only by the Owner, for a global one (#219)", async () => {
    const { hub, runner, web } = await scene()
    await makeOwner(hub, "alice")
    const created = state(
      await ask(web, {
        _tag: "CreatePlugin",
        name: "Tracker",
        url: mcpUrl(),
        auth: { _tag: "OAuth" },
      }),
    )
    const pluginId = created.plugins.find((plugin) => plugin.name === "Tracker")?.id
    const answer = state(
      await ask(web, {
        _tag: "CreateInstallation",
        pluginId,
        name: "Tracker",
        repos: [],
        global: true,
      }),
    )
    const installationId = answer.installations.find((found) => found.pluginId === pluginId)?.id
    if (installationId === undefined) throw new Error("Not installed")

    // Every Session on the Hub would act as its account: not bob's to choose.
    const bob = await openWeb(hub, "bob")
    for (const _tag of ["ConnectInstallation", "DisconnectInstallation"]) {
      expect(await ask(bob, { _tag, installationId })).toMatchObject({
        _tag: "CommandFailed",
        message: globalConnectRefusal,
      })
    }
    // A Session on any Repo is kept from starting until the Owner connects it.
    await connect(hub, web, installationId)
    expect(await logOf(web)).toEqual(["Created", "Connected"])
    const start = await startSession(web, runner)
    expect((await through(hub, installationId, start.modToken)).status).toBe(200)
    expect(await ask(bob, { _tag: "DisconnectInstallation", installationId })).toMatchObject({
      _tag: "CommandFailed",
      message: globalConnectRefusal,
    })
    expect((await installationOf(web, installationId))?.connection).toBeDefined()

    // A connection begun on a Repo-scoped one isn't finished once it is global.
    const scoped = state(
      await ask(web, { _tag: "CreateInstallation", pluginId, name: "Scoped", repos: [repo] }),
    ).installations.find((found) => found.name === "Scoped")?.id
    if (scoped === undefined) throw new Error("Not installed")
    const begun = await authorize(web, scoped)
    await ask(web, { _tag: "DeleteInstallation", installationId })
    state(
      await ask(web, {
        _tag: "EditInstallation",
        installationId: scoped,
        name: "Scoped",
        repos: [],
        global: true,
      }),
    )
    const back = await callback(hub, web.cookie, {
      code: begun.code,
      state: begun.state,
      iss: issuer(),
    })
    expect(back.searchParams.get("connectError")).toBe(
      "Scoped or its Plugin changed meanwhile: connect it again.",
    )
    expect((await installationOf(web, scoped))?.connection).toBeUndefined()
  })
})

describe("an OAuth Installation's tokens", () => {
  test("reach its server through the Gateway, live, and Claude Code never runs OAuth", async () => {
    const { hub, runner, web } = await scene()
    const { installationId } = await install(web)
    await connect(hub, web, installationId)
    // Connecting asked the server without a token, for its challenge.
    expect(mcpSeen.map((seen) => seen.authorization)).toEqual([null])
    mcpSeen.length = 0
    const start = await startSession(web, runner)
    // The start's check, with the token.
    expect(mcpSeen.length).toBeGreaterThan(0)
    expect(mcpSeen.every((seen) => seen.authorization === `Bearer ${accessToken(1)}`)).toBe(true)
    const checked = mcpSeen.length

    const answer = await through(hub, installationId, start.modToken)
    expect(answer.status).toBe(200)
    expect(answer.headers.get("www-authenticate")).toBeNull()
    expect(mcpSeen.at(-1)?.authorization).toBe(`Bearer ${accessToken(1)}`)

    // Nothing under the Installation's path reaches a server, nor OAuth's discovery.
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server",
      "/register",
    ]) {
      const below = await through(hub, `${installationId}${path}`, start.modToken, {
        method: "GET",
        body: null,
      })
      expect(below.status).toBe(404)
      expect(below.headers.get("content-type")).toContain("application/json")
    }
    expect(mcpSeen).toHaveLength(checked + 1)

    // Its token refused, the Hub refreshes it and sends the request again: one answer.
    as.valid.clear()
    const retried = await through(hub, installationId, start.modToken)
    expect(retried.status).toBe(200)
    expect(mcpSeen.slice(-2).map((seen) => seen.authorization)).toEqual([
      `Bearer ${accessToken(1)}`,
      `Bearer ${accessToken(2)}`,
    ])

    // Refused again with the refreshed one, before it ever worked: the 401 isn't passed on.
    as.valid.clear()
    const lost = await logsOf(async () => {
      const refused = await through(hub, installationId, start.modToken)
      expect(refused.status).not.toBe(401)
      expect(refused.headers.get("www-authenticate")).toBeNull()
    })
    expectNoSecretIn(lost)
    expectNoSecretIn(web.texts.join("\n"))
  })

  test("go with a request the Gateway holds no more than 4 MiB of", async () => {
    const { hub, runner, web } = await scene()
    const { installationId } = await install(web)
    await connect(hub, web, installationId)
    const start = await startSession(web, runner)
    const sent = mcpSeen.length
    const tooLarge = `The request's body is larger than 4 MiB, the most the Gateway takes for an OAuth Installation.`

    // Saying its length.
    const said = await through(hub, installationId, start.modToken, {
      body: "x".repeat(MaxOAuthRequestBytes + 1),
    })
    expect(said.status).toBe(413)
    expect(await said.json()).toEqual({ error: tooLarge })

    // In chunks, without saying: refused once past the limit, the rest never read.
    let pulled = 0
    const chunk = new Uint8Array(1024 * 1024)
    const chunked = await through(hub, installationId, start.modToken, {
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          // Far more than the limit, were it all read.
          if (++pulled > 64) controller.close()
          else controller.enqueue(chunk)
        },
      }),
      duplex: "half",
    } as RequestInit)
    expect(chunked.status).toBe(413)
    expect(await chunked.json()).toEqual({ error: tooLarge })
    expect(pulled).toBeLessThan(64)
    expect(mcpSeen).toHaveLength(sent)

    // At the limit, it goes.
    const atLimit = await through(hub, installationId, start.modToken, {
      body: "x".repeat(MaxOAuthRequestBytes),
    })
    expect(atLimit.status).toBe(200)
    expect(mcpSeen).toHaveLength(sent + 1)
  })

  test("are refreshed once at a time, and the rotated refresh token is kept", async () => {
    const { hub, web } = await scene()
    const { installationId } = await install(web)
    // Tokens that expire within a minute are refreshed before they are sent.
    as.expiresIn = 30
    await connect(hub, web, installationId)
    as.expiresIn = 3600
    as.refreshDelay = 100
    const tokens = await hub.run(
      Effect.flatMap(PluginOAuth, (oauth) =>
        Effect.all(
          Array.from({ length: 5 }, () => oauth.accessToken(installationId as never)),
          { concurrency: "unbounded" },
        ),
      ),
    )
    expect(as.refreshes).toHaveLength(1)
    expect(
      new Set(tokens.map((token) => token._tag === "Token" && Redacted.value(token.token))),
    ).toEqual(new Set([accessToken(2)]))
    expect(as.refreshes[0]?.get("refresh_token")).toBe(refreshToken(1))
    expect(as.refreshes[0]?.get("resource")).toBe(mcpUrl())

    // Refused by the server, the next refresh uses the refresh token the last one rotated to: the
    // first no longer works.
    const generation = tokens[0]?._tag === "Token" ? tokens[0].generation : -1
    const next = await hub.run(
      Effect.flatMap(PluginOAuth, (oauth) =>
        Effect.andThen(
          oauth.rejected(installationId as never, generation),
          oauth.accessToken(installationId as never),
        ),
      ),
    )
    expect(next._tag === "Token" && Redacted.value(next.token)).toBe(accessToken(3))
    expect(as.refreshes.map((form) => form.get("refresh_token"))).toEqual([
      refreshToken(1),
      refreshToken(2),
    ])
    expect((await installationOf(web, installationId))?.connection?.lostAt).toBeUndefined()
  })

  test("refused a refresh, lose the connection: Sessions don't start until it is reconnected", async () => {
    const { hub, runner, web } = await scene()
    const { installationId } = await install(web)
    await connect(hub, web, installationId)
    const start = await startSession(web, runner)

    // The grant revoked at the authorization server: the token refused, and its refresh too.
    as.valid.clear()
    as.revoked = true
    const logged = await logsOf(async () => {
      const answer = await through(hub, installationId, start.modToken)
      expect(answer.status).toBe(409)
      expect(answer.headers.get("www-authenticate")).toBeNull()
      expect(await answer.json()).toEqual({
        error: "Tracker isn't connected to its account: reconnect it on the Plugins page.",
      })
    })
    expect(logged).toContain("invalid_grant")
    expectNoSecretIn(logged)
    // Noted in the running Session.
    expect(await notesOf(web, start.sessionId)).toEqual([
      {
        _tag: "SandboxNoted",
        message:
          "Tracker isn't connected to its account. Its tools fail until it is reconnected on the Plugins page.",
        installationFailed: { installationId, installation: "Tracker", reason: "NotConnected" },
      },
    ])
    // Shown lost on the Plugins page.
    expect((await installationOf(web, installationId))?.connection?.lostAt).toEqual(
      expect.any(Number),
    )

    // A new Session doesn't start, without its server asked anything.
    mcpSeen.length = 0
    const created = await ask(web, { _tag: "CreateSession", repo, baseBranch: "main" })
    if (created._tag !== "SessionCreated") throw new Error(JSON.stringify(created))
    await web.take(
      "SessionUpdated",
      (m) => m.session.id === created.session.id && m.session.state === "Asleep",
    )
    expect(await lastChangeOf(web, created.session.id)).toMatchObject({
      state: "Asleep",
      installationsFailed: [{ installationId, installation: "Tracker", reason: "NotConnected" }],
    })
    expect(mcpSeen).toEqual([])
    expect(await runner.untaken("StartSession")).toEqual([])

    // Reconnected, it starts.
    as.revoked = false
    await connect(hub, web, installationId)
    web.send({ _tag: "WakeSession", sessionId: created.session.id })
    expect((await runner.take("StartSession")).sessionId).toBe(created.session.id)
    expectNoSecretIn(web.texts.join("\n"))
  })
})

describe("a client entered by hand (#218)", () => {
  const app = { clientId: "gh-app", clientSecret: "gh-SECRET-entered-5f1e" }
  /** The authorization server offers no Dynamic Client Registration, and knows `app`. */
  const withoutRegistration = (methods?: ReadonlyArray<string>) => {
    as.metadata = {
      registration_endpoint: undefined,
      ...(methods !== undefined && { token_endpoint_auth_methods_supported: methods }),
    }
    as.manual.set(app.clientId, app.clientSecret)
  }

  test("is asked for where the server offers no Dynamic Client Registration, then connects and refreshes", async () => {
    const { hub, runner, web } = await scene()
    const { installationId } = await install(web)
    withoutRegistration()

    let logged = ""
    logged += await logsOf(async () => {
      // The form shows where to register the client: the Hub's callback.
      expect(await ask(web, { _tag: "ConnectInstallation", installationId })).toEqual({
        _tag: "InstallationNeedsClient",
        requestId: expect.any(String),
        installationId,
        issuer: issuer(),
        callbackUrl: `${webOrigin}${OAuthCallbackPath}`,
        publicClient: false,
      })
      const begun = await authorize(web, installationId, app)
      expect(begun.url.searchParams.get("client_id")).toBe("gh-app")
      expect(begun.url.searchParams.get("redirect_uri")).toBe(`${webOrigin}${OAuthCallbackPath}`)
      const back = await callback(hub, web.cookie, {
        code: begun.code,
        state: begun.state,
        iss: issuer(),
      })
      expect(back.searchParams.get("connectError")).toBeNull()
    })
    // Basic, as the server's metadata names no other way (RFC 8414's default).
    expect(as.auth).toEqual(["client_secret_basic:gh-app"])
    expect(as.registered).toEqual([])
    const installation = await installationOf(web, installationId)
    expect(installation?.client).toEqual({
      clientId: "gh-app",
      secret: true,
      setBy: { id: "dev:alice", login: "alice", name: "alice" },
      setAt: expect.any(Number),
    })
    // Its ID token is for the client entered: the account is known.
    expect(installation?.connection?.account).toBe("bot@example.com")
    expect(await logOf(web)).toEqual(["Created", "ClientSet", "Connected"])

    // Reconnecting reuses it, without asking again, nor logging it as set again.
    as.expiresIn = 30
    logged += await logsOf(() => connect(hub, web, installationId).then(() => undefined))
    as.expiresIn = 3600
    expect(await logOf(web)).toEqual(["Created", "ClientSet", "Connected", "Reconnected"])

    // Refreshed as a registered one is, with the client entered.
    const start = await startSession(web, runner)
    expect((await through(hub, installationId, start.modToken)).status).toBe(200)
    expect(as.refreshes).toHaveLength(1)
    expect(as.auth.at(-1)).toBe("client_secret_basic:gh-app")

    // Disconnecting keeps the client, to connect with again.
    const disconnected = state(await ask(web, { _tag: "DisconnectInstallation", installationId }))
    expect(disconnected.installations[0]?.connection).toBeUndefined()
    expect(disconnected.installations[0]?.client?.clientId).toBe("gh-app")
    expect((await ask(web, { _tag: "ConnectInstallation", installationId }))._tag).toBe(
      "InstallationAuthorizing",
    )

    // Its secret is encrypted at rest, and reaches no web client nor any log.
    expectNoSecretIn(await databaseText(hub))
    expectNoSecretIn(web.texts.join("\n"))
    expectNoSecretIn(logged)
  })

  test("authenticates as the server takes: by Basic, in the form, or as a public client", async () => {
    const { hub, web } = await scene()
    const { installationId } = await install(web)
    const refusal = async (client: Record<string, unknown>) => {
      const answer = await ask(web, { _tag: "ConnectInstallation", installationId, client })
      if (answer._tag !== "CommandFailed") throw new Error(JSON.stringify(answer))
      return answer.message
    }

    withoutRegistration(["client_secret_post"])
    await connect(hub, web, installationId, app)
    expect(as.auth).toEqual(["client_secret_post:gh-app"])
    expect(await refusal({ clientId: "gh-app" })).toBe(
      `The authorization server ${issuer()} takes no public client: enter the client's secret too.`,
    )

    // A server that takes public clients says so, and takes one without a secret. The client
    // entered before, which it no longer takes, is asked for again.
    withoutRegistration(["none"])
    as.manual.set("gh-public", undefined)
    expect(await ask(web, { _tag: "ConnectInstallation", installationId })).toMatchObject({
      _tag: "InstallationNeedsClient",
      publicClient: true,
      reason:
        "The authorization server no longer takes the client entered before as it was: enter it again.",
    })
    expect(await refusal(app)).toBe(
      `The authorization server ${issuer()} takes only public clients: leave the client secret empty.`,
    )
    as.auth.length = 0
    await connect(hub, web, installationId, { clientId: "gh-public" })
    expect(as.auth).toEqual(["none:gh-public"])
    expect((await installationOf(web, installationId))?.client).toMatchObject({
      clientId: "gh-public",
      secret: false,
    })

    // What the web UI checks, the Hub checks too.
    expect(await refusal({ clientId: " " })).toBe("Enter the client ID.")
    expect(await refusal({ clientId: "gh app" })).toBe(
      "The client ID must be one word of plain characters, with no spaces.",
    )
    expect(await logOf(web)).toEqual([
      "Created",
      "ClientSet",
      "Connected",
      "ClientSet",
      "Reconnected",
    ])
  })

  test("is changed on request, kept only once it connects, and never replaced by a registered one", async () => {
    const { hub, web } = await scene()
    const { installationId } = await install(web)
    withoutRegistration()
    await connect(hub, web, installationId, app)

    // Change client asks for one even where the one it has fits.
    expect(
      await ask(web, { _tag: "ConnectInstallation", installationId, changeClient: true }),
    ).toMatchObject({ _tag: "InstallationNeedsClient", issuer: issuer() })
    // One entered for a connection never finished is not kept.
    as.manual.set("gh-wrong", "gh-SECRET-wrong-0c2a")
    await authorize(web, installationId, {
      clientId: "gh-wrong",
      clientSecret: "gh-SECRET-wrong-0c2a",
    })
    expect((await installationOf(web, installationId))?.client?.clientId).toBe("gh-app")
    // Nor is one the server refuses the code for: the one before still works.
    const refused = await authorize(web, installationId, {
      clientId: "gh-app",
      clientSecret: "gh-SECRET-not-it",
    })
    const back = await callback(hub, web.cookie, {
      code: refused.code,
      state: refused.state,
      iss: issuer(),
    })
    expect(back.searchParams.get("connectError")).toBe(
      "The authorization server refused the connection: invalid_client.",
    )
    expect((await installationOf(web, installationId))?.connection).toBeDefined()
    expect((await installationOf(web, installationId))?.client?.clientId).toBe("gh-app")

    // Another client, connected, replaces it, logged.
    as.manual.set("gh-other", "gh-SECRET-other-77d3")
    await connect(hub, web, installationId, {
      clientId: "gh-other",
      clientSecret: "gh-SECRET-other-77d3",
    })
    expect((await installationOf(web, installationId))?.client?.clientId).toBe("gh-other")
    expect(await logOf(web)).toEqual([
      "Created",
      "ClientSet",
      "Connected",
      "ClientSet",
      "Reconnected",
    ])

    // Should the server offer registration later, the client entered is still the one used.
    as.metadata = {}
    as.auth.length = 0
    await connect(hub, web, installationId)
    expect(as.registered).toEqual([])
    expect(as.auth).toEqual(["client_secret_basic:gh-other"])
  })

  test("is set only by the Owner, for a global one, and redacted from every Session's output", async () => {
    const { hub, web } = await scene()
    await makeOwner(hub, "alice")
    withoutRegistration()
    const created = state(
      await ask(web, {
        _tag: "CreatePlugin",
        name: "Tracker",
        url: mcpUrl(),
        auth: { _tag: "OAuth" },
      }),
    )
    const pluginId = created.plugins.find((plugin) => plugin.name === "Tracker")?.id
    const installationId = state(
      await ask(web, {
        _tag: "CreateInstallation",
        pluginId,
        name: "Tracker",
        repos: [],
        global: true,
      }),
    ).installations.find((found) => found.pluginId === pluginId)?.id
    if (installationId === undefined) throw new Error("Not installed")

    const bob = await openWeb(hub, "bob")
    expect(
      await ask(bob, { _tag: "ConnectInstallation", installationId, client: app }),
    ).toMatchObject({ _tag: "CommandFailed", message: globalConnectRefusal })
    await connect(hub, web, installationId, app)
    expect((await installationOf(bob, installationId))?.client?.clientId).toBe("gh-app")

    // Only the Hub ever sends it; yet were it printed, it is redacted, on any Repo.
    const values = await hub.run(
      Effect.flatMap(Plugins, (plugins) => plugins.valuesOn("someone/else")),
    )
    expect(values.map(Redacted.value)).toContain(app.clientSecret)
  })

  test("goes, with its secret, when its Plugin's server moves to another origin", async () => {
    const { hub, web } = await scene()
    const { pluginId, installationId } = await install(web)
    withoutRegistration()
    await connect(hub, web, installationId, app)
    await ask(web, { _tag: "DisconnectInstallation", installationId })
    state(
      await ask(web, {
        _tag: "EditPlugin",
        pluginId,
        name: "Tracker",
        url: `http://localhost:${server.port}/mcp`,
        auth: { _tag: "OAuth" },
      }),
    )
    expect((await installationOf(web, installationId))?.client).toBeUndefined()
    expect(await databaseText(hub)).not.toContain("gh-app")
  })
})
