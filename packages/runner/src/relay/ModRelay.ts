// The mod relay (ADR 0026): one per Runner, on the host's loopback, which every Session's Sandbox
// reaches at host.microsandbox.internal, so no Sandbox needs a route to the Hub. The mod and Claude
// Code's MCP traffic in a Sandbox hold only its Session token (SessionTokens.ts). The relay:
//
// - answers 401 to a request without a live Session token, the only identity a guest has: every
//   guest's connection arrives from 127.0.0.1. A token held after a Runner restart (#157) is
//   answered 503 until it is let in again, which the mod retries;
// - relays the mod's calls, `/mod/*`, to the Hub with the Session's mod token in the token's
//   place, so no mod token enters a Sandbox (ADR 0004, amended);
// - relays Claude Code's MCP traffic to its Installations, `/gateway/*` in any method, to the
//   Hub's Gateway (ADR 0020) the same way, its body streaming as it comes;
// - answers 404 to anything else;
// - streams every response back as it comes, with no buffering and no idle timeout: the mod's
//   command polls wait up to 25 s, and an MCP answer streams for as long as its tool runs.
//
// Claude Code talks to Anthropic itself, on its Creator's Claude credential (ClaudeEnvironment.ts):
// nothing for Anthropic comes here. The relay never logs a mod token or a Session token.

import type { SessionId } from "@kndl/protocol"
import { Context, Data, Effect, Layer, Redacted } from "effect"
import type { Scope } from "effect"
import { RunnerConfig } from "../RunnerConfig.ts"
import { hostFromGuest } from "../sandbox/SessionLayout.ts"
import { RelayConfig } from "./RelayConfig.ts"
import { type SessionGrant, SessionTokens } from "./SessionTokens.ts"

export class ModRelayError extends Data.TaggedError("ModRelayError")<{
  readonly message: string
}> {}

export class ModRelay extends Context.Service<
  ModRelay,
  {
    /** The relay as a guest reaches it: `http://host.microsandbox.internal:<port>`. */
    readonly guestUrl: string
    /** The relay on the host's loopback. */
    readonly hostUrl: string
    /**
     * Issues the Session a new token, standing for its mod token, kept in memory alone. Any token
     * it had before is revoked. Run as it starts or wakes, and for a Session kept running across a
     * Runner restart, which is let in again on the token it holds.
     */
    readonly admit: (grant: SessionGrant) => Effect.Effect<Redacted.Redacted<string>>
    /**
     * Holds the token a Session's Claude Code was started with, read back after a Runner restart,
     * until {@link admit} lets it in again. False for one that isn't a Session token, or is another's.
     */
    readonly hold: (sessionId: SessionId, token: string) => Effect.Effect<boolean>
    /**
     * Revokes the Session's token and forgets its mod token. Run as it sleeps, is archived or
     * exits. A response already streaming runs to its end.
     */
    readonly revoke: (sessionId: SessionId) => Effect.Effect<void>
  }
>()("@kndl/runner/ModRelay") {}

/** The mod's calls to the Hub, relayed with its mod token. */
const isModCall = (method: string, path: string) =>
  (method === "GET" || method === "POST") && path.startsWith("/mod/")

/**
 * Claude Code's MCP traffic to its Installations (ADR 0020), relayed to the Hub's Gateway with the
 * mod token, in whatever method Streamable HTTP sends it.
 */
const isGatewayCall = (path: string) => path.startsWith("/gateway/")

/**
 * Headers never passed on: per-connection ones, the Session token replaced, a length the stream
 * sets itself, and `accept-encoding`, so the response comes back uncompressed and the client
 * reads it as is.
 */
const notForwarded = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "authorization",
  "cookie",
  "content-length",
  "accept-encoding",
])

/** The headers of a response not passed back: the stream sets its own framing. */
const notReturned = new Set(["content-length", "transfer-encoding", "connection", "keep-alive"])

/** The Session token a request presents, as a bearer. */
export function presentedToken(headers: Headers): string | undefined {
  const authorization = headers.get("authorization")
  return authorization?.startsWith("Bearer ") === true
    ? authorization.slice("Bearer ".length)
    : undefined
}

/** An answer the relay gives itself, worded as the Hub words one. */
const answer = (status: number, message: string) => Response.json({ message }, { status })

const returned = (response: Response) => {
  const headers = new Headers()
  for (const [name, value] of response.headers) if (!notReturned.has(name)) headers.set(name, value)
  return new Response(response.body, { status: response.status, headers })
}

/**
 * Bun's fetch options the DOM's RequestInit lacks: no timeout, as a command poll waits and an MCP
 * answer streams, and the body exactly as sent.
 */
const streaming = { timeout: false, decompress: false } as unknown as RequestInit

/** Sends a request on, its response streaming back. A body read whole, or streaming on as it comes. */
const send = (
  url: string,
  request: Request,
  headers: Headers,
  body: ArrayBuffer | ReadableStream<Uint8Array> | null | undefined,
) =>
  Effect.tryPromise({
    try: () =>
      fetch(url, {
        method: request.method,
        headers,
        body,
        ...(body instanceof ReadableStream && { duplex: "half" }),
        redirect: "manual",
        signal: request.signal,
        ...streaming,
      } as RequestInit),
    // Fetch's error names the URL at most, never a header.
    catch: (error) => new ModRelayError({ message: String(error) }),
  })

/** A request's body, read whole: the mod's are small. */
const readBody = (request: Request) =>
  request.body === null
    ? Effect.succeed(undefined)
    : Effect.tryPromise({
        try: () => request.arrayBuffer(),
        catch: () => new ModRelayError({ message: "the request body was cut off" }),
      })

export interface RelayHandlerOptions {
  /** The Hub, which the mod's calls and MCP traffic are relayed to. */
  readonly hubUrl: URL
}

/** Answers one request to the relay. Never fails: a problem is answered as the Hub would answer it. */
export const makeRelayHandler = (options: RelayHandlerOptions) =>
  Effect.gen(function* () {
    const tokens = yield* SessionTokens
    const hub = options.hubUrl.href.replace(/\/+$/, "")

    /**
     * Relays a mod's call, or Claude Code's MCP traffic, to the Hub, with the Session's mod token.
     * MCP traffic's body streams on as it comes.
     */
    const toHub = (request: Request, url: URL, grant: SessionGrant) =>
      Effect.gen(function* () {
        const headers = new Headers()
        for (const [name, value] of request.headers)
          if (!notForwarded.has(name)) headers.set(name, value)
        headers.set("authorization", `Bearer ${Redacted.value(grant.modToken)}`)
        const body = isGatewayCall(url.pathname) ? request.body : yield* readBody(request)
        const response = yield* send(`${hub}${url.pathname}${url.search}`, request, headers, body)
        // The Gateway answers 403 for an Installation the Session doesn't run with.
        if (response.status === 401 || (response.status === 403 && !isGatewayCall(url.pathname)))
          yield* Effect.logWarning(
            `Session ${grant.sessionId}: the Hub refused its mod token (${response.status} on ${url.pathname})`,
          )
        return returned(response)
      }).pipe(
        Effect.catchTag("ModRelayError", (error) =>
          request.signal.aborted
            ? Effect.succeed(new Response(null, { status: 499 }))
            : Effect.as(
                Effect.logWarning(
                  `Session ${grant.sessionId}: relaying ${url.pathname} to the Hub failed: ${error.message}`,
                ),
                answer(502, "the Runner could not reach the Hub"),
              ),
        ),
      )

    return (request: Request): Effect.Effect<Response> =>
      Effect.gen(function* () {
        // Parsing resolves dot segments, so `/mod/../v1/models` is checked as `/v1/models`.
        const url = new URL(request.url)
        const { method } = request
        const path = url.pathname
        const token = presentedToken(request.headers)
        const grant = token === undefined ? undefined : yield* tokens.find(token)
        if (grant === undefined) {
          yield* Effect.logWarning(`Refused ${method} ${path}: no live Session token`)
          return answer(401, "no live Session token")
        }
        if (grant === "Held") {
          const retry = answer(503, "the Runner restarted; try again in a moment")
          retry.headers.set("retry-after", "1")
          return retry
        }
        if (isModCall(method, path) || isGatewayCall(path)) return yield* toHub(request, url, grant)
        yield* Effect.logWarning(`Session ${grant.sessionId}: refused ${method} ${path}`)
        return answer(404, `${method} ${path} is not relayed`)
      })
  })

export interface ServeOptions extends RelayHandlerOptions {
  /** The port on the host's loopback; 0 for any free one. */
  readonly port: number
}

/** Serves the relay on the host's loopback for as long as the scope is open; its port. */
export const serveModRelay = (
  options: ServeOptions,
): Effect.Effect<number, ModRelayError, SessionTokens | Scope.Scope> =>
  Effect.gen(function* () {
    const handle = yield* makeRelayHandler(options)
    const context = yield* Effect.context<never>()
    const run = Effect.runPromiseWith(context)
    const server = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: options.port,
            // A mod's command poll waits in silence, and an MCP answer streams.
            idleTimeout: 0,
            fetch: (request) => run(handle(request)),
          }),
        catch: (error) =>
          new ModRelayError({
            message: `could not listen on 127.0.0.1:${options.port}: ${error instanceof Error ? error.message : String(error)}`,
          }),
      }),
      (listening) => Effect.promise(() => listening.stop(true)),
    )
    return server.port ?? options.port
  })

/**
 * The mod relay on `RUNNER_RELAY_PORT`, from the Runner's start. One that can't listen, as when
 * another process has the port, is logged, and the Runner runs on: the mods of Sessions in
 * Sandboxes can't reach the Hub until it can.
 */
export const ModRelayLive = Layer.effect(
  ModRelay,
  Effect.gen(function* () {
    const config = yield* RunnerConfig
    const relayConfig = yield* RelayConfig
    const tokens = yield* SessionTokens
    const port = yield* serveModRelay({ port: relayConfig.port, hubUrl: config.hubUrl }).pipe(
      Effect.tap((bound) => Effect.logInfo(`Mod relay listening on 127.0.0.1:${bound}`)),
      Effect.catchTag("ModRelayError", (error) =>
        Effect.as(
          Effect.logError(
            `The mod relay is down: ${error.message}. Set RUNNER_RELAY_PORT to a free port.`,
          ),
          relayConfig.port,
        ),
      ),
    )
    return makeModRelay({ port, tokens })
  }),
)

/** The relay's service, over Session tokens, for a relay listening on `port`. */
export const makeModRelay = (options: {
  readonly port: number
  readonly tokens: SessionTokens["Service"]
}) =>
  ModRelay.of({
    guestUrl: `http://${hostFromGuest}:${options.port}`,
    hostUrl: `http://127.0.0.1:${options.port}`,
    admit: options.tokens.issue,
    hold: options.tokens.hold,
    revoke: options.tokens.revoke,
  })
