// Who is making a request. Every Hub route but sign-in and /health authenticates with one of:
// - a sign-in cookie, for people in a browser;
// - a Runner token, as `Authorization: Bearer`, for a Runner;
// - a mod token, as `Authorization: Bearer`, for one Session's mod;
// - a CLI token, as `Authorization: Bearer`, for the `kndl` CLI of a person signed in with
//   `kndl login`: on the CLI's own endpoints, the tunnel endpoint among them.
// Sandboxes can reach the Hub (ADR 0004), so nothing is open without one.

import type { Participant } from "@kndl/protocol"
import { Duration, Effect, Option, Schema } from "effect"
import { HttpServerRequest, HttpServerRespondable, HttpServerResponse } from "effect/http"
import { type CliIdentity, CliTokens } from "./CliTokens.ts"
import { HubConfig } from "./HubConfig.ts"
import { type ModGrant, ModTokens } from "./ModTokens.ts"
import { type RunnerIdentity, RunnerTokens } from "./RunnerTokens.ts"
import { SignIns } from "./SignIns.ts"

/**
 * The cookie holding a browser's sign-in token. Host-only: it never names a `Domain`. No
 * `__Host-` prefix, which browsers refuse without `Secure`: see `cookieSecurity`.
 */
export const signInCookie = "kndl_sign_in"

/** No credential, or one that isn't valid here: answered with 401. */
// oxlint-disable-next-line unicorn/throw-new-error -- Effect makes error classes with a factory call
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {
  message: Schema.String,
}) {
  [HttpServerRespondable.symbol]() {
    return Effect.succeed(HttpServerResponse.jsonUnsafe({ error: this.message }, { status: 401 }))
  }
}

/** A cookie-authenticated request from a page other than the web UI's: answered with 403. */
// oxlint-disable-next-line unicorn/throw-new-error -- Effect makes error classes with a factory call
export class ForeignOrigin extends Schema.TaggedError<ForeignOrigin>()("ForeignOrigin", {
  message: Schema.String,
}) {
  [HttpServerRespondable.symbol]() {
    return Effect.succeed(HttpServerResponse.jsonUnsafe({ error: this.message }, { status: 403 }))
  }
}

/** The bearer token in the request's `Authorization` header. */
export const bearerToken = (request: HttpServerRequest.HttpServerRequest): Option.Option<string> =>
  Option.fromNullishOr(/^Bearer (\S+)$/i.exec(request.headers.authorization ?? "")?.[1])

/**
 * Fails unless the request comes from the web UI's own origin. Browsers always send `Origin` on
 * WebSocket handshakes and on POSTs, so this stops another site, or a Preview on another port of
 * the same host, from riding on the sign-in cookie.
 */
export const requireSameOrigin = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const { publicUrl } = yield* HubConfig
  if (request.headers.origin !== publicUrl.origin) {
    return yield* new ForeignOrigin({
      message: `Only the web UI at ${publicUrl.origin} may make this request`,
    })
  }
})

/** The person signed in by the request's cookie. */
export const authenticateParticipant = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const token = request.cookies[signInCookie]
  const participant =
    token === undefined ? Option.none<Participant>() : yield* (yield* SignIns).authenticate(token)
  if (Option.isNone(participant)) {
    return yield* new Unauthorized({ message: "Sign in first" })
  }
  return participant.value
})

/** The Runner whose token the request carries. */
export const authenticateRunner = Effect.gen(function* () {
  const token = bearerToken(yield* HttpServerRequest.HttpServerRequest)
  const runner = Option.isNone(token)
    ? Option.none<RunnerIdentity>()
    : yield* (yield* RunnerTokens).authenticate(token.value)
  if (Option.isNone(runner)) {
    return yield* new Unauthorized({ message: "Expected a Runner token" })
  }
  return runner.value
})

/** The Session whose mod token the request carries. */
export const authenticateMod = Effect.gen(function* () {
  const token = bearerToken(yield* HttpServerRequest.HttpServerRequest)
  const grant = Option.isNone(token)
    ? Option.none<ModGrant>()
    : yield* (yield* ModTokens).authenticate(token.value)
  if (Option.isNone(grant)) {
    return yield* new Unauthorized({ message: "Expected a mod token" })
  }
  return grant.value
})

/**
 * The CLI whose token the request carries, and the person it acts for. Checked against the
 * database on every request, so a revoked token is refused from the next one on.
 */
export const authenticateCli = Effect.gen(function* () {
  const token = bearerToken(yield* HttpServerRequest.HttpServerRequest)
  const cli = Option.isNone(token)
    ? Option.none<CliIdentity>()
    : yield* (yield* CliTokens).authenticate(token.value)
  if (Option.isNone(cli)) {
    return yield* new Unauthorized({ message: "Expected a CLI token: run kndl login" })
  }
  return cli.value
})

/** Sets the sign-in cookie: HttpOnly, SameSite=Lax, host-only, and Secure as HubConfig says. */
export const setSignInCookie = (
  response: HttpServerResponse.HttpServerResponse,
  signIn: { readonly token: string; readonly expiresAt: Date },
) =>
  Effect.flatMap(HubConfig, ({ secureCookies }) =>
    HttpServerResponse.setCookie(response, signInCookie, signIn.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: secureCookies,
      path: "/",
      expires: signIn.expiresAt,
    }),
  ).pipe(Effect.orDie)

export const clearSignInCookie = (response: HttpServerResponse.HttpServerResponse) =>
  Effect.flatMap(HubConfig, ({ secureCookies }) =>
    HttpServerResponse.setCookie(response, signInCookie, "", {
      httpOnly: true,
      sameSite: "lax",
      secure: secureCookies,
      path: "/",
      maxAge: Duration.zero,
    }),
  ).pipe(Effect.orDie)
