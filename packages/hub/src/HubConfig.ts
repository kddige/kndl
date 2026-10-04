import { createPrivateKey } from "node:crypto"
import { readFile } from "node:fs/promises"
import { Config, Context, Duration, Effect, Layer, Option, Redacted, Schema } from "effect"

/** The GitHub App's user sign-in credentials (issue #1). */
export interface GitHubOAuthConfig {
  readonly clientId: string
  readonly clientSecret: Redacted.Redacted<string>
}

/**
 * The GitHub App's own credentials, which mint installation tokens: for the Runner's clone and
 * WIP pushes, and for git and gh in the Sandbox (issue #73, ADR 0010). Only the Hub holds them.
 */
export interface GitHubAppConfig {
  readonly appId: string
  /** The App's private key, PEM. */
  readonly privateKey: Redacted.Redacted<string>
  /** GitHub's REST API: https://api.github.com, or a stand-in in tests. */
  readonly apiUrl: URL
}

/** GitHub's REST API. */
export const GitHubApiUrl = new URL("https://api.github.com")

/** What the Hub is configured with, as read from the environment. */
export interface HubConfigInput {
  /** The address the Hub listens on. */
  readonly host: string
  readonly port: number
  /**
   * Where browsers reach the Hub: the web UI's origin, which serves the Hub's routes on the same
   * origin (the Vite dev server proxies them in development). GitHub redirects back here.
   */
  readonly publicUrl: URL
  readonly githubClientId: Option.Option<string>
  readonly githubClientSecret: Option.Option<Redacted.Redacted<string>>
  readonly githubAppId: Option.Option<string>
  /** The App's private key itself, PEM; the environment gives the path to it. */
  readonly githubAppPrivateKey: Option.Option<Redacted.Redacted<string>>
  /** GitHub's REST API, for the App: GitHubApiUrl unless a test points it elsewhere. */
  readonly githubApiUrl?: URL
  readonly devLogin: boolean
  /** Who dev login signs in as when the form names no one. */
  readonly devLoginName: string
  /** How long an Active Session may sit idle before it goes Asleep, in milliseconds. */
  readonly sleepAfterMs: number
  /** How long an Archived Session can be restored before it is purged, in milliseconds. */
  readonly archiveRetentionMs: number
  /** The key Sensitive variable values are encrypted with: 32 bytes, base64. */
  readonly secretsKey: Option.Option<Redacted.Redacted<string>>
}

/** How long an idle Session stays Active by default (GLOSSARY.md: Asleep). */
export const DefaultSleepAfter = Duration.minutes(15)

/** How long an Archived Session can be restored by default (ADR 0003). */
export const DefaultArchiveRetention = Duration.days(30)

// oxlint-disable-next-line unicorn/throw-new-error -- Effect makes error classes with a factory call
export class HubConfigError extends Schema.TaggedError<HubConfigError>()("HubConfigError", {
  message: Schema.String,
}) {}

/** How long a key for Sensitive values is, in bytes: AES-256. */
export const SecretsKeyBytes = 32

/** Reads a key for Sensitive values from base64 or base64url, or `undefined` if it isn't one. */
export function parseSecretsKey(text: string): Uint8Array | undefined {
  const trimmed = text.trim()
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) return undefined
  const bytes = Buffer.from(trimmed.replaceAll("-", "+").replaceAll("_", "/"), "base64")
  return bytes.length === SecretsKeyBytes ? new Uint8Array(bytes) : undefined
}

/** True for `localhost` and loopback IP addresses (127.0.0.0/8, ::1, and 127.x mapped to IPv6). */
export function isLoopback(host: string): boolean {
  const bare = host
    .replace(/^\[(.*)\]$/, "$1")
    .toLowerCase()
    .replace(/^::ffff:(?=127\.)/, "")
  return (
    bare === "localhost" ||
    bare === "::1" ||
    bare === "0:0:0:0:0:0:0:1" ||
    /^127(?:\.\d{1,3}){3}$/.test(bare)
  )
}

/** The Hub's configuration, checked. */
export class HubConfig extends Context.Service<
  HubConfig,
  {
    readonly host: string
    readonly port: number
    readonly publicUrl: URL
    /** GitHub sign-in, or none while the GitHub App isn't configured: sign-in is then off. */
    readonly github: Option.Option<GitHubOAuthConfig>
    /**
     * The GitHub App's credentials, or none (dev mode): the Runner then clones and pushes WIP
     * refs with its host's own credentials, and the Sandbox gets no GitHub token.
     */
    readonly githubApp: Option.Option<GitHubAppConfig>
    /** Dev login: sign in as a local Participant without GitHub. Loopback only. */
    readonly devLogin: Option.Option<{ readonly defaultName: string }>
    /** Cookies get `Secure` unless browsers reach the Hub on a loopback address over HTTP. */
    readonly secureCookies: boolean
    /**
     * How long an Active Session goes with no Turn running, no prompt queued and no
     * Participant present before it is put to sleep.
     */
    readonly sleepAfter: Duration.Duration
    /** How long an Archived Session can be restored before it is purged. */
    readonly archiveRetention: Duration.Duration
    /**
     * The key Sensitive variable values are encrypted with at rest (ADR 0009), or none: Sensitive
     * values can't then be saved, and the Hub refuses to start if any are stored.
     */
    readonly secretsKey: Option.Option<Redacted.Redacted<Uint8Array>>
  }
>()("@claude-hub/hub/HubConfig") {
  /** Checks the configuration; fails when it would expose dev login or half-configure GitHub. */
  static readonly make = Effect.fnUntraced(function* (input: HubConfigInput) {
    const { host, publicUrl } = input
    if (input.devLogin && !isLoopback(host)) {
      return yield* new HubConfigError({
        message: `Dev login (CLAUDE_HUB_DEV_LOGIN) is refused: the Hub is bound to ${host}, not a loopback address. Unset CLAUDE_HUB_DEV_LOGIN, or set HOST=127.0.0.1.`,
      })
    }
    if (input.devLogin && !isLoopback(publicUrl.hostname)) {
      return yield* new HubConfigError({
        message: `Dev login (CLAUDE_HUB_DEV_LOGIN) is refused: browsers reach the Hub at ${publicUrl.origin}, not a loopback address. Unset CLAUDE_HUB_DEV_LOGIN, or set HUB_PUBLIC_URL to a localhost URL.`,
      })
    }
    if (!Number.isSafeInteger(input.sleepAfterMs) || input.sleepAfterMs <= 0) {
      return yield* new HubConfigError({
        message: `HUB_SLEEP_AFTER_MS must be a whole number of milliseconds above 0, not ${input.sleepAfterMs}.`,
      })
    }
    if (!Number.isSafeInteger(input.archiveRetentionMs) || input.archiveRetentionMs <= 0) {
      return yield* new HubConfigError({
        message: `HUB_ARCHIVE_RETENTION_MS must be a whole number of milliseconds above 0, not ${input.archiveRetentionMs}.`,
      })
    }
    if (Option.isSome(input.githubClientId) !== Option.isSome(input.githubClientSecret)) {
      return yield* new HubConfigError({
        message:
          "GitHub sign-in needs both GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET; only one is set.",
      })
    }
    if (Option.isSome(input.githubAppId) !== Option.isSome(input.githubAppPrivateKey)) {
      return yield* new HubConfigError({
        message:
          "The GitHub App needs both GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH; only one is set.",
      })
    }
    if (Option.isSome(input.githubAppPrivateKey)) {
      const key = input.githubAppPrivateKey.value
      const parsed = yield* Effect.try({
        try: () => createPrivateKey(Redacted.value(key)),
        catch: () =>
          new HubConfigError({ message: "The GitHub App's private key is not a PEM key." }),
      })
      if (parsed.asymmetricKeyType !== "rsa") {
        return yield* new HubConfigError({
          message: "The GitHub App's private key is not an RSA key.",
        })
      }
    }
    let secretsKey = Option.none<Redacted.Redacted<Uint8Array>>()
    if (Option.isSome(input.secretsKey)) {
      const key = parseSecretsKey(Redacted.value(input.secretsKey.value))
      if (key === undefined) {
        return yield* new HubConfigError({
          message: `HUB_SECRETS_KEY must be ${SecretsKeyBytes} random bytes in base64, as \`bun run secrets-key\` prints.`,
        })
      }
      secretsKey = Option.some(Redacted.make(key))
    }
    return HubConfig.of({
      host,
      port: input.port,
      publicUrl,
      github: Option.zipWith(
        input.githubClientId,
        input.githubClientSecret,
        (clientId, clientSecret) => ({ clientId, clientSecret }),
      ),
      githubApp: Option.zipWith(
        input.githubAppId,
        input.githubAppPrivateKey,
        (appId, privateKey) => ({ appId, privateKey, apiUrl: input.githubApiUrl ?? GitHubApiUrl }),
      ),
      devLogin: input.devLogin ? Option.some({ defaultName: input.devLoginName }) : Option.none(),
      secureCookies: publicUrl.protocol === "https:" || !isLoopback(publicUrl.hostname),
      sleepAfter: Duration.millis(input.sleepAfterMs),
      archiveRetention: Duration.millis(input.archiveRetentionMs),
      secretsKey,
    })
  })

  /**
   * From the environment: `HOST` (127.0.0.1), `PORT` (7777), `HUB_PUBLIC_URL`
   * (http://localhost:5173), `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` (unset: GitHub sign-in
   * off), `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` (unset: the Runner uses its host's
   * git credentials, and the Sandbox gets no GitHub token), `CLAUDE_HUB_DEV_LOGIN` (off), `CLAUDE_HUB_DEV_USER` (`$USER`), `HUB_SLEEP_AFTER_MS`
   * (15 minutes), `HUB_ARCHIVE_RETENTION_MS` (30 days) and `HUB_SECRETS_KEY` (unset: Sensitive
   * values can't be saved).
   */
  static readonly layer = Layer.effect(
    HubConfig,
    Effect.gen(function* () {
      const keyPath = yield* Config.option(Config.NonEmptyString("GITHUB_APP_PRIVATE_KEY_PATH"))
      const githubAppPrivateKey = Option.isNone(keyPath)
        ? Option.none<Redacted.Redacted<string>>()
        : yield* Effect.tryPromise({
            try: () => readFile(keyPath.value, "utf8"),
            catch: () =>
              new HubConfigError({
                message: `Could not read the GitHub App's private key at ${keyPath.value} (GITHUB_APP_PRIVATE_KEY_PATH).`,
              }),
          }).pipe(Effect.map((pem) => Option.some(Redacted.make(pem))))
      const input = yield* Config.all({
        host: Config.String("HOST").pipe(Config.withDefault("127.0.0.1")),
        port: Config.Port("PORT").pipe(Config.withDefault(7777)),
        publicUrl: Config.URL("HUB_PUBLIC_URL").pipe(
          Config.withDefault(new URL("http://localhost:5173")),
        ),
        githubClientId: Config.option(Config.NonEmptyString("GITHUB_CLIENT_ID")),
        githubClientSecret: Config.option(Config.Redacted("GITHUB_CLIENT_SECRET")),
        githubAppId: Config.option(Config.NonEmptyString("GITHUB_APP_ID")),
        devLogin: Config.Boolean("CLAUDE_HUB_DEV_LOGIN").pipe(Config.withDefault(false)),
        devLoginName: Config.String("CLAUDE_HUB_DEV_USER").pipe(
          Config.orElse(() => Config.String("USER")),
          Config.withDefault("dev"),
        ),
        sleepAfterMs: Config.Int("HUB_SLEEP_AFTER_MS").pipe(
          Config.withDefault(Duration.toMillis(DefaultSleepAfter)),
        ),
        archiveRetentionMs: Config.Int("HUB_ARCHIVE_RETENTION_MS").pipe(
          Config.withDefault(Duration.toMillis(DefaultArchiveRetention)),
        ),
        secretsKey: Config.option(Config.Redacted("HUB_SECRETS_KEY")),
      })
      return yield* HubConfig.make({ ...input, githubAppPrivateKey })
    }),
  )

  /** A checked configuration, for tests. */
  static readonly layerFrom = (input: HubConfigInput) =>
    Layer.effect(HubConfig, HubConfig.make(input))
}
