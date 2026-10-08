// Where an OAuth Installation's authorization server sends the browser back (#217):
// `GET /auth/plugins/callback`, the redirect URI the Hub registered there. It needs the sign-in
// cookie of the person who began connecting, and the `state` the Hub gave them, which it takes
// once. The Hub trades the code for tokens and keeps them, then sends the browser to the
// Installation on the Plugins page, with what went wrong, if anything did. No token is ever in a
// URL the Hub sends the browser to, nor logged.

import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { authenticateParticipant } from "./Auth.ts"
import { HubConfig } from "./HubConfig.ts"
import { OAuthCallbackPath } from "./PluginOAuth.ts"
import { SessionRelay } from "./SessionRelay.ts"

/** The longest text taken from the callback's query, for each parameter. */
const maxParam = 2048

/** Where the browser goes once the connection finished, or failed. */
const backTo = (result: { readonly installationId?: string; readonly error?: string }) => {
  const search = new URLSearchParams()
  if (result.installationId !== undefined) search.set("installation", result.installationId)
  if (result.error === undefined) search.set("connected", "1")
  else search.set("connectError", result.error)
  return `/plugins?${search.toString()}`
}

export const PluginOAuthRoutes = HttpRouter.use(
  Effect.fn(function* (router) {
    const config = yield* HubConfig
    const relay = yield* SessionRelay

    yield* router.add(
      "GET",
      OAuthCallbackPath,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const params = new URL(request.url, config.publicUrl).searchParams
        const param = (name: string) => {
          const value = params.get(name)
          return value === null || value === "" ? undefined : value.slice(0, maxParam)
        }
        const state = param("state")
        const you = yield* authenticateParticipant.pipe(Effect.option)
        if (you._tag === "None") {
          return HttpServerResponse.redirect(
            backTo({ error: "Sign in to kndl, then connect the Installation again." }),
            { status: 302 },
          )
        }
        if (state === undefined) {
          return HttpServerResponse.redirect(
            backTo({ error: "The authorization server sent no state: connect again." }),
            { status: 302 },
          )
        }
        const code = param("code")
        const error = param("error")
        const errorDescription = param("error_description")
        const iss = param("iss")
        const result = yield* relay.finishPluginConnect(you.value, {
          state,
          ...(code !== undefined && { code }),
          ...(error !== undefined && { error }),
          ...(errorDescription !== undefined && { errorDescription }),
          ...(iss !== undefined && { iss }),
        })
        return HttpServerResponse.redirect(backTo(result), { status: 302 })
      }).pipe(Effect.withSpan("PluginOAuth.callback")),
    )
  }),
)
