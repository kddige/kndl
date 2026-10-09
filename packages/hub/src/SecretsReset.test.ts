// Starting over when HUB_SECRETS_KEY is lost (#57): `secrets-reset` on a database whose key is
// gone, then a Hub with a new key, real web clients and a fake Runner over WebSockets.

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { ConfigProvider, Effect, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { databaseAt } from "./Database.ts"
import { generateSecretsKey, Secrets } from "./Secrets.ts"
import {
  resetSecrets,
  type SecretsResetPlan,
  secretsResetDoneText,
  secretsResetPlanText,
} from "./SecretsReset.ts"
import {
  type Connection,
  issueRunnerToken,
  openRunner,
  openWeb,
  stopAll,
  type Web,
} from "./testChannels.ts"
import { startHub, startHubProcess, type TestHub, testDatabaseDir } from "./testSupport.ts"

const dirs: Array<string> = []
const children: Array<Bun.Subprocess> = []

afterEach(async () => {
  await stopAll()
  for (const child of children.splice(0)) child.kill("SIGKILL")
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const repo = "kddige/kndl"
const buildSecret = "npm_BUILD_SECRET_4f1c"
const runtimeSecret = "sk_RUNTIME_SECRET_9a2e"
const sharedSecret = "ghp_SHARED_SECRET_77b0"
const signingSecret = "sig_SIGNING_SECRET_31d8"
// A fake: ClaudeCheck.layerTest takes it without asking Anthropic.
const claudeSecret = "sk-ant-oat01-FAKE_CLAUDE_TOKEN_0000c1a7"
const mcpServerSecret = "lin_MCP_SERVER_SECRET_2c9d"
const oauthSecret = "oat_OAUTH_TOKEN_SECRET_8e3a"
const secrets = [
  oauthSecret,
  buildSecret,
  runtimeSecret,
  sharedSecret,
  signingSecret,
  "ghp_rotated_5e6f",
  claudeSecret,
  mcpServerSecret,
]
const lostKey = generateSecretsKey()
const newKey = generateSecretsKey()

const withKey = (key: string) => ({ devLogin: true, secretsKey: Option.some(Redacted.make(key)) })

let requests = 0
const nextRequest = () => `q-${++requests}`

const answer = (web: Connection<Web>, requestId: string) =>
  web.takeWhere(
    (message): message is Web => "requestId" in message && message.requestId === requestId,
    `answer to ${requestId}`,
  )

const recipe = {
  image: "debian:bookworm-slim",
  bootstrapScript: "apt-get install -y ripgrep",
  docker: false,
  dependencyFolders: [],
  resources: { cpus: 2, memoryMib: 4096 },
}

/** The Environment: Plain, Sensitive at build and not, and Links to Plain and Sensitive. */
const variables = (values: { readonly build?: string; readonly runtime?: string }) => [
  { _tag: "Plain", name: "NODE_ENV", value: "development" },
  { _tag: "Sensitive", name: "NPM_TOKEN", availableAtBuild: true, value: values.build },
  { _tag: "Sensitive", name: "API_KEY", availableAtBuild: false, value: values.runtime },
  { _tag: "Link", name: "GH_TOKEN", sharedVariable: "GITHUB_TOKEN", availableAtBuild: false },
  { _tag: "Link", name: "SIGNING_KEY", sharedVariable: "SIGNING_KEY", availableAtBuild: true },
  { _tag: "Link", name: "REGISTRY", sharedVariable: "REGISTRY", availableAtBuild: true },
]

/**
 * The scene on a Hub over `database`: a Runner relaying MCP servers online, and alice on the web.
 */
async function scene(hub: TestHub) {
  const issued = await issueRunnerToken(hub)
  const runner = await openRunner(hub, issued.token, [], undefined, true, {
    relaysMcpServers: true,
  })
  const web = await openWeb(hub, "alice")
  const request = async (message: { readonly _tag: string } & Record<string, unknown>) => {
    const requestId = nextRequest()
    web.send({ ...message, requestId })
    return answer(web, requestId)
  }
  const setShared = (variable: Record<string, unknown>) =>
    request({ _tag: "SetSharedVariable", variable })
  const testBuild = async (draft: Record<string, unknown>) => {
    const requestId = nextRequest()
    web.send({ _tag: "StartTestBuild", requestId, repo, runnerId: issued.runnerId, draft })
    const started = await answer(web, requestId)
    if (started._tag !== "TestBuildStarted") return started
    const run = await runner.take("RunTestBuild", (m) => m.testBuildId === started.testBuild.id)
    runner.send({ _tag: "TestBuildFinished", testBuildId: run.testBuildId, result: "Passed" })
    return web.take("TestBuildEnded", (message) => message.testBuildId === run.testBuildId)
  }
  const apply = (draft: Record<string, unknown>, baseVersion: number | null) =>
    request({ _tag: "ApplyEnvironment", repo, baseVersion, draft })
  return { hub, runner, web, request, setShared, testBuild, apply }
}

/** A database whose key is `lostKey`, holding every kind of variable, a Session and its log. */
async function seededDatabase() {
  const dir = testDatabaseDir("kndl-reset-")
  dirs.push(dir)
  const file = join(dir, "hub.db")
  const env = await scene(await startHub({ config: withKey(lostKey), database: databaseAt(file) }))
  await env.setShared({ _tag: "Plain", name: "REGISTRY", value: "ghcr.io" })
  await env.setShared({ _tag: "Sensitive", name: "GITHUB_TOKEN", value: sharedSecret })
  await env.setShared({ _tag: "Sensitive", name: "SIGNING_KEY", value: signingSecret })
  await env.setShared({ _tag: "Sensitive", name: "UNUSED_TOKEN", value: sharedSecret })
  expect(
    await env.request({ _tag: "SetClaudeCredential", secret: claudeSecret, plan: "max5x" }),
  ).toMatchObject({ _tag: "ClaudeCredentialState", credential: { kind: "OAuthToken" } })
  const draft = { ...recipe, variables: variables({ build: buildSecret, runtime: runtimeSecret }) }
  expect((await env.testBuild(draft))._tag).toBe("TestBuildEnded")
  expect((await env.apply(draft, null))._tag).toBe("EnvironmentState")
  // An Installation with a header secret value, which the Session starts with.
  const created = await env.request({
    _tag: "CreateMcpServer",
    name: "Linear",
    // Nothing listens there: a Session's start goes ahead past it at once (#216).
    url: "http://127.0.0.1:1/mcp",
    auth: {
      _tag: "Headers",
      headers: [
        { key: "token", title: "API key", header: "Authorization", template: "Bearer {value}" },
      ],
    },
  })
  if (created._tag !== "McpServersState") throw new Error(JSON.stringify(created))
  expect(
    await env.request({
      _tag: "CreateInstallation",
      mcpServerId: created.mcpServers[0]?.id,
      name: "Team Linear",
      repos: [repo],
      values: [{ key: "token", value: mcpServerSecret }],
    }),
  ).toMatchObject({ _tag: "McpServersState" })
  // A Session, and a value replaced while it runs: retired, kept to redact what it prints.
  const requestId = nextRequest()
  env.web.send({
    _tag: "CreateSession",
    requestId,
    repo,
    branch: { _tag: "Existing", name: "main", newWorkBranch: true },
  })
  await env.runner.take("StartSession")
  const session = (await env.web.take("SessionCreated", (m) => m.requestId === requestId)).session
  env.runner.send({ _tag: "SessionStarted", sessionId: session.id, environmentVersion: 1 })
  await env.web.take("SessionUpdated", (m) => m.session.environment?.version === 1)
  await env.setShared({ _tag: "Sensitive", name: "GITHUB_TOKEN", value: "ghp_rotated_5e6f" })
  // OAuth tokens kept for the Installation (#217), as a connection keeps them.
  await env.hub.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const sealer = yield* Secrets
      const [installation] = yield* sql<{ readonly id: string }>`SELECT id FROM installations`
      const id = installation?.id ?? ""
      const tokens = yield* sealer.encrypt(
        Redacted.make(JSON.stringify({ access: oauthSecret, resource: "http://127.0.0.1:1/mcp" })),
        `installation-oauth-tokens:${id}`,
      )
      yield* sql`
        INSERT INTO installation_oauth (installation_id, tokens, generation, connected_by, connected_at)
        VALUES (${id}, ${tokens}, 1, (SELECT id FROM participants WHERE login = 'alice'), 1)
      `
    }),
  )
  await stopAll()
  return { file, sessionId: session.id }
}

/** Runs the reset on `file`, as the configuration names it, answering `confirm`. */
const reset = (file: string, confirmed: boolean) => {
  const asked: Array<SecretsResetPlan> = []
  return Effect.runPromise(
    resetSecrets((plan) => Effect.sync(() => (asked.push(plan), confirmed))).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { HUB_DATABASE: file } }))),
    ),
  ).then((outcome) => ({ outcome, asked }))
}

const expectedPlan: SecretsResetPlan = {
  environments: [{ repo, names: ["NPM_TOKEN", "API_KEY"] }],
  sharedVariables: ["GITHUB_TOKEN", "SIGNING_KEY", "UNUSED_TOKEN"],
  retiredValues: 1,
  testBuilds: 1,
  claudeCredentials: ["alice"],
  installations: [{ name: "Team Linear", secrets: ["API key"] }],
  sessionValues: 1,
  connections: ["Team Linear"],
}

/** Every row of every table in the database, as text. */
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

describe("secrets-reset", () => {
  test("refuses while a Hub runs on the database, and works once it stopped", async () => {
    const { file } = await seededDatabase()
    const hub = await startHubProcess(file, { HUB_SECRETS_KEY: lostKey })
    children.push(hub.child)
    const refused = await reset(file, true).then(
      () => "reset",
      (cause: unknown) => String(cause),
    )
    expect(refused).toContain(
      `The Sensitive values can't be reset: a Hub is running on ${file}. Stop it first.`,
    )
    hub.child.kill("SIGTERM")
    await hub.child.exited
    expect((await reset(file, true)).outcome._tag).toBe("Reset")
  }, 20_000)

  test("refuses where there is no database, rather than make one", async () => {
    const dir = testDatabaseDir("kndl-reset-")
    dirs.push(dir)
    const file = join(dir, "hub.db")
    expect(await reset(file, true).catch((cause: unknown) => String(cause))).toContain(
      `There is no Hub database at ${file}.`,
    )
    expect(existsSync(file)).toBe(false)
  })

  test("clears nothing without confirmation", async () => {
    const { file } = await seededDatabase()
    const { outcome, asked } = await reset(file, false)
    expect(outcome._tag).toBe("Kept")
    expect(asked).toEqual([expectedPlan])
    // The lost key still opens everything: nothing was cleared.
    const hub = await startHub({ config: withKey(lostKey), database: databaseAt(file) })
    const env = await scene(hub)
    expect(await env.request({ _tag: "GetSharedVariables" })).toMatchObject({
      variables: expect.arrayContaining([
        expect.objectContaining({ name: "GITHUB_TOKEN", needsValue: false }),
      ]),
    })
  })

  test("says what it clears by name, never by value", async () => {
    const { file } = await seededDatabase()
    const { outcome } = await reset(file, true)
    if (outcome._tag !== "Reset") throw new Error(outcome._tag)
    const plan = secretsResetPlanText(outcome.plan)
    const done = secretsResetDoneText(outcome.plan, "`bun run secrets-key`")
    expect(plan).toContain("This clears 5 Sensitive values")
    expect(plan).toContain(`  - ${repo}: NPM_TOKEN, API_KEY`)
    expect(plan).toContain("  - shared variables: GITHUB_TOKEN, SIGNING_KEY, UNUSED_TOKEN")
    expect(plan).toContain("1 retired value")
    expect(plan).toContain("the record of 1 Test build")
    expect(plan).toContain("It removes the Claude credential of alice")
    expect(done).toContain("It removes the Claude credential of alice")
    expect(done).toContain("Cleared 5 Sensitive values")
    expect(done).toContain("`bun run secrets-key`")
    expect(plan).toContain(
      "It clears the header secret values of 1 Installation, keeping each Installation:\n  - Team Linear: API key",
    )
    expect(plan).toContain("It also drops 1 header secret value that Sessions started with.")
    expect(done).toContain("Cleared the header secret values of 1 Installation")
    expect(done).toContain("and each Installation's on the MCP page")
    expect(plan).toContain(
      "It disconnects 1 OAuth Installation, dropping its tokens and its client, the one the Hub registered or the one entered by hand: Team Linear.",
    )
    expect(done).toContain("Connect each OAuth Installation again on the MCP page;")
    for (const secret of secrets) expect(plan + done).not.toContain(secret)
    // Run again, there is nothing left to reset.
    expect((await reset(file, true)).outcome._tag).toBe("NothingToReset")
  })

  test("keeps Plain values and Links; a Hub with a new key starts and shows what needs a value", async () => {
    const { file } = await seededDatabase()
    expect(
      await startHub({ config: withKey(newKey), database: databaseAt(file) }).then(
        () => "started",
        (cause: unknown) => String(cause),
      ),
    ).toContain("secrets-reset")
    await stopAll()
    expect((await reset(file, true)).outcome._tag).toBe("Reset")

    const hub = await startHub({ config: withKey(newKey), database: databaseAt(file) })
    const env = await scene(hub)
    // alice's Claude credential is gone too: she adds it again.
    expect(env.web.claudeCredential.credential).toBeNull()
    const state = await env.request({ _tag: "GetEnvironment", repo })
    expect(state).toMatchObject({
      _tag: "EnvironmentState",
      environment: {
        version: 1,
        variables: [
          { _tag: "Plain", name: "NODE_ENV", value: "development" },
          { _tag: "Sensitive", name: "NPM_TOKEN", availableAtBuild: true, needsValue: true },
          { _tag: "Sensitive", name: "API_KEY", availableAtBuild: false, needsValue: true },
          { _tag: "Link", name: "GH_TOKEN", sharedVariable: "GITHUB_TOKEN" },
          { _tag: "Link", name: "SIGNING_KEY", sharedVariable: "SIGNING_KEY" },
          { _tag: "Link", name: "REGISTRY", sharedVariable: "REGISTRY" },
        ],
      },
    })
    expect(await env.request({ _tag: "GetSharedVariables" })).toMatchObject({
      variables: [
        {
          _tag: "Sensitive",
          name: "GITHUB_TOKEN",
          needsValue: true,
          linkedBy: [{ repo, name: "GH_TOKEN" }],
        },
        { _tag: "Plain", name: "REGISTRY", value: "ghcr.io", linkedBy: [{ repo }] },
        { _tag: "Sensitive", name: "SIGNING_KEY", needsValue: true, linkedBy: [{ repo }] },
        { _tag: "Sensitive", name: "UNUSED_TOKEN", needsValue: true, linkedBy: [] },
      ],
    })
    const stored = await databaseText(hub)
    for (const secret of secrets) expect(stored).not.toContain(secret)
    const left = await hub.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* sql<{ readonly builds: number; readonly retired: number }>`
          SELECT (SELECT COUNT(*) FROM test_builds) AS builds,
            (SELECT COUNT(*) FROM retired_values) AS retired
        `
      }),
    )
    expect(left).toEqual([{ builds: 0, retired: 0 }])
    // Each Installation stays, and needs a value again.
    const mcpServers = await env.request({ _tag: "GetMcpServers" })
    if (mcpServers._tag !== "McpServersState") throw new Error(mcpServers._tag)
    expect(mcpServers.installations).toMatchObject([{ name: "Team Linear", values: [] }])
  })

  test("Sessions don't start, nor Test builds, until every value is entered again", async () => {
    const { file, sessionId } = await seededDatabase()
    await reset(file, true)
    const env = await scene(await startHub({ config: withKey(newKey), database: databaseAt(file) }))
    const { web, runner } = env
    const cantStart = `${repo}'s Sessions can't start: NPM_TOKEN, API_KEY, GH_TOKEN (the shared variable GITHUB_TOKEN) and SIGNING_KEY (shared) need values. Enter them on the Repo's Environment screen and the Shared variables screen.`

    // A new Session is refused, naming the variables.
    expect(
      await env.request({
        _tag: "CreateSession",
        repo,
        branch: { _tag: "Existing", name: "main", newWorkBranch: true },
      }),
    ).toMatchObject({
      _tag: "CommandFailed",
      message: cantStart,
    })

    // The Session from before stays Asleep, its prompt queued, saying why.
    web.send({ _tag: "JoinSession", sessionId })
    await web.take("SessionHistory")
    web.send({ _tag: "SendPrompt", sessionId, text: "still there?" })
    const failed = await web.take(
      "SessionEventLogged",
      (m) => m.entry.event._tag === "SessionStateChanged" && m.entry.event.state === "Asleep",
    )
    expect(failed.entry.event).toMatchObject({
      state: "Asleep",
      message: `Claude Code could not start: ${cantStart}`,
      valuesNeeded: true,
    })
    expect(await runner.untaken("StartSession")).toEqual([])
    expect(
      (
        await web.take("PromptQueueChanged", (m) => m.sessionId === sessionId && m.queue.length > 0)
      ).queue.map((prompt) => prompt.text),
    ).toEqual(["still there?"])

    // A draft keeping a value that is gone can't be Test built or applied.
    const kept = { ...recipe, variables: variables({}) }
    expect(await env.testBuild(kept)).toMatchObject({
      _tag: "CommandFailed",
      message: "NPM_TOKEN needs a value: enter one.",
    })

    // A Link whose shared variable needs a value can't be applied: that value comes first.
    const entered = { ...recipe, variables: variables({ build: "npm_NEW", runtime: "sk_NEW_1" }) }
    expect(await env.apply(entered, 1)).toMatchObject({
      _tag: "CommandFailed",
      message:
        "GH_TOKEN (the shared variable GITHUB_TOKEN) needs a value: set it on the Shared variables screen.",
    })
    // Shared values are entered as any, even one linked at build.
    await env.setShared({ _tag: "Sensitive", name: "GITHUB_TOKEN", value: "ghp_NEW_000001" })
    expect(
      await env.setShared({ _tag: "Sensitive", name: "SIGNING_KEY", value: "sig_NEW_0001" }),
    ).toMatchObject({
      variables: expect.arrayContaining([
        expect.objectContaining({ name: "SIGNING_KEY", needsValue: false }),
      ]),
    })
    expect(
      await env.request({
        _tag: "CreateSession",
        repo,
        branch: { _tag: "Existing", name: "main", newWorkBranch: true },
      }),
    ).toMatchObject({
      message: `${repo}'s Sessions can't start: NPM_TOKEN and API_KEY need values. Enter them on the Repo's Environment screen.`,
    })
    // The Environment's own apply straight away, even at build: they restore values.
    expect(await env.apply(entered, 1)).toMatchObject({
      _tag: "EnvironmentState",
      environment: {
        version: 2,
        variables: expect.arrayContaining([
          expect.objectContaining({ name: "NPM_TOKEN", needsValue: false }),
          expect.objectContaining({ name: "API_KEY", needsValue: false }),
        ]),
      },
    })

    // The Installation's header secret value too (#216): without it the Session doesn't start.
    web.send({ _tag: "WakeSession", sessionId })
    const unplugged = await web.take(
      "SessionEventLogged",
      (m) =>
        m.entry.event._tag === "SessionStateChanged" &&
        m.entry.event.installationsFailed !== undefined,
    )
    expect(unplugged.entry.event).toMatchObject({
      state: "Asleep",
      installationsFailed: [{ installation: "Team Linear", reason: "ValueNeeded" }],
    })
    const mcpServers = await env.request({ _tag: "GetMcpServers" })
    if (mcpServers._tag !== "McpServersState") throw new Error(mcpServers._tag)
    expect(
      await env.request({
        _tag: "EditInstallation",
        installationId: mcpServers.installations[0]?.id,
        name: "Team Linear",
        repos: [repo],
        values: [{ key: "token", value: "lin_NEW_0001" }],
      }),
    ).toMatchObject({ _tag: "McpServersState" })

    // Every value is back: the Session wakes for its prompt, and new ones start.
    web.send({ _tag: "WakeSession", sessionId })
    expect((await runner.take("StartSession")).sessionId).toBe(sessionId)
    const requestId = nextRequest()
    web.send({
      _tag: "CreateSession",
      requestId,
      repo,
      branch: { _tag: "Existing", name: "main", newWorkBranch: true },
    })
    expect(await web.take("SessionCreated", (m) => m.requestId === requestId)).toBeDefined()
  })
})
