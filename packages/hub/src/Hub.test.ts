// The Hub's routes, served by a real Bun server on 127.0.0.1 with an in-memory database: the
// WebSocket channels need a real upgrade, and dev login checks the caller's address.

import { afterEach, describe, expect, test } from "bun:test"
import { ProtocolVersion, SessionId } from "@claude-hub/protocol"
import { BunHttpServer } from "@effect/platform-bun"
import { Context, Effect, Exit, Layer, Option, Scope } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import { signInCookie } from "./Auth.ts"
import { CloseCode } from "./Channels.ts"
import { DatabaseTest } from "./Database.ts"
import { GitHub } from "./GitHub.ts"
import { HubRoutes, HubServices } from "./Hub.ts"
import { HubConfig, type HubConfigInput } from "./HubConfig.ts"
import { ModTokens } from "./ModTokens.ts"
import { RunnerTokens } from "./RunnerTokens.ts"
import type { SignIns } from "./SignIns.ts"

const webOrigin = "http://localhost:5173"

const baseConfig: HubConfigInput = {
  host: "127.0.0.1",
  port: 0,
  publicUrl: new URL(webOrigin),
  githubClientId: Option.none(),
  githubClientSecret: Option.none(),
  devLogin: false,
  devLoginName: "dev",
}

type Credentials = RunnerTokens | ModTokens | SignIns

interface TestHub {
  /** The Hub's address, such as `http://127.0.0.1:54321`. */
  readonly url: string
  /** Runs an effect against the Hub's credential stores. */
  readonly run: <A, E>(effect: Effect.Effect<A, E, Credentials>) => Promise<A>
}

const openHubs: Array<Scope.Closeable> = []
afterEach(async () => {
  await Promise.all(
    openHubs.splice(0).map((scope) => Effect.runPromise(Scope.close(scope, Exit.void))),
  )
})

async function startHub(
  options: {
    readonly config?: Partial<HubConfigInput>
    readonly github?: Layer.Layer<GitHub>
  } = {},
): Promise<TestHub> {
  const layer = HttpRouter.serve(HubRoutes, { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provideMerge(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0 })),
    Layer.provideMerge(options.github ?? GitHub.layer),
    Layer.provideMerge(HubServices),
    Layer.provideMerge(DatabaseTest),
    Layer.provideMerge(HubConfig.layerFrom({ ...baseConfig, ...options.config })),
  )
  const scope = Scope.makeUnsafe()
  openHubs.push(scope)
  const context = await Effect.runPromise(Layer.buildWithScope(layer, scope))
  const address = Context.get(context, HttpServer.HttpServer).address
  if (!("port" in address)) throw new Error("expected a TCP address")
  return {
    url: `http://127.0.0.1:${address.port}`,
    run: (effect) => Effect.runPromise(Effect.provideContext(effect, context)),
  }
}

const runnerHello = {
  _tag: "RunnerHello",
  protocolVersion: ProtocolVersion,
  name: "mac",
  login: { account: "alice@example.com" },
  sessions: [],
}

const modHello = (sessionId: string) => ({
  _tag: "ModHello",
  protocolVersion: ProtocolVersion,
  sessionId,
  claudeSessionId: "claude-1",
  model: "claude-opus",
})

const webHello = { _tag: "WebHello", protocolVersion: ProtocolVersion }

interface SocketOutcome {
  readonly opened: boolean
  readonly messages: ReadonlyArray<unknown>
  readonly code: number
  readonly reason: string
}

/**
 * Opens a WebSocket, sends `hello` once it is open, and reports what came back until the Hub
 * closes it, or until it has been quiet for a moment after its first message.
 */
function openSocket(
  hub: TestHub,
  path: string,
  options: { readonly headers?: Record<string, string>; readonly hello?: unknown },
): Promise<SocketOutcome> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${hub.url.replace(/^http/, "ws")}${path}`, {
      headers: options.headers ?? {},
    })
    let opened = false
    const messages: Array<unknown> = []
    socket.addEventListener("open", () => {
      opened = true
      if (options.hello !== undefined) socket.send(JSON.stringify(options.hello))
    })
    socket.addEventListener("message", (event) => {
      messages.push(JSON.parse(String(event.data)))
      setTimeout(() => socket.close(1000), 100)
    })
    socket.addEventListener("close", (event) =>
      resolve({ opened, messages, code: event.code, reason: event.reason }),
    )
  })
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

/** The sign-in cookie to send back, from a response that set it. */
function cookieFrom(response: Response): string {
  const value = new RegExp(`${signInCookie}=([^;]+)`).exec(
    response.headers.get("set-cookie") ?? "",
  )?.[1]
  if (value === undefined) throw new Error("no sign-in cookie was set")
  return `${signInCookie}=${value}`
}

const devSignIn = (hub: TestHub, login = "alice") =>
  fetch(`${hub.url}/auth/dev`, {
    method: "POST",
    headers: { origin: webOrigin, "content-type": "application/json" },
    body: JSON.stringify({ login }),
  })

/** A Runner token, and a mod token for Session `s-a` on that Runner. */
const issueTokens = (hub: TestHub) =>
  hub.run(
    Effect.gen(function* () {
      const runner = yield* (yield* RunnerTokens).issue("mac")
      const modToken = yield* (yield* ModTokens).issue({
        sessionId: SessionId.make("s-a"),
        runnerId: runner.runnerId,
      })
      return { runnerToken: runner.token, modToken }
    }),
  )

describe("without a credential", () => {
  // Every route the Hub serves but /health and the sign-in flow itself.
  const protectedRoutes = [
    ["GET", "/auth/me"],
    ["POST", "/auth/sign-out"],
    ["GET", "/ws/runner"],
    ["GET", "/ws/mod"],
    ["GET", "/ws/web"],
  ] as const

  test.each(protectedRoutes)("%s %s is rejected", async (method, path) => {
    const hub = await startHub()
    const response = await fetch(`${hub.url}${path}`, {
      method,
      headers: { origin: webOrigin },
    })

    expect(response.status).toBe(401)
  })

  test.each(["/ws/runner", "/ws/mod", "/ws/web"])("no WebSocket opens on %s", async (path) => {
    const hub = await startHub()
    const outcome = await openSocket(hub, path, {
      headers: { origin: webOrigin },
      hello: runnerHello,
    })

    expect(outcome.opened).toBe(false)
    expect(outcome.messages).toEqual([])
  })

  test("a token that was never issued is rejected", async () => {
    const hub = await startHub()
    const forged = `chr_${"0".repeat(24)}.${"A".repeat(43)}`
    const outcome = await openSocket(hub, "/ws/runner", {
      headers: bearer(forged),
      hello: runnerHello,
    })

    expect(outcome.opened).toBe(false)
  })

  test("GET /health still answers", async () => {
    const hub = await startHub()

    expect((await fetch(`${hub.url}/health`)).status).toBe(200)
  })

  test("GET /auth/me says how to sign in", async () => {
    const hub = await startHub({ config: { devLogin: true } })
    const response = await fetch(`${hub.url}/auth/me`)

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: "Sign in first", github: false, dev: true })
  })
})

describe("Runner channel", () => {
  test("welcomes a Runner with the RunnerId its token was issued to", async () => {
    const hub = await startHub()
    const runner = await hub.run(Effect.flatMap(RunnerTokens, (r) => r.issue("mac")))
    const outcome = await openSocket(hub, "/ws/runner", {
      headers: bearer(runner.token),
      hello: runnerHello,
    })

    expect(outcome.messages).toEqual([
      { _tag: "RunnerWelcome", protocolVersion: ProtocolVersion, runnerId: runner.runnerId },
    ])
  })

  test("rejects a hello from another protocol version", async () => {
    const hub = await startHub()
    const runner = await hub.run(Effect.flatMap(RunnerTokens, (r) => r.issue("mac")))
    const outcome = await openSocket(hub, "/ws/runner", {
      headers: bearer(runner.token),
      hello: { ...runnerHello, protocolVersion: ProtocolVersion + 1 },
    })

    expect(outcome.messages).toMatchObject([
      { _tag: "HandshakeRejected", reason: "ProtocolVersionMismatch" },
    ])
    expect(outcome.code).toBe(1008)
  })

  test("refuses a mod token and a sign-in cookie", async () => {
    const hub = await startHub({ config: { devLogin: true } })
    const { modToken } = await issueTokens(hub)
    const cookie = cookieFrom(await devSignIn(hub))

    for (const headers of [bearer(modToken), { cookie, origin: webOrigin }]) {
      const response = await fetch(`${hub.url}/ws/runner`, { headers })
      expect(response.status).toBe(401)
    }
  })
})

describe("mod channel", () => {
  test("welcomes the mod of the Session its token is for", async () => {
    const hub = await startHub()
    const { modToken } = await issueTokens(hub)
    const outcome = await openSocket(hub, "/ws/mod", {
      headers: bearer(modToken),
      hello: modHello("s-a"),
    })

    expect(outcome.messages).toEqual([{ _tag: "ModWelcome", protocolVersion: ProtocolVersion }])
  })

  test("refuses a mod token for another Session", async () => {
    const hub = await startHub()
    const { modToken } = await issueTokens(hub)
    const outcome = await openSocket(hub, "/ws/mod", {
      headers: bearer(modToken),
      hello: modHello("s-b"),
    })

    expect(outcome.opened).toBe(true)
    expect(outcome.messages).toEqual([])
    expect(outcome.code).toBe(CloseCode.Forbidden)
  })

  test("refuses a Runner token", async () => {
    const hub = await startHub()
    const { runnerToken } = await issueTokens(hub)
    const outcome = await openSocket(hub, "/ws/mod", {
      headers: bearer(runnerToken),
      hello: modHello("s-a"),
    })

    expect(outcome.opened).toBe(false)
    expect((await fetch(`${hub.url}/ws/mod`, { headers: bearer(runnerToken) })).status).toBe(401)
  })
})

describe("web channel", () => {
  test("welcomes the signed-in person from the web UI's origin", async () => {
    const hub = await startHub({ config: { devLogin: true } })
    const cookie = cookieFrom(await devSignIn(hub))
    const outcome = await openSocket(hub, "/ws/web", {
      headers: { cookie, origin: webOrigin },
      hello: webHello,
    })

    expect(outcome.messages).toEqual([
      {
        _tag: "WebWelcome",
        protocolVersion: ProtocolVersion,
        you: { id: "dev:alice", login: "alice", name: "alice" },
      },
    ])
  })

  test("refuses a signed-in cookie sent from another origin", async () => {
    const hub = await startHub({ config: { devLogin: true } })
    const cookie = cookieFrom(await devSignIn(hub))
    const response = await fetch(`${hub.url}/ws/web`, {
      headers: { cookie, origin: "http://localhost:3000" },
    })

    expect(response.status).toBe(403)
  })

  test("refuses a Runner token", async () => {
    const hub = await startHub()
    const runner = await hub.run(Effect.flatMap(RunnerTokens, (r) => r.issue("mac")))
    const response = await fetch(`${hub.url}/ws/web`, {
      headers: { ...bearer(runner.token), origin: webOrigin },
    })

    expect(response.status).toBe(401)
  })
})

describe("dev login", () => {
  test("is off unless CLAUDE_HUB_DEV_LOGIN is set", async () => {
    const hub = await startHub()

    expect((await devSignIn(hub)).status).toBe(404)
  })

  test("is refused when the Hub is bound to a non-loopback address", async () => {
    for (const host of ["0.0.0.0", "192.168.1.10", "::", "hub.example.com"]) {
      const result = await Effect.runPromiseExit(
        HubConfig.make({ ...baseConfig, host, devLogin: true }),
      )
      expect(Exit.isFailure(result)).toBe(true)
    }
  })

  test("is refused when browsers reach the Hub at a non-loopback URL", async () => {
    const result = await Effect.runPromiseExit(
      HubConfig.make({
        ...baseConfig,
        publicUrl: new URL("https://hub.example.com"),
        devLogin: true,
      }),
    )

    expect(Exit.isFailure(result)).toBe(true)
  })

  test("is allowed on every loopback address", async () => {
    for (const host of ["127.0.0.1", "localhost", "::1", "[::1]"]) {
      const result = await Effect.runPromiseExit(
        HubConfig.make({ ...baseConfig, host, devLogin: true }),
      )
      expect(Exit.isSuccess(result)).toBe(true)
    }
  })

  test("signs in with an HttpOnly, SameSite=Lax, host-only cookie, not Secure on loopback", async () => {
    const hub = await startHub({ config: { devLogin: true } })
    const response = await devSignIn(hub)
    const setCookie = response.headers.get("set-cookie") ?? ""

    expect(response.status).toBe(200)
    expect(setCookie).toContain("HttpOnly")
    expect(setCookie).toContain("SameSite=Lax")
    expect(setCookie).not.toContain("Secure")
    expect(setCookie).not.toContain("Domain")

    const me = await fetch(`${hub.url}/auth/me`, { headers: { cookie: cookieFrom(response) } })
    expect(await me.json()).toEqual({ id: "dev:alice", login: "alice", name: "alice" })
  })

  test("signs in as the configured user when no login is given", async () => {
    const hub = await startHub({ config: { devLogin: true, devLoginName: "Emil Dige" } })
    const response = await fetch(`${hub.url}/auth/dev`, {
      method: "POST",
      headers: { origin: webOrigin },
    })

    expect(await response.json()).toEqual({
      id: "dev:Emil-Dige",
      login: "Emil-Dige",
      name: "Emil-Dige",
    })
  })

  test("refuses a request from another origin", async () => {
    const hub = await startHub({ config: { devLogin: true } })
    const response = await fetch(`${hub.url}/auth/dev`, {
      method: "POST",
      headers: { origin: "http://evil.test" },
    })

    expect(response.status).toBe(403)
  })
})

describe("sign-out", () => {
  test("ends the sign-in", async () => {
    const hub = await startHub({ config: { devLogin: true } })
    const cookie = cookieFrom(await devSignIn(hub))
    const signOut = await fetch(`${hub.url}/auth/sign-out`, {
      method: "POST",
      headers: { cookie, origin: webOrigin },
    })

    expect(signOut.status).toBe(204)
    expect((await fetch(`${hub.url}/auth/me`, { headers: { cookie } })).status).toBe(401)
  })
})

describe("GitHub sign-in", () => {
  const github = GitHub.layerTest({
    code: "good-code",
    user: { id: 42, login: "octocat", name: null },
  })

  test("is off while the GitHub App isn't configured", async () => {
    const hub = await startHub()

    expect((await fetch(`${hub.url}/auth/github`, { redirect: "manual" })).status).toBe(404)
    expect((await fetch(`${hub.url}/auth/github/callback?code=x&state=y`)).status).toBe(404)
  })

  test("is refused with only one of the client id and secret", async () => {
    const result = await Effect.runPromiseExit(
      HubConfig.make({ ...baseConfig, githubClientId: Option.some("Iv1.abc") }),
    )

    expect(Exit.isFailure(result)).toBe(true)
  })

  test("signs in once GitHub sends the browser back with the state it was given", async () => {
    const hub = await startHub({ github })
    const start = await fetch(`${hub.url}/auth/github`, { redirect: "manual" })
    const location = new URL(start.headers.get("location") ?? "")
    const state = location.searchParams.get("state") ?? ""
    const stateCookie = /claude_hub_oauth_state=([^;]+)/.exec(
      start.headers.get("set-cookie") ?? "",
    )?.[1]

    expect(start.status).toBe(302)
    expect(location.searchParams.get("redirect_uri")).toBe(`${webOrigin}/auth/github/callback`)

    const callback = await fetch(
      `${hub.url}/auth/github/callback?code=good-code&state=${encodeURIComponent(state)}`,
      { redirect: "manual", headers: { cookie: `claude_hub_oauth_state=${stateCookie}` } },
    )
    expect(callback.status).toBe(302)

    const me = await fetch(`${hub.url}/auth/me`, { headers: { cookie: cookieFrom(callback) } })
    expect(await me.json()).toEqual({ id: "github:42", login: "octocat", name: "octocat" })
  })

  test("refuses a callback whose state doesn't match the browser's", async () => {
    const hub = await startHub({ github })
    const callback = await fetch(`${hub.url}/auth/github/callback?code=good-code&state=forged`, {
      redirect: "manual",
      headers: { cookie: "claude_hub_oauth_state=other" },
    })

    expect(callback.status).toBe(400)
    expect(callback.headers.get("set-cookie") ?? "").not.toContain(signInCookie)
  })

  test("sets a Secure cookie when browsers reach the Hub over HTTPS", async () => {
    const hub = await startHub({
      github,
      config: { publicUrl: new URL("https://hub.example.com") },
    })
    const start = await fetch(`${hub.url}/auth/github`, { redirect: "manual" })
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? ""
    const callback = await fetch(
      `${hub.url}/auth/github/callback?code=good-code&state=${encodeURIComponent(state)}`,
      { redirect: "manual", headers: { cookie: `claude_hub_oauth_state=${state}` } },
    )

    expect(start.headers.get("set-cookie")).toContain("Secure")
    expect(callback.headers.get("set-cookie")).toContain("Secure")
  })
})
