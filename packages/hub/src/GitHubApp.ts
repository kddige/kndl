// The GitHub App as the git tools use it (issue #13, ADR 0005): the Hub, and only the Hub, holds
// the App's private key. It signs a short JWT with it, mints installation tokens scoped to one
// Repo with `contents:write` and `pull_requests:write`, and calls GitHub's pull request API with
// them. Runners get the tokens over their WebSocket and hand them to git per command.

import { createPrivateKey, type KeyObject, sign } from "node:crypto"
import type { GitIdentity, RepoName, ReviewEvent } from "@claude-hub/protocol"
import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
  Semaphore,
} from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { type GitHubAppConfig, HubConfig } from "./HubConfig.ts"

// oxlint-disable-next-line unicorn/throw-new-error -- Effect makes error classes with a factory call
export class GitHubAppError extends Schema.TaggedError<GitHubAppError>()("GitHubAppError", {
  message: Schema.String,
}) {}

/** An installation token for one Repo. */
export interface RepoToken {
  readonly token: Redacted.Redacted<string>
  readonly expiresAt: number
}

/** A pull request, as the git tools report it. */
export interface PullRequest {
  readonly number: number
  readonly url: string
  /** True when it was already open, rather than opened now. */
  readonly existing: boolean
}

/** How long before it expires a cached token is replaced. */
export const tokenRefreshMargin = Duration.minutes(5)

/** The App JWT's lifetime: GitHub allows at most 10 minutes. */
const jwtLifetimeSeconds = 9 * 60
/** How far back the JWT's `iat` is set, for clock drift, as GitHub recommends. */
const jwtBackdateSeconds = 60

const base64url = (data: string | Buffer) => Buffer.from(data).toString("base64url")

/** An RS256 App JWT, as GitHub asks for to act as the App. */
export function appJwt(options: {
  readonly appId: string
  readonly key: KeyObject
  readonly nowMs: number
}): string {
  const now = Math.floor(options.nowMs / 1000)
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const payload = base64url(
    JSON.stringify({
      iat: now - jwtBackdateSeconds,
      exp: now + jwtLifetimeSeconds,
      iss: options.appId,
    }),
  )
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), options.key)
  return `${header}.${payload}.${base64url(signature)}`
}

/** Splits `owner/name`. */
const splitRepo = (repo: RepoName) => {
  const [owner = "", name = ""] = repo.split("/")
  return { owner, name }
}

const Installation = Schema.Struct({ id: Schema.Int })
const AccessToken = Schema.Struct({ token: Schema.NonEmptyString, expires_at: Schema.String })
const App = Schema.Struct({ slug: Schema.NonEmptyString })
const User = Schema.Struct({ id: Schema.Int })
const Pull = Schema.Struct({ number: Schema.Int, html_url: Schema.String })
const Pulls = Schema.Array(Pull)
const Review = Schema.Struct({ html_url: Schema.String })
const ApiError = Schema.Struct({
  message: Schema.optional(Schema.String),
  errors: Schema.optional(
    Schema.Array(
      Schema.Union([Schema.String, Schema.Struct({ message: Schema.optional(Schema.String) })]),
    ),
  ),
})

export class GitHubApp extends Context.Service<
  GitHubApp,
  {
    /** Whether the App's credentials are configured; without them, the dev fallback. */
    readonly isConfigured: boolean
    /** An installation token for the Repo only, cached until shortly before it expires. */
    readonly repoToken: (repo: RepoName) => Effect.Effect<RepoToken, GitHubAppError>
    /** The App's bot, which commits made through the App are authored by. */
    readonly botIdentity: (repo: RepoName) => Effect.Effect<GitIdentity, GitHubAppError>
    /** Opens a pull request from `head` into `base`, or finds the one open already. */
    readonly openPullRequest: (options: {
      readonly repo: RepoName
      readonly head: string
      readonly base: string
      readonly title: string
      readonly body: string
      readonly draft: boolean
    }) => Effect.Effect<PullRequest, GitHubAppError>
    /** Posts a review on a pull request; answers with its URL. */
    readonly reviewPullRequest: (options: {
      readonly repo: RepoName
      readonly number: number
      readonly body: string
      readonly event: ReviewEvent
    }) => Effect.Effect<string, GitHubAppError>
  }
>()("@claude-hub/hub/GitHubApp") {
  /** The App from `HubConfig.githubApp`; when that is none, every call fails, saying so. */
  static readonly layer = Layer.effect(
    GitHubApp,
    Effect.gen(function* () {
      const { githubApp } = yield* HubConfig
      if (Option.isNone(githubApp)) return GitHubApp.unconfigured
      return yield* GitHubApp.make(githubApp.value)
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer))

  /** Without the App's credentials: the git tools fall back to the host's own git credentials. */
  static readonly unconfigured = GitHubApp.of({
    isConfigured: false,
    repoToken: () => Effect.fail(notConfigured),
    botIdentity: () => Effect.fail(notConfigured),
    openPullRequest: () => Effect.fail(notConfigured),
    reviewPullRequest: () => Effect.fail(notConfigured),
  })

  static readonly make = Effect.fnUntraced(function* (config: GitHubAppConfig) {
    const key = createPrivateKey(Redacted.value(config.privateKey))
    const http = yield* HttpClient.HttpClient
    const tokens = new Map<RepoName, RepoToken>()
    const minting = yield* Semaphore.make(1)
    let bot: GitIdentity | undefined

    /** A request to the API, as the App (`jwt`) or an installation (`token`). */
    const request = (
      method: "GET" | "POST",
      path: string,
      auth: { readonly jwt: true } | { readonly token: Redacted.Redacted<string> },
    ) =>
      Effect.map(Clock.currentTimeMillis, (nowMs) =>
        HttpClientRequest.make(method)(
          new URL(path.replace(/^\//, ""), withSlash(config.apiUrl)),
        ).pipe(
          HttpClientRequest.bearerToken(
            "jwt" in auth
              ? appJwt({ appId: config.appId, key, nowMs })
              : Redacted.value(auth.token),
          ),
          HttpClientRequest.accept("application/vnd.github+json"),
          HttpClientRequest.setHeader("x-github-api-version", "2022-11-28"),
          HttpClientRequest.setHeader("user-agent", "claude-hub"),
        ),
      )

    /** Sends the request and decodes a 2xx answer; any other is a GitHubAppError with GitHub's words. */
    const call = <A, I>(
      what: string,
      schema: Schema.Codec<A, I>,
      made: Effect.Effect<HttpClientRequest.HttpClientRequest>,
    ) =>
      Effect.gen(function* () {
        const response = yield* http.execute(yield* made)
        const text = yield* response.text
        if (response.status < 200 || response.status >= 300) {
          return yield* new GitHubAppError({
            message: `${what}: GitHub answered ${response.status}${apiMessage(text)}`,
          })
        }
        return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text)
      }).pipe(
        Effect.catchTags({
          HttpClientError: (error) =>
            Effect.fail(new GitHubAppError({ message: `${what}: ${error.message}` })),
          SchemaError: () =>
            Effect.fail(
              new GitHubAppError({ message: `${what}: GitHub sent an unexpected answer` }),
            ),
        }),
      )

    const mint = Effect.fn("GitHubApp.mint")(function* (repo: RepoName) {
      const { owner, name } = splitRepo(repo)
      const installation = yield* call(
        `The GitHub App is not installed on ${repo}, or can't see it`,
        Installation,
        request("GET", `/repos/${owner}/${name}/installation`, { jwt: true }),
      )
      const minted = yield* call(
        `Could not get a token for ${repo}`,
        AccessToken,
        request("POST", `/app/installations/${installation.id}/access_tokens`, { jwt: true }).pipe(
          Effect.map(
            HttpClientRequest.bodyJsonUnsafe({
              repositories: [name],
              permissions: { contents: "write", pull_requests: "write" },
            }),
          ),
        ),
      )
      const expiresAt = Date.parse(minted.expires_at)
      if (Number.isNaN(expiresAt)) {
        return yield* new GitHubAppError({ message: "GitHub sent a token with no valid expiry" })
      }
      return { token: Redacted.make(minted.token), expiresAt }
    })

    const repoToken = Effect.fn("GitHubApp.repoToken")(function* (repo: RepoName) {
      return yield* minting.withPermits(1)(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const cached = tokens.get(repo)
          if (
            cached !== undefined &&
            cached.expiresAt - Duration.toMillis(tokenRefreshMargin) > now
          ) {
            return cached
          }
          const fresh = yield* mint(repo)
          tokens.set(repo, fresh)
          return fresh
        }),
      )
    })

    const botIdentity = Effect.fn("GitHubApp.botIdentity")(function* (repo: RepoName) {
      if (bot !== undefined) return bot
      const app = yield* call(
        "Could not look up the GitHub App",
        App,
        request("GET", "/app", { jwt: true }),
      )
      const login = `${app.slug}[bot]`
      const { token } = yield* repoToken(repo)
      const user = yield* call(
        `Could not look up ${login}`,
        User,
        request("GET", `/users/${encodeURIComponent(login)}`, { token }),
      )
      bot = { name: login, email: `${user.id}+${login}@users.noreply.github.com` }
      return bot
    })

    const openPullRequest = Effect.fn("GitHubApp.openPullRequest")(function* (options: {
      readonly repo: RepoName
      readonly head: string
      readonly base: string
      readonly title: string
      readonly body: string
      readonly draft: boolean
    }) {
      const { owner, name } = splitRepo(options.repo)
      const { token } = yield* repoToken(options.repo)
      const open = yield* call(
        "Could not list pull requests",
        Pulls,
        request("GET", `/repos/${owner}/${name}/pulls`, { token }).pipe(
          Effect.map(
            HttpClientRequest.setUrlParams({
              head: `${owner}:${options.head}`,
              base: options.base,
              state: "open",
            }),
          ),
        ),
      )
      const [found] = open
      if (found !== undefined) return { number: found.number, url: found.html_url, existing: true }
      const opened = yield* call(
        "Could not open the pull request",
        Pull,
        request("POST", `/repos/${owner}/${name}/pulls`, { token }).pipe(
          Effect.map(
            HttpClientRequest.bodyJsonUnsafe({
              title: options.title,
              body: options.body,
              head: options.head,
              base: options.base,
              draft: options.draft,
            }),
          ),
        ),
      )
      return { number: opened.number, url: opened.html_url, existing: false }
    })

    const reviewPullRequest = Effect.fn("GitHubApp.reviewPullRequest")(function* (options: {
      readonly repo: RepoName
      readonly number: number
      readonly body: string
      readonly event: ReviewEvent
    }) {
      const { owner, name } = splitRepo(options.repo)
      const { token } = yield* repoToken(options.repo)
      const review = yield* call(
        `Could not review pull request #${options.number}`,
        Review,
        request("POST", `/repos/${owner}/${name}/pulls/${options.number}/reviews`, { token }).pipe(
          Effect.map(
            HttpClientRequest.bodyJsonUnsafe({ body: options.body, event: options.event }),
          ),
        ),
      )
      return review.html_url
    })

    return GitHubApp.of({
      isConfigured: true,
      repoToken,
      botIdentity,
      openPullRequest,
      reviewPullRequest,
    })
  })
}

const notConfigured = new GitHubAppError({
  message:
    "This needs the GitHub App, which the Hub doesn't have: set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH on the Hub.",
})

const withSlash = (url: URL) => (url.href.endsWith("/") ? url.href : `${url.href}/`)

/** GitHub's own explanation from an error body, as `: …`, or nothing. */
function apiMessage(text: string): string {
  try {
    const body = Schema.decodeUnknownSync(ApiError)(JSON.parse(text))
    const details = (body.errors ?? [])
      .map((error) => (typeof error === "string" ? error : error.message))
      .filter((message): message is string => message !== undefined && message !== "")
    const parts = [body.message, ...details].filter((part) => part !== undefined && part !== "")
    return parts.length === 0 ? "" : `: ${parts.join("; ")}`
  } catch {
    return ""
  }
}
