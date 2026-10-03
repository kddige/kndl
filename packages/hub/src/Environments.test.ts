// Environments on the Hub, end to end (issue #47): a real Hub, web clients and fake Runners over
// WebSockets. The real Runner side of Test builds and variable fetches is #49.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Option, Redacted } from "effect"
import { SqlClient } from "effect/sql"
import { databaseAt } from "./Database.ts"
import { refuseSessionsWithoutEnvironment } from "./EnvironmentRelay.ts"
import { HubConfig } from "./HubConfig.ts"
import { decryptValue, encryptValue, generateSecretsKey, Secrets } from "./Secrets.ts"
import {
  type Connection,
  issueRunnerToken,
  openRunner,
  openWeb,
  stopAll,
  type ToRunner,
  type Web,
} from "./testChannels.ts"
import { baseConfig, startHub, type TestHub } from "./testSupport.ts"

afterEach(stopAll)

const repo = "kddige/claude-hub"
const buildSecret = "npm_BUILD_SECRET_4f1c"
const runtimeSecret = "sk_RUNTIME_SECRET_9a2e"
const sharedSecret = "ghp_SHARED_SECRET_77b0"
const keyA = generateSecretsKey()
const keyB = generateSecretsKey()

const withKey = (key: string) => ({ secretsKey: Option.some(Redacted.make(key)) })

/** A draft as the web UI sends it, with a Plain, a Sensitive at build and a Sensitive not. */
const draft = (overrides: Record<string, unknown> = {}) => ({
  image: "debian:bookworm-slim",
  bootstrapScript: "apt-get install -y ripgrep",
  docker: false,
  dependencyFolders: [{ pattern: "**/node_modules", nextTo: "package.json" }],
  resources: { cpus: 2, memoryMib: 4096 },
  variables: [
    { _tag: "Plain", name: "NODE_ENV", value: "development" },
    { _tag: "Sensitive", name: "NPM_TOKEN", value: buildSecret, availableAtBuild: true },
    { _tag: "Sensitive", name: "API_KEY", value: runtimeSecret, availableAtBuild: false },
  ],
  ...overrides,
})

/** The same draft, keeping the Sensitive values saved. */
const keptDraft = (overrides: Record<string, unknown> = {}) =>
  draft({
    variables: [
      { _tag: "Plain", name: "NODE_ENV", value: "development" },
      { _tag: "Sensitive", name: "NPM_TOKEN", availableAtBuild: true },
      { _tag: "Sensitive", name: "API_KEY", availableAtBuild: false },
    ],
    ...overrides,
  })

let requests = 0
const nextRequest = () => `q-${++requests}`

/** The answer to the request: whatever message carries its id. */
const answer = (web: Connection<Web>, requestId: string) =>
  web.takeWhere(
    (message): message is Web => "requestId" in message && message.requestId === requestId,
    `answer to ${requestId}`,
  )

/** A Hub with a key, a Runner online and alice on the web. */
async function scene(options: { readonly hub?: TestHub } = {}) {
  const hub = options.hub ?? (await startHub({ config: { devLogin: true, ...withKey(keyA) } }))
  const issued = await issueRunnerToken(hub)
  const runner = await openRunner(hub, issued.token)
  const web = await openWeb(hub, "alice")
  return { hub, runner, web, runnerId: issued.runnerId, runnerToken: issued.token }
}

type Scene = Awaited<ReturnType<typeof scene>>

/** Runs a Test build of `body` on the scene's Runner, which reports `result`. */
async function testBuild(
  { runner, web, runnerId }: Scene,
  body: Record<string, unknown>,
  result: "Passed" | "Failed" = "Passed",
) {
  const requestId = nextRequest()
  web.send({ _tag: "StartTestBuild", requestId, repo, runnerId, draft: body })
  const started = await web.take("TestBuildStarted", (message) => message.requestId === requestId)
  const run = await runner.take("RunTestBuild", (m) => m.testBuildId === started.testBuild.id)
  runner.send({ _tag: "TestBuildFinished", testBuildId: run.testBuildId, result })
  await web.take("TestBuildEnded", (message) => message.testBuildId === run.testBuildId)
  return run
}

/** Applies `body` on top of `baseVersion`, and returns the Hub's answer. */
async function apply({ web }: Scene, body: Record<string, unknown>, baseVersion: number | null) {
  const requestId = nextRequest()
  web.send({ _tag: "ApplyEnvironment", requestId, repo, baseVersion, draft: body })
  return answer(web, requestId)
}

const expectRefused = (reply: Web, message: string | RegExp) => {
  expect(reply._tag).toBe("CommandFailed")
  expect(reply._tag === "CommandFailed" && reply.message).toMatch(message)
}

const expectApplied = (reply: Web, version: number) => {
  if (reply._tag !== "EnvironmentState") throw new Error(JSON.stringify(reply))
  expect(reply.environment?.version).toBe(version)
  return reply
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

/** A web client's variables fetched for a Runner: the reply to a FetchVariables. */
async function fetchVariables(
  runner: Connection<ToRunner>,
  forWhat: Record<string, unknown>,
): Promise<ToRunner> {
  const requestId = `v-${++requests}`
  runner.send({ _tag: "FetchVariables", requestId, for: forWhat })
  return runner.takeWhere(
    (message): message is ToRunner => "requestId" in message && message.requestId === requestId,
    `answer to ${requestId}`,
  )
}

describe("Secrets", () => {
  const key = new Uint8Array(Buffer.from(keyA, "base64"))
  const other = new Uint8Array(Buffer.from(keyB, "base64"))

  test("AES-256-GCM: round-trips, with a fresh IV, and no plaintext in the ciphertext", () => {
    const first = encryptValue(key, runtimeSecret, "environment:a/b:API_KEY")
    const second = encryptValue(key, runtimeSecret, "environment:a/b:API_KEY")
    expect(first).not.toBe(second)
    expect(first).not.toContain(runtimeSecret)
    expect(first.startsWith("v1:")).toBe(true)
    expect(decryptValue(key, first, "environment:a/b:API_KEY")).toBe(runtimeSecret)
  })

  test("a wrong key, another variable's context, or tampering reads nothing", () => {
    const stored = encryptValue(key, runtimeSecret, "shared:TOKEN")
    expect(decryptValue(other, stored, "shared:TOKEN")).toBeUndefined()
    expect(decryptValue(key, stored, "shared:OTHER")).toBeUndefined()
    const [version, iv, ciphertext, tag] = stored.split(":")
    const flipped = `${ciphertext?.[0] === "A" ? "B" : "A"}${ciphertext?.slice(1)}`
    expect(decryptValue(key, [version, iv, flipped, tag].join(":"), "shared:TOKEN")).toBe(undefined)
    expect(decryptValue(key, "garbage", "shared:TOKEN")).toBeUndefined()
  })

  test("the Hub refuses a HUB_SECRETS_KEY that isn't 32 bytes of base64", async () => {
    for (const bad of ["short", Buffer.alloc(16).toString("base64"), "not base64 at all!!"]) {
      const made = await Effect.runPromiseExit(
        HubConfig.make({ ...baseConfig, secretsKey: Option.some(Redacted.make(bad)) }),
      )
      expect(made._tag).toBe("Failure")
      expect(String(made)).toContain("HUB_SECRETS_KEY must be 32 random bytes")
    }
  })

  test("the Hub refuses to start when Sensitive values are stored but the key is missing or wrong", async () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-hub-"))
    try {
      const database = databaseAt(join(dir, "hub.db"))
      // A key with nothing encrypted yet is taken, whichever it is.
      const keyless = await startHub({ config: { devLogin: true }, database })
      await keyless.stop()

      const first = await startHub({ config: { devLogin: true, ...withKey(keyA) }, database })
      const { web } = await scene({ hub: first })
      const requestId = nextRequest()
      web.send({
        _tag: "SetSharedVariable",
        requestId,
        variable: { _tag: "Sensitive", name: "GITHUB_TOKEN", value: sharedSecret },
      })
      expect((await answer(web, requestId))._tag).toBe("SharedVariables")
      await stopAll()

      for (const [config, message] of [
        [{}, "HUB_SECRETS_KEY is not set"],
        [withKey(keyB), "HUB_SECRETS_KEY is not the key"],
      ] as const) {
        const error = await startHub({ config: { devLogin: true, ...config }, database }).then(
          () => undefined,
          (cause: unknown) => cause,
        )
        expect(String(error)).toContain(message)
      }

      // With the right key it starts, and the value is still there for a Runner.
      const again = await startHub({ config: { devLogin: true, ...withKey(keyA) }, database })
      const value = await again.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const secrets = yield* Secrets
          const [row] = yield* sql<{ readonly value: string }>`
            SELECT value FROM shared_variables WHERE name = 'GITHUB_TOKEN'
          `
          return Redacted.value(yield* secrets.decrypt(row?.value ?? "", "shared:GITHUB_TOKEN"))
        }),
      )
      expect(value).toBe(sharedSecret)
    } finally {
      await stopAll()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a Hub without a key refuses Sensitive values, and takes Plain ones", async () => {
    const hub = await startHub({ config: { devLogin: true } })
    const env = await scene({ hub })
    const requestId = nextRequest()
    env.web.send({ _tag: "CheckEnvironmentDraft", requestId, repo, draft: draft() })
    expectRefused(await answer(env.web, requestId), /no HUB_SECRETS_KEY.*bun run secrets-key/)

    const plain = draft({ variables: [{ _tag: "Plain", name: "NODE_ENV", value: "test" }] })
    await testBuild(env, plain)
    expectApplied(await apply(env, plain, null), 1)
  })

  test("the Hub's Layer fails cleanly when the key is wrong, as main.ts would report it", async () => {
    // The same check, without a server: Secrets over a database holding a value under keyA.
    const dir = mkdtempSync(join(tmpdir(), "claude-hub-"))
    try {
      const database = databaseAt(join(dir, "hub.db"))
      const store = Layer.provideMerge(
        Secrets.layer,
        Layer.merge(database, HubConfig.layerFrom({ ...baseConfig, ...withKey(keyA) })),
      )
      await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const ciphertext = yield* (yield* Secrets).encrypt(Redacted.make("x"), "shared:X")
          yield* sql`INSERT INTO participants (id, login, name, created_at, updated_at)
            VALUES ('dev:a', 'a', 'a', 0, 0)`
          yield* sql`INSERT INTO shared_variables (name, kind, value, updated_by, updated_at)
            VALUES ('X', 'Sensitive', ${ciphertext}, 'dev:a', 0)`
        }).pipe(Effect.provide(store)),
      )
      const wrong = Layer.provideMerge(
        Secrets.layer,
        Layer.merge(database, HubConfig.layerFrom({ ...baseConfig, ...withKey(keyB) })),
      )
      const exit = await Effect.runPromiseExit(Effect.provide(Effect.void, wrong))
      expect(exit._tag).toBe("Failure")
      expect(String(exit)).toContain("HUB_SECRETS_KEY is not the key")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("Applying an Environment", () => {
  test("a Repo's first Environment needs a passing Test build of exactly that draft", async () => {
    const env = await scene()
    const { web, runner } = env
    const get = nextRequest()
    web.send({ _tag: "GetEnvironment", requestId: get, repo })
    expect(await answer(web, get)).toMatchObject({
      _tag: "EnvironmentState",
      environment: null,
      versions: [],
    })

    const check = nextRequest()
    web.send({ _tag: "CheckEnvironmentDraft", requestId: check, repo, draft: draft() })
    expect(await answer(web, check)).toMatchObject({
      _tag: "EnvironmentDraftChecked",
      needsTestBuild: true,
      testBuildPassed: false,
    })
    expectRefused(await apply(env, draft(), null), /Test build/)

    // The Runner gets the recipe without values, and fetches them for the build it runs.
    const requestId = nextRequest()
    web.send({ _tag: "StartTestBuild", requestId, repo, runnerId: env.runnerId, draft: draft() })
    const started = await web.take("TestBuildStarted")
    expect(started.testBuild).toMatchObject({
      repo,
      runnerId: env.runnerId,
      startedBy: { id: "dev:alice" },
    })
    const run = await runner.take("RunTestBuild")
    expect(run.recipe.variables).toEqual([
      { name: "NODE_ENV", availableAtBuild: true },
      { name: "NPM_TOKEN", availableAtBuild: true },
      { name: "API_KEY", availableAtBuild: false },
    ])
    expect(JSON.stringify(run)).not.toContain(buildSecret)
    expect(
      await fetchVariables(runner, { _tag: "TestBuild", testBuildId: run.testBuildId }),
    ).toEqual({
      _tag: "VariablesFetched",
      requestId: expect.any(String),
      variables: [
        { name: "NODE_ENV", value: "development", availableAtBuild: true },
        { name: "NPM_TOKEN", value: buildSecret, availableAtBuild: true },
        { name: "API_KEY", value: runtimeSecret, availableAtBuild: false },
      ],
    })

    // Its log goes to the person who started it, and the result is recorded.
    runner.send({
      _tag: "TestBuildLog",
      testBuildId: run.testBuildId,
      data: "Setting up ripgrep\n",
    })
    expect(await web.take("TestBuildLogged")).toEqual({
      _tag: "TestBuildLogged",
      testBuildId: run.testBuildId,
      data: "Setting up ripgrep\n",
    })
    runner.send({ _tag: "TestBuildFinished", testBuildId: run.testBuildId, result: "Passed" })
    expect(await web.take("TestBuildEnded")).toMatchObject({ result: "Passed", repo })

    // A finished build's values are gone from the Hub's memory.
    expect(
      (await fetchVariables(runner, { _tag: "TestBuild", testBuildId: run.testBuildId }))._tag,
    ).toBe("VariablesRefused")

    const checked = nextRequest()
    web.send({ _tag: "CheckEnvironmentDraft", requestId: checked, repo, draft: draft() })
    expect(await answer(web, checked)).toMatchObject({
      needsTestBuild: true,
      testBuildPassed: true,
    })

    const bob = await openWeb(env.hub, "bob")
    const applied = expectApplied(await apply(env, draft(), null), 1)
    expect(applied.environment?.variables).toEqual([
      { _tag: "Plain", name: "NODE_ENV", value: "development" },
      { _tag: "Sensitive", name: "NPM_TOKEN", availableAtBuild: true },
      { _tag: "Sensitive", name: "API_KEY", availableAtBuild: false },
    ])
    expect(applied.versions).toMatchObject([
      { version: 1, appliedBy: { id: "dev:alice" }, rebuilt: true },
    ])
    // Everyone else hears of the new version.
    const heard = await bob.take("EnvironmentState")
    expect(heard.requestId).toBeUndefined()
    expect(heard.environment?.version).toBe(1)
  })

  test("a passing Test build of a different draft doesn't count", async () => {
    const env = await scene()
    await testBuild(env, draft())
    expectRefused(
      await apply(env, draft({ bootstrapScript: "apt-get install -y jq" }), null),
      /Test build/,
    )
    expectRefused(await apply(env, draft({ docker: true }), null), /Test build/)
    expectRefused(
      await apply(env, draft({ dependencyFolders: [{ pattern: "**/node_modules" }] }), null),
      /Test build/,
    )
    // Another value for a variable available at build is another build.
    const otherValue = draft({
      variables: [
        { _tag: "Plain", name: "NODE_ENV", value: "development" },
        { _tag: "Sensitive", name: "NPM_TOKEN", value: "npm_other", availableAtBuild: true },
        { _tag: "Sensitive", name: "API_KEY", value: runtimeSecret, availableAtBuild: false },
      ],
    })
    expectRefused(await apply(env, otherValue, null), /Test build/)
    // A failed build doesn't count either.
    await testBuild(env, otherValue, "Failed")
    expectRefused(await apply(env, otherValue, null), /Test build/)
    // What doesn't go into the build may differ: resources and variables not available at build.
    const sameBuild = draft({
      resources: { cpus: 8, memoryMib: 16_384 },
      variables: [
        { _tag: "Plain", name: "NODE_ENV", value: "development" },
        { _tag: "Sensitive", name: "NPM_TOKEN", value: buildSecret, availableAtBuild: true },
        { _tag: "Sensitive", name: "API_KEY", value: "sk_other", availableAtBuild: false },
      ],
    })
    expectApplied(await apply(env, sameBuild, null), 1)
  })

  test("changes outside the build apply straight away; build changes are new build versions", async () => {
    const env = await scene()
    await testBuild(env, draft())
    expectApplied(await apply(env, draft(), null), 1)

    // Rotating a Sensitive value not available at build, and more CPU.
    const rotated = keptDraft({
      resources: { cpus: 4, memoryMib: 4096 },
      variables: [
        { _tag: "Plain", name: "NODE_ENV", value: "development" },
        { _tag: "Sensitive", name: "NPM_TOKEN", availableAtBuild: true },
        { _tag: "Sensitive", name: "API_KEY", value: "sk_rotated", availableAtBuild: false },
      ],
    })
    expectApplied(await apply(env, rotated, 1), 2)
    // Changing a Plain variable, or which variables reach the build, changes the build.
    expectRefused(
      await apply(
        env,
        keptDraft({ variables: [{ _tag: "Plain", name: "NODE_ENV", value: "production" }] }),
        2,
      ),
      /Test build/,
    )
    const atBuild = keptDraft({
      variables: [
        { _tag: "Plain", name: "NODE_ENV", value: "development" },
        { _tag: "Sensitive", name: "NPM_TOKEN", availableAtBuild: true },
        { _tag: "Sensitive", name: "API_KEY", availableAtBuild: true },
      ],
    })
    expectRefused(await apply(env, atBuild, 2), /Test build/)
    // The saved value is what is built and stored: a Test build of the kept draft counts.
    const run = await testBuild(env, atBuild)
    expect(run.recipe.variables.at(-1)).toEqual({ name: "API_KEY", availableAtBuild: true })
    const applied = expectApplied(await apply(env, atBuild, 2), 3)
    expect(applied.versions.map(({ version, rebuilt }) => [version, rebuilt])).toEqual([
      [3, true],
      [2, false],
      [1, true],
    ])

    // A Session gets the latest version, with the version that last changed its build.
    const session = await createSession(env)
    expect(session.start.environment).toMatchObject({ version: 3, buildVersion: 3 })
    expectApplied(
      await apply(env, keptDraft({ ...atBuild, resources: { cpus: 1, memoryMib: 2048 } }), 3),
      4,
    )
    const next = await createSession(env)
    expect(next.start.environment).toMatchObject({
      version: 4,
      buildVersion: 3,
      recipe: { resources: { cpus: 1, memoryMib: 2048 } },
    })
    expect(JSON.stringify(next.start)).not.toContain(runtimeSecret)
  })

  test("a draft made from an older version is refused", async () => {
    const env = await scene()
    await testBuild(env, draft())
    expectApplied(await apply(env, draft(), null), 1)
    expectRefused(await apply(env, keptDraft(), null), /has changed since: version 1/)
    expectApplied(await apply(env, keptDraft(), 1), 2)
    expectRefused(await apply(env, keptDraft(), 1), /version 2 is the latest/)
  })

  test("names are unique in an Environment, local and linked alike, and the Runner's are reserved", async () => {
    const env = await scene()
    const set = nextRequest()
    env.web.send({
      _tag: "SetSharedVariable",
      requestId: set,
      variable: { _tag: "Plain", name: "REGISTRY", value: "ghcr.io" },
    })
    await answer(env.web, set)
    const refusals: Array<[Record<string, unknown>, RegExp]> = [
      [
        {
          variables: [
            { _tag: "Plain", name: "TOKEN", value: "a" },
            { _tag: "Link", name: "TOKEN", sharedVariable: "REGISTRY", availableAtBuild: false },
          ],
        },
        /TOKEN is there twice/,
      ],
      [{ variables: [{ _tag: "Plain", name: "CLAUDE_HUB_URL", value: "x" }] }, /reserved/],
      [{ variables: [{ _tag: "Plain", name: "MY-VAR", value: "x" }] }, /not a variable name/],
      [
        {
          variables: [{ _tag: "Link", name: "R", sharedVariable: "NOPE", availableAtBuild: false }],
        },
        /no shared variable NOPE/,
      ],
      [
        { variables: [{ _tag: "Sensitive", name: "NEW_TOKEN", availableAtBuild: false }] },
        /NEW_TOKEN has no saved Sensitive value/,
      ],
      [{ dependencyFolders: [{ pattern: "../outside" }] }, /not a dependency-folder pattern/],
      [{ image: "" }, /not an image reference/],
      [{ resources: { cpus: 0, memoryMib: 4096 } }, /CPUs must be/],
    ]
    for (const [overrides, message] of refusals) {
      const requestId = nextRequest()
      env.web.send({
        _tag: "StartTestBuild",
        requestId,
        repo,
        runnerId: env.runnerId,
        draft: draft(overrides),
      })
      expectRefused(await answer(env.web, requestId), message)
      expectRefused(await apply(env, draft(overrides), null), message)
    }
    // A Test build to a Runner that isn't online is refused too.
    const offline = nextRequest()
    env.web.send({
      _tag: "StartTestBuild",
      requestId: offline,
      repo,
      runnerId: "r-gone",
      draft: draft(),
    })
    expectRefused(await answer(env.web, offline), /not online/)
  })

  test("a Test build fails when its Runner goes offline", async () => {
    const env = await scene()
    const requestId = nextRequest()
    env.web.send({
      _tag: "StartTestBuild",
      requestId,
      repo,
      runnerId: env.runnerId,
      draft: draft(),
    })
    const run = await env.runner.take("RunTestBuild")
    await env.runner.close()
    expect(await env.web.take("TestBuildEnded")).toMatchObject({
      testBuildId: run.testBuildId,
      result: "Failed",
      message: expect.stringContaining("went offline"),
    })
    expectRefused(await apply(env, draft(), null), /Test build/)
  })
})

describe("Shared variables", () => {
  test("are listed without Sensitive values, linked under any name, and guarded while linked", async () => {
    const env = await scene()
    const { web } = env
    const set = async (variable: Record<string, unknown>) => {
      const requestId = nextRequest()
      web.send({ _tag: "SetSharedVariable", requestId, variable })
      return answer(web, requestId)
    }
    await set({ _tag: "Plain", name: "REGISTRY", value: "ghcr.io" })
    const listed = await set({ _tag: "Sensitive", name: "GITHUB_TOKEN", value: sharedSecret })
    expect(listed).toEqual({
      _tag: "SharedVariables",
      requestId: expect.any(String),
      variables: [
        { _tag: "Sensitive", name: "GITHUB_TOKEN", linkedBy: [] },
        { _tag: "Plain", name: "REGISTRY", value: "ghcr.io", linkedBy: [] },
      ],
    })
    expectRefused(await set({ _tag: "Sensitive", name: "NEW" }), /no saved Sensitive value/)
    expectRefused(await set({ _tag: "Plain", name: "CLAUDE_HUB_X", value: "x" }), /reserved/)

    const linked = draft({
      variables: [
        { _tag: "Link", name: "GH_TOKEN", sharedVariable: "GITHUB_TOKEN", availableAtBuild: false },
        {
          _tag: "Link",
          name: "DOCKER_REGISTRY",
          sharedVariable: "REGISTRY",
          availableAtBuild: true,
        },
      ],
    })
    const run = await testBuild(env, linked)
    expect(run.recipe.variables).toEqual([
      { name: "GH_TOKEN", availableAtBuild: false },
      { name: "DOCKER_REGISTRY", availableAtBuild: true },
    ])
    expectApplied(await apply(env, linked, null), 1)

    const get = nextRequest()
    web.send({ _tag: "GetSharedVariables", requestId: get })
    expect(await answer(web, get)).toMatchObject({
      variables: [
        { name: "GITHUB_TOKEN", linkedBy: [{ repo, name: "GH_TOKEN", availableAtBuild: false }] },
        { name: "REGISTRY", linkedBy: [{ repo, name: "DOCKER_REGISTRY", availableAtBuild: true }] },
      ],
    })

    // Rotating a value not available at build is fine; one available at build would change it.
    expect(
      (await set({ _tag: "Sensitive", name: "GITHUB_TOKEN", value: "ghp_rotated" }))._tag,
    ).toBe("SharedVariables")
    expectRefused(
      await set({ _tag: "Plain", name: "REGISTRY", value: "docker.io" }),
      /available at build in kddige\/claude-hub/,
    )
    expect((await set({ _tag: "Plain", name: "REGISTRY", value: "ghcr.io" }))._tag).toBe(
      "SharedVariables",
    )

    // A linked variable can't be deleted; an unlinked one can.
    const del = nextRequest()
    web.send({ _tag: "DeleteSharedVariable", requestId: del, name: "GITHUB_TOKEN" })
    expectRefused(await answer(web, del), /linked in kddige\/claude-hub/)
    await set({ _tag: "Plain", name: "UNUSED", value: "1" })
    const delUnused = nextRequest()
    web.send({ _tag: "DeleteSharedVariable", requestId: delUnused, name: "UNUSED" })
    expect(await answer(web, delUnused)).toMatchObject({ _tag: "SharedVariables" })

    // A Session's Runner gets the linked values under their names, current ones included.
    const session = await createSession(env)
    expect(
      await fetchVariables(env.runner, { _tag: "Session", sessionId: session.sessionId }),
    ).toMatchObject({
      _tag: "VariablesFetched",
      variables: [
        { name: "GH_TOKEN", value: "ghp_rotated", availableAtBuild: false },
        { name: "DOCKER_REGISTRY", value: "ghcr.io", availableAtBuild: true },
      ],
    })
  })
})

/** alice creates a Session on the scene's Runner, which starts it. */
async function createSession(env: Scene, environmentVersion?: number) {
  const requestId = nextRequest()
  env.web.send({ _tag: "CreateSession", requestId, repo, baseBranch: "main" })
  const start = await env.runner.take("StartSession")
  const created = await env.web.take("SessionCreated", (message) => message.requestId === requestId)
  const sessionId = created.session.id
  env.runner.send({
    _tag: "SessionStarted",
    sessionId,
    ...(environmentVersion !== undefined && { environmentVersion }),
  })
  return { start, sessionId, created }
}

describe("Sessions and Environments", () => {
  test("a Repo without an Environment still gets Sessions, until the web UI can set one up", async () => {
    // TODO(#50): flip this test when Sessions without an Environment are refused.
    expect(refuseSessionsWithoutEnvironment).toBe(false)
    const env = await scene()
    const { start, created } = await createSession(env)
    expect(start.environment).toBeUndefined()
    expect(created.session.environment).toBeUndefined()
  })

  test("the Hub tells when a Session runs on an older version", async () => {
    const env = await scene()
    await testBuild(env, draft())
    expectApplied(await apply(env, draft(), null), 1)
    const { sessionId } = await createSession(env, 1)
    expect(
      (
        await env.web.take(
          "SessionUpdated",
          (m) => m.session.id === sessionId && m.session.environment?.version === 1,
        )
      ).session.environment,
    ).toEqual({ version: 1, latestVersion: 1 })
    expectApplied(await apply(env, keptDraft({ resources: { cpus: 3, memoryMib: 4096 } }), 1), 2)
    expect(
      (await env.web.take("SessionUpdated", (m) => m.session.environment?.latestVersion === 2))
        .session.environment,
    ).toEqual({ version: 1, latestVersion: 2 })
  })

  test("a Runner gets values only for its own Active Sessions and its own Test builds", async () => {
    const env = await scene()
    await testBuild(env, draft())
    expectApplied(await apply(env, draft(), null), 1)
    const { sessionId } = await createSession(env, 1)

    expect(await fetchVariables(env.runner, { _tag: "Session", sessionId })).toMatchObject({
      _tag: "VariablesFetched",
      variables: [
        { name: "NODE_ENV", value: "development" },
        { name: "NPM_TOKEN", value: buildSecret },
        { name: "API_KEY", value: runtimeSecret },
      ],
    })

    const other = await issueRunnerToken(env.hub, "other")
    const otherRunner = await openRunner(env.hub, other.token)
    expect(await fetchVariables(otherRunner, { _tag: "Session", sessionId })).toMatchObject({
      _tag: "VariablesRefused",
      message: "Not a Session this Runner runs.",
    })
    expect(
      (await fetchVariables(otherRunner, { _tag: "Session", sessionId: "s-unknown" }))._tag,
    ).toBe("VariablesRefused")

    const requestId = nextRequest()
    env.web.send({
      _tag: "StartTestBuild",
      requestId,
      repo,
      runnerId: env.runnerId,
      draft: draft(),
    })
    const run = await env.runner.take("RunTestBuild")
    expect(
      await fetchVariables(otherRunner, { _tag: "TestBuild", testBuildId: run.testBuildId }),
    ).toMatchObject({ _tag: "VariablesRefused", message: "Not a Test build this Runner runs." })
    // Nor can another Runner speak for the build.
    otherRunner.send({ _tag: "TestBuildFinished", testBuildId: run.testBuildId, result: "Passed" })
    expect(await env.web.untaken("TestBuildEnded")).toEqual([])

    // An archived Session gets none.
    env.web.send({ _tag: "ArchiveSession", sessionId })
    await env.runner.take("StopSession")
    expect(await fetchVariables(env.runner, { _tag: "Session", sessionId })).toMatchObject({
      _tag: "VariablesRefused",
      message: "The Session is Archived: it gets no variables.",
    })
  })
})

describe("Sensitive values", () => {
  test("never reach the web, the Hub's logs or its database in plaintext", async () => {
    const logged: Array<string> = []
    const methods = ["log", "info", "warn", "error", "debug", "trace"] as const
    const originals = methods.map((method) => console[method])
    for (const method of methods) {
      console[method] = (...args: Array<unknown>) => {
        logged.push(args.map((arg) => (typeof arg === "string" ? arg : Bun.inspect(arg))).join(" "))
      }
    }
    try {
      const env = await scene()
      const bob = await openWeb(env.hub, "bob")
      const shared = nextRequest()
      env.web.send({
        _tag: "SetSharedVariable",
        requestId: shared,
        variable: { _tag: "Sensitive", name: "GITHUB_TOKEN", value: sharedSecret },
      })
      await answer(env.web, shared)
      const withLink = draft({
        variables: [
          ...(draft().variables as Array<unknown>),
          {
            _tag: "Link",
            name: "GH_TOKEN",
            sharedVariable: "GITHUB_TOKEN",
            availableAtBuild: true,
          },
        ],
      })
      const check = nextRequest()
      env.web.send({ _tag: "CheckEnvironmentDraft", requestId: check, repo, draft: withLink })
      await answer(env.web, check)
      const run = await testBuild(env, withLink)
      expect(
        JSON.stringify(
          await fetchVariables(env.runner, { _tag: "TestBuild", testBuildId: run.testBuildId }),
        ),
      ).toContain("VariablesRefused")
      expectApplied(await apply(env, withLink, null), 1)
      const get = nextRequest()
      env.web.send({ _tag: "GetEnvironment", requestId: get, repo })
      await answer(env.web, get)
      const list = nextRequest()
      env.web.send({ _tag: "GetSharedVariables", requestId: list })
      await answer(env.web, list)
      // A refused draft and a message the channel can't decode carry values too.
      expectRefused(
        await apply(
          env,
          draft({
            image: "bad image",
            variables: [
              { _tag: "Sensitive", name: "X", value: runtimeSecret, availableAtBuild: false },
            ],
          }),
          1,
        ),
        /image/,
      )
      env.web.send({
        _tag: "ApplyEnvironment",
        requestId: nextRequest(),
        draft: { variables: [{ _tag: "Sensitive", name: "X", value: buildSecret }] },
      })
      const { sessionId } = await createSession(env, 1)
      // The Runner of the Session does get them.
      expect(
        JSON.stringify(await fetchVariables(env.runner, { _tag: "Session", sessionId })),
      ).toContain(sharedSecret)
      await Bun.sleep(100)

      const web = [...env.web.texts, ...bob.texts].join("\n")
      const database = await databaseText(env.hub)
      expect(database).toContain("GITHUB_TOKEN")
      expect(logged.join("\n")).toContain("Dropped a message")
      for (const secret of [buildSecret, runtimeSecret, sharedSecret]) {
        expect(web).not.toContain(secret)
        expect(database).not.toContain(secret)
        expect(logged.join("\n")).not.toContain(secret)
      }
    } finally {
      methods.forEach((method, index) => {
        console[method] = originals[index] as never
      })
    }
  })
})
