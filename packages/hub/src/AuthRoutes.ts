// Signing in and out. These are the only routes, with /health, /cli and the CLI's trade of a Login
// code (CliLoginRoutes.ts), that answer without a credential.
//
// The Hub is invite-only (ADR 0019): a GitHub sign-in gets in only as a Member already, as the
// Owner with the Setup link, or with an Invite (Members.ts). The web UI's /setup and /invite pages
// hand the Hub the link's secret (`POST /auth/github/admission`) just before sending the browser to
// GitHub, and the Hub keeps it in a cookie, beside the OAuth `state`, for when GitHub sends the
// browser back. Anyone not let in is sent to the /invite-only page, alike whatever they brought.

import {
  AdmissionTicket,
  GitHubLogin,
  InviteOnlyPath,
  Participant,
  ParticipantId,
} from "@kndl/protocol"
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
import { Members } from "./Members.ts"
import { SessionRelay } from "./SessionRelay.ts"
import { SignIns } from "./SignIns.ts"
import { constantTimeEqual, hashSecret, randomSecret } from "./Tokens.ts"

/**
 * Holds the OAuth `state` between leaving for GitHub and coming back. No `__Host-` or `__Secure-`
 * prefix, which browsers refuse without `Secure`: see `cookieSecurity`.
 */
const stateCookie = "kndl_oauth_state"

/**
 * Holds where to go once signed in with GitHub, when not to the web UI's start: `GET /auth/github`
 * takes it as `?return=`, such as the `/cli-login` page asking to come back to itself.
 */
const returnCookie = "kndl_oauth_return"

/**
 * Holds the secret of the Setup link or Invite the person came with, until GitHub sends them back.
 */
const admissionCookie = "kndl_oauth_admission"

/** The cookies a GitHub sign-in keeps until it comes back. */
const roundTripCookies = [stateCookie, returnCookie, admissionCookie]

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

const DevLoginBody = Schema.Struct({ login: Schema.optional(GitHubLogin) })

const notFound = HttpServerResponse.text("not found", { status: 404 })

const errorPage = (status: number, message: string) =>
  HttpServerResponse.text(`Sign-in failed: ${message}`, { status })

export const AuthRoutes = HttpRouter.use(
  Effect.fn(function* (router) {
    const config = yield* HubConfig
    const github = yield* GitHub
    const signIns = yield* SignIns
    const members = yield* Members
    const relay = yield* SessionRelay
    const roundTrip = {
      httpOnly: true,
      sameSite: "lax",
      secure: config.secureCookies,
      path: "/auth/github",
      maxAge: Duration.minutes(10),
    } as const
    /** Expires the cookies a GitHub sign-in kept until it came back. */
    const roundTripDone = Effect.fnUntraced(function* (
      response: HttpServerResponse.HttpServerResponse,
    ) {
      let done = response
      for (const cookie of roundTripCookies) {
        done = yield* HttpServerResponse.expireCookie(done, cookie, { path: "/auth/github" }).pipe(
          Effect.orDie,
        )
      }
      return done
    })
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
        const response = yield* HttpServerResponse.redirect(url.value, { status: 302 }).pipe(
          HttpServerResponse.setCookie(stateCookie, state, roundTrip),
          Effect.orDie,
        )
        return back === undefined
          ? yield* HttpServerResponse.expireCookie(response, returnCookie, {
              path: "/auth/github",
            }).pipe(Effect.orDie)
          : yield* HttpServerResponse.setCookie(response, returnCookie, back, roundTrip).pipe(
              Effect.orDie,
            )
      }),
    )

    // The secret of the Setup link or Invite the person came with, from the web UI's /setup or
    // /invite page just before it sends the browser to `GET /auth/github`. Kept as it is: the
    // callback checks it, so nothing here says whether it is one.
    yield* router.add(
      "POST",
      "/auth/github/admission",
      Effect.gen(function* () {
        if (!github.isEnabled) return notFound
        yield* requireSameOrigin
        const request = yield* HttpServerRequest.HttpServerRequest
        const body = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AdmissionTicket))(
          yield* request.text,
        )
        return yield* HttpServerResponse.setCookie(
          HttpServerResponse.empty({ status: 204 }),
          admissionCookie,
          body.ticket,
          roundTrip,
        ).pipe(Effect.orDie)
      }).pipe(
        Effect.catchTag("SchemaError", () =>
          Effect.succeed(HttpServerResponse.text("Expected a ticket", { status: 400 })),
        ),
      ),
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
        const participant = Participant.make({
          id: ParticipantId.make(`github:${user.id}`),
          login: user.login,
          name: user.name || user.login,
          ...(avatarUrl !== undefined && { avatarUrl }),
        })
        const admission = yield* members.admit(participant, request.cookies[admissionCookie])
        if (Option.isNone(admission)) {
          yield* Effect.logInfo(`Turned away ${user.login}, who has no Invite`)
          return yield* roundTripDone(HttpServerResponse.redirect(InviteOnlyPath, { status: 302 }))
        }
        if (admission.value !== "Member") {
          yield* Effect.logInfo(
            admission.value === "Owner"
              ? `${user.login} signed in with the Setup link, and is the Hub's Owner`
              : `${user.login} signed in with an Invite, and is a Member`,
          )
        }
        const signIn = yield* signIns.signIn(participant)
        if (admission.value !== "Member") yield* relay.membersChanged
        return yield* roundTripDone(
          yield* setSignInCookie(
            HttpServerResponse.redirect(returnPath(request.cookies[returnCookie]) ?? "/", {
              status: 302,
            }),
            signIn,
          ),
        )
      }).pipe(
        Effect.catchTag("GitHubError", (error) => Effect.succeed(errorPage(502, error.message))),
      ),
    )

    // Dev login: sign in as a local Participant without GitHub. Answers 404 unless
    // KNDL_DEV_LOGIN is set, which HubConfig refuses unless the Hub is on loopback.
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
        const participant = Participant.make({
          id: ParticipantId.make(`dev:${login}`),
          login,
          name: login,
        })
        // Dev login needs no Invite: it only answers on loopback.
        yield* members.admitLocal(participant)
        const signIn = yield* signIns.signIn(participant)
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
