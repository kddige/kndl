// Each person's Claude credential (ADR 0015, ADR 0026, issue #150), end to end: a real Hub, web
// clients and fake Runners over WebSockets. ClaudeCheck.layerTest stands in for Anthropic, so
// every secret here is a fake.

import { afterEach, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { ParticipantId } from "@kndl/protocol"
import { Effect, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { ClaudeCredentials } from "./ClaudeCredentials.ts"
import { databaseAt } from "./Database.ts"
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
import { seedEnvironment, startHub, type TestHub, testDatabaseDir } from "./testSupport.ts"

afterEach(stopAll)

const repo = "kddige/kndl"
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

const save = (web: Connection<Web>, secret: string) =>
  request(web, { _tag: "SetClaudeCredential", secret })

/** A Hub with a Runner online, and alice on the web with no Claude credential yet. */
async function scene(options: { readonly config?: object; readonly hub?: TestHub } = {}) {
  const hub = options.hub ?? (await startHub({ config: options.config ?? withKey }))
  const issued = await issueRunnerToken(hub)
  const runner = await openRunner(hub, issued.token)
  const web = await openWeb(hub, "alice", undefined, { setupToken: false })
  await seedEnvironment(hub, repo, "dev:alice")
  return { hub, runner, web, runnerId: issued.runnerId }
}

/** A Session alice creates on the Runner, once it says it started. */
async function createSession(web: Connection<Web>, runner: Connection<ToRunner>) {
  const created = await request(web, {
    _tag: "CreateSession",
    repo,
    branch: { _tag: "Existing", name: "main", newWorkBranch: true },
  })
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
  test("a setup token is stored; only its kind, last 4 and date come back", async () => {
    const { hub, web } = await scene()
    expect(web.claudeCredential).toEqual({ _tag: "ClaudeCredentialState", credential: null })
    const elsewhere = await openWeb(hub, "alice", web.cookie)
    const bob = await openWeb(hub, "bob")

    const saved = await save(web, `  ${token}\n`)
    expect(saved).toEqual({
      _tag: "ClaudeCredentialState",
      requestId: expect.any(String),
      credential: { kind: "OAuthToken", last4: "9f3b", addedAt: expect.any(Number) },
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
    const later = await openWeb(hub, "alice", web.cookie)
    expect(later.claudeCredential.credential).toEqual({
      kind: "OAuthToken",
      last4: "9f3b",
      addedAt: expect.any(Number),
    })
  })

  test("refuses an API key, and what isn't a whole setup token", async () => {
    const { web } = await scene()
    const refusals = [
      [" ", "Paste the token `claude setup-token` printed."],
      [apiKey, "API keys aren't taken for now."],
      ["hunter2-not-a-token", "That isn't a Claude setup token: it starts with sk-ant-oat."],
      ["sk-ant-oat01-short", "That doesn't look like a whole token."],
    ] as const
    for (const [secret, message] of refusals) {
      expect(await save(web, secret)).toMatchObject({
        _tag: "CommandFailed",
        command: "SetClaudeCredential",
        message: expect.stringContaining(message),
      })
    }
    expect(await web.untaken("ClaudeCredentialState")).toEqual([])
  })

  test("refuses one Anthropic rejects, keeping the one before", async () => {
    const { hub, web } = await scene()
    await save(web, token)
    expect(await save(web, "sk-ant-oat01-REJECTED_FAKE_TOKEN_0000")).toMatchObject({
      _tag: "CommandFailed",
      message: "Anthropic rejected this token: it is invalid.",
    })
    const again = await openWeb(hub, "alice", web.cookie)
    expect(again.claudeCredential.credential).toMatchObject({ last4: "9f3b" })
  })

  test("stores one Anthropic can't be asked about, with a warning", async () => {
    const { web } = await scene()
    expect(await save(web, "sk-ant-oat01-UNREACHABLE_FAKE_TOKEN_0000")).toMatchObject({
      _tag: "ClaudeCredentialState",
      credential: { kind: "OAuthToken", last4: "0000" },
      warning: "Saved without checking it: Anthropic couldn't be reached.",
    })
  })

  test("is refused, saying why, on a Hub without HUB_SECRETS_KEY", async () => {
    const { web } = await scene({ config: { devLogin: true, secretsKey: Option.none() } })
    expect(await save(web, token)).toMatchObject({
      _tag: "CommandFailed",
      message: expect.stringContaining("needs HUB_SECRETS_KEY"),
    })
  })

  test("is removed on request", async () => {
    const { hub, web } = await scene()
    await save(web, token)
    expect(await request(web, { _tag: "RemoveClaudeCredential" })).toEqual({
      _tag: "ClaudeCredentialState",
      requestId: expect.any(String),
      credential: null,
    })
    expect(await storedText(hub)).toBe("[]")
  })

  test("API keys stored from before are deleted as the Hub starts, and a row that isn't a token is none", async () => {
    const dir = testDatabaseDir("kndl-")
    try {
      const database = databaseAt(join(dir, "hub.db"))
      const first = await startHub({ config: withKey, database })
      const { web } = await scene({ hub: first })
      const bob = await openWeb(first, "bob", undefined, { setupToken: false })
      await save(web, token)
      // As a Hub from before stored them: bob's an API key, and carol's a token that is a key.
      await openWeb(first, "carol", undefined, { setupToken: false })
      await first.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const secrets = yield* Secrets
          const sealed = (id: string) =>
            Effect.orDie(secrets.encrypt(Redacted.make(apiKey), `claude-credential:${id}`))
          yield* sql`INSERT INTO claude_credentials (participant_id, kind, ciphertext, last4, added_at)
            VALUES ('dev:bob', 'ApiKey', ${yield* sealed("dev:bob")}, '77d1', 1),
              ('dev:carol', 'OAuthToken', ${yield* sealed("dev:carol")}, '77d1', 1)`
        }),
      )
      await bob.close()
      await stopAll()

      const second = await startHub({ config: withKey, database })
      const kept = await second.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const credentials = yield* ClaudeCredentials
          return {
            rows: yield* sql<{ readonly participantId: string }>`
              SELECT participant_id AS participantId FROM claude_credentials ORDER BY 1`,
            carol: credentials.credentialOf(ParticipantId.make("dev:carol")),
          }
        }),
      )
      expect(kept.rows).toEqual([{ participantId: "dev:alice" }, { participantId: "dev:carol" }])
      expect(kept.carol).toBeUndefined()
      expect(
        (await openWeb(second, "alice", web.cookie)).claudeCredential.credential,
      ).toMatchObject({ last4: "9f3b" })
      expect(
        (await openWeb(second, "carol", undefined, { setupToken: false })).claudeCredential,
      ).toMatchObject({ credential: null })
    } finally {
      await stopAll()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("a Session's Claude credential", () => {
  test("its Runner is sent its Creator's setup token, and refused once they have none", async () => {
    const { web, runner } = await scene()
    await save(web, token)
    const session = await createSession(web, runner)
    expect(await fetchCredential(runner, session.id)).toEqual({
      _tag: "ClaudeCredentialFetched",
      requestId: expect.any(String),
      credential: { _tag: "OAuthToken", token },
    })

    // Once removed, there is no other: the Runner is refused (ADR 0026).
    await request(web, { _tag: "RemoveClaudeCredential" })
    expect(await fetchCredential(runner, session.id)).toEqual({
      _tag: "ClaudeCredentialRefused",
      requestId: expect.any(String),
      message: "alice, who started this Session, has no Claude credential.",
    })
  })

  test("is refused to a Runner the Session doesn't run on", async () => {
    const { hub, web, runner } = await scene()
    await save(web, token)
    const session = await createSession(web, runner)
    const other = await issueRunnerToken(hub, "linux")
    const intruder = await openRunner(hub, other.token)
    expect(await fetchCredential(intruder, session.id)).toEqual({
      _tag: "ClaudeCredentialRefused",
      requestId: expect.any(String),
      message: "Not a Session this Runner runs.",
    })
    expect(intruder.texts.join("\n")).not.toContain(token)
  })

  test("is refused once its Creator isn't a Member", async () => {
    const { hub, web, runner } = await scene()
    await save(web, token)
    const session = await createSession(web, runner)
    await hub.run(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`UPDATE participants SET admitted_at = NULL WHERE id = 'dev:alice'`,
      ),
    )
    expect(await fetchCredential(runner, session.id)).toEqual({
      _tag: "ClaudeCredentialRefused",
      requestId: expect.any(String),
      message: "alice, who started this Session, isn't a Member of this Hub any more.",
    })
    expect(runner.texts.join("\n")).not.toContain(token)
  })

  test("a Session whose Creator has none doesn't start: there is no other to run on", async () => {
    const { web, runner } = await scene()
    expect(
      await request(web, {
        _tag: "CreateSession",
        repo,
        branch: { _tag: "Existing", name: "main", newWorkBranch: true },
      }),
    ).toMatchObject({
      _tag: "CommandFailed",
      message: "You have no Claude credential: add your setup token on the Account page.",
    })
    expect(await runner.untaken("StartSession")).toEqual([])

    await save(web, token)
    expect((await createSession(web, runner)).creator.id).toBe("dev:alice")
  })

  test("the web is told nothing of a Runner's own credential, which there is none of", async () => {
    const { web } = await scene()
    const [runner] = web.runners.runners
    expect(runner?.isOnline).toBe(true)
    expect(runner).not.toHaveProperty("ownClaudeCredential")
    expect(runner).not.toHaveProperty("login")
  })
})
