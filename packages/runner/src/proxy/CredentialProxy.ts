// The credential proxy (ADR 0013): one per Runner, on the host's loopback, which every Session's
// Sandbox reaches at host.microsandbox.internal. Claude Code in a Sandbox holds only its Session
// token (SessionTokens.ts). The proxy:
//
// - answers 401 to a request without a live Session token, the only identity a guest has: every
//   guest's connection arrives from 127.0.0.1. A token held after a Runner restart (#157) is
//   answered 503 until it is let in again, which Claude Code and the mod both retry;
// - forwards the three requests Claude Code sends Anthropic (spike #142) to Anthropic with the
//   Session's Claude credential, or the Runner's (RunnerCredential.ts), in the token's place, and
//   answers 404 to anything else;
// - relays the mod's calls, `/mod/*`, to the Hub with the Session's mod token in the token's
//   place, so no mod token enters a Sandbox (ADR 0004, amended);
// - streams every response back as it comes, with no buffering and no idle timeout: a Turn
//   streams for minutes, and the mod's command polls wait up to 25 s.
//
// It logs each request to Anthropic under its Session, and never a credential, a mod token or a
// Session token.

import type { ClaudeCredential, SessionId } from "@claude-hub/protocol"
import { Context, Data, Effect, Layer, Redacted } from "effect"
import type { Scope } from "effect"
import { RunnerConfig } from "../RunnerConfig.ts"
import { hostFromGuest } from "../sandbox/SessionLayout.ts"
import { sandboxClaudeEnvironment } from "./ClaudeEnvironment.ts"
import { ProxyConfig } from "./ProxyConfig.ts"
import { RunnerCredential } from "./RunnerCredential.ts"
import { type SessionGrant, SessionTokens } from "./SessionTokens.ts"

export class CredentialProxyError extends Data.TaggedError("CredentialProxyError")<{
  readonly message: string
}> {}

/** What a Session is given to run Claude Code in its Sandbox with. */
export interface SessionPass {
  /** Its Session token, in place of every credential it would hold. */
  readonly token: Redacted.Redacted<string>
  /**
   * Whose Claude credential the proxy uses for it: the Session's own, the Runner's, or none, as
   * when the Runner has none either. Then every request to Anthropic is answered 401.
   */
  readonly credential: "Session" | "Runner" | "None"
  /**
   * The environment Claude Code and its mod run with in the Sandbox, Session token included (see
   * ClaudeEnvironment.ts). The rest of the mod's environment is as on the host.
   */
  readonly env: Readonly<Record<string, string>>
}

export class CredentialProxy extends Context.Service<
  CredentialProxy,
  {
    /** The proxy as a guest reaches it: `http://host.microsandbox.internal:<port>`. */
    readonly guestUrl: string
    /** The proxy on the host's loopback. */
    readonly hostUrl: string
    /**
     * Issues the Session a new token, standing for its mod token and, when it has one, its
     * Creator's Claude credential, kept in memory alone. Any token it had before is revoked. Run
     * as it starts or wakes, and for a Session kept running across a Runner restart, which is let
     * in again on the token it holds.
     */
    readonly admit: (grant: SessionGrant) => Effect.Effect<SessionPass>
    /**
     * Holds the token a Session's Claude Code was started with, read back after a Runner restart,
     * until {@link admit} lets it in again. False for one that isn't a Session token, or is another's.
     */
    readonly hold: (sessionId: SessionId, token: string) => Effect.Effect<boolean>
    /**
     * Revokes the Session's token and forgets what it stood for. Run as it sleeps, is archived or
     * exits. A response already streaming runs to its end.
     */
    readonly revoke: (sessionId: SessionId) => Effect.Effect<void>
    /**
     * How the Runner's own Claude credential is shown, for Sessions whose Creator has none (ADR
     * 0015), or undefined when it has none. The Hub is told, so it can refuse a Session neither
     * has one for.
     */
    readonly runnerAccount: Effect.Effect<string | undefined>
  }
>()("@claude-hub/runner/CredentialProxy") {}

/** Anthropic's API, where requests go unless a test says otherwise. */
export const AnthropicApi = "https://api.anthropic.com"

/** The requests Claude Code 2.1.289 sends its base URL (spike #142); anything else is refused. */
const allowed: ReadonlyArray<{ readonly method: string; readonly path: string }> = [
  { method: "POST", path: "/v1/messages" },
  { method: "POST", path: "/v1/messages/count_tokens" },
  { method: "GET", path: "/v1/models" },
]

const isAllowed = (method: string, path: string) =>
  allowed.some((rule) => rule.method === method && rule.path === path)

/** Claude Code's connectivity check, sent without a credential: answered here, never forwarded. */
const isConnectivityCheck = (method: string, path: string) =>
  (method === "HEAD" || method === "GET") && path === "/api/hello"

/** The mod's calls to the Hub, relayed with its mod token. */
const isModCall = (method: string, path: string) =>
  (method === "GET" || method === "POST") && path.startsWith("/mod/")

/**
 * Headers never passed on: per-connection ones, the credentials replaced, a length the stream
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
  "x-api-key",
  "cookie",
  "content-length",
  "accept-encoding",
])

/** The headers of a response not passed back: the stream sets its own framing. */
const notReturned = new Set(["content-length", "transfer-encoding", "connection", "keep-alive"])

/** The `anthropic-beta` flag that lets a request carry a subscription token. */
export const OAuthBeta = "oauth-2025-04-20"

/** The Session token a request presents: Claude Code sends it as a bearer, or as an API key. */
export function presentedToken(headers: Headers): string | undefined {
  const authorization = headers.get("authorization")
  if (authorization?.startsWith("Bearer ") === true) return authorization.slice("Bearer ".length)
  return headers.get("x-api-key") ?? undefined
}

const withoutBeta = (value: string | null, flag: string) =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "" && entry !== flag)

/**
 * The headers a request goes to Anthropic with: the client's, less {@link notForwarded}, with
 * the credential in the Session token's place. A subscription token goes as a bearer, with the
 * beta flag that allows it; an API key goes as `x-api-key`, without that flag, which Anthropic
 * refuses API keys with.
 */
export function upstreamHeaders(incoming: Headers, credential: ClaudeCredential): Headers {
  const headers = new Headers()
  for (const [name, value] of incoming) if (!notForwarded.has(name)) headers.set(name, value)
  const betas = withoutBeta(incoming.get("anthropic-beta"), OAuthBeta)
  if (credential._tag === "OAuthToken") {
    headers.set("authorization", `Bearer ${Redacted.value(credential.token)}`)
    headers.set("anthropic-beta", [...betas, OAuthBeta].join(","))
  } else {
    headers.set("x-api-key", Redacted.value(credential.key))
    if (betas.length === 0) headers.delete("anthropic-beta")
    else headers.set("anthropic-beta", betas.join(","))
  }
  return headers
}

const sameCredential = (a: ClaudeCredential, b: ClaudeCredential) =>
  a._tag === "OAuthToken" && b._tag === "OAuthToken"
    ? Redacted.value(a.token) === Redacted.value(b.token)
    : a._tag === "ApiKey" && b._tag === "ApiKey" && Redacted.value(a.key) === Redacted.value(b.key)

/** An error as Anthropic's API words one, which Claude Code shows as it is. */
const apiError = (status: number, type: string, message: string) =>
  Response.json({ type: "error", error: { type, message: `claude-hub: ${message}` } }, { status })

const returned = (response: Response) => {
  const headers = new Headers()
  for (const [name, value] of response.headers) if (!notReturned.has(name)) headers.set(name, value)
  return new Response(response.body, { status: response.status, headers })
}

/**
 * Bun's fetch options the DOM's RequestInit lacks: no timeout, as a Turn streams for minutes,
 * and the body exactly as sent.
 */
const streaming = { timeout: false, decompress: false } as unknown as RequestInit

/** Sends a request on, its response streaming back. */
const send = (url: string, request: Request, headers: Headers, body: ArrayBuffer | undefined) =>
  Effect.tryPromise({
    try: () =>
      fetch(url, {
        method: request.method,
        headers,
        body,
        redirect: "manual",
        signal: request.signal,
        ...streaming,
      }),
    // Fetch's error names the URL at most, never a header.
    catch: (error) => new CredentialProxyError({ message: String(error) }),
  })

/** A request's body, read whole: it is small, and sent again on a retry. */
const readBody = (request: Request) =>
  request.body === null
    ? Effect.succeed(undefined)
    : Effect.tryPromise({
        try: () => request.arrayBuffer(),
        catch: () => new CredentialProxyError({ message: "the request body was cut off" }),
      })

export interface ProxyHandlerOptions {
  /** The Hub, which the mod's calls are relayed to. */
  readonly hubUrl: URL
  /** Anthropic's API; a test's fake. */
  readonly upstream?: string
}

/**
 * Answers one request to the proxy. Never fails: a problem is answered as Anthropic's API, or
 * the Hub, would answer it.
 */
export const makeProxyHandler = (options: ProxyHandlerOptions) =>
  Effect.gen(function* () {
    const tokens = yield* SessionTokens
    const runnerCredential = yield* RunnerCredential
    const upstream = (options.upstream ?? AnthropicApi).replace(/\/+$/, "")
    const hub = options.hubUrl.href.replace(/\/+$/, "")

    /** Sends a request on to Anthropic, with the Runner's credential read again once if refused. */
    const toAnthropic = (request: Request, url: URL, grant: SessionGrant) =>
      Effect.gen(function* () {
        const { sessionId } = grant
        const started = Date.now()
        const target = `${upstream}${url.pathname}${url.search}`
        const own = grant.credential
        let credential = own ?? (yield* runnerCredential.current)
        const body = yield* readBody(request)
        let response = yield* send(
          target,
          request,
          upstreamHeaders(request.headers, credential),
          body,
        )
        // The host's Claude Code may have refreshed its login since it was read, or the owner
        // replaced the setup-token. A Session's own credential is the Hub's to replace.
        if (response.status === 401 && own === undefined) {
          const reread = yield* runnerCredential.reread
          if (!sameCredential(reread, credential)) {
            yield* Effect.promise(async () => response.body?.cancel())
            credential = reread
            response = yield* send(
              target,
              request,
              upstreamHeaders(request.headers, credential),
              body,
            )
          }
        }
        const whose = own === undefined ? "the Runner's credential" : "its own credential"
        const log =
          response.status >= 500 || response.status === 401 ? Effect.logWarning : Effect.logInfo
        yield* log(
          `Session ${sessionId}: ${request.method} ${url.pathname} ${response.status} in ${Date.now() - started} ms, on ${whose}`,
        )
        return returned(response)
      }).pipe(
        Effect.catchTags({
          NoClaudeCredential: (error) =>
            Effect.as(
              Effect.logWarning(
                `Session ${grant.sessionId}: no Claude credential: ${error.message}`,
              ),
              apiError(
                401,
                "authentication_error",
                `this Session has no Claude credential, and the Runner has none: ${error.message}`,
              ),
            ),
          CredentialProxyError: (error) =>
            request.signal.aborted
              ? Effect.succeed(new Response(null, { status: 499 }))
              : Effect.as(
                  Effect.logWarning(
                    `Session ${grant.sessionId}: ${request.method} ${url.pathname} failed: ${error.message}`,
                  ),
                  apiError(502, "api_error", "the Runner could not reach Anthropic"),
                ),
        }),
      )

    /** Relays a mod's call to the Hub, with the Session's mod token. */
    const toHub = (request: Request, url: URL, grant: SessionGrant) =>
      Effect.gen(function* () {
        const headers = new Headers()
        for (const [name, value] of request.headers)
          if (!notForwarded.has(name)) headers.set(name, value)
        headers.set("authorization", `Bearer ${Redacted.value(grant.modToken)}`)
        const body = yield* readBody(request)
        const response = yield* send(`${hub}${url.pathname}${url.search}`, request, headers, body)
        if (response.status === 401 || response.status === 403)
          yield* Effect.logWarning(
            `Session ${grant.sessionId}: the Hub refused its mod token (${response.status} on ${url.pathname})`,
          )
        return returned(response)
      }).pipe(
        Effect.catchTag("CredentialProxyError", (error) =>
          request.signal.aborted
            ? Effect.succeed(new Response(null, { status: 499 }))
            : Effect.as(
                Effect.logWarning(
                  `Session ${grant.sessionId}: relaying ${url.pathname} to the Hub failed: ${error.message}`,
                ),
                Response.json({ message: "the Runner could not reach the Hub" }, { status: 502 }),
              ),
        ),
      )

    return (request: Request): Effect.Effect<Response> =>
      Effect.gen(function* () {
        // Parsing resolves dot segments, so `/v1/messages/../models` is checked as `/v1/models`.
        const url = new URL(request.url)
        const { method } = request
        const path = url.pathname
        if (isConnectivityCheck(method, path)) return new Response(null, { status: 200 })
        const token = presentedToken(request.headers)
        const grant = token === undefined ? undefined : yield* tokens.find(token)
        if (grant === undefined) {
          yield* Effect.logWarning(`Refused ${method} ${path}: no live Session token`)
          return apiError(401, "authentication_error", "no live Session token")
        }
        if (grant === "Held") {
          const answer = apiError(503, "api_error", "the Runner restarted; try again in a moment")
          answer.headers.set("retry-after", "1")
          return answer
        }
        if (isModCall(method, path)) return yield* toHub(request, url, grant)
        if (!isAllowed(method, path)) {
          yield* Effect.logWarning(`Session ${grant.sessionId}: refused ${method} ${path}`)
          return apiError(404, "not_found_error", `${method} ${path} is not forwarded`)
        }
        return yield* toAnthropic(request, url, grant)
      })
  })

export interface ServeOptions extends ProxyHandlerOptions {
  /** The port on the host's loopback; 0 for any free one. */
  readonly port: number
}

/** Serves the proxy on the host's loopback for as long as the scope is open; its port. */
export const serveCredentialProxy = (
  options: ServeOptions,
): Effect.Effect<number, CredentialProxyError, SessionTokens | RunnerCredential | Scope.Scope> =>
  Effect.gen(function* () {
    const handle = yield* makeProxyHandler(options)
    const context = yield* Effect.context<never>()
    const run = Effect.runPromiseWith(context)
    const server = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: options.port,
            // A Turn streams for minutes, and a mod's command poll waits in silence.
            idleTimeout: 0,
            fetch: (request) => run(handle(request)),
          }),
        catch: (error) =>
          new CredentialProxyError({
            message: `could not listen on 127.0.0.1:${options.port}: ${error instanceof Error ? error.message : String(error)}`,
          }),
      }),
      (listening) => Effect.promise(() => listening.stop(true)),
    )
    return server.port ?? options.port
  })

/**
 * The credential proxy on `RUNNER_PROXY_PORT`, from the Runner's start. One that can't listen,
 * as when another process has the port, is logged, and the Runner runs on: Sessions in Sandboxes
 * can't reach Anthropic or the Hub until it can.
 */
export const CredentialProxyLive = Layer.effect(
  CredentialProxy,
  Effect.gen(function* () {
    const config = yield* RunnerConfig
    const proxyConfig = yield* ProxyConfig
    const tokens = yield* SessionTokens
    const runnerCredential = yield* RunnerCredential
    const port = yield* serveCredentialProxy({
      port: proxyConfig.port,
      hubUrl: config.hubUrl,
    }).pipe(
      Effect.tap((bound) => Effect.logInfo(`Credential proxy listening on 127.0.0.1:${bound}`)),
      Effect.catchTag("CredentialProxyError", (error) =>
        Effect.as(
          Effect.logError(
            `The credential proxy is down: ${error.message}. Set RUNNER_PROXY_PORT to a free port.`,
          ),
          proxyConfig.port,
        ),
      ),
    )
    return makeCredentialProxy({ port, tokens, runnerCredential })
  }),
)

/** The proxy's service, over tokens and a credential, for a proxy listening on `port`. */
export const makeCredentialProxy = (options: {
  readonly port: number
  readonly tokens: SessionTokens["Service"]
  readonly runnerCredential: RunnerCredential["Service"]
}) => {
  const guestUrl = `http://${hostFromGuest}:${options.port}`
  return CredentialProxy.of({
    guestUrl,
    hostUrl: `http://127.0.0.1:${options.port}`,
    admit: (grant) =>
      Effect.gen(function* () {
        const token = yield* options.tokens.issue(grant)
        const runners =
          grant.credential === undefined
            ? yield* options.runnerCredential.current.pipe(Effect.orElseSucceed(() => undefined))
            : undefined
        const credential = grant.credential ?? runners
        return {
          token,
          credential:
            grant.credential !== undefined ? "Session" : runners !== undefined ? "Runner" : "None",
          env: sandboxClaudeEnvironment({ proxyUrl: guestUrl, token, credential }),
        } satisfies SessionPass
      }),
    hold: options.tokens.hold,
    revoke: options.tokens.revoke,
    runnerAccount: options.runnerCredential.describe.pipe(
      Effect.map((read) => read.account),
      Effect.orElseSucceed(() => undefined),
    ),
  })
}
