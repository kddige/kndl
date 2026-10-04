// The Hub's routes, served by a real Bun server on 127.0.0.1 with an in-memory database: the
// WebSocket channels need a real upgrade, dev login checks the caller's address, and the mod's
// long poll needs a real connection held open.

import { afterEach, describe, expect, test } from "bun:test"
import { ModCommand, ProtocolVersion, SessionId } from "@claude-hub/protocol"
import { Effect, Exit, Option } from "effect"
import { signInCookie } from "./Auth.ts"
import { GitHub } from "./GitHub.ts"
import { HubConfig } from "./HubConfig.ts"
import { ModOutbox } from "./ModOutbox.ts"
import { ModTokens } from "./ModTokens.ts"
import { RunnerTokens } from "./RunnerTokens.ts"
import {
  baseConfig,
  bearer,
  cookieFrom,
  devSignIn,
  startHub,
  stopHubs,
  type TestHub,
  webOrigin,
} from "./testSupport.ts"

afterEach(stopHubs)

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

/** A Runner token, and mod tokens for Sessions `s-a` and `s-b` on that Runner. */
const issueTokens = (hub: TestHub) =>
  hub.run(
    Effect.gen(function* () {
      const runner = yield* (yield* RunnerTokens).issue("mac")
      const modTokens = yield* ModTokens
      const modToken = yield* modTokens.issue({
        sessionId: SessionId.make("s-a"),
        runnerId: runner.runnerId,
      })
      const otherModToken = yield* modTokens.issue({
        sessionId: SessionId.make("s-b"),
        runnerId: runner.runnerId,
      })
      return { runnerToken: runner.token, modToken, otherModToken }
    }),
  )

const sayHello = (hub: TestHub, token: string, hello: unknown = modHello("s-a")) =>
  fetch(`${hub.url}/mod/hello`, {
    method: "POST",
    headers: { ...bearer(token), "content-type": "application/json" },
    body: JSON.stringify(hello),
  })

const postEvents = (hub: TestHub, token: string, messages: ReadonlyArray<unknown> = []) =>
  fetch(`${hub.url}/mod/events`, {
    method: "POST",
    headers: { ...bearer(token), "content-type": "application/json" },
    body: JSON.stringify({ messages }),
  })

const pollCommands = (hub: TestHub, token: string, query = "") =>
  fetch(`${hub.url}/mod/commands${query}`, { headers: bearer(token) })

/** Queues a StopTurn for a Session's mod, as the Session relay will. */
const enqueueStop = (hub: TestHub, session: string) => {
  const sessionId = SessionId.make(session)
  return hub.run(
    Effect.flatMap(ModOutbox, (outbox) =>
      outbox.enqueue(sessionId, ModCommand.cases.StopTurn.make({ sessionId })),
    ),
  )
}

/** The seqs of the commands a poll answers with. */
const polledSeqs = async (response: Response) => {
  const body = (await response.json()) as { messages: Array<{ seq: number }> }
  return body.messages.map((command) => command.seq)
}

const turnStarted = {
  _tag: "TurnStarted",
  turnId: "t-1",
  promptId: "p-1",
  text: "add tests",
  sender: { _tag: "FromParticipant", participant: { id: "u-1", login: "alice", name: "Alice" } },
}

describe("without a credential", () => {
  // Every route the Hub serves but /health and the sign-in flow itself.
  const protectedRoutes = [
    ["GET", "/auth/me"],
    ["POST", "/auth/sign-out"],
    ["GET", "/ws/runner"],
    ["GET", "/ws/web"],
    ["POST", "/mod/hello"],
    ["POST", "/mod/events"],
    ["GET", "/mod/commands"],
  ] as const

  test.each(protectedRoutes)("%s %s is rejected", async (method, path) => {
    const hub = await startHub()
    const response = await fetch(`${hub.url}${path}`, {
      method,
      headers: { origin: webOrigin },
    })

    expect(response.status).toBe(401)
  })

  test.each(["/ws/runner", "/ws/web"])("no WebSocket opens on %s", async (path) => {
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
  const modRoutes = [
    ["POST", "/mod/hello"],
    ["POST", "/mod/events"],
    ["GET", "/mod/commands"],
  ] as const

  test.each(modRoutes)(
    "%s %s refuses a Runner token and a sign-in cookie",
    async (method, path) => {
      const hub = await startHub({ config: { devLogin: true } })
      const { runnerToken } = await issueTokens(hub)
      const cookie = cookieFrom(await devSignIn(hub))

      for (const headers of [bearer(runnerToken), { cookie, origin: webOrigin }]) {
        const response = await fetch(`${hub.url}${path}`, {
          method,
          headers: { ...headers, "content-type": "application/json" },
          ...(method === "POST" ? { body: JSON.stringify(modHello("s-a")) } : {}),
        })
        expect(response.status).toBe(401)
      }
    },
  )

  describe("POST /mod/hello", () => {
    test("welcomes the mod of the Session its token is for", async () => {
      const hub = await startHub()
      const { modToken } = await issueTokens(hub)
      const response = await sayHello(hub, modToken)

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        _tag: "ModWelcome",
        protocolVersion: ProtocolVersion,
      })
    })

    test("refuses a hello for another Session with 403", async () => {
      const hub = await startHub()
      const { modToken } = await issueTokens(hub)
      const response = await sayHello(hub, modToken, modHello("s-b"))

      expect(response.status).toBe(403)
      expect((await postEvents(hub, modToken)).status).toBe(409)
    })

    test("rejects a hello from another protocol version", async () => {
      const hub = await startHub()
      const { modToken } = await issueTokens(hub)
      const response = await sayHello(hub, modToken, {
        ...modHello("s-a"),
        protocolVersion: ProtocolVersion + 1,
      })

      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        _tag: "HandshakeRejected",
        reason: "ProtocolVersionMismatch",
      })
    })

    test("rejects a malformed hello", async () => {
      const hub = await startHub()
      const { modToken } = await issueTokens(hub)
      const response = await sayHello(hub, modToken, { ...modHello("s-a"), model: "" })

      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        _tag: "HandshakeRejected",
        reason: "MalformedHandshake",
      })
    })
  })

  describe("POST /mod/events", () => {
    test("answers 409 until the mod says hello, then takes a batch", async () => {
      const hub = await startHub()
      const { modToken } = await issueTokens(hub)

      expect((await postEvents(hub, modToken, [turnStarted])).status).toBe(409)
      await sayHello(hub, modToken)
      expect((await postEvents(hub, modToken, [turnStarted])).status).toBe(204)
    })

    test("needs this Session's hello, not another's", async () => {
      const hub = await startHub()
      const { modToken, otherModToken } = await issueTokens(hub)
      await sayHello(hub, modToken)

      expect((await postEvents(hub, otherModToken)).status).toBe(409)
    })

    test("rejects a batch that isn't Turn events and failed deliveries", async () => {
      const hub = await startHub()
      const { modToken } = await issueTokens(hub)
      await sayHello(hub, modToken)

      expect((await postEvents(hub, modToken, [modHello("s-a")])).status).toBe(400)
      expect((await postEvents(hub, modToken, [{ ...turnStarted, text: 7 }])).status).toBe(400)
    })
  })

  describe("GET /mod/commands", () => {
    test("answers 409 until the mod says hello", async () => {
      const hub = await startHub()
      const { modToken } = await issueTokens(hub)

      expect((await pollCommands(hub, modToken)).status).toBe(409)
    })

    test("answers as soon as a command is queued", async () => {
      const hub = await startHub()
      const { modToken } = await issueTokens(hub)
      await sayHello(hub, modToken)
      const started = performance.now()
      const poll = pollCommands(hub, modToken, "?after=0&waitMs=10000")
      await Bun.sleep(100)
      await enqueueStop(hub, "s-a")
      const response = await poll

      expect(performance.now() - started).toBeLessThan(5000)
      expect(await response.json()).toEqual({
        messages: [{ seq: 1, message: { _tag: "StopTurn", sessionId: "s-a" } }],
      })
    })

    test("answers with no commands once waitMs has passed", async () => {
      const hub = await startHub()
      const { modToken } = await issueTokens(hub)
      await sayHello(hub, modToken)
      const started = performance.now()
      const response = await pollCommands(hub, modToken, "?waitMs=300")

      expect(performance.now() - started).toBeGreaterThanOrEqual(250)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ messages: [] })
    })

    test("answers only with commands after the one the mod last handled", async () => {
      const hub = await startHub()
      const { modToken } = await issueTokens(hub)
      await sayHello(hub, modToken)
      await enqueueStop(hub, "s-a")
      await enqueueStop(hub, "s-a")
      await enqueueStop(hub, "s-a")

      expect(await polledSeqs(await pollCommands(hub, modToken, "?after=0"))).toEqual([1, 2, 3])
      expect(await polledSeqs(await pollCommands(hub, modToken, "?after=1"))).toEqual([2, 3])
      // A poll whose answer was lost asks again from the same place, and gets the same commands.
      expect(await polledSeqs(await pollCommands(hub, modToken, "?after=1"))).toEqual([2, 3])
      expect(await polledSeqs(await pollCommands(hub, modToken, "?after=3&waitMs=50"))).toEqual([])
      await enqueueStop(hub, "s-a")
      expect(await polledSeqs(await pollCommands(hub, modToken, "?after=3"))).toEqual([4])
    })

    test("only reads the commands of its own Session", async () => {
      const hub = await startHub()
      const { modToken, otherModToken } = await issueTokens(hub)
      await sayHello(hub, modToken)
      await sayHello(hub, otherModToken, modHello("s-b"))
      await enqueueStop(hub, "s-a")

      expect(await polledSeqs(await pollCommands(hub, otherModToken, "?waitMs=50"))).toEqual([])
      expect(await polledSeqs(await pollCommands(hub, modToken))).toEqual([1])
    })

    test("rejects a query that isn't whole numbers", async () => {
      const hub = await startHub()
      const { modToken } = await issueTokens(hub)
      await sayHello(hub, modToken)

      expect((await pollCommands(hub, modToken, "?after=-1")).status).toBe(400)
      expect((await pollCommands(hub, modToken, "?waitMs=soon")).status).toBe(400)
    })
  })
})

describe("web channel", () => {
  test("welcomes the signed-in person from the web UI's origin, then lists Runners and Sessions", async () => {
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
      { _tag: "RunnerList", runners: [] },
      { _tag: "SessionList", sessions: [] },
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

/** Whether cookies get Secure, and the warning the Hub logs at startup, for this config. */
const cookiesFor = (publicUrl: string, insecureCookies = false) =>
  Effect.runPromise(
    HubConfig.make({ ...baseConfig, publicUrl: new URL(publicUrl), insecureCookies }).pipe(
      Effect.map((config) => ({
        secure: config.secureCookies,
        warning: Option.getOrUndefined(config.cookieWarning),
      })),
    ),
  )

describe("cookies", () => {
  test("are Secure over HTTPS, with nothing to warn about", async () => {
    expect(await cookiesFor("https://hub.example.com")).toEqual({
      secure: true,
      warning: undefined,
    })
  })

  test("are not Secure on loopback over HTTP, with nothing to warn about", async () => {
    for (const url of ["http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173"]) {
      expect(await cookiesFor(url)).toEqual({ secure: false, warning: undefined })
    }
  })

  test("stay Secure over HTTP on a LAN address, with a warning that points to the ways out", async () => {
    const { secure, warning } = await cookiesFor("http://192.168.1.10:5173")

    expect(secure).toBe(true)
    expect(warning).toContain("http://192.168.1.10:5173")
    expect(warning).toContain("drop")
    expect(warning).toContain("HTTPS")
    expect(warning).toContain("SSH tunnel")
    expect(warning).toContain("Tailscale")
    expect(warning).toContain("HUB_INSECURE_COOKIES=1")
  })

  test("are not Secure over HTTP on a LAN address with HUB_INSECURE_COOKIES, with a loud warning", async () => {
    const { secure, warning } = await cookiesFor("http://192.168.1.10:5173", true)

    expect(secure).toBe(false)
    expect(warning).toContain("INSECURE COOKIES")
    expect(warning).toContain("cleartext")
  })

  test("stay Secure over HTTPS with HUB_INSECURE_COOKIES, with a warning that it does nothing", async () => {
    const { secure, warning } = await cookiesFor("https://hub.example.com", true)

    expect(secure).toBe(true)
    expect(warning).toContain("does nothing")
  })

  test("are set without Secure or a __Host-/__Secure- prefix when HUB_INSECURE_COOKIES is on", async () => {
    const hub = await startHub({
      github: GitHub.layerTest({
        code: "good-code",
        user: { id: 42, login: "octocat", name: null },
      }),
      config: { publicUrl: new URL("http://192.168.1.10:5173"), insecureCookies: true },
    })
    const start = await fetch(`${hub.url}/auth/github`, { redirect: "manual" })
    const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? ""
    const callback = await fetch(
      `${hub.url}/auth/github/callback?code=good-code&state=${encodeURIComponent(state)}`,
      { redirect: "manual", headers: { cookie: `claude_hub_oauth_state=${state}` } },
    )
    const setCookies = [...start.headers.getSetCookie(), ...callback.headers.getSetCookie()]

    expect(setCookies.some((cookie) => cookie.startsWith(`${signInCookie}=`))).toBe(true)
    for (const cookie of setCookies) {
      expect(cookie).not.toContain("Secure")
      expect(cookie).not.toMatch(/^__(?:Host|Secure)-/)
    }
  })
})

const githubWith = (avatar_url: string | undefined) =>
  GitHub.layerTest({
    code: "good-code",
    user: { id: 42, login: "octocat", name: "The Octocat", avatar_url },
  })

/** Signs in through the stand-in GitHub; returns what `/auth/me` then says. */
async function signInAndAskMe(hub: TestHub) {
  const start = await fetch(`${hub.url}/auth/github`, { redirect: "manual" })
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state") ?? ""
  const callback = await fetch(
    `${hub.url}/auth/github/callback?code=good-code&state=${encodeURIComponent(state)}`,
    { redirect: "manual", headers: { cookie: `claude_hub_oauth_state=${state}` } },
  )
  const me = await fetch(`${hub.url}/auth/me`, { headers: { cookie: cookieFrom(callback) } })
  return me.json()
}

describe("avatar from the sign-in", () => {
  const avatarUrl = "https://avatars.githubusercontent.com/u/583231?v=4"

  test("is stored at sign-in and answered by /auth/me", async () => {
    const hub = await startHub({ github: githubWith(avatarUrl) })

    expect(await signInAndAskMe(hub)).toEqual({
      id: "github:42",
      login: "octocat",
      name: "The Octocat",
      avatarUrl,
    })
  })

  test("is dropped unless it is on GitHub's avatar host over HTTPS", async () => {
    for (const url of [
      "https://evil.example/avatar.png",
      "http://avatars.githubusercontent.com/u/1",
      "https://avatars.githubusercontent.com.evil.example/u/1",
      "https://avatars.githubusercontent.com@evil.example/u/1",
      "https://avatars.githubusercontent.com\\@evil.example/u/1",
      "javascript:alert(1)",
      "",
    ]) {
      const hub = await startHub({ github: githubWith(url) })

      expect(await signInAndAskMe(hub), url).toEqual({
        id: "github:42",
        login: "octocat",
        name: "The Octocat",
      })
    }
  })

  test("is absent when GitHub sends none, and for dev login", async () => {
    const hub = await startHub({ github: githubWith(undefined), config: { devLogin: true } })

    expect(await signInAndAskMe(hub)).not.toHaveProperty("avatarUrl")
    expect(await (await devSignIn(hub)).json()).not.toHaveProperty("avatarUrl")
  })
})
