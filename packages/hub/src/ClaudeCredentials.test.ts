// Each person's Claude credential (ADR 0015, issue #150), end to end: a real Hub, web clients and
// fake Runners over WebSockets. ClaudeCheck.layerTest stands in for Anthropic, so every secret
// here is a fake.

import { afterEach, describe, expect, test } from "bun:test"
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
import { seedEnvironment, startHub, type TestHub } from "./testSupport.ts"

afterEach(stopAll)

const repo = "kddige/claude-hub"
const token = "sk-ant-oat01-FAKE_TOKEN_FOR_TESTS_ONLY_9f3b"
const apiKey = "sk-ant-api03-FAKE_KEY_FOR_TESTS_ONLY_77d1"

const withKey = { devLogin: true, secretsKey: Option.some(Redacted.make(generateSecretsKey())) }

let requests = 0

/** Sends `message` with a fresh requestId, and the answer to it. */
async function request(
  web: Connection<Web>,
  message: { readonly _tag: string } & Record<string, unknown>,
) {
  const requestId = `c-${++requests}`
  web.send({ ...message, requestId })
  return web.takeWhere(
    (each): each is Web => "requestId" in each && each.requestId === requestId,
    `answer to ${requestId}`,
  )
}

const save = (web: Connection<Web>, secret: string, plan?: string) =>
  request(web, {
    _tag: "SetClaudeCredential",
    secret,
    ...(plan !== undefined && { plan }),
  })

/** A Hub with a Runner online, and alice on the web. */
async function scene(
  options: { readonly ownClaudeCredential?: boolean; readonly config?: object } = {},
) {
  const hub = await startHub({ config: options.config ?? withKey })
  const issued = await issueRunnerToken(hub)
  const runner = await openRunner(
    hub,
    issued.token,
    [],
    undefined,
    true,
    options.ownClaudeCredential === undefined
      ? {}
      : { ownClaudeCredential: options.ownClaudeCredential },
  )
  const web = await openWeb(hub, "alice")
  await seedEnvironment(hub, repo, "dev:alice")
  return { hub, runner, web, runnerId: issued.runnerId }
}

/** A Session alice creates on the Runner, once it says it started. */
async function createSession(web: Connection<Web>, runner: Connection<ToRunner>) {
  const created = await request(web, { _tag: "CreateSession", repo, baseBranch: "main" })
  if (created._tag !== "SessionCreated") throw new Error(JSON.stringify(created))
  const start = await runner.take("StartSession")
  runner.send({ _tag: "SessionStarted", sessionId: start.sessionId })
  return created.session
}

/** What the Runner is answered when it asks for the Session's credential. */
async function fetchCredential(runner: Connection<ToRunner>, sessionId: string) {
  const requestId = `f-${++requests}`
  runner.send({ _tag: "FetchClaudeCredential", requestId, sessionId })
  return runner.takeWhere(
    (each): each is ToRunner => "requestId" in each && each.requestId === requestId,
    `answer to ${requestId}`,
  )
}

const storedText = (hub: TestHub) =>
  hub.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      return JSON.stringify(yield* sql`SELECT * FROM claude_credentials`)
    }),
  )

describe("saving a Claude credential", () => {
  test("a token is stored with its plan; only its kind, last 4, plan and date come back", async () => {
    const { hub, web } = await scene()
    expect(web.claudeCredential).toEqual({ _tag: "ClaudeCredentialState", credential: null })
    const elsewhere = await openWeb(hub, "alice")
    const bob = await openWeb(hub, "bob")

    const saved = await save(web, `  ${token}\n`, "max5x")
    expect(saved).toEqual({
      _tag: "ClaudeCredentialState",
      requestId: expect.any(String),
      credential: { kind: "OAuthToken", last4: "9f3b", plan: "max5x", addedAt: expect.any(Number) },
    })
    // alice's other tab hears of it; bob doesn't.
    expect(
      (await elsewhere.take("ClaudeCredentialState", (m) => m.credential !== null)).credential,
    ).toMatchObject({ last4: "9f3b" })
    expect(await bob.untaken("ClaudeCredentialState")).toEqual([])

    // Write-only: never sent back, nor stored in the clear.
    for (const connection of [web, elsewhere, bob]) {
      expect(connection.texts.join("\n")).not.toContain(token)
    }
    expect(await storedText(hub)).not.toContain(token)

    // A new connection is told what it has.
    const later = await openWeb(hub, "alice")
    expect(later.claudeCredential.credential).toMatchObject({ kind: "OAuthToken", plan: "max5x" })
  })

  test("an API key needs no plan, and replaces the token before it", async () => {
    const { web } = await scene()
    await save(web, token, "pro")
    expect(await save(web, apiKey, "pro")).toMatchObject({
      credential: { kind: "ApiKey", last4: "77d1" },
    })
    const state = await save(web, apiKey)
    expect(state).toMatchObject({ credential: { kind: "ApiKey" } })
    expect(state._tag === "ClaudeCredentialState" && state.credential?.plan).toBeFalsy()
  })

  test("refuses what isn't a whole token or key, and a token without a plan", async () => {
    const { web } = await scene()
    const refusals = [
      [" ", undefined, "Paste a token or an API key."],
      [
        "hunter2-not-a-token",
        undefined,
        "That isn't a Claude token or API key: a token starts with sk-ant-oat, a key with sk-ant-api.",
      ],
      ["sk-ant-oat01-short", "pro", "That doesn't look like a whole token or key."],
      [token, undefined, "Pick the plan your Claude account is on."],
    ] as const
    for (const [secret, plan, message] of refusals) {
      expect(await save(web, secret, plan)).toMatchObject({
        _tag: "CommandFailed",
        command: "SetClaudeCredential",
        message: expect.stringContaining(message),
      })
    }
    expect(await web.untaken("ClaudeCredentialState")).toEqual([])
  })

  test("refuses one Anthropic rejects, keeping the one before", async () => {
    const { hub, web } = await scene()
    await save(web, token, "max20x")
    expect(await save(web, "sk-ant-oat01-REJECTED_FAKE_TOKEN_0000", "pro")).toMatchObject({
      _tag: "CommandFailed",
      message: "Anthropic rejected this token: it is invalid.",
    })
    const again = await openWeb(hub, "alice")
    expect(again.claudeCredential.credential).toMatchObject({ last4: "9f3b", plan: "max20x" })
  })

  test("stores one Anthropic can't be asked about, with a warning", async () => {
    const { web } = await scene()
    expect(await save(web, "sk-ant-api03-UNREACHABLE_FAKE_KEY_0000")).toMatchObject({
      _tag: "ClaudeCredentialState",
      credential: { kind: "ApiKey", last4: "0000" },
      warning: "Saved without checking it: Anthropic couldn't be reached.",
    })
  })

  test("is refused, saying why, on a Hub without HUB_SECRETS_KEY", async () => {
    const { web } = await scene({ config: { devLogin: true } })
    expect(await save(web, token, "pro")).toMatchObject({
      _tag: "CommandFailed",
      message: expect.stringContaining("needs HUB_SECRETS_KEY"),
    })
  })

  test("is removed on request", async () => {
    const { hub, web } = await scene()
    await save(web, token, "team")
    expect(await request(web, { _tag: "RemoveClaudeCredential" })).toEqual({
      _tag: "ClaudeCredentialState",
      requestId: expect.any(String),
      credential: null,
    })
    expect(await storedText(hub)).toBe("[]")
  })
})

describe("a Session's Claude credential", () => {
  test("its Runner is sent its Creator's, with the plan Claude Code is told", async () => {
    const { web, runner } = await scene()
    await save(web, token, "max20x")
    const session = await createSession(web, runner)
    expect(session.claudeAccount).toBe("Creator")
    expect(await fetchCredential(runner, session.id)).toEqual({
      _tag: "ClaudeCredentialFetched",
      requestId: expect.any(String),
      credential: {
        _tag: "OAuthToken",
        token,
        plan: { subscriptionType: "max", rateLimitTier: "default_claude_max_20x" },
      },
    })

    // Once removed, the Runner is told to use its own, and the Session says so.
    await request(web, { _tag: "RemoveClaudeCredential" })
    expect(
      (await web.take("SessionUpdated", (m) => m.session.claudeAccount === "Runner")).session.id,
    ).toBe(session.id)
    expect(await fetchCredential(runner, session.id)).toEqual({
      _tag: "ClaudeCredentialFetched",
      requestId: expect.any(String),
    })
  })

  test("is refused to a Runner the Session doesn't run on", async () => {
    const { hub, web, runner } = await scene()
    await save(web, apiKey)
    const session = await createSession(web, runner)
    const other = await issueRunnerToken(hub, "linux")
    const intruder = await openRunner(hub, other.token)
    expect(await fetchCredential(intruder, session.id)).toEqual({
      _tag: "ClaudeCredentialRefused",
      requestId: expect.any(String),
      message: "Not a Session this Runner runs.",
    })
    expect(intruder.texts.join("\n")).not.toContain(apiKey)
  })

  test("a Session neither its Creator nor its Runner has one for doesn't start", async () => {
    const { web, runner } = await scene({ ownClaudeCredential: false })
    expect(await request(web, { _tag: "CreateSession", repo, baseBranch: "main" })).toMatchObject({
      _tag: "CommandFailed",
      message: "Neither you nor mac has a Claude credential: add yours on the Account page.",
    })
    expect(await runner.untaken("StartSession")).toEqual([])

    await save(web, token, "pro")
    const session = await createSession(web, runner)
    expect(session.claudeAccount).toBe("Creator")
  })

  test("a Session on a Runner with its own runs on the Runner's when its Creator has none", async () => {
    const { web, runner } = await scene()
    const session = await createSession(web, runner)
    expect(session.claudeAccount).toBe("Runner")
  })

  test("is redacted from what its Sessions print", async () => {
    const { web, runner } = await scene()
    await save(web, token, "pro")
    const session = await createSession(web, runner)
    web.send({ _tag: "JoinSession", sessionId: session.id })
    await web.take("SessionHistory")
    runner.send({ _tag: "WipPushFailed", sessionId: session.id, message: `leaked ${token}` })
    const logged = await web.take(
      "SessionEventLogged",
      (m) => m.entry.event._tag === "WipNotPushed",
    )
    expect(logged.entry.event).toMatchObject({ message: `leaked ${"*".repeat(token.length)}` })
    expect(web.texts.join("\n")).not.toContain(token)
  })
})
