// The GitHub App (ADR 0010): the Hub, and only the Hub, holds the App's private key. It signs a
// short JWT with it and mints installation tokens scoped to one Repo: one with `contents:write`
// that Runners hand to host git per command for the clone and WIP pushes, and one per Session
// with every permission the installation has, which the Runner keeps in the Session's Sandbox
// for `git` and `gh`. As the installation, it also answers who has access to a Repo
// (RepoAccess.ts).

import { createPrivateKey, type KeyObject, sign } from "node:crypto"
import type { GitIdentity, RepoName } from "@claude-hub/protocol"
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
  /** The HTTP status GitHub answered with, when it answered. */
  status: Schema.optional(Schema.Int),
}) {}

/** An installation token for one Repo. */
export interface RepoToken {
  readonly token: Redacted.Redacted<string>
  readonly expiresAt: number
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
    /**
     * A fresh installation token for a Session's Sandbox: scoped to the Repo, with no permissions
     * list, so it has every permission the App's installation has. Never cached or shared, so
     * each Session's token is its own.
     */
    readonly sandboxToken: (repo: RepoName) => Effect.Effect<RepoToken, GitHubAppError>
    /**
     * Whether the GitHub account `login` is a collaborator on the Repo: an outside collaborator,
     * an organization member with access through a team or the organization's base permission,
     * or an owner. Asked as the Repo's installation, which needs only the Metadata permission
     * every App has. Fails with status 404 when the App isn't installed on the Repo.
     */
    readonly isCollaborator: (
      repo: RepoName,
      login: string,
    ) => Effect.Effect<boolean, GitHubAppError>
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

  /** Without the App's credentials: host git falls back to the host's own, the Sandbox gets none. */
  static readonly unconfigured = GitHubApp.of({
    isConfigured: false,
    repoToken: () => Effect.fail(notConfigured),
    botIdentity: () => Effect.fail(notConfigured),
    sandboxToken: () => Effect.fail(notConfigured),
    isCollaborator: () => Effect.fail(notConfigured),
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
            status: response.status,
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

    /** Mints a token for the Repo only; with `permissions`, only those, else the installation's. */
    const mint = Effect.fn("GitHubApp.mint")(function* (
      repo: RepoName,
      permissions?: Readonly<Record<string, string>>,
    ) {
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
            HttpClientRequest.bodyJsonUnsafe(
              permissions === undefined
                ? { repositories: [name] }
                : { repositories: [name], permissions },
            ),
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
          const fresh = yield* mint(repo, { contents: "write" })
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

    const sandboxToken = Effect.fn("GitHubApp.sandboxToken")(function* (repo: RepoName) {
      return yield* mint(repo)
    })

    const isCollaborator = Effect.fn("GitHubApp.isCollaborator")(
      function* (repo: RepoName, login: string) {
        const { owner, name } = splitRepo(repo)
        const { token } = yield* repoToken(repo)
        const response = yield* http.execute(
          yield* request(
            "GET",
            `/repos/${owner}/${name}/collaborators/${encodeURIComponent(login)}`,
            { token },
          ),
        )
        // 204 for a collaborator; 404 for anyone else, a public Repo's other readers included.
        if (response.status === 204) return true
        if (response.status === 404) return false
        return yield* new GitHubAppError({
          message: `Could not check ${login}'s access to ${repo}: GitHub answered ${response.status}${apiMessage(yield* response.text)}`,
          status: response.status,
        })
      },
      Effect.catchTag("HttpClientError", (error) =>
        Effect.fail(new GitHubAppError({ message: `Could not check access: ${error.message}` })),
      ),
    )

    return GitHubApp.of({
      isConfigured: true,
      repoToken,
      botIdentity,
      sandboxToken,
      isCollaborator,
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
