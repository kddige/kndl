// The Gateway (#221, ADR 0020): how a Session's Claude Code reaches the remote MCP server of each
// Installation it runs with. MCP traffic goes through the Hub, so that an MCP server's credentials,
// once it has them, stay on the Hub, and only the Hub decides which Session reaches which server.
//
// - `/gateway/<installation id>`, any method, by the Session's mod token alone as `Authorization:
//   Bearer`: the token the Runner's credential proxy relays it with (ADR 0013). A request without
//   a live token is answered `401`.
// - The Installation must be one the Session started with, and still on for its Repo; any other is
//   answered `403`, alike whether it exists or not. One removed from the Repo stops at once; one
//   added waits for the Session's next wake or Restart. A global one (#219) is on for the Repo
//   unless the Repo turned it off or a Repo-scoped Installation of its MCP server takes its place
//   there: either stops it at once too.
// - The request goes to the MCP server's URL as it is now, so an edit to it reaches running
//   Sessions at once. Its body and the answer's stream both ways untouched: Streamable HTTP's
//   server-sent events, compression and all. The Session token, cookies and hop-by-hop headers stay
//   behind; the server's cookies don't come back. A redirect isn't followed: it is answered `502`.
// - The MCP server's header secrets (#215) are added as its declarations say now, from the values
//   the Session started with, which only the Hub holds: a header of the same name from the Sandbox,
//   by any case, is dropped. An Installation without a value for one is answered `409`, naming it
//   and the header secret's title.
// - A server that refuses the Session's credential (401 or 403), or an Installation without a value
//   for one, is shown in the Session as an error (#216), once until it works again. The Session
//   runs on: its other MCP servers may well work.
// - An OAuth Installation (#217) is sent with `Authorization: Bearer` and its access token as the
//   Hub holds it now: live, never a copy a Session started with, so a refresh or a reconnect
//   reaches running Sessions at once, and a disconnect stops them. One not connected is answered
//   `409`, and noted in the Session; one whose token expired and couldn't be refreshed just now,
//   `503`. A `401` from its server has the token refreshed and the request sent once more; then
//   it is answered `502`, or `409` once the connection is lost.
//   Its request's body is held, to be sent again: one over MaxOAuthRequestBytes is answered `413`.
// - Claude Code never runs OAuth against the Gateway: no answer carries `WWW-Authenticate`, an
//   OAuth Installation's 401 isn't passed on, and nothing under `/gateway/<id>/`, such as
//   `/.well-known/oauth-protected-resource`, reaches a server: it is answered `404`.
// - Each request is logged with its Session, Installation, method, status and time taken, and
//   nothing of what it carries.

import { InstallationId as InstallationIdSchema } from "@kndl/protocol"
import { Clock, Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { authenticateMod } from "./Auth.ts"
import { Gateway, MaxOAuthRequestBytes, type Refusal } from "./Gateway.ts"
import { SessionRelay } from "./SessionRelay.ts"

const errorResponse = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status })

/** What an OAuth Installation's server refusing its account is answered with (#217). */
const oauthRefusal =
  "The MCP server refused the Installation's account: reconnect it on the MCP page."

const tooLarge = `The request's body is larger than ${MaxOAuthRequestBytes / 1024 / 1024} MiB, the most the Gateway takes for an OAuth Installation.`

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
    const gateway = yield* Gateway
    const relay = yield* SessionRelay

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

        /** What the Gateway answers when the Session can't reach the Installation now. */
        const refusal = Effect.fn("Gateway.refusal")(function* (found: Refusal) {
          switch (found._tag) {
            case "NotActive": {
              yield* done(401)
              return errorResponse(401, "Expected the mod token of an Active Session")
            }
            case "Off": {
              yield* done(403)
              return errorResponse(403, "This Installation isn't on for the Session's Repo.")
            }
            case "Unreadable": {
              yield* Effect.logError("Could not decrypt an Installation's credentials", found.error)
              yield* done(500)
              return errorResponse(
                500,
                "The Hub could not read this Installation's credentials: check HUB_SECRETS_KEY.",
              )
            }
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

        const authorised = yield* gateway.authorise(grant.sessionId, installationId)
        if (authorised._tag !== "Authorised") return yield* refusal(authorised)
        const incoming = yield* HttpServerRequest.toWeb(request)
        const sent = yield* gateway.send(authorised, {
          method: request.method,
          headers: kept(incoming.headers, heldRequestHeaders),
          body: incoming.body,
          length: Number(incoming.headers.get("content-length")),
          signal: incoming.signal,
        })
        switch (sent._tag) {
          case "Answered":
            break
          case "TooLarge": {
            yield* done(413)
            return errorResponse(413, tooLarge)
          }
          case "BodyUnreadable": {
            yield* done(400)
            return errorResponse(400, "The request's body could not be read.")
          }
          // A server's 401 to an OAuth token never reaches Claude Code, which would begin OAuth
          // against the Gateway itself (#217).
          case "Refused": {
            yield* relay.installationFailed(grant.sessionId, installationId, {
              reason: "Rejected",
              status: 401,
            })
            yield* done(502)
            return errorResponse(502, oauthRefusal)
          }
          case "Lost": {
            if (sent.error !== undefined) {
              yield* Effect.logError("Could not decrypt an Installation's OAuth tokens", sent.error)
            }
            const again = yield* gateway.authorise(grant.sessionId, installationId)
            if (again._tag !== "Authorised") return yield* refusal(again)
            // Reconnected meanwhile: this request isn't sent again.
            yield* done(502)
            return errorResponse(502, oauthRefusal)
          }
          case "Unreachable": {
            yield* done(502)
            return errorResponse(502, "The MCP server could not be reached.")
          }
          case "Redirected": {
            yield* done(502)
            return errorResponse(
              502,
              "The MCP server redirected, which the Gateway doesn't follow.",
            )
          }
          default:
            return yield* refusal(sent)
        }
        const response = sent.response
        if (response.status === 401 || response.status === 403) {
          yield* relay.installationFailed(grant.sessionId, installationId, {
            reason: "Rejected",
            status: response.status,
          })
        } else if (response.ok) {
          relay.installationWorks(grant.sessionId, installationId)
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
