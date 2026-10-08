// The Gateway (#221, ADR 0020): how a Session's Claude Code reaches the remote MCP server of each
// Installation it runs with. MCP traffic goes through the Hub, so that a Plugin's credentials, once
// it has them, stay on the Hub, and only the Hub decides which Session reaches which server.
//
// - `/gateway/<installation id>`, any method, by the Session's mod token alone as `Authorization:
//   Bearer`: the token the Runner's credential proxy relays it with (ADR 0013). A request without
//   a live token is answered `401`.
// - The Installation must be one the Session started with, and still on for its Repo; any other is
//   answered `403`, alike whether it exists or not. One removed from the Repo stops at once; one
//   added waits for the Session's next wake or Restart.
// - The request goes to the Plugin's URL as it is now, so an edit to it reaches running Sessions
//   at once. Its body and the answer's stream both ways untouched: Streamable HTTP's server-sent
//   events, compression and all. The Session token, cookies and hop-by-hop headers stay behind;
//   the server's cookies don't come back. A redirect isn't followed: it is answered `502`.
// - The Plugin's header secrets (#215) are added as its declarations say now, from the values the
//   Session started with, which only the Hub holds: a header of the same name from the Sandbox, by
//   any case, is dropped. An Installation without a value for one is answered `409`, naming it and
//   the header secret's title.
// - Each request is logged with its Session, Installation, method, status and time taken, and
//   nothing of what it carries.

import {
  type InstallationId,
  InstallationId as InstallationIdSchema,
  type SessionId,
} from "@kndl/protocol"
import { Clock, Effect, Option, Redacted } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { authenticateMod } from "./Auth.ts"
import { Plugins } from "./Plugins.ts"
import { Sessions } from "./Sessions.ts"

const errorResponse = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status })

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

        const found = yield* target(grant.sessionId, installationId).pipe(
          Effect.catchTag("SecretsUnavailable", (error) =>
            Effect.as(
              Effect.logError("Could not decrypt an Installation's header secret values", error),
              500 as const,
            ),
          ),
        )
        if (found === 401) {
          yield* done(401)
          return errorResponse(401, "Expected the mod token of an Active Session")
        }
        if (found === 403) {
          yield* done(403)
          return errorResponse(403, "This Installation isn't on for the Session's Repo.")
        }
        if (found === 500) {
          yield* done(500)
          return errorResponse(
            500,
            "The Hub could not read this Installation's header secret values: check HUB_SECRETS_KEY.",
          )
        }
        if (found._tag === "NeedsValue") {
          yield* done(409)
          return errorResponse(409, found.message)
        }
        const incoming = yield* HttpServerRequest.toWeb(request)
        const headers = kept(incoming.headers, heldRequestHeaders)
        // Headers.set replaces one of the same name, by any case.
        for (const { header, value } of found.headers) headers.set(header, Redacted.value(value))
        const hasBody = !["GET", "HEAD"].includes(request.method)
        const answer = yield* Effect.tryPromise({
          try: (signal) =>
            fetch(found.url, {
              method: request.method,
              headers,
              ...(hasBody && { body: incoming.body, duplex: "half" }),
              redirect: "manual",
              // Answers stream back as they come, compressed or not.
              decompress: false,
              signal: AbortSignal.any([signal, incoming.signal]),
            } as RequestInit),
          catch: (error) => error,
        }).pipe(Effect.option)
        if (Option.isNone(answer)) {
          yield* done(502)
          return errorResponse(502, "The Plugin's MCP server could not be reached.")
        }
        const response = answer.value
        if (response.status >= 300 && response.status < 400) {
          yield* Effect.promise(() => response.body?.cancel() ?? Promise.resolve())
          yield* done(502)
          return errorResponse(
            502,
            "The Plugin's MCP server redirected, which the Gateway doesn't follow.",
          )
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
  }),
)
