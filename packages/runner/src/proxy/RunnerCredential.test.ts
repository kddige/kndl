import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ClaudeCredential } from "@claude-hub/protocol"
import { Effect, Logger, Redacted } from "effect"
import {
  type CredentialSource,
  DefaultKeychainService,
  parseCredentialSource,
} from "./ProxyConfig.ts"
import {
  ClaudeCodeKeychainService,
  hostSecretReaders,
  makeRunnerCredential,
  type RunnerCredentialOptions,
  type SecretReaders,
} from "./RunnerCredential.ts"

// Fake credentials only.
const setupToken = "sk-ant-oat01-setup-FAKE"
const loginToken = "sk-ant-oat01-login-FAKE"

const dir = mkdtempSync(join(tmpdir(), "claude-hub-credential-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const noConfig = join(dir, "missing.claude.json")

/** Claude Code's login record, as it keeps it. */
const login = (accessToken: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    claudeAiOauth: { accessToken, refreshToken: "sk-ant-ort01-FAKE", ...extra },
  })

/** Readers over a fixed Keychain and file system, counting each read. */
const fakeReaders = (
  keychain: Record<string, string | undefined>,
  files: Record<string, string | undefined> = {},
) => {
  const reads: Array<string> = []
  const readers: SecretReaders = {
    keychain: (service) =>
      Effect.sync(() => (reads.push(`keychain ${service}`), keychain[service])),
    file: (path) => Effect.sync(() => (reads.push(`file ${path}`), files[path])),
  }
  return { readers, reads, keychain, files }
}

const credentialOf = (
  readers: SecretReaders,
  source: CredentialSource,
  options: Partial<RunnerCredentialOptions> = {},
) =>
  Effect.runSync(
    makeRunnerCredential({
      source,
      plan: undefined,
      home: "/home/runner",
      readers,
      platform: "darwin",
      claudeConfigPath: noConfig,
      claudeConfigDir: "/home/runner/.claude",
      ...options,
    }),
  )

const secretOf = (credential: ClaudeCredential) =>
  credential._tag === "OAuthToken"
    ? Redacted.value(credential.token)
    : Redacted.value(credential.key)

const run = <A, E>(effect: Effect.Effect<A, E>, logs: Array<string> = []) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Logger.layer([
          Logger.make(({ logLevel, message }) =>
            logs.push(
              `${logLevel}: ${Array.isArray(message) ? message.join(" ") : String(message)}`,
            ),
          ),
        ]),
      ),
    ),
  )

const failureOf = <A, E extends { readonly message: string }>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.flip(effect)).then((error) => error.message)

describe("parseCredentialSource", () => {
  test("reads each form RUNNER_CLAUDE_CREDENTIAL takes", () => {
    expect(parseCredentialSource("auto")).toEqual({ _tag: "Auto" })
    expect(parseCredentialSource("none")).toEqual({ _tag: "None" })
    expect(parseCredentialSource("claude-code")).toEqual({ _tag: "ClaudeCode" })
    expect(parseCredentialSource("keychain")).toEqual({
      _tag: "Keychain",
      service: DefaultKeychainService,
    })
    expect(parseCredentialSource(" keychain:work ")).toEqual({ _tag: "Keychain", service: "work" })
    expect(parseCredentialSource("file:/etc/claude-hub/token")).toEqual({
      _tag: "File",
      path: "/etc/claude-hub/token",
    })
  })

  test("refuses anything else", () => {
    for (const text of ["", "keychain:", "file:", "sk-ant-oat01-FAKE", "env"])
      expect(parseCredentialSource(text)).toBeUndefined()
  })
})

describe("the Runner's credential, unset", () => {
  test("is the setup-token in the Keychain on a Mac", async () => {
    const fake = fakeReaders({
      [DefaultKeychainService]: `${setupToken}\n`,
      [ClaudeCodeKeychainService]: login(loginToken),
    })
    const credential = credentialOf(fake.readers, { _tag: "Auto" })
    const read = await run(credential.describe)

    expect(secretOf(read.credential)).toBe(setupToken)
    expect(read.from).toStartWith(`the Keychain item "${DefaultKeychainService}"`)
    expect(fake.reads).toEqual([`keychain ${DefaultKeychainService}`])
  })

  test("is the setup-token file in the Runner's home elsewhere", async () => {
    const fake = fakeReaders({}, { "/home/runner/claude-token": setupToken })
    const credential = credentialOf(fake.readers, { _tag: "Auto" }, { platform: "linux" })

    expect(secretOf(await run(credential.current))).toBe(setupToken)
    expect(fake.reads).toEqual(["file /home/runner/claude-token"])
  })

  test("falls back to Claude Code's login: its Keychain item, then its file", async () => {
    const mac = fakeReaders({ [ClaudeCodeKeychainService]: login(loginToken) })
    expect(secretOf(await run(credentialOf(mac.readers, { _tag: "Auto" }).current))).toBe(
      loginToken,
    )

    const linux = fakeReaders({}, { "/home/runner/.claude/.credentials.json": login(loginToken) })
    const credential = credentialOf(linux.readers, { _tag: "Auto" }, { platform: "linux" })
    expect(secretOf(await run(credential.current))).toBe(loginToken)
    expect(linux.reads).toEqual([
      "file /home/runner/claude-token",
      "file /home/runner/.claude/.credentials.json",
    ])
  })

  test("says why there is none, without failing on the way", async () => {
    const fake = fakeReaders({})
    const message = await failureOf(credentialOf(fake.readers, { _tag: "Auto" }).current)
    expect(message).toBe("Claude Code is not signed in on this host")
  })
})

describe("the Runner's credential, as configured", () => {
  test("reads the Keychain item, or the file, it is pointed at, and only that", async () => {
    const fake = fakeReaders(
      { work: "sk-ant-api03-FAKE", [DefaultKeychainService]: setupToken },
      { "/etc/token": setupToken },
    )
    const key = await run(credentialOf(fake.readers, { _tag: "Keychain", service: "work" }).current)
    expect(key._tag).toBe("ApiKey")

    const file = credentialOf(fake.readers, { _tag: "File", path: "/etc/token" })
    expect(secretOf(await run(file.current))).toBe(setupToken)

    const missing = credentialOf(fake.readers, { _tag: "Keychain", service: "other" })
    expect(await failureOf(missing.current)).toBe('there is no Keychain item "other"')
  })

  test("reads Claude Code's login only, when pointed at it", async () => {
    const fake = fakeReaders({
      [DefaultKeychainService]: setupToken,
      [ClaudeCodeKeychainService]: login(loginToken),
    })
    const credential = credentialOf(fake.readers, { _tag: "ClaudeCode" })
    expect(secretOf(await run(credential.current))).toBe(loginToken)
    expect(fake.reads).toEqual([`keychain ${ClaudeCodeKeychainService}`])
  })

  test("is none when told so", async () => {
    const fake = fakeReaders({ [DefaultKeychainService]: setupToken })
    expect(await failureOf(credentialOf(fake.readers, { _tag: "None" }).current)).toContain("none")
    expect(fake.reads).toEqual([])
  })

  test("refuses a login without an access token", async () => {
    const fake = fakeReaders({ [ClaudeCodeKeychainService]: '{"claudeAiOauth":{}}' })
    const message = await failureOf(credentialOf(fake.readers, { _tag: "ClaudeCode" }).current)
    expect(message).toContain("holds no access token")
  })
})

/** A Claude Code config file whose account is on `organizationType`. */
const configWith = (organizationType: string) => {
  const path = join(dir, `${organizationType}.claude.json`)
  writeFileSync(
    path,
    JSON.stringify({
      oauthAccount: { organizationType, organizationRateLimitTier: "default_claude_max_20x" },
    }),
  )
  return path
}

/** The plan of the setup-token, or with `setup: false` of Claude Code's login. */
const planOf = async (options: Partial<RunnerCredentialOptions>, setup = true) => {
  const fake = fakeReaders({
    [DefaultKeychainService]: setup ? setupToken : undefined,
    [ClaudeCodeKeychainService]: login(loginToken, {
      subscriptionType: "pro",
      rateLimitTier: "default_claude_ai",
    }),
  })
  const read = await run(credentialOf(fake.readers, { _tag: "Auto" }, options).describe)
  return { plan: read.credential._tag === "OAuthToken" ? read.credential.plan : undefined, read }
}

describe("the plan", () => {
  test("is RUNNER_CLAUDE_PLAN's first", async () => {
    const { plan, read } = await planOf({
      plan: { subscriptionType: "team" },
      claudeConfigPath: configWith("claude_max"),
    })
    expect(plan).toEqual({ subscriptionType: "team" })
    expect(read.from).toContain("from RUNNER_CLAUDE_PLAN")
  })

  test("else the one in Claude Code's config", async () => {
    const { plan } = await planOf({ claudeConfigPath: configWith("claude_max") })
    expect(plan).toEqual({ subscriptionType: "max", rateLimitTier: "default_claude_max_20x" })
  })

  test("else the one Claude Code's login records", async () => {
    const { plan } = await planOf({}, false)
    expect(plan).toEqual({ subscriptionType: "pro", rateLimitTier: "default_claude_ai" })
  })

  test("else unknown, and the log says how to state it", async () => {
    const fake = fakeReaders({ [DefaultKeychainService]: setupToken })
    const read = await run(credentialOf(fake.readers, { _tag: "Auto" }).describe)
    expect(read.credential._tag === "OAuthToken" && read.credential.plan).toBeUndefined()
    expect(read.from).toContain("set RUNNER_CLAUDE_PLAN")
  })
})

describe("caching", () => {
  test("reads a setup-token once, and again when asked to", async () => {
    const fake = fakeReaders({ [DefaultKeychainService]: setupToken })
    const credential = credentialOf(fake.readers, { _tag: "Auto" })
    await run(credential.current)
    await run(credential.current)
    expect(fake.reads).toHaveLength(1)

    fake.keychain[DefaultKeychainService] = "sk-ant-oat01-replaced-FAKE"
    expect(secretOf(await run(credential.reread))).toBe("sk-ant-oat01-replaced-FAKE")
    expect(secretOf(await run(credential.current))).toBe("sk-ant-oat01-replaced-FAKE")
    expect(fake.reads).toHaveLength(2)
  })

  test("reads Claude Code's login again close to its expiry, and warns once when it has expired", async () => {
    let now = 1_000_000_000
    const expiresAt = now + 10 * 60_000
    const fake = fakeReaders({ [ClaudeCodeKeychainService]: login(loginToken, { expiresAt }) })
    const credential = credentialOf(fake.readers, { _tag: "ClaudeCode" }, { now: () => now })
    const logs: Array<string> = []

    await run(credential.current, logs)
    now += 4 * 60_000
    await run(credential.current, logs)
    expect(fake.reads).toHaveLength(1)

    now += 2 * 60_000
    await run(credential.current, logs)
    expect(fake.reads).toHaveLength(2)

    now = expiresAt + 1
    await run(credential.current, logs)
    await run(credential.current, logs)
    expect(fake.reads).toHaveLength(4)
    expect(logs.filter((line) => line.includes("has expired"))).toHaveLength(1)

    fake.keychain[ClaudeCodeKeychainService] = login("sk-ant-oat01-refreshed-FAKE", {
      expiresAt: now + 60 * 60_000,
    })
    expect(secretOf(await run(credential.current, logs))).toBe("sk-ant-oat01-refreshed-FAKE")
    for (const line of logs) expect(line).not.toContain("FAKE")
  })

  test("forgets a credential that can no longer be read", async () => {
    const fake = fakeReaders({ [DefaultKeychainService]: setupToken })
    const credential = credentialOf(fake.readers, {
      _tag: "Keychain",
      service: DefaultKeychainService,
    })
    await run(credential.current)
    fake.keychain[DefaultKeychainService] = undefined
    await failureOf(credential.reread)
    expect(await failureOf(credential.current)).toContain("there is no Keychain item")
  })
})

describe("hostSecretReaders' files", () => {
  // The spawner is only for the Keychain.
  const readers = hostSecretReaders(undefined as never)

  test("read a private file of the Runner's user, and nothing for a missing one", async () => {
    const path = join(dir, "private-token")
    writeFileSync(path, setupToken, { mode: 0o600 })
    chmodSync(path, 0o600)
    expect(await Effect.runPromise(readers.file(path, { private: true }))).toBe(setupToken)
    expect(
      await Effect.runPromise(readers.file(join(dir, "absent"), { private: true })),
    ).toBeUndefined()
  })

  test("refuse a private file others can read, without its content in the error", async () => {
    const path = join(dir, "shared-token")
    writeFileSync(path, setupToken)
    chmodSync(path, 0o644)
    const message = await failureOf(readers.file(path, { private: true }))
    expect(message).toContain(`chmod 600 ${path}`)
    expect(message).not.toContain(setupToken)
    expect(await Effect.runPromise(readers.file(path))).toBe(setupToken)
  })
})
