// How the Hub reaches an Installation's remote MCP server (ADR 0020): the one way both the Gateway
// (GatewayRoutes.ts) relays a Session's request, and a Session's start checks the server first
// (#216). The MCP server's header secrets are added as the target says; a redirect isn't followed.

import { type Duration, Effect, Option, Redacted } from "effect"
import type { GatewayTarget } from "./McpServers.ts"

/** Where a request through an Installation goes: its MCP server's URL, with its header secrets. */
export type ReadyTarget = Extract<GatewayTarget, { readonly _tag: "Ready" }>

/**
 * Sends the request to the target's server, its header secrets set over any header of the same
 * name, by any case. Bodies stream both ways; answers come back compressed or not, as sent. The
 * answer, or none when the server could not be reached.
 */
export const forward = (
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

/**
 * A body read to its end, unless it is longer than `max` bytes: then the rest is left unread, and
 * it is `undefined`. However the sender frames it, the Hub never holds more than `max` of it.
 */
export const readAtMost = async (
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<Uint8Array | undefined> => {
  if (body === null) return new Uint8Array(0)
  const reader = body.getReader()
  const chunks: Array<Uint8Array> = []
  let size = 0
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    size += read.value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => undefined)
      return undefined
    }
    chunks.push(read.value)
  }
  return Buffer.concat(chunks, size)
}

/** Lets an answer's body go unread. */
const discard = (response: Response) =>
  Effect.promise(() => response.body?.cancel() ?? Promise.resolve()).pipe(Effect.ignore)

/** What checking an Installation's MCP server found, before a Session starts with it (#216). */
export type ServerCheck =
  | { readonly _tag: "Works" }
  /** It answered 401 or 403: it refuses the credential. */
  | { readonly _tag: "Rejected"; readonly status: number }
  /** It answered another error, or a redirect, which the Gateway doesn't follow. */
  | { readonly _tag: "Errored"; readonly status: number }
  /** It could not be reached, or didn't answer in time. */
  | { readonly _tag: "Unreachable" }

/** The MCP version the check speaks: one every Streamable HTTP server answers. */
const checkProtocolVersion = "2025-06-18"

/**
 * Checks the server as Claude Code starts with it: an MCP `initialize`, through the Gateway's own
 * path, waiting up to `timeout` for its answer's status. A server that opened an MCP session for
 * it is asked to end it. Nothing of what the server answers is kept, nor any header sent.
 */
export const checkServer = Effect.fn("Gateway.checkServer")(function* (
  target: ReadyTarget,
  timeout: Duration.Duration,
): Effect.fn.Return<ServerCheck> {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  })
  const answer = yield* forward(target, {
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
  }).pipe(Effect.timeoutOption(timeout), Effect.map(Option.flatten))
  if (Option.isNone(answer)) return { _tag: "Unreachable" }
  const response = answer.value
  yield* discard(response)
  const { status } = response
  if (status === 401 || status === 403) return { _tag: "Rejected", status }
  if (status < 200 || status >= 300) return { _tag: "Errored", status }
  const session = response.headers.get("mcp-session-id")
  if (session !== null) {
    headers.set("mcp-session-id", session)
    headers.set("mcp-protocol-version", checkProtocolVersion)
    const ended = yield* forward(target, { method: "DELETE", headers }).pipe(
      Effect.timeoutOption(timeout),
      Effect.map(Option.flatten),
    )
    if (Option.isSome(ended)) yield* discard(ended.value)
  }
  return { _tag: "Works" }
})
