// The Gateway (#221, ADR 0020): how a Session's Claude Code reaches the remote MCP server of each
// Installation it runs with. MCP traffic goes through the Hub, so that an MCP server's credentials,
// once it has them, stay on the Hub, and only the Hub decides which Session reaches which server.
//
// - `/gateway/<installation id>`, any method, by the Session's mod token alone as `Authorization:
//   Bearer`: the token the Runner's mod relay passes it on with (ADR 0026). A request without
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
//
// A pi Session's model calls (ADR 0029) come through it too, to its Creator's Connected providers:
//
// - `/gateway/models/<provider>/<the Provider's API path>`, any method, by the mod token as above.
//   An Installation's id is 24 random hex characters (Tokens.ts's randomId), so it is never
//   `models`: the two never meet.
// - Each refusal is in the Providers' own error shape, `{"error":{"message":…}}`, which pi shows:
//   - `403`: a Claude Code Session's call (only pi Sessions spend Connected providers); a call that
//     isn't one pi makes to the Provider's API, its inference or model-listing endpoints, so not
//     its files, batches or fine-tuning (PiProviders.ts); a Provider its Creator hasn't
//     connected, or must connect again. Claude's Models don't come through it: they run through
//     Claude Code in the Sandbox.
//   - `404`: a Provider kndl doesn't know. `400`: a path that could leave the Provider's API.
//   - `429`: more calls at once than a Session may run. `503`: the Hub holds as many sign-ins'
//     bodies as it may, or a sign-in couldn't be refreshed just now. `413`: a body larger than
//     the Gateway takes. All three are in ModelCallLimits (Gateway.ts).
//   - `502`: the Provider couldn't be reached, or redirected, which isn't followed.
// - The call goes to the origin of the Provider's API (`https://api.openai.com`, or the one a
//   sign-in names, as GitHub Copilot's does) with the path and query below the Provider's, so
//   `/gateway/models/openai/v1/responses` goes to `https://api.openai.com/v1/responses`. Its
//   `authorization`, `x-api-key` and `x-goog-api-key` are dropped, and the Creator's key or sign-in
//   takes the place of the Session token in the one pi sent its key in: `x-goog-api-key` for
//   Google's API, `x-api-key` for Anthropic's Messages API, else `Authorization: Bearer`. A
//   sign-in's own headers are added (PiProviders.ts). A sign-in's body is held, to send it once
//   more after a sign-in refused is refreshed; an API key's streams on (Gateway.ts). The answer
//   streams back as it comes, with no idle timeout at the Hub or upstream, and the call is logged
//   once it has.

import {
  InstallationId as InstallationIdSchema,
  ModelProvider,
  modelGatewayPath,
} from "@kndl/protocol"
import { Clock, Effect, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { authenticateMod } from "./Auth.ts"
import { Gateway, MaxOAuthRequestBytes, type ModelCallEnded, type Refusal } from "./Gateway.ts"
import { keyHeaderOf, nameOf } from "./PiProviders.ts"
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

/** What a model call is answered with when the Gateway refuses it: a Provider's error shape. */
const providerError = (status: number, message: string) =>
  HttpServerResponse.jsonUnsafe({ error: { message } }, { status })

/** A model call's headers that stay at the Gateway: those above, and Gemini's key header. */
const heldModelHeaders = new Set([...heldRequestHeaders, "x-goog-api-key"])

const isModelProvider = Schema.is(ModelProvider)

/**
 * Turns off the Hub server's idle timeout for the request, which is sized for the mod's long poll
 * (Hub.ts): a Model may think for longer before it says anything. Bun's server has
 * `timeout(request, seconds)` for that; Effect's Bun server keeps the server, and Bun's request,
 * on its request, which is the only way to them from a route. Elsewhere, nothing is done.
 */
const keepOpen = (request: HttpServerRequest.HttpServerRequest) => {
  const { source, bunServer } = request as unknown as {
    readonly source?: unknown
    readonly bunServer?: { readonly timeout?: (request: Request, seconds: number) => void }
  }
  if (source instanceof Request && typeof bunServer?.timeout === "function") {
    bunServer.timeout(source, 0)
  }
}

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

    // A pi Session's model calls (ADR 0029), at the static `models`, which the router prefers to
    // an Installation's id.
    const modelCall = Effect.gen(function* () {
      const grant = yield* authenticateMod
      const request = yield* HttpServerRequest.HttpServerRequest
      // A Model may think for longer than the Hub's idle timeout before it says anything.
      keepOpen(request)
      const provider = (yield* HttpRouter.params).provider ?? ""
      const started = yield* Clock.currentTimeMillis
      const done = (status: number, bytes?: number, outcome?: ModelCallEnded["outcome"]) =>
        Effect.gen(function* () {
          const took = (yield* Clock.currentTimeMillis) - started
          const answered =
            bytes === undefined
              ? ""
              : `, ${bytes} bytes${outcome === "Ended" ? "" : `, ${outcome}`}`
          yield* Effect.logInfo(`Gateway ${request.method} ${status} in ${took}ms${answered}`).pipe(
            Effect.annotateLogs({ sessionId: grant.sessionId, provider }),
          )
        })
      const refused = Effect.fnUntraced(function* (status: number, message: string) {
        yield* done(status)
        return providerError(status, message)
      })
      if (!isModelProvider(provider)) {
        return yield* refused(404, `kndl has no Provider called ${provider}.`)
      }
      // As the Hub's server has it: its dot segments resolved, any encoding as sent.
      const url = new URL(request.url, "http://gateway")
      const path = url.pathname.slice(modelGatewayPath(provider).length) + url.search
      const incoming = yield* HttpServerRequest.toWeb(request)
      const length = incoming.headers.get("content-length")
      const sent = yield* gateway.model(grant.sessionId, provider, {
        method: request.method,
        path,
        headers: kept(incoming.headers, heldModelHeaders),
        keyHeader: keyHeaderOf(incoming.headers),
        body: incoming.body,
        ...(length !== null && { length: Number(length) }),
        signal: incoming.signal,
      })
      switch (sent._tag) {
        case "NotActive":
          return yield* refused(401, "Expected the mod token of an Active Session")
        case "NotPi":
          return yield* refused(
            403,
            "Only a pi Session's model calls go through the Gateway: this Session runs Claude Code, on its Creator's Claude credential.",
          )
        case "NotAllowed":
          return yield* refused(
            403,
            `The Gateway sends only model calls to ${nameOf(provider)}: ${request.method} ${url.pathname.slice(modelGatewayPath(provider).length)} isn't one pi makes.`,
          )
        case "BadAddress":
          return yield* refused(400, "The Gateway doesn't send a path like that on.")
        case "Busy":
          return yield* refused(
            429,
            `This Session is running ${sent.limit} model calls already, the most the Gateway runs for one at once: try again once one ends.`,
          )
        case "Full":
          return yield* refused(
            503,
            "The Hub is holding as many model calls as it can just now: try again shortly.",
          )
        case "TooLarge":
          return yield* refused(
            413,
            `The request is larger than the Gateway takes: ${sent.limit / 1024 / 1024} MiB.`,
          )
        case "BodyUnreadable":
          return yield* refused(400, "The request's body could not be read.")
        case "NotConnected":
          return yield* refused(403, sent.message)
        case "Unavailable":
          return yield* refused(503, sent.message)
        case "Unreachable":
          return yield* refused(502, "The Provider could not be reached.")
        case "Redirected":
          return yield* refused(
            502,
            `${nameOf(provider)} redirected the call, which the Gateway doesn't follow.`,
          )
        case "Answered": {
          const response = sent.response
          // Logged once the answer has streamed back, or stopped.
          const services = yield* Effect.context<never>()
          void sent.ended.then((end) =>
            Effect.runForkWith(services)(done(response.status, end.bytes, end.outcome)),
          )
          return HttpServerResponse.raw(
            new Response(response.body, {
              status: response.status,
              statusText: response.statusText,
              headers: kept(response.headers, heldResponseHeaders),
            }),
          )
        }
      }
    }).pipe(Effect.annotateLogs({ component: "Gateway" }), Effect.withSpan("Gateway.modelCall"))
    yield* router.add("*", "/gateway/models/:provider/*", modelCall)

    // Nothing lies under an Installation's path: not least OAuth's `/.well-known` documents, which
    // Claude Code would look for to begin OAuth itself (#217). Not the web UI either.
    yield* router.add(
      "*",
      "/gateway/:installationId/:below/*",
      Effect.succeed(errorResponse(404, "There is nothing under an Installation's Gateway path.")),
    )
  }),
)
