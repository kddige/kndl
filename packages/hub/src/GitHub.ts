import { Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpIncomingMessage,
} from "effect/http"
import { HubConfig } from "./HubConfig.ts"

/** A GitHub account, as the sign-in flow learns it. */
export const GitHubUser = Schema.Struct({
  id: Schema.Int,
  login: Schema.NonEmptyString,
  name: Schema.NullOr(Schema.String),
})
export type GitHubUser = typeof GitHubUser.Type

// oxlint-disable-next-line unicorn/throw-new-error -- Effect makes error classes with a factory call
export class GitHubError extends Schema.TaggedError<GitHubError>()("GitHubError", {
  message: Schema.String,
}) {}

const AccessToken = Schema.Union([
  Schema.Struct({ access_token: Schema.NonEmptyString }),
  Schema.Struct({ error: Schema.String, error_description: Schema.optional(Schema.String) }),
])

/**
 * GitHub's user sign-in flow, as the GitHub App (issue #1) offers it. Only used while the Hub has
 * the App's client id and secret; the user's GitHub token is used once, to learn who they are,
 * and never stored.
 */
export class GitHub extends Context.Service<
  GitHub,
  {
    /** Whether GitHub sign-in is on: it is off until the App's client id and secret are set. */
    readonly isEnabled: boolean
    /** Where to send the browser to sign in, while it is on; GitHub sends it back to `redirectUri`. */
    readonly authorizeUrl: (options: {
      readonly state: string
      readonly redirectUri: string
    }) => Option.Option<URL>
    /** Exchanges the code GitHub sent back for the account it belongs to. */
    readonly user: (options: {
      readonly code: string
      readonly redirectUri: string
    }) => Effect.Effect<GitHubUser, GitHubError>
  }
>()("@claude-hub/hub/GitHub") {
  /** Talks to github.com with the client id and secret from `HubConfig`. */
  static readonly layer = Layer.effect(
    GitHub,
    Effect.gen(function* () {
      const { github } = yield* HubConfig
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)

      const authorizeUrl = (options: { readonly state: string; readonly redirectUri: string }) =>
        Option.map(github, ({ clientId }) => {
          const url = new URL("https://github.com/login/oauth/authorize")
          url.searchParams.set("client_id", clientId)
          url.searchParams.set("redirect_uri", options.redirectUri)
          url.searchParams.set("state", options.state)
          return url
        })

      const user = Effect.fn("GitHub.user")(
        function* (options: { readonly code: string; readonly redirectUri: string }) {
          if (Option.isNone(github)) {
            return yield* new GitHubError({ message: "GitHub sign-in is not configured" })
          }
          const exchanged = yield* client
            .execute(
              HttpClientRequest.post("https://github.com/login/oauth/access_token").pipe(
                HttpClientRequest.acceptJson,
                HttpClientRequest.bodyUrlParams({
                  client_id: github.value.clientId,
                  client_secret: Redacted.value(github.value.clientSecret),
                  code: options.code,
                  redirect_uri: options.redirectUri,
                }),
              ),
            )
            .pipe(Effect.flatMap(HttpIncomingMessage.schemaBodyJson(AccessToken)))
          if ("error" in exchanged) {
            return yield* new GitHubError({
              message: `GitHub refused the sign-in: ${exchanged.error_description ?? exchanged.error}`,
            })
          }
          return yield* client
            .execute(
              HttpClientRequest.get("https://api.github.com/user").pipe(
                HttpClientRequest.bearerToken(exchanged.access_token),
                HttpClientRequest.accept("application/vnd.github+json"),
                HttpClientRequest.setHeader("x-github-api-version", "2022-11-28"),
                HttpClientRequest.setHeader("user-agent", "claude-hub"),
              ),
            )
            .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(GitHubUser)))
        },
        Effect.catchTags({
          HttpClientError: (error) =>
            Effect.fail(new GitHubError({ message: `GitHub sign-in failed: ${error.message}` })),
          SchemaError: (error) =>
            Effect.fail(
              new GitHubError({ message: `GitHub sent an unexpected answer: ${error.message}` }),
            ),
        }),
      )

      return GitHub.of({ isEnabled: Option.isSome(github), authorizeUrl, user })
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer))

  /** A stand-in GitHub that knows one code, for tests. */
  static readonly layerTest = (options: { readonly code: string; readonly user: GitHubUser }) =>
    Layer.succeed(
      GitHub,
      GitHub.of({
        isEnabled: true,
        authorizeUrl: ({ state, redirectUri }) => {
          const url = new URL("https://github.test/login/oauth/authorize")
          url.searchParams.set("redirect_uri", redirectUri)
          url.searchParams.set("state", state)
          return Option.some(url)
        },
        user: ({ code }) =>
          code === options.code
            ? Effect.succeed(options.user)
            : Effect.fail(new GitHubError({ message: "bad verification code" })),
      }),
    )
}
