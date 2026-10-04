import { createPrivateKey } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
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
  /** Drop `Secure` from cookies when browsers reach the Hub over plain HTTP on a non-loopback host. */
  readonly insecureCookies: boolean
  /** Who dev login signs in as when the form names no one. */
  readonly devLoginName: string
  /** How long an Active Session may sit idle before it goes Asleep, in milliseconds. */
  readonly sleepAfterMs: number
  /** How long an Archived Session can be restored before it is purged, in milliseconds. */
  readonly archiveRetentionMs: number
  /** How long the Hub trusts what GitHub said about a person's access to a Repo, in milliseconds. */
  readonly repoAccessTtlMs: number
  /** The key Sensitive variable values are encrypted with: 32 bytes, base64. */
  readonly secretsKey: Option.Option<Redacted.Redacted<string>>
  /** The web UI's build: the directory holding its `index.html`. */
  readonly webDir: string
}

/**
 * Where the Hub finds the web UI's build by default: `packages/web/dist` in this checkout, which
 * `bun run web:build` writes.
 */
export const DefaultWebDir = fileURLToPath(new URL("../../web/dist", import.meta.url))

/** How long an idle Session stays Active by default (GLOSSARY.md: Asleep). */
export const DefaultSleepAfter = Duration.minutes(15)

/** How long an Archived Session can be restored by default (ADR 0003). */
export const DefaultArchiveRetention = Duration.days(30)

/**
 * How long the Hub trusts an answer about a person's access to a Repo by default (RepoAccess.ts).
 * It bounds how long someone keeps a Repo's Sessions after losing access on GitHub, and each
 * check is a call to GitHub's API, against the App installation's rate limit of 5,000 an hour or
 * more: five minutes keeps a team of 15 with Sessions in 10 Repos under 2,000 an hour.
 */
export const DefaultRepoAccessTtl = Duration.minutes(5)

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

/**
 * Whether cookies get `Secure`, and what to warn about at startup. Browsers drop a Secure cookie
 * set over plain HTTP, except on loopback, so a Hub reached at `http://192.168.x.x` can't sign
 * anyone in unless `insecure` (HUB_INSECURE_COOKIES) drops `Secure`. That never weakens an HTTPS
 * Hub. No cookie takes a `__Host-` or `__Secure-` prefix, which browsers refuse without `Secure`.
 */
export function cookieSecurity(
  publicUrl: URL,
  insecure: boolean,
): { readonly secure: boolean; readonly warning: Option.Option<string> } {
  const https = publicUrl.protocol === "https:"
  const loopback = isLoopback(publicUrl.hostname)
  if (insecure) {
    return {
      secure: https,
      warning: Option.some(
        https
          ? `HUB_INSECURE_COOKIES is set but does nothing: browsers reach the Hub over HTTPS (${publicUrl.origin}), so its cookies stay Secure. Unset it.`
          : `INSECURE COOKIES (HUB_INSECURE_COOKIES): the Hub's cookies are not Secure, so sign-in tokens travel in cleartext to ${publicUrl.origin}. Anyone who can watch that network can take over a sign-in. Only use it on a network you trust, and prefer HTTPS, an SSH tunnel or Tailscale.`,
      ),
    }
  }
  if (!https && !loopback) {
    return {
      secure: true,
      warning: Option.some(
        `Browsers reach the Hub over plain HTTP at ${publicUrl.origin} (HUB_PUBLIC_URL), so they will drop its Secure cookies and sign-in will fail. Serve it over HTTPS, reach it through an SSH tunnel to localhost or over Tailscale HTTPS, or, on a network you trust, set HUB_INSECURE_COOKIES=1.`,
      ),
    }
  }
  return { secure: https, warning: Option.none() }
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
    /**
     * Cookies get `Secure` unless browsers reach the Hub on a loopback address over HTTP, or over
     * HTTP with HUB_INSECURE_COOKIES set.
     */
    readonly secureCookies: boolean
    /** What to warn about the cookies at startup, or none: see `cookieSecurity`. */
    readonly cookieWarning: Option.Option<string>
    /**
     * How long an Active Session goes with no Turn running, no prompt queued and no
     * Participant present before it is put to sleep.
     */
    readonly sleepAfter: Duration.Duration
    /** How long an Archived Session can be restored before it is purged. */
    readonly archiveRetention: Duration.Duration
    /**
     * How long an answer about a person's access to a Repo is cached, and how often the Repos of
     * everyone connected are checked again (RepoAccess.ts).
     */
    readonly repoAccessTtl: Duration.Duration
    /**
     * The key Sensitive variable values are encrypted with at rest (ADR 0009), or none: Sensitive
     * values can't then be saved, and the Hub refuses to start if any are stored.
     */
    readonly secretsKey: Option.Option<Redacted.Redacted<Uint8Array>>
    /** The web UI's build, which the Hub serves (WebUi.ts). It may not exist. */
    readonly webDir: string
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
    if (!Number.isSafeInteger(input.repoAccessTtlMs) || input.repoAccessTtlMs <= 0) {
      return yield* new HubConfigError({
        message: `HUB_REPO_ACCESS_TTL_MS must be a whole number of milliseconds above 0, not ${input.repoAccessTtlMs}.`,
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
    const cookies = cookieSecurity(publicUrl, input.insecureCookies)
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
      secureCookies: cookies.secure,
      cookieWarning: cookies.warning,
      sleepAfter: Duration.millis(input.sleepAfterMs),
      archiveRetention: Duration.millis(input.archiveRetentionMs),
      repoAccessTtl: Duration.millis(input.repoAccessTtlMs),
      secretsKey,
      webDir: input.webDir,
    })
  })

  /**
   * From the environment: `HOST` (127.0.0.1), `PORT` (7777), `HUB_PUBLIC_URL`
   * (http://localhost:5173), `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` (unset: GitHub sign-in
   * off), `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_PATH` (unset: the Runner uses its host's
   * git credentials, and the Sandbox gets no GitHub token), `CLAUDE_HUB_DEV_LOGIN` (off), `CLAUDE_HUB_DEV_USER` (`$USER`), `HUB_INSECURE_COOKIES` (off), `HUB_SLEEP_AFTER_MS`
   * (15 minutes), `HUB_ARCHIVE_RETENTION_MS` (30 days), `HUB_REPO_ACCESS_TTL_MS` (5 minutes),
   * `HUB_SECRETS_KEY` (unset: Sensitive values can't be saved) and `HUB_WEB_DIR` (DefaultWebDir).
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
        insecureCookies: Config.Boolean("HUB_INSECURE_COOKIES").pipe(Config.withDefault(false)),
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
        repoAccessTtlMs: Config.Int("HUB_REPO_ACCESS_TTL_MS").pipe(
          Config.withDefault(Duration.toMillis(DefaultRepoAccessTtl)),
        ),
        secretsKey: Config.option(Config.Redacted("HUB_SECRETS_KEY")),
        webDir: Config.NonEmptyString("HUB_WEB_DIR").pipe(Config.withDefault(DefaultWebDir)),
      })
      return yield* HubConfig.make({ ...input, githubAppPrivateKey })
    }),
  )

  /** A checked configuration, for tests. */
  static readonly layerFrom = (input: HubConfigInput) =>
    Layer.effect(HubConfig, HubConfig.make(input))
}
