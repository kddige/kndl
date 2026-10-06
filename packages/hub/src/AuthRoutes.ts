// Signing in and out. These are the only routes, with /health, /cli and the CLI's trade of a Login
// code (CliLoginRoutes.ts), that answer without a credential.

import { Participant, ParticipantId } from "@claude-hub/protocol"
import { Duration, Effect, Option, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import {
  authenticateParticipant,
  clearSignInCookie,
  requireSameOrigin,
  setSignInCookie,
  signInCookie,
} from "./Auth.ts"
import { GitHub, githubAvatarUrl } from "./GitHub.ts"
import { HubConfig, isLoopback } from "./HubConfig.ts"
import { SignIns } from "./SignIns.ts"
import { constantTimeEqual, hashSecret, randomSecret } from "./Tokens.ts"

/**
 * Holds the OAuth `state` between leaving for GitHub and coming back. No `__Host-` or `__Secure-`
 * prefix, which browsers refuse without `Secure`: see `cookieSecurity`.
 */
const stateCookie = "claude_hub_oauth_state"

/**
 * Holds where to go once signed in with GitHub, when not to the web UI's start: `GET /auth/github`
 * takes it as `?return=`, such as the `/cli-login` page asking to come back to itself.
 */
const returnCookie = "claude_hub_oauth_return"

/**
 * A path on the Hub to come back to after signing in, or undefined for anything else: it must start
 * with one `/`, so no `//host` or `/\host` sends the person to another site.
 */
export function returnPath(text: string | null | undefined): string | undefined {
  if (text === null || text === undefined || text.length > 2048) return undefined
  if (!/^\/(?![/\\])/.test(text) || text.includes("\\")) return undefined
  // No control characters, which a browser might drop to read `/\t/host` as `//host`.
  for (const char of text) if (char.charCodeAt(0) < 0x20 || char === "\u007f") return undefined
  return text
}

/** What `GET /auth/me` answers with 401: the ways to sign in that are on. */
export const SignInOptions = Schema.Struct({
  error: Schema.String,
  github: Schema.Boolean,
  dev: Schema.Boolean,
})

/** A GitHub login: letters, digits and single hyphens, at most 39 characters. */
const Login = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/))

const DevLoginBody = Schema.Struct({ login: Schema.optional(Login) })

const notFound = HttpServerResponse.text("not found", { status: 404 })

const errorPage = (status: number, message: string) =>
  HttpServerResponse.text(`Sign-in failed: ${message}`, { status })

export const AuthRoutes = HttpRouter.use(
  Effect.fn(function* (router) {
    const config = yield* HubConfig
    const github = yield* GitHub
    const signIns = yield* SignIns
    const redirectUri = new URL("/auth/github/callback", config.publicUrl).href

    // The signed-in person, or 401 with the ways to sign in.
    yield* router.add(
      "GET",
      "/auth/me",
      authenticateParticipant.pipe(
        Effect.flatMap(HttpServerResponse.schemaJson(Participant)),
        Effect.catchTag("Unauthorized", (error) =>
          HttpServerResponse.schemaJson(SignInOptions)(
            { error: error.message, github: github.isEnabled, dev: Option.isSome(config.devLogin) },
            { status: 401 },
          ),
        ),
      ),
    )

    yield* router.add(
      "POST",
      "/auth/sign-out",
      Effect.gen(function* () {
        yield* requireSameOrigin
        yield* authenticateParticipant
        const request = yield* HttpServerRequest.HttpServerRequest
        yield* signIns.signOut(request.cookies[signInCookie] ?? "")
        return yield* clearSignInCookie(HttpServerResponse.empty({ status: 204 }))
      }),
    )

    // GitHub sign-in, off until the GitHub App's client id and secret are set.
    yield* router.add(
      "GET",
      "/auth/github",
      Effect.gen(function* () {
        const state = randomSecret()
        const url = github.authorizeUrl({ state, redirectUri })
        if (Option.isNone(url)) return notFound
        const request = yield* HttpServerRequest.HttpServerRequest
        const back = returnPath(new URL(request.url, config.publicUrl).searchParams.get("return"))
        const cookie = {
          httpOnly: true,
          sameSite: "lax",
          secure: config.secureCookies,
          path: "/auth/github",
          maxAge: Duration.minutes(10),
        } as const
        const response = yield* HttpServerResponse.redirect(url.value, { status: 302 }).pipe(
          HttpServerResponse.setCookie(stateCookie, state, cookie),
          Effect.orDie,
        )
        return back === undefined
          ? yield* HttpServerResponse.expireCookie(response, returnCookie, {
              path: "/auth/github",
            }).pipe(Effect.orDie)
          : yield* HttpServerResponse.setCookie(response, returnCookie, back, cookie).pipe(
              Effect.orDie,
            )
      }),
    )

    yield* router.add(
      "GET",
      "/auth/github/callback",
      Effect.gen(function* () {
        if (!github.isEnabled) return notFound
        const request = yield* HttpServerRequest.HttpServerRequest
        const params = new URL(request.url, config.publicUrl).searchParams
        const code = params.get("code")
        const state = params.get("state")
        const expectedState = request.cookies[stateCookie]
        if (
          code === null ||
          state === null ||
          expectedState === undefined ||
          !constantTimeEqual(hashSecret(state), hashSecret(expectedState))
        ) {
          return errorPage(400, "the sign-in expired or came from elsewhere. Try again.")
        }
        const user = yield* github.user({ code, redirectUri })
        const avatarUrl = githubAvatarUrl(user.avatar_url)
        const signIn = yield* signIns.signIn(
          Participant.make({
            id: ParticipantId.make(`github:${user.id}`),
            login: user.login,
            name: user.name || user.login,
            ...(avatarUrl !== undefined && { avatarUrl }),
          }),
        )
        const response = yield* setSignInCookie(
          HttpServerResponse.redirect(returnPath(request.cookies[returnCookie]) ?? "/", {
            status: 302,
          }),
          signIn,
        )
        const expired = yield* HttpServerResponse.expireCookie(response, stateCookie, {
          path: "/auth/github",
        }).pipe(Effect.orDie)
        return yield* HttpServerResponse.expireCookie(expired, returnCookie, {
          path: "/auth/github",
        }).pipe(Effect.orDie)
      }).pipe(
        Effect.catchTag("GitHubError", (error) => Effect.succeed(errorPage(502, error.message))),
      ),
    )

    // Dev login: sign in as a local Participant without GitHub. Answers 404 unless
    // CLAUDE_HUB_DEV_LOGIN is set, which HubConfig refuses unless the Hub is on loopback.
    yield* router.add(
      "POST",
      "/auth/dev",
      Effect.gen(function* () {
        if (Option.isNone(config.devLogin)) return notFound
        yield* requireSameOrigin
        const request = yield* HttpServerRequest.HttpServerRequest
        if (!Option.exists(request.remoteAddress, isLoopback)) {
          return HttpServerResponse.text("Dev login only answers on loopback", { status: 403 })
        }
        const text = yield* request.text
        const body = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(DevLoginBody))(
          text.trim() === "" ? "{}" : text,
        )
        const login = body.login ?? devLoginName(config.devLogin.value.defaultName)
        const signIn = yield* signIns.signIn(
          Participant.make({ id: ParticipantId.make(`dev:${login}`), login, name: login }),
        )
        const response = yield* HttpServerResponse.schemaJson(Participant)(signIn.participant)
        return yield* setSignInCookie(response, signIn)
      }).pipe(
        Effect.catchTag("SchemaError", (error) =>
          Effect.succeed(HttpServerResponse.text(error.message, { status: 400 })),
        ),
      ),
    )
  }),
)

/** Turns a user name such as `$USER` into something shaped like a GitHub login. */
function devLoginName(name: string): string {
  const login = name
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 39)
  return login === "" ? "dev" : login
}
