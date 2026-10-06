// The Runner's own Claude credential: what a Session without its Creator's credential runs on
// (ADR 0015), and, on a Mac, the zero-config path: a `claude setup-token` token in the Keychain.
//
// It is read where the Runner owner keeps it, never stored anywhere else, never refreshed, and
// never logged. Claude Code's own login, the fallback, is read as Claude Code leaves it: the
// host's Claude Code keeps it fresh, and the Runner reads it again close to its expiry, and when
// Anthropic refuses it.

import { stat, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  type ClaudeCredential,
  type ClaudePlan,
  ClaudeSubscriptionType,
  credentialFromSecret,
} from "@claude-hub/protocol"
import { Context, Data, Effect, Layer, Schema, Semaphore } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { accountFromClaudeConfig, claudeConfigPath, planFromClaudeConfig } from "../ClaudeConfig.ts"
import { runCommand } from "../Process.ts"
import {
  type CredentialSource,
  DefaultKeychainService,
  DefaultTokenFile,
  ProxyConfig,
} from "./ProxyConfig.ts"

export class NoClaudeCredential extends Data.TaggedError("NoClaudeCredential")<{
  readonly message: string
}> {}

/** Where Claude Code 2.1.289 keeps its login on macOS. */
export const ClaudeCodeKeychainService = "Claude Code-credentials"

/** Reads secrets where they are kept; replaced in tests. Neither ever puts one in an error. */
export interface SecretReaders {
  /** The password of a generic Keychain item, or undefined when there is no such item. */
  readonly keychain: (service: string) => Effect.Effect<string | undefined, NoClaudeCredential>
  /**
   * A file's content, or undefined when it is missing. A `private` file must be the Runner
   * user's, and readable by no one else.
   */
  readonly file: (
    path: string,
    options?: { readonly private?: boolean },
  ) => Effect.Effect<string | undefined, NoClaudeCredential>
}

/** `security find-generic-password` exits with this when there is no such item. */
const securityItemNotFound = 44

/** The host's Keychain, through `security`, and its files. */
export const hostSecretReaders = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
): SecretReaders => ({
  keychain: (service) =>
    runCommand("security", ["find-generic-password", "-s", service, "-w"]).pipe(
      Effect.map(({ stdout }) => stdout.replace(/\n$/, "")),
      // Its output is the secret, so none of it goes into the error.
      Effect.catchTag("CommandFailed", (error) =>
        error.exitCode === securityItemNotFound
          ? Effect.succeed(undefined)
          : Effect.fail(
              new NoClaudeCredential({
                message: `reading the Keychain item "${service}" failed (security exited with ${error.exitCode ?? "an error"})`,
              }),
            ),
      ),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    ),
  file: (path, options) =>
    Effect.tryPromise({
      try: async () => {
        const found = await stat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          throw error
        })
        if (found === undefined) return undefined
        if (options?.private === true) {
          if ((found.mode & 0o077) !== 0)
            throw new Error(`others can read it: run \`chmod 600 ${path}\``)
          if (process.getuid !== undefined && found.uid !== process.getuid())
            throw new Error("it belongs to another user")
        }
        return await readFile(path, "utf8")
      },
      catch: (error) =>
        new NoClaudeCredential({
          message: `${path} can't be used: ${error instanceof Error ? error.message : "it can't be read"}`,
        }),
    }),
})

export interface RunnerCredentialOptions {
  readonly source: CredentialSource
  /** The plan `RUNNER_CLAUDE_PLAN` states; else the one Claude Code's config records. */
  readonly plan: ClaudePlan | undefined
  /** The Runner's home, which the setup-token file is looked for in off macOS. */
  readonly home: string
  readonly readers: SecretReaders
  readonly platform?: NodeJS.Platform
  /** Claude Code's config file, for its account and the account's plan. */
  readonly claudeConfigPath?: string
  /** Claude Code's config directory, holding its login off macOS. */
  readonly claudeConfigDir?: string
  readonly now?: () => number
}

/** The credential read, how it is shown, where from, and until when it is good. */
export interface CredentialRead {
  readonly credential: ClaudeCredential
  /**
   * How the Hub shows it, never the secret: a token's kind and last four characters, such as
   * "Subscription token …9f3b", or the account Claude Code is signed in to.
   */
  readonly account: string
  /** Where it was read from and where its plan came from, for the log. */
  readonly from: string
  /** When it expires, for Claude Code's login; a setup-token is good until refused. */
  readonly expiresAt?: number
}

export class RunnerCredential extends Context.Service<
  RunnerCredential,
  {
    /** The credential, read when first needed and again close to its expiry. */
    readonly current: Effect.Effect<ClaudeCredential, NoClaudeCredential>
    /**
     * Reads it again, as after Anthropic refused it: the host's Claude Code may have refreshed
     * its login, or the owner replaced the setup-token.
     */
    readonly reread: Effect.Effect<ClaudeCredential, NoClaudeCredential>
    /** Reads it as `current` does, and says where it came from. */
    readonly describe: Effect.Effect<CredentialRead, NoClaudeCredential>
  }
>()("@claude-hub/runner/RunnerCredential") {}

/** Claude Code's login is read again this long before it expires. */
const refreshMargin = 5 * 60_000

interface ClaudeCodeLogin {
  readonly accessToken: string
  readonly expiresAt?: number
  readonly plan?: ClaudePlan
}

/** The `claudeAiOauth` record Claude Code keeps its login in, without its refresh token. */
function parseClaudeCodeLogin(text: string): ClaudeCodeLogin | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const oauth = (parsed as { claudeAiOauth?: Record<string, unknown> } | null)?.claudeAiOauth
  const accessToken = oauth?.accessToken
  if (typeof accessToken !== "string" || accessToken === "") return undefined
  const expiresAt = typeof oauth?.expiresAt === "number" ? oauth.expiresAt : undefined
  const subscriptionType = oauth?.subscriptionType
  const tier = oauth?.rateLimitTier
  const plan: ClaudePlan | undefined = isSubscriptionType(subscriptionType)
    ? {
        subscriptionType,
        ...(typeof tier === "string" && tier !== "" ? { rateLimitTier: tier } : {}),
      }
    : undefined
  return {
    accessToken,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(plan === undefined ? {} : { plan }),
  }
}

const isSubscriptionType = Schema.is(ClaudeSubscriptionType)

const readJson = (path: string) =>
  Effect.tryPromise(async () => JSON.parse(await readFile(path, "utf8")) as unknown).pipe(
    Effect.orElseSucceed(() => undefined),
  )

/** The Runner's credential, read from `options.source`. */
export const makeRunnerCredential = (options: RunnerCredentialOptions) =>
  Effect.gen(function* () {
    const platform = options.platform ?? process.platform
    const now = options.now ?? Date.now
    const configPath = options.claudeConfigPath ?? claudeConfigPath()
    const configDir =
      options.claudeConfigDir ?? (process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"))
    const { readers } = options
    const lock = yield* Semaphore.make(1)
    let cached: CredentialRead | undefined
    let warnedExpiry: number | undefined

    /**
     * A subscription token on the plan the owner stated, else the one Claude Code records. Shown
     * as Claude Code's account when it is Claude Code's login, else by its kind and last four.
     */
    const withPlan = (
      secret: string,
      recorded: ClaudePlan | undefined,
      from: string,
      claudeCode = false,
    ) =>
      Effect.gen(function* () {
        const config = yield* readJson(configPath)
        let plan = options.plan
        let planFrom = "RUNNER_CLAUDE_PLAN"
        if (plan === undefined) {
          plan = planFromClaudeConfig(config)
          planFrom = configPath
        }
        if (plan === undefined && recorded !== undefined) {
          plan = recorded
          planFrom = "Claude Code's login"
        }
        const credential = credentialFromSecret(secret, plan)
        if (credential === undefined)
          return yield* new NoClaudeCredential({ message: `${from} is empty` })
        const planText =
          credential._tag === "ApiKey"
            ? "an API key"
            : plan === undefined
              ? "plan unknown: set RUNNER_CLAUDE_PLAN"
              : `plan ${plan.subscriptionType}${plan.rateLimitTier === undefined ? "" : ` (${plan.rateLimitTier})`}, from ${planFrom}`
        const account = claudeCode
          ? (accountFromClaudeConfig(config) ?? "Claude Code's login")
          : `${credential._tag === "ApiKey" ? "API key" : "Subscription token"} …${secret.trim().slice(-4)}`
        return { credential, account, from: `${from}; ${planText}` }
      })

    const fromKeychain = (service: string) =>
      Effect.gen(function* () {
        const secret = yield* readers.keychain(service)
        if (secret === undefined)
          return yield* new NoClaudeCredential({
            message: `there is no Keychain item "${service}"`,
          })
        return yield* withPlan(secret, undefined, `the Keychain item "${service}"`)
      })

    const fromFile = (path: string) =>
      Effect.gen(function* () {
        const secret = yield* readers.file(path, { private: true })
        if (secret === undefined)
          return yield* new NoClaudeCredential({ message: `there is no file ${path}` })
        return yield* withPlan(secret, undefined, path)
      })

    const claudeCodeFile = join(configDir, ".credentials.json")

    /** Claude Code's login: its Keychain item on macOS, else (or failing that) its file. */
    const fromClaudeCode = Effect.gen(function* () {
      let text: string | undefined
      let from = claudeCodeFile
      if (platform === "darwin") {
        text = yield* readers.keychain(ClaudeCodeKeychainService)
        from = `Claude Code's login in the Keychain item "${ClaudeCodeKeychainService}"`
      }
      if (text === undefined) {
        text = yield* readers.file(claudeCodeFile)
        from = `Claude Code's login in ${claudeCodeFile}`
      }
      if (text === undefined)
        return yield* new NoClaudeCredential({
          message: "Claude Code is not signed in on this host",
        })
      const login = parseClaudeCodeLogin(text)
      if (login === undefined)
        return yield* new NoClaudeCredential({ message: `${from} holds no access token` })
      const read = yield* withPlan(login.accessToken, login.plan, from, true)
      return login.expiresAt === undefined ? read : { ...read, expiresAt: login.expiresAt }
    })

    const read: Effect.Effect<CredentialRead, NoClaudeCredential> = Effect.suspend(() => {
      const source = options.source
      switch (source._tag) {
        case "Keychain":
          return fromKeychain(source.service)
        case "File":
          return fromFile(source.path)
        case "ClaudeCode":
          return fromClaudeCode
        case "None":
          return Effect.fail(
            new NoClaudeCredential({ message: "RUNNER_CLAUDE_CREDENTIAL is none" }),
          )
        case "Auto":
          return Effect.gen(function* () {
            if (platform === "darwin") {
              const secret = yield* readers.keychain(DefaultKeychainService)
              if (secret !== undefined)
                return yield* withPlan(
                  secret,
                  undefined,
                  `the Keychain item "${DefaultKeychainService}"`,
                )
            } else {
              const path = join(options.home, DefaultTokenFile)
              const secret = yield* readers.file(path, { private: true })
              if (secret !== undefined) return yield* withPlan(secret, undefined, path)
            }
            return yield* fromClaudeCode
          })
      }
    })

    const fresh = (entry: CredentialRead) =>
      entry.expiresAt === undefined || entry.expiresAt - now() > refreshMargin

    /** Reads, unless `force` is false and what's cached is still good. One read at a time. */
    const load = (force: boolean) =>
      lock.withPermit(
        Effect.gen(function* () {
          if (!force && cached !== undefined && fresh(cached)) return cached
          const entry = yield* read.pipe(
            Effect.tapError(() => Effect.sync(() => void (cached = undefined))),
          )
          cached = entry
          if (
            entry.expiresAt !== undefined &&
            entry.expiresAt <= now() &&
            entry.expiresAt !== warnedExpiry
          ) {
            warnedExpiry = entry.expiresAt
            yield* Effect.logWarning(
              `The Runner's Claude credential, ${entry.from.split(";")[0]}, has expired: run \`claude\` on this host to refresh it, or give the Runner a setup-token`,
            )
          }
          return entry
        }),
      )

    return RunnerCredential.of({
      current: Effect.map(load(false), (entry) => entry.credential),
      reread: Effect.map(load(true), (entry) => entry.credential),
      describe: load(false),
    })
  })

/**
 * The Runner's credential, from the host's Keychain and files, as `RUNNER_CLAUDE_CREDENTIAL`
 * says. Read once as the Runner starts, so the log says which one it is, or why there is none;
 * the Runner starts either way.
 */
export const RunnerCredentialLive = Layer.effect(
  RunnerCredential,
  Effect.gen(function* () {
    const config = yield* ProxyConfig
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const credential = yield* makeRunnerCredential({
      source: config.credential,
      plan: config.plan,
      home: config.home,
      readers: hostSecretReaders(spawner),
    })
    yield* credential.describe.pipe(
      Effect.flatMap((read) =>
        Effect.logInfo(`Claude credential for Sessions without their own: ${read.from}`),
      ),
      Effect.catchTag("NoClaudeCredential", (error) =>
        Effect.logWarning(
          `No Claude credential for Sessions without their own: ${error.message}. See RUNNER_CLAUDE_CREDENTIAL.`,
        ),
      ),
    )
    return credential
  }),
)
