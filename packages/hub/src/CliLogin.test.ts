// Signing the CLI in, end to end (issue #179): a real Hub, the `/cli-login` page's approval with
// the sign-in cookie, the CLI's trade of the code over plain HTTP, and the Account page's list of
// CLI tokens over the web channel.

import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { pkceChallenge } from "./CliTokens.ts"
import { issueRunnerToken, openWeb, stopAll } from "./testChannels.ts"
import {
  bearer,
  cookieFrom,
  devSignIn,
  startHub,
  stopHubs,
  type TestHub,
  webOrigin,
} from "./testSupport.ts"

afterEach(async () => {
  await stopAll()
  await stopHubs()
})

const verifier = "a-verifier-only-the-cli-knows-0123456789-abcdef"
const challenge = pkceChallenge(verifier)

const loginHub = () => startHub({ config: { devLogin: true } })

/** The `/cli-login` page approving `machine`, with the sign-in cookie. */
const approve = (
  hub: TestHub,
  cookie: string | undefined,
  body: unknown = { machine: "laptop", challenge },
  origin = webOrigin,
) =>
  fetch(`${hub.url}/auth/cli/approve`, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      ...(cookie !== undefined && { cookie }),
    },
    body: JSON.stringify(body),
  })

/** The CLI trading a code. */
const trade = (hub: TestHub, code: string, withVerifier = verifier) =>
  fetch(`${hub.url}/auth/cli/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, verifier: withVerifier }),
  })

const whoami = (hub: TestHub, token: string) =>
  fetch(`${hub.url}/auth/cli/me`, { headers: bearer(token) })

/** alice approves "laptop" on the page and the CLI trades the code: its token, and whose. */
async function signInCli(hub: TestHub, cookie: string, machine = "laptop") {
  const approved = await approve(hub, cookie, { machine, challenge })
  expect(approved.status).toBe(200)
  const { code } = (await approved.json()) as { code: string }
  const traded = await trade(hub, code)
  expect(traded.status).toBe(200)
  return (await traded.json()) as {
    token: string
    id: string
    machine: string
    you: { login: string }
  }
}

describe("claude-hub login", () => {
  test("signs the CLI in for whoever approves it, and lists the token on their Account page alone", async () => {
    const hub = await loginHub()
    const alice = await openWeb(hub, "alice")
    const bob = await openWeb(hub, "bob")
    expect(alice.cliTokens.tokens).toEqual([])

    const signedIn = await signInCli(hub, alice.cookie)
    expect(signedIn).toMatchObject({ machine: "laptop", you: { login: "alice" } })
    expect(signedIn.token.startsWith("chc_")).toBe(true)

    const listed = await alice.take("CliTokenList", (m) => m.tokens.length === 1)
    expect(listed.tokens[0]).toMatchObject({ id: signedIn.id, machine: "laptop" })
    expect(JSON.stringify(listed)).not.toContain(signedIn.token)
    expect(await bob.untaken("CliTokenList")).toEqual([])

    const me = await whoami(hub, signedIn.token)
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({
      you: { login: "alice" },
      id: signedIn.id,
      machine: "laptop",
    })
  })

  test("approves only with the sign-in cookie, from the web UI's own origin", async () => {
    const hub = await loginHub()
    const cookie = cookieFrom(await devSignIn(hub, "alice"))
    expect((await approve(hub, undefined)).status).toBe(401)
    expect((await approve(hub, cookie, undefined, "https://evil.example")).status).toBe(403)
    expect((await approve(hub, cookie, { machine: "", challenge })).status).toBe(400)
    expect((await approve(hub, cookie, { machine: "laptop", challenge: "short" })).status).toBe(400)
  })

  test("refuses a code with the wrong verifier, a used one, and a made-up one alike", async () => {
    const hub = await loginHub()
    const cookie = cookieFrom(await devSignIn(hub, "alice"))
    const { code } = (await (await approve(hub, cookie)).json()) as { code: string }

    const wrong = await trade(hub, code, `${verifier}x`)
    expect(wrong.status).toBe(400)
    const used = await trade(hub, code)
    expect(used.status).toBe(400)
    const madeUp = await trade(hub, "ABCD-EFGH-JKMN-PQRS")
    expect(await madeUp.json()).toEqual(await used.json())
    expect((await trade(hub, "not json at all" as string)).status).toBe(400)
  })

  test("never writes a token or a code to the Hub's log", async () => {
    const logged: Array<string> = []
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      spyOn(console, level).mockImplementation((...args: Array<unknown>) => {
        logged.push(
          args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
        )
      }),
    )
    try {
      const hub = await loginHub()
      const cookie = cookieFrom(await devSignIn(hub, "alice"))
      const approved = (await (await approve(hub, cookie)).json()) as { code: string }
      const traded = (await (await trade(hub, approved.code)).json()) as { token: string }
      await whoami(hub, traded.token)
      await fetch(`${hub.url}/auth/cli/sign-out`, { method: "POST", headers: bearer(traded.token) })
      expect(logged.join("\n")).toContain("signed in the CLI on laptop")
      expect(logged.join("\n")).not.toContain(traded.token.split(".")[1])
      expect(logged.join("\n")).not.toContain(approved.code)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })
})

describe("a CLI token", () => {
  test("is accepted as a bearer, and nothing else is in its place", async () => {
    const hub = await loginHub()
    const alice = await openWeb(hub, "alice")
    const runner = await issueRunnerToken(hub)
    expect((await whoami(hub, runner.token)).status).toBe(401)
    const withCookie = await fetch(`${hub.url}/auth/cli/me`, { headers: { cookie: alice.cookie } })
    expect(withCookie.status).toBe(401)
    expect(await withCookie.json()).toEqual({
      error: "Expected a CLI token: run claude-hub login",
    })
  })

  test("revoked on the Account page is refused from the next request on", async () => {
    const hub = await loginHub()
    const alice = await openWeb(hub, "alice")
    const other = await openWeb(hub, "alice", alice.cookie)
    const bob = await openWeb(hub, "bob")
    const signedIn = await signInCli(hub, alice.cookie)
    await alice.take("CliTokenList", (m) => m.tokens.length === 1)
    await other.take("CliTokenList", (m) => m.tokens.length === 1)
    expect((await whoami(hub, signedIn.token)).status).toBe(200)

    // bob can't revoke alice's.
    bob.send({ _tag: "RevokeCliToken", requestId: "r-0", cliTokenId: signedIn.id })
    expect(await bob.take("CommandFailed")).toMatchObject({
      command: "RevokeCliToken",
      requestId: "r-0",
    })
    expect((await whoami(hub, signedIn.token)).status).toBe(200)

    alice.send({ _tag: "RevokeCliToken", requestId: "r-1", cliTokenId: signedIn.id })
    expect(await alice.take("CliTokenList", (m) => m.requestId === "r-1")).toEqual({
      _tag: "CliTokenList",
      requestId: "r-1",
      tokens: [],
    })
    await other.take("CliTokenList", (m) => m.tokens.length === 0)
    expect((await whoami(hub, signedIn.token)).status).toBe(401)
  })

  test("signs itself out with claude-hub logout", async () => {
    const hub = await loginHub()
    const alice = await openWeb(hub, "alice")
    const signedIn = await signInCli(hub, alice.cookie)
    await alice.take("CliTokenList", (m) => m.tokens.length === 1)
    const signOut = () =>
      fetch(`${hub.url}/auth/cli/sign-out`, { method: "POST", headers: bearer(signedIn.token) })
    expect((await signOut()).status).toBe(204)
    await alice.take("CliTokenList", (m) => m.tokens.length === 0)
    expect((await whoami(hub, signedIn.token)).status).toBe(401)
    expect((await signOut()).status).toBe(401)
  })

  test("comes with the welcome, to its owner's new web clients", async () => {
    const hub = await loginHub()
    const cookie = cookieFrom(await devSignIn(hub, "alice"))
    const signedIn = await signInCli(hub, cookie)
    const alice = await openWeb(hub, "alice", cookie)
    expect(alice.cliTokens.tokens).toMatchObject([{ id: signedIn.id, machine: "laptop" }])
    const bob = await openWeb(hub, "bob")
    expect(bob.cliTokens.tokens).toEqual([])
  })
})
