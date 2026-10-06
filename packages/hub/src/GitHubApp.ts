// The GitHub App (ADR 0010): the Hub, and only the Hub, holds the App's private key. It signs a
// short JWT with it and mints installation tokens scoped to one Repo: one with `contents:write`
// that Runners hand to host git per command for the clone and WIP pushes, and one per Session
// with every permission the installation has, which the Runner keeps in the Session's Sandbox
// for `git` and `gh`. As the installation, it also answers who has access to a Repo
// (RepoAccess.ts). As the App, it reads its own permissions and its installations', to check them
// against what the Hub needs (AppPermissions.ts).
//
// It also makes the App in the first place: `claude-hub onboard` registers it on GitHub from a
// manifest, and trades the code GitHub hands back for its credentials (convertManifest).

import { createPrivateKey, type KeyObject, sign } from "node:crypto"
import { type AppPermissionsCheck, type GitIdentity, RepoName, repoKey } from "@claude-hub/protocol"
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
import {
  type AppFacts,
  appInstallUrl,
  checkAppPermissions,
  type InstallationFacts,
} from "./AppPermissions.ts"
import { type GitHubAppConfig, GitHubApiUrl, HubConfig } from "./HubConfig.ts"

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

/** A GitHub account's noreply address, which GitHub ties commits to that account by. */
export const noreplyEmail = (userId: number | string, login: string) =>
  `${userId}+${login}@users.noreply.github.com`

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

const Grants = Schema.Record(Schema.String, Schema.String)
/** `GET /repos/{owner}/{repo}/installation`: which installation, and what it was granted. */
const Installation = Schema.Struct({ id: Schema.Int, permissions: Schema.optional(Grants) })
const AccessToken = Schema.Struct({ token: Schema.NonEmptyString, expires_at: Schema.String })
/** `GET /repos/{owner}/{repo}`, as far as the Hub reads it: the Repo's name as GitHub spells it. */
const Repository = Schema.Struct({ full_name: RepoName })
const App = Schema.Struct({ slug: Schema.NonEmptyString, html_url: Schema.String })
/** `GET /app`, as the permission check reads it. An enterprise's App has no owner login. */
const AppDetails = Schema.Struct({
  slug: Schema.NonEmptyString,
  html_url: Schema.String,
  owner: Schema.NullOr(
    Schema.Struct({ login: Schema.optional(Schema.String), type: Schema.optional(Schema.String) }),
  ),
  permissions: Grants,
  events: Schema.Array(Schema.String),
})
/** One of `GET /app/installations`. An enterprise's account has a name, not a login. */
const InstallationDetails = Schema.Struct({
  id: Schema.Int,
  account: Schema.NullOr(
    Schema.Struct({ login: Schema.optional(Schema.String), name: Schema.optional(Schema.String) }),
  ),
  html_url: Schema.String,
  target_type: Schema.optional(Schema.String),
  permissions: Grants,
  events: Schema.Array(Schema.String),
  suspended_at: Schema.optional(Schema.NullOr(Schema.String)),
})
/**
 * What the Hub's own token for a Repo may do: push its WIP refs and branches and, where the
 * installation has it, read the organization's members. Without that, GitHub leaves out of a
 * Repo's collaborators everyone with access through its organization (owners, the base
 * permission, teams), so `isCollaborator` says no to them (#189). Asked for only where granted,
 * since GitHub refuses a token a permission its installation lacks, as on a personal account.
 */
export const hostTokenPermissions = (
  granted: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> =>
  granted.members === undefined ? { contents: "write" } : { contents: "write", members: "read" }

/** The most installations GitHub lists on one page. */
const installationsPerPage = 100

const notConfigured = new GitHubAppError({
  message:
    "This needs the GitHub App, which the Hub doesn't have: set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH on the Hub.",
})
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
     * A fresh installation token for a Test build's clone (#104): scoped to the Repo, with
     * `contents:read` only. Never cached: the Runner hands it to git for the one clone.
     */
    readonly cloneToken: (repo: RepoName) => Effect.Effect<RepoToken, GitHubAppError>
    /**
     * The Repo's name as GitHub spells it, its `full_name`, whatever spelling it was asked by:
     * GitHub's names ignore case (#197). Asked as the Repo's installation, so it fails, with
     * status 404, where the App isn't installed.
     */
    readonly fullName: (repo: RepoName) => Effect.Effect<RepoName, GitHubAppError>
    /**
     * Whether the App is installed on the Repo and can see it, asked as the App. A Repo that
     * doesn't exist, or that the App can't see, is not installed.
     */
    readonly isInstalled: (repo: RepoName) => Effect.Effect<boolean, GitHubAppError>
    /** Where to install the App on another account or Repo, from its `html_url`; kept once read. */
    readonly installUrl: Effect.Effect<string, GitHubAppError>
    /**
     * Whether the GitHub account `login` is a collaborator on the Repo: an outside collaborator,
     * an organization member with access through a team or the organization's base permission,
     * or an owner. Asked as the Repo's installation, with the Metadata permission every App has;
     * on an organization, GitHub counts access through it only with Members (read) as well
     * (`hostTokenPermissions`). Fails with status 404 when the App isn't installed on the Repo.
     */
    readonly isCollaborator: (
      repo: RepoName,
      login: string,
    ) => Effect.Effect<boolean, GitHubAppError>
    /**
     * The App's permissions and events, and each installation's, against those the Hub needs
     * (AppPermissions.ts): `GET /app`, and every page of `GET /app/installations`.
     */
    readonly checkPermissions: Effect.Effect<AppPermissionsCheck, GitHubAppError>
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
    cloneToken: () => Effect.fail(notConfigured),
    fullName: () => Effect.fail(notConfigured),
    isInstalled: () => Effect.fail(notConfigured),
    installUrl: Effect.fail(notConfigured),
    isCollaborator: () => Effect.fail(notConfigured),
    checkPermissions: Effect.fail(notConfigured),
  })

  static readonly make = Effect.fnUntraced(function* (config: GitHubAppConfig) {
    const key = createPrivateKey(Redacted.value(config.privateKey))
    const http = yield* HttpClient.HttpClient
    // By `repoKey`, so every spelling of a Repo shares its token.
    const tokens = new Map<string, RepoToken>()
    const minting = yield* Semaphore.make(1)
    let bot: GitIdentity | undefined
    let appHtmlUrl: string | undefined

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

    const call = <A, I>(
      what: string,
      schema: Schema.Codec<A, I>,
      made: Effect.Effect<HttpClientRequest.HttpClientRequest>,
    ) => Effect.flatMap(made, (built) => callWith(http, what, schema, built))

    /**
     * Mints a token for the Repo only; with `scoped`, only those permissions, else the
     * installation's. `scoped` may pick them from what the installation was granted.
     */
    const mint = Effect.fn("GitHubApp.mint")(function* (
      repo: RepoName,
      scoped?:
        | Readonly<Record<string, string>>
        | ((granted: Readonly<Record<string, string>>) => Readonly<Record<string, string>>),
    ) {
      const { owner, name } = splitRepo(repo)
      const installation = yield* call(
        `The GitHub App is not installed on ${repo}, or can't see it`,
        Installation,
        request("GET", `/repos/${owner}/${name}/installation`, { jwt: true }),
      )
      const permissions =
        typeof scoped === "function" ? scoped(installation.permissions ?? {}) : scoped
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
          const cached = tokens.get(repoKey(repo))
          if (
            cached !== undefined &&
            cached.expiresAt - Duration.toMillis(tokenRefreshMargin) > now
          ) {
            return cached
          }
          const fresh = yield* mint(repo, hostTokenPermissions)
          tokens.set(repoKey(repo), fresh)
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
      bot = { name: login, email: noreplyEmail(user.id, login) }
      return bot
    })

    const sandboxToken = Effect.fn("GitHubApp.sandboxToken")(function* (repo: RepoName) {
      return yield* mint(repo)
    })

    const cloneToken = Effect.fn("GitHubApp.cloneToken")(function* (repo: RepoName) {
      return yield* mint(repo, { contents: "read" })
    })

    const fullName = Effect.fn("GitHubApp.fullName")(function* (repo: RepoName) {
      const { owner, name } = splitRepo(repo)
      const { token } = yield* repoToken(repo)
      const found = yield* call(
        `Could not look up ${repo}`,
        Repository,
        request("GET", `/repos/${owner}/${name}`, { token }),
      )
      return found.full_name
    })

    const isInstalled = Effect.fn("GitHubApp.isInstalled")(
      function* (repo: RepoName) {
        const { owner, name } = splitRepo(repo)
        const response = yield* http.execute(
          yield* request("GET", `/repos/${owner}/${name}/installation`, { jwt: true }),
        )
        if (response.status === 200) return true
        if (response.status === 404) return false
        return yield* new GitHubAppError({
          message: `Could not check whether the GitHub App is installed on ${repo}: GitHub answered ${response.status}${apiMessage(yield* response.text)}`,
          status: response.status,
        })
      },
      Effect.catchTag("HttpClientError", (error) =>
        Effect.fail(
          new GitHubAppError({
            message: `Could not check where the GitHub App is installed: ${error.message}`,
          }),
        ),
      ),
    )

    const installUrl = Effect.suspend(() =>
      appHtmlUrl === undefined
        ? call("Could not look up the GitHub App", App, request("GET", "/app", { jwt: true })).pipe(
            Effect.map((app) => {
              appHtmlUrl = app.html_url
              return appHtmlUrl
            }),
          )
        : Effect.succeed(appHtmlUrl),
    ).pipe(Effect.map((htmlUrl) => appInstallUrl({ htmlUrl })))

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

    const checkPermissions = Effect.gen(function* () {
      const app = yield* call(
        "Could not read the GitHub App's permissions",
        AppDetails,
        request("GET", "/app", { jwt: true }),
      )
      const installations: Array<InstallationFacts> = []
      for (let page = 1; ; page++) {
        const listed = yield* call(
          "Could not list the GitHub App's installations",
          Schema.Array(InstallationDetails),
          request("GET", `/app/installations?per_page=${installationsPerPage}&page=${page}`, {
            jwt: true,
          }),
        )
        for (const installation of listed) {
          installations.push({
            id: installation.id,
            account:
              installation.account?.login ??
              installation.account?.name ??
              `installation ${installation.id}`,
            htmlUrl: installation.html_url,
            permissions: installation.permissions,
            events: installation.events,
            suspended: installation.suspended_at != null,
            organization: installation.target_type === "Organization",
          })
        }
        if (listed.length < installationsPerPage) break
      }
      const facts: AppFacts = {
        slug: app.slug,
        htmlUrl: app.html_url,
        owner: { login: app.owner?.login ?? "", type: app.owner?.type ?? "User" },
        permissions: app.permissions,
        events: app.events,
      }
      return checkAppPermissions(facts, installations, yield* Clock.currentTimeMillis)
    }).pipe(Effect.withSpan("GitHubApp.checkPermissions"))

    return GitHubApp.of({
      isConfigured: true,
      repoToken,
      botIdentity,
      sandboxToken,
      cloneToken,
      fullName,
      isInstalled,
      installUrl,
      isCollaborator,
      checkPermissions,
    })
  })
}

/** Sends `request` and decodes a 2xx answer; any other is a GitHubAppError with GitHub's words. */
const callWith = <A, I>(
  http: HttpClient.HttpClient,
  what: string,
  schema: Schema.Codec<A, I>,
  request: HttpClientRequest.HttpClientRequest,
) =>
  Effect.gen(function* () {
    const response = yield* http.execute(request)
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
        Effect.fail(new GitHubAppError({ message: `${what}: GitHub sent an unexpected answer` })),
    }),
  )

/** What GitHub hands back for a manifest's code: the new App and its credentials. */
export interface ManifestConversion {
  readonly id: number
  readonly slug: string
  /** `https://github.com/apps/<slug>`. */
  readonly htmlUrl: string
  readonly owner: string
  readonly clientId: string
  readonly clientSecret: Redacted.Redacted<string>
  /** Only for an App with a webhook, which the Hub's has not. */
  readonly webhookSecret: Option.Option<Redacted.Redacted<string>>
  /** The App's private key, PEM. GitHub hands it out this once. */
  readonly pem: Redacted.Redacted<string>
}

const Conversion = Schema.Struct({
  id: Schema.Int,
  slug: Schema.NonEmptyString,
  html_url: Schema.String,
  owner: Schema.NullOr(Schema.Struct({ login: Schema.optional(Schema.String) })),
  client_id: Schema.NonEmptyString,
  client_secret: Schema.NonEmptyString,
  webhook_secret: Schema.optional(Schema.NullOr(Schema.String)),
  pem: Schema.NonEmptyString,
})

/**
 * Trades the code GitHub redirected back with, once it registered an App from a manifest, for the
 * App's credentials: `POST /app-manifests/{code}/conversions`, which needs no credentials of its
 * own. A code works once, within an hour.
 */
export const convertManifest = Effect.fn("GitHubApp.convertManifest")(function* (
  code: string,
  apiUrl: URL = GitHubApiUrl,
) {
  const http = yield* HttpClient.HttpClient
  const converted = yield* callWith(
    http,
    "GitHub didn't hand over the new App's credentials",
    Conversion,
    HttpClientRequest.post(
      new URL(`app-manifests/${encodeURIComponent(code)}/conversions`, withSlash(apiUrl)),
    ).pipe(
      HttpClientRequest.accept("application/vnd.github+json"),
      HttpClientRequest.setHeader("x-github-api-version", "2022-11-28"),
      HttpClientRequest.setHeader("user-agent", "claude-hub"),
    ),
  )
  return {
    id: converted.id,
    slug: converted.slug,
    htmlUrl: converted.html_url,
    owner: converted.owner?.login ?? "",
    clientId: converted.client_id,
    clientSecret: Redacted.make(converted.client_secret),
    webhookSecret:
      converted.webhook_secret == null || converted.webhook_secret === ""
        ? Option.none()
        : Option.some(Redacted.make(converted.webhook_secret)),
    pem: Redacted.make(converted.pem),
  } satisfies ManifestConversion
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
