// The Gateway (#221, ADR 0020): how a Session's Claude Code reaches the remote MCP server of each
// Installation it runs with. MCP traffic goes through the Hub, so that a Plugin's credentials, once
// it has them, stay on the Hub, and only the Hub decides which Session reaches which server.
//
// - `/gateway/<installation id>`, any method, by the Session's mod token alone as `Authorization:
//   Bearer`: the token the Runner's credential proxy relays it with (ADR 0013). A request without
//   a live token is answered `401`.
// - The Installation must be one the Session started with, and still on for its Repo; any other is
//   answered `403`, alike whether it exists or not. One removed from the Repo stops at once; one
//   added waits for the Session's next wake or Restart. A global one (#219) is on for the Repo
//   unless the Repo turned it off or a Repo-scoped Installation of its Plugin takes its place there:
//   either stops it at once too.
// - The request goes to the Plugin's URL as it is now, so an edit to it reaches running Sessions
//   at once. Its body and the answer's stream both ways untouched: Streamable HTTP's server-sent
//   events, compression and all. The Session token, cookies and hop-by-hop headers stay behind;
//   the server's cookies don't come back. A redirect isn't followed: it is answered `502`.
// - The Plugin's header secrets (#215) are added as its declarations say now, from the values the
//   Session started with, which only the Hub holds: a header of the same name from the Sandbox, by
//   any case, is dropped. An Installation without a value for one is answered `409`, naming it and
//   the header secret's title.
// - A server that refuses the Session's credential (401 or 403), or an Installation without a value
//   for one, is shown in the Session as an error (#216), once until it works again. The Session
//   runs on: its other MCP servers may well work.
// - An OAuth Installation (#217) is sent with `Authorization: Bearer` and its access token as the
//   Hub holds it now: live, never a copy a Session started with, so a refresh or a reconnect
//   reaches running Sessions at once, and a disconnect stops them. One not connected is answered
//   `409`, and noted in the Session; one whose token expired and couldn't be refreshed just now,
//   `503`. A `401` from its server has the token refreshed and the request sent once more; then
//   it is answered `502`, or `409` once the connection is lost.
// - Claude Code never runs OAuth against the Gateway: no answer carries `WWW-Authenticate`, an
//   OAuth Installation's 401 isn't passed on, and nothing under `/gateway/<id>/`, such as
//   `/.well-known/oauth-protected-resource`, reaches a server: it is answered `404`.
// - Each request is logged with its Session, Installation, method, status and time taken, and
//   nothing of what it carries.

import {
  type InstallationId,
  InstallationId as InstallationIdSchema,
  type SessionId,
} from "@kndl/protocol"
import { Clock, Effect, Option } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { authenticateMod } from "./Auth.ts"
import { forward, type ReadyTarget } from "./Gateway.ts"
import { PluginOAuth } from "./PluginOAuth.ts"
import { type GatewayTarget, Plugins } from "./Plugins.ts"
import type { SecretsUnavailable } from "./Secrets.ts"
import { SessionRelay } from "./SessionRelay.ts"
import { Sessions } from "./Sessions.ts"

const errorResponse = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status })

/** What an OAuth Installation's server refusing its account is answered with (#217). */
const oauthRefusal =
  "The Plugin's MCP server refused the Installation's account: reconnect it on the Plugins page."

/** Lets an answer's body go unread. */
const discard = (response: Response) =>
  Effect.promise(() => response.body?.cancel() ?? Promise.resolve()).pipe(Effect.ignore)

/** Request headers that stay at the Gateway: the Session's own, and the connection's. */
const heldRequestHeaders = new Set([
  "authorization",
  "cookie",
  "host",
  "origin",
  "referer",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "x-api-key",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
])

/** Answer headers that stay at the Gateway: the server's cookies, and the connection's. */
const heldResponseHeaders = new Set([
  "set-cookie",
  // Claude Code would begin OAuth against the Gateway on a challenge (#217): only the Hub does.
  "www-authenticate",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

const kept = (headers: Headers, held: ReadonlySet<string>) => {
  const out = new Headers()
  for (const [name, value] of headers) {
    if (!held.has(name.toLowerCase())) out.append(name, value)
  }
  return out
}

export const GatewayRoutes = HttpRouter.use(
  Effect.fn(function* (router) {
    const sessions = yield* Sessions
    const plugins = yield* Plugins
    const relay = yield* SessionRelay
    const oauth = yield* PluginOAuth

    /**
     * Where the Session may reach the Installation's MCP server: the Plugin's URL, or the status
     * it is refused with. A token is live only while its Session is Active: an Asleep Session's
     * is left from its last run, until its next start replaces it.
     */
    const target = Effect.fn("Gateway.target")(function* (
      sessionId: SessionId,
      installationId: InstallationId,
    ) {
      const session = yield* sessions.get(sessionId)
      if (Option.isNone(session) || session.value.state !== "Active") return 401
      const startedWith = session.value.plugins ?? []
      if (!startedWith.some((installation) => installation.id === installationId)) return 403
      const on = yield* plugins.gatewayTarget(installationId, session.value)
      return Option.isSome(on) ? on.value : 403
    })

    yield* router.add(
      "*",
      "/gateway/:installationId",
      Effect.gen(function* () {
        const grant = yield* authenticateMod
        const installationId = InstallationIdSchema.make(
          (yield* HttpRouter.params).installationId ?? "-",
        )
        const request = yield* HttpServerRequest.HttpServerRequest
        const started = yield* Clock.currentTimeMillis
        const done = (status: number) =>
          Effect.gen(function* () {
            const took = (yield* Clock.currentTimeMillis) - started
            yield* Effect.logInfo(`Gateway ${request.method} ${status} in ${took}ms`).pipe(
              Effect.annotateLogs({ sessionId: grant.sessionId, installationId }),
            )
          })

        /** What the Gateway answers when the Installation can't be reached now. */
        const refusal = Effect.fn("Gateway.refusal")(function* (
          found: Exclude<GatewayTarget, ReadyTarget> | 401 | 403,
        ) {
          if (found === 401) {
            yield* done(401)
            return errorResponse(401, "Expected the mod token of an Active Session")
          }
          if (found === 403) {
            yield* done(403)
            return errorResponse(403, "This Installation isn't on for the Session's Repo.")
          }
          switch (found._tag) {
            case "NeedsValue": {
              yield* relay.installationFailed(grant.sessionId, installationId, {
                reason: "ValueNeeded",
                secrets: found.secrets,
              })
              yield* done(409)
              return errorResponse(409, found.message)
            }
            case "NotConnected": {
              yield* relay.installationFailed(grant.sessionId, installationId, {
                reason: "NotConnected",
              })
              yield* done(409)
              return errorResponse(409, found.message)
            }
            case "Unavailable": {
              yield* done(503)
              return errorResponse(503, found.message)
            }
          }
        })
        const unreadable = Effect.fn("Gateway.unreadable")(function* (error: SecretsUnavailable) {
          yield* Effect.logError("Could not decrypt an Installation's credentials", error)
          yield* done(500)
          return errorResponse(
            500,
            "The Hub could not read this Installation's credentials: check HUB_SECRETS_KEY.",
          )
        })

        const current = target(grant.sessionId, installationId).pipe(
          Effect.catchTag("SecretsUnavailable", (error) => Effect.succeed(error)),
        )
        const found = yield* current
        if (typeof found !== "number" && found._tag === "SecretsUnavailable") {
          return yield* unreadable(found)
        }
        if (typeof found === "number" || found._tag !== "Ready") return yield* refusal(found)
        let ready = found
        const incoming = yield* HttpServerRequest.toWeb(request)
        const headers = kept(incoming.headers, heldRequestHeaders)
        // An OAuth Installation's request is sent again once its token is refused and refreshed
        // (#217): its body is read first. MCP's requests are small JSON-RPC messages.
        let body: RequestInit["body"] = incoming.body
        if (ready.oauth !== undefined && incoming.body !== null) {
          const read = yield* Effect.tryPromise(() => incoming.arrayBuffer()).pipe(Effect.option)
          if (Option.isNone(read)) {
            yield* done(400)
            return errorResponse(400, "The request's body could not be read.")
          }
          body = read.value
        }
        const send = (to: ReadyTarget) =>
          forward(to, { method: request.method, headers, body, signal: incoming.signal })

        let answer = yield* send(ready)
        // The server refused an OAuth token (#217): it is refreshed and the request sent once
        // more, or the connection is lost. The 401 never reaches Claude Code, which would begin
        // OAuth against the Gateway itself.
        for (let tries = 1; ready.oauth !== undefined; tries++) {
          if (Option.isNone(answer) || answer.value.status !== 401) break
          yield* discard(answer.value)
          const next = yield* oauth
            .rejected(installationId, ready.oauth.generation)
            .pipe(
              Effect.catchTag("SecretsUnavailable", (error) =>
                Effect.as(
                  Effect.logError("Could not decrypt an Installation's OAuth tokens", error),
                  "Lost" as const,
                ),
              ),
            )
          if (next === "Retry" && tries >= 2) {
            yield* relay.installationFailed(grant.sessionId, installationId, {
              reason: "Rejected",
              status: 401,
            })
            yield* done(502)
            return errorResponse(502, oauthRefusal)
          }
          const again = yield* current
          if (typeof again !== "number" && again._tag === "SecretsUnavailable") {
            return yield* unreadable(again)
          }
          if (typeof again === "number" || again._tag !== "Ready") return yield* refusal(again)
          if (next === "Lost") {
            // Reconnected meanwhile: this request isn't sent again.
            yield* done(502)
            return errorResponse(502, oauthRefusal)
          }
          ready = again
          answer = yield* send(ready)
        }
        if (Option.isNone(answer)) {
          yield* done(502)
          return errorResponse(502, "The Plugin's MCP server could not be reached.")
        }
        const response = answer.value
        if (response.status >= 300 && response.status < 400) {
          yield* discard(response)
          yield* done(502)
          return errorResponse(
            502,
            "The Plugin's MCP server redirected, which the Gateway doesn't follow.",
          )
        }
        if (response.status === 401 || response.status === 403) {
          yield* relay.installationFailed(grant.sessionId, installationId, {
            reason: "Rejected",
            status: response.status,
          })
        } else if (response.ok) {
          relay.installationWorks(grant.sessionId, installationId)
          if (ready.oauth !== undefined) oauth.works(installationId, ready.oauth.generation)
        }
        yield* done(response.status)
        return HttpServerResponse.raw(
          new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: kept(response.headers, heldResponseHeaders),
          }),
        )
      }).pipe(Effect.annotateLogs({ component: "Gateway" }), Effect.withSpan("Gateway.request")),
    )

    // Nothing lies under an Installation's path: not least OAuth's `/.well-known` documents, which
    // Claude Code would look for to begin OAuth itself (#217). Not the web UI either.
    yield* router.add(
      "*",
      "/gateway/:installationId/:below/*",
      Effect.succeed(errorResponse(404, "There is nothing under an Installation's Gateway path.")),
    )
  }),
)
