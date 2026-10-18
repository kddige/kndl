// Sending a request through an Installation (ADR 0020, #254): the one way the Hub reaches an
// Installation's remote MCP server, both for the Gateway (GatewayRoutes.ts), which relays a
// Session's request, and for a Session's start, which checks each server first (#216). Each says
// what the outcome means for it; this module decides what the outcome is.
//
// - Authorising: a running Session reaches only an Installation it started with, while it is
//   Active and the Installation is still on for its Repo; a starting one, those on for its Repo.
//   It is authorised again before a request is sent once more.
// - The credential: the Installation's header secrets, or its OAuth access token as the Hub holds
//   it now (#217), are set over any header of the same name, by any case.
// - A `401` to an OAuth Installation's token has it refreshed, and the request authorised and sent
//   once more; its body is held to be sent again, up to MaxOAuthRequestBytes. Refused again, or
//   with the connection lost, the request isn't sent a third time. A token that a server took is
//   noted, so a refusal of it later is tried once more too.
// - A redirect isn't followed. Bodies stream both ways; answers come back compressed or not, as
//   sent.
// - A Session's model call (ADR 0029) goes to its Provider's own API, at the origin pi-ai's
//   built-in provider has, or its Creator's sign-in names, with the path pi sent. Its Creator's key
//   takes the Session token's place, in the header pi sent that in, and a sign-in's own headers
//   are added, as pi-ai's `toAuth` says (PiProviders.ts). Its body is held, to be sent again once
//   a sign-in refused is refreshed; the answer streams back.

import type { InstallationId, ModelProvider, SessionId } from "@kndl/protocol"
import { Context, type Duration, Effect, Layer, Option, Redacted } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { type CallCredential, ConnectedProviders, ProviderApis } from "./ConnectedProviders.ts"
import { McpServerOAuth } from "./McpServerOAuth.ts"
import { type GatewayTarget, McpServers } from "./McpServers.ts"
import { apiOrigin, authorize, type KeyHeader } from "./PiProviders.ts"
import { readAtMost } from "./ReadAtMost.ts"
import type { SecretsUnavailable } from "./Secrets.ts"
import { Sessions } from "./Sessions.ts"

/**
 * The most of an OAuth Installation's request body the Hub holds (#217), to send it again once its
 * token is refreshed. MCP's JSON-RPC messages are far smaller; a Sandbox sending a larger one
 * mustn't make the Hub hold it all.
 */
export const MaxOAuthRequestBytes = 4 * 1024 * 1024

/**
 * Who sends: a running Session, by its id, which must be Active and have started with the
 * Installation; or one starting, which starts with those on for its Repo.
 */
export type Sender = SessionId | { readonly starting: SessionId; readonly repo: string }

/** Why the Session can't reach the Installation now. */
export type Refusal =
  /** The Session isn't Active, or there is no such Session. */
  | { readonly _tag: "NotActive" }
  /** The Installation isn't one the Session started with, or isn't on for its Repo now. */
  | { readonly _tag: "Off" }
  /** Without a value for a header secret; an OAuth one not connected, or not refreshable now. */
  | Exclude<GatewayTarget, ReadyTarget>
  /** The Hub can't decrypt the Installation's credentials. */
  | { readonly _tag: "Unreadable"; readonly error: SecretsUnavailable }

/** The Installation's MCP server, as the Session may reach it now: what to send a request with. */
export interface Authorised {
  readonly _tag: "Authorised"
  readonly sender: Sender
  readonly installationId: InstallationId
  readonly target: ReadyTarget
}

/** A request to send through an Installation, without credentials: those are added. */
export interface McpRequest {
  readonly method: string
  readonly headers: Headers
  readonly body: ReadableStream<Uint8Array> | string | null
  /** The body's length, if its sender said it. */
  readonly length?: number
  readonly signal?: AbortSignal
}

/** What sending a request through an Installation came to. */
export type Sent =
  /** The server's answer, unless a redirect, its body unread. */
  | { readonly _tag: "Answered"; readonly response: Response }
  /** The server redirected, which isn't followed. */
  | { readonly _tag: "Redirected"; readonly status: number }
  /** The server could not be reached, or didn't answer in time. */
  | { readonly _tag: "Unreachable" }
  /** An OAuth Installation's request body is larger than MaxOAuthRequestBytes: none was sent. */
  | { readonly _tag: "TooLarge" }
  /** An OAuth Installation's request body could not be read: none was sent. */
  | { readonly _tag: "BodyUnreadable" }
  /** The server refused the OAuth token, and the refreshed one too. */
  | { readonly _tag: "Refused" }
  /**
   * The server refused the OAuth token, and the connection is lost, or `error` kept its tokens
   * from being read: the request isn't sent again. It may have been reconnected meanwhile.
   */
  | { readonly _tag: "Lost"; readonly error?: SecretsUnavailable }
  /** Its OAuth token refreshed, the Session could no longer reach the Installation. */
  | Refusal

/** What checking a server came to: as {@link Sent}, the answer's body discarded. */
export type Checked = Exclude<Sent, { readonly _tag: "TooLarge" | "BodyUnreadable" }>

/** Where a request through an Installation goes: its MCP server's URL, with its header secrets. */
type ReadyTarget = Extract<GatewayTarget, { readonly _tag: "Ready" }>

/**
 * Sends the request to the target's server, its header secrets set over any header of the same
 * name, by any case. The answer, or none when the server could not be reached.
 */
const forward = (
  target: ReadyTarget,
  request: {
    readonly method: string
    readonly headers: Headers
    readonly body?: RequestInit["body"]
    readonly signal?: AbortSignal
  },
) =>
  Effect.tryPromise({
    try: (signal) => {
      const headers = new Headers(request.headers)
      // Headers.set replaces one of the same name, by any case.
      for (const { header, value } of target.headers) headers.set(header, Redacted.value(value))
      const hasBody = !["GET", "HEAD"].includes(request.method) && request.body != null
      return fetch(target.url, {
        method: request.method,
        headers,
        ...(hasBody && { body: request.body, duplex: "half" }),
        redirect: "manual",
        // Answers stream back as they come, compressed or not.
        decompress: false,
        signal: request.signal === undefined ? signal : AbortSignal.any([signal, request.signal]),
      } as RequestInit)
    },
    catch: (error) => error,
  }).pipe(Effect.option)

/** Lets an answer's body go unread. */
const discard = (response: Response) =>
  Effect.promise(() => response.body?.cancel() ?? Promise.resolve()).pipe(Effect.ignore)

/**
 * The most of a model call's body the Hub holds, to send it again once a sign-in is refreshed: a
 * conversation with its images, as pi sends it whole each Turn.
 */
export const MaxModelRequestBytes = 64 * 1024 * 1024

/** A Session's call to a Provider's own API (ADR 0029), without credentials: those are added. */
export interface ModelCall {
  readonly method: string
  /** Below the origin of the Provider's API, with the query: `/v1/responses?stream=true`. */
  readonly path: string
  /** Without the Session's own credential, which the Gateway holds back. */
  readonly headers: Headers
  /** The header pi sent the Session's token in as its key, where the Creator's key goes. */
  readonly keyHeader: KeyHeader
  readonly body: Uint8Array | undefined
  readonly signal?: AbortSignal
}

/** What sending a Session's model call came to. */
export type ModelCallSent =
  /** The Provider's answer, its body unread. */
  | { readonly _tag: "Answered"; readonly response: Response }
  /** The Session isn't Active, or there is no such Session. */
  | { readonly _tag: "NotActive" }
  /** Its Creator hasn't connected the Provider, or must connect it again: `message` says which. */
  | { readonly _tag: "NotConnected"; readonly message: string }
  /** The Creator's sign-in couldn't be refreshed just now. */
  | { readonly _tag: "Unavailable"; readonly message: string }
  /** The Provider could not be reached. */
  | { readonly _tag: "Unreachable" }

/** The MCP version the check speaks: one every Streamable HTTP server answers. */
const checkProtocolVersion = "2025-06-18"

export class Gateway extends Context.Service<
  Gateway,
  {
    /** Whether the Session may reach the Installation now: how, or why not. */
    readonly authorise: (
      sender: Sender,
      installationId: InstallationId,
    ) => Effect.Effect<Authorised | Refusal, SqlError>
    /**
     * Sends the request through the Installation, with its credential: once more if its server
     * refuses an OAuth token, refreshed and authorised again. The Installation's account, an OAuth
     * one, is noted as working on any 2xx answer.
     */
    readonly send: (authorised: Authorised, request: McpRequest) => Effect.Effect<Sent, SqlError>
    /**
     * Checks the server as Claude Code starts with it: an MCP `initialize`, sent as
     * {@link send} does, waiting up to `timeout` for each answer's status. A server that opened
     * an MCP session for it is asked to end it. Nothing of what the server answers is kept.
     */
    readonly check: (
      authorised: Authorised,
      timeout: Duration.Duration,
    ) => Effect.Effect<Checked, SqlError>
    /**
     * Sends the Session's model call to the Provider with its Creator's credential, while the
     * Session is Active: a sign-in that expires within 5 minutes refreshed first, and once more
     * after the Provider refuses it, with the call sent again.
     */
    readonly model: (
      sessionId: SessionId,
      provider: ModelProvider,
      call: ModelCall,
    ) => Effect.Effect<ModelCallSent, SqlError>
  }
>()("@kndl/hub/Gateway") {
  static readonly layer = Layer.effect(
    Gateway,
    Effect.gen(function* () {
      const sessions = yield* Sessions
      const mcpServers = yield* McpServers
      const oauth = yield* McpServerOAuth
      const providers = yield* ConnectedProviders
      const apis = yield* ProviderApis

      /**
       * Where the Session may reach the Installation's MCP server. A token is live only while
       * its Session is Active: an Asleep Session's is left from its last run, until its next start
       * replaces it.
       */
      const authorise = Effect.fn("Gateway.authorise")(function* (
        sender: Sender,
        installationId: InstallationId,
      ): Effect.fn.Return<Authorised | Refusal, SqlError> {
        let session: { readonly id: SessionId; readonly repo: string }
        if (typeof sender === "string") {
          const started = yield* sessions.startedWith(sender)
          if (Option.isNone(started) || started.value.state !== "Active") {
            return { _tag: "NotActive" }
          }
          const startedWith = started.value.mcpServers
          if (!startedWith.some((installation) => installation.id === installationId)) {
            return { _tag: "Off" }
          }
          session = { id: sender, repo: started.value.repo }
        } else {
          session = { id: sender.starting, repo: sender.repo }
        }
        return yield* mcpServers.gatewayTarget(installationId, session).pipe(
          Effect.map((on): Authorised | Refusal => {
            if (Option.isNone(on)) return { _tag: "Off" }
            if (on.value._tag !== "Ready") return on.value
            return { _tag: "Authorised", sender, installationId, target: on.value }
          }),
          Effect.catchTag("SecretsUnavailable", (error) =>
            Effect.succeed<Refusal>({ _tag: "Unreadable", error }),
          ),
        )
      })

      /**
       * Sends the request, once more with fresh tokens if its server refused an OAuth token
       * (#217); the target it was last sent to, for a request that follows it.
       */
      const deliver = Effect.fn("Gateway.deliver")(function* (
        authorised: Authorised,
        request: Omit<McpRequest, "body" | "length"> & { readonly body: RequestInit["body"] },
        timeout?: Duration.Duration,
      ): Effect.fn.Return<{ readonly sent: Checked; readonly target?: ReadyTarget }, SqlError> {
        const { sender, installationId } = authorised
        let ready = authorised.target
        const send = (to: ReadyTarget) => {
          const sent = forward(to, request)
          return timeout === undefined
            ? sent
            : sent.pipe(Effect.timeoutOption(timeout), Effect.map(Option.flatten))
        }

        let answer = yield* send(ready)
        for (let tries = 1; ready.oauth !== undefined; tries++) {
          if (Option.isNone(answer) || answer.value.status !== 401) break
          yield* discard(answer.value)
          const next = yield* oauth
            .rejected(installationId, ready.oauth.generation)
            .pipe(
              Effect.catchTag("SecretsUnavailable", (error) =>
                Effect.succeed({ _tag: "Lost" as const, error }),
              ),
            )
          if (next !== "Retry") return { sent: next === "Lost" ? { _tag: "Lost" } : next }
          if (tries >= 2) return { sent: { _tag: "Refused" } }
          const again = yield* authorise(sender, installationId)
          if (again._tag !== "Authorised") return { sent: again }
          ready = again.target
          answer = yield* send(ready)
        }
        if (Option.isNone(answer)) return { sent: { _tag: "Unreachable" } }
        const response = answer.value
        if (response.status >= 300 && response.status < 400) {
          yield* discard(response)
          return { sent: { _tag: "Redirected", status: response.status } }
        }
        if (response.ok && ready.oauth !== undefined) {
          oauth.works(installationId, ready.oauth.generation)
        }
        return { sent: { _tag: "Answered", response }, target: ready }
      })

      const send = Effect.fn("Gateway.send")(function* (
        authorised: Authorised,
        request: McpRequest,
      ): Effect.fn.Return<Sent, SqlError> {
        // An OAuth Installation's request is sent again once its token is refused and refreshed:
        // its body is read first, up to MaxOAuthRequestBytes, whether it says its length or comes
        // in chunks.
        let body: RequestInit["body"] = request.body
        if (authorised.target.oauth !== undefined && typeof request.body === "object") {
          const stream = request.body
          if (stream !== null) {
            if ((request.length ?? 0) > MaxOAuthRequestBytes) return { _tag: "TooLarge" }
            const read = yield* Effect.tryPromise(() =>
              readAtMost(stream, MaxOAuthRequestBytes),
            ).pipe(Effect.option)
            if (Option.isNone(read)) return { _tag: "BodyUnreadable" }
            if (read.value === undefined) return { _tag: "TooLarge" }
            body = read.value
          }
        }
        return (yield* deliver(authorised, { ...request, body })).sent
      })

      const check = Effect.fn("Gateway.check")(function* (
        authorised: Authorised,
        timeout: Duration.Duration,
      ): Effect.fn.Return<Checked, SqlError> {
        const headers = new Headers({
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        })
        const { sent, target } = yield* deliver(
          authorised,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 0,
              method: "initialize",
              params: {
                protocolVersion: checkProtocolVersion,
                capabilities: {},
                clientInfo: { name: "kndl", version: "1.0.0" },
              },
            }),
          },
          timeout,
        )
        if (sent._tag !== "Answered") return sent
        const response = sent.response
        yield* discard(response)
        const session = response.headers.get("mcp-session-id")
        if (response.ok && session !== null && target !== undefined) {
          headers.set("mcp-session-id", session)
          headers.set("mcp-protocol-version", checkProtocolVersion)
          const ended = yield* forward(target, { method: "DELETE", headers }).pipe(
            Effect.timeoutOption(timeout),
            Effect.map(Option.flatten),
          )
          if (Option.isSome(ended)) yield* discard(ended.value)
        }
        return sent
      })

      const model = Effect.fn("Gateway.model")(function* (
        sessionId: SessionId,
        provider: ModelProvider,
        call: ModelCall,
      ): Effect.fn.Return<ModelCallSent, SqlError> {
        const session = yield* sessions.get(sessionId)
        if (Option.isNone(session) || session.value.state !== "Active") return { _tag: "NotActive" }
        const creator = session.value.creator.id
        const credential = yield* Effect.result(providers.credentialFor(creator, provider))
        if (credential._tag === "Failure") {
          const { reason, message } = credential.failure
          return reason === "Unavailable"
            ? { _tag: "Unavailable", message }
            : { _tag: "NotConnected", message }
        }
        const sendCall = (callWith: CallCredential) =>
          Effect.tryPromise({
            try: (signal) => {
              const auth = Redacted.value(callWith.auth)
              const to = `${apiOrigin(provider, auth)}${call.path}`
              const headers = new Headers(call.headers)
              authorize(headers, auth, call.keyHeader)
              const hasBody = !["GET", "HEAD"].includes(call.method) && call.body !== undefined
              return apis.fetch(
                new Request(to, {
                  method: call.method,
                  headers,
                  ...(hasBody && { body: call.body }),
                  redirect: "manual",
                  signal:
                    call.signal === undefined ? signal : AbortSignal.any([signal, call.signal]),
                } as RequestInit),
                // Answers stream back as they come, compressed or not.
                { decompress: false },
              )
            },
            catch: (error) => error,
          }).pipe(Effect.option)

        const first = yield* sendCall(credential.success)
        if (Option.isNone(first)) return { _tag: "Unreachable" }
        if (first.value.status !== 401 || credential.success.kind !== "SignIn") {
          return { _tag: "Answered", response: first.value }
        }
        const next = yield* providers.rejected(
          creator,
          provider,
          Redacted.value(credential.success.token),
        )
        if (Option.isNone(next)) return { _tag: "Answered", response: first.value }
        yield* discard(first.value)
        const again = yield* sendCall(next.value)
        return Option.isNone(again)
          ? { _tag: "Unreachable" }
          : { _tag: "Answered", response: again.value }
      })

      return Gateway.of({ authorise, send, check, model })
    }),
  )
}
