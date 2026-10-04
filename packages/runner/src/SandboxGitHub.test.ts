import { describe, expect, test } from "bun:test"
import { GitAnswer } from "@claude-hub/protocol"
import { Effect, Exit, Layer, Logger, Redacted, Scope } from "effect"
import { TestClock } from "effect/testing"
import { makeFake } from "./sandbox/FakeSandboxBackend.ts"
import type { FakeOptions } from "./sandbox/FakeSandboxBackend.ts"
import { sessionSandboxSpec } from "./sandbox/SessionLayout.ts"
import {
  credentialHelper,
  ghHostsPath,
  installSandboxToken,
  keepSandboxToken,
  prepareScript,
  TokenRefreshInterval,
  TokenRetryInterval,
  tokenPath,
} from "./SandboxGitHub.ts"
import { sessionId } from "./testSupport.ts"

const s1 = sessionId("s-1")

/** A running Sandbox on the fake backend. */
const running = (options?: FakeOptions) =>
  Effect.gen(function* () {
    const fake = makeFake(options)
    yield* fake.backend.create(
      sessionSandboxSpec({ sessionId: s1, image: "debian", workspaceHostPath: "/host/ws" }),
    )
    return fake
  })

const fileIn = (fake: ReturnType<typeof makeFake>, path: string) =>
  fake.backend.readFile(s1, path).pipe(
    Effect.map((bytes) => new TextDecoder().decode(bytes)),
    Effect.orElseSucceed(() => undefined),
  )

/** Lets forked fibers run up to their next sleep. */
const settle = Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow, {
  discard: true,
})

const minted = (token: string) =>
  GitAnswer.cases.SandboxToken.make({ token: Redacted.make(token), expiresAt: 0 })

/** Warnings and infos logged while `effect` runs. */
const logsOf = (logs: Array<string>) =>
  Logger.layer([
    Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn" || logLevel === "Info")
        logs.push(`${logLevel}: ${Array.isArray(message) ? message.join(" ") : String(message)}`)
    }),
  ])

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>, logs: Array<string> = []) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(TestClock.layer(), logsOf(logs))),
    Effect.runPromise,
  )

describe("installSandboxToken", () => {
  test("readies the Sandbox, then writes the token and gh's hosts.yml, readable by root alone", () =>
    run(
      Effect.gen(function* () {
        const fake = yield* running()
        yield* installSandboxToken(fake.backend, s1, Redacted.make("ghs_one"))

        expect(yield* fileIn(fake, tokenPath)).toBe("ghs_one")
        expect(yield* fileIn(fake, ghHostsPath)).toBe(
          'github.com:\n    oauth_token: "ghs_one"\n    user: x-access-token\n    git_protocol: https\n',
        )
        expect(fake.world.execCalls.map((call) => call.request)).toEqual([
          { command: "sh", args: ["-c", prepareScript, "sh", credentialHelper] },
          { command: "chmod", args: ["0600", tokenPath, ghHostsPath] },
        ])
        // Nothing that runs in the Sandbox is given the token, and its settings never hold it.
        expect(JSON.stringify(fake.world.execCalls)).not.toContain("ghs_one")
        expect(JSON.stringify(fake.world.sandboxes.get(s1)?.spec)).not.toContain("ghs_one")
      }),
    ))

  test("writes no token where the tmpfs can't be mounted", () =>
    run(
      Effect.gen(function* () {
        const fake = yield* running({
          onExec: () => Effect.succeed({ exitCode: 32, stderr: "mount: permission denied\n" }),
        })
        const error = yield* Effect.flip(
          installSandboxToken(fake.backend, s1, Redacted.make("ghs_one")),
        )
        expect(error.message).toBe(
          "could not ready the Sandbox for a GitHub token: mount: permission denied",
        )
        expect(yield* fileIn(fake, tokenPath)).toBeUndefined()
        expect(yield* fileIn(fake, ghHostsPath)).toBeUndefined()
      }),
    ))
})

describe("the credential helper and prepare script", () => {
  test("hand out the token file's content for github.com only, and mount a tmpfs for it", () => {
    expect(credentialHelper).toContain(`[ "$1" = get ]`)
    expect(credentialHelper).toContain("username=x-access-token")
    expect(credentialHelper).toContain(`password=$(cat ${tokenPath})`)
    expect(prepareScript).toContain("mount -t tmpfs")
    expect(prepareScript).toContain(
      "git config --system --replace-all credential.https://github.com.helper",
    )
    expect(prepareScript).toContain(`ln -sfn ${ghHostsPath}`)
  })
})

describe("keepSandboxToken", () => {
  test("installs a token now and a fresh one every 45 minutes, until its scope closes", () => {
    const asked: Array<string> = []
    return run(
      Effect.gen(function* () {
        const fake = yield* running()
        const scope = yield* Scope.make()
        yield* keepSandboxToken({
          backend: fake.backend,
          sessionId: s1,
          source: (id) =>
            Effect.sync(() => {
              asked.push(id)
              return minted(`ghs_${asked.length}`)
            }),
        }).pipe(Scope.provide(scope))
        yield* settle
        expect(yield* fileIn(fake, tokenPath)).toBe("ghs_1")

        yield* TestClock.adjust("44 minutes")
        yield* settle
        expect(asked).toEqual(["s-1"])
        yield* TestClock.adjust("1 minute")
        yield* settle
        expect(yield* fileIn(fake, tokenPath)).toBe("ghs_2")
        expect(yield* fileIn(fake, ghHostsPath)).toContain('oauth_token: "ghs_2"')

        yield* Scope.close(scope, Exit.void)
        yield* TestClock.adjust(TokenRefreshInterval)
        yield* settle
        expect(asked).toHaveLength(2)
      }),
    )
  })

  test("without a token, as with no GitHub App, logs it once and asks again sooner", () => {
    const logs: Array<string> = []
    let answer: GitAnswer = GitAnswer.cases.GitFailed.make({
      message: "No GitHub App is configured",
    })
    let asks = 0
    return run(
      Effect.gen(function* () {
        const fake = yield* running()
        yield* keepSandboxToken({
          backend: fake.backend,
          sessionId: s1,
          source: () => Effect.sync(() => (asks++, answer)),
        })
        yield* settle
        yield* TestClock.adjust(TokenRetryInterval)
        yield* settle
        expect(asks).toBe(2)
        expect(yield* fileIn(fake, tokenPath)).toBeUndefined()
        expect(logs).toEqual([
          "Warn: Session s-1: its Sandbox has no GitHub token, so git and gh there can't reach GitHub: No GitHub App is configured",
        ])

        answer = minted("ghs_back")
        yield* TestClock.adjust(TokenRetryInterval)
        yield* settle
        expect(yield* fileIn(fake, tokenPath)).toBe("ghs_back")
        expect(logs.at(-1)).toBe("Info: Session s-1: its Sandbox has a GitHub token again")
      }),
      logs,
    )
  })
})
