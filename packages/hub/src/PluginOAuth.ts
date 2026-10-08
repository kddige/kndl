// OAuth Installations (#217, ADR 0020): connecting an Installation of a Plugin whose MCP server
// uses OAuth to one account on its authorization server, and keeping its tokens fresh. Only the
// Hub runs OAuth; Claude Code never does, and never sees a token.
//
// - Connecting follows the MCP authorization spec. The Hub asks the MCP server, without a token,
//   for its Protected Resource Metadata (RFC 9728): where its `401`'s `WWW-Authenticate` says, else
//   at its well-known paths. That names the authorization server, whose metadata (RFC 8414, or
//   OpenID Connect's) must offer Dynamic Client Registration (RFC 7591) and PKCE with S256. The Hub
//   registers itself there, once per Installation and authorization server, with its callback,
//   then sends the browser to sign in and consent, with the `resource` (RFC 8707) it wants a token
//   for, and a `state` bound to the person and the Installation, used once, within
//   OAuthConnectTtlMs. The connection begun is kept in memory: a restarted Hub forgets it.
// - The tokens and the client the Hub registered are encrypted with the secrets key (ADR 0009),
//   bound to their Installation, and never sent to the web, a Runner or a Sandbox; nor logged.
// - The Gateway asks for the token on each request, live: a refresh reaches running Sessions at
//   once. Only the Hub refreshes, ahead of the token's expiry, once at a time for each Installation,
//   and saves the refresh token it rotates to before anyone uses it. A refresh the authorization
//   server refuses loses the connection: someone must Reconnect it. One that can't reach it keeps
//   the connection, and is tried again on the next request.
// - A server that refuses a token gets the next one refreshed; refusing that one too, before it
//   worked once, loses the connection.
// - Every fetch here is to https, or to a loopback host, and follows no redirect.

import { createHash, randomBytes } from "node:crypto"
import {
  type InstallationId,
  OAuthConnectTtlMs,
  type ParticipantId,
  type PluginAuth,
} from "@kndl/protocol"
import {
  Clock,
  Context,
  Effect,
  Layer,
  Option,
  PubSub,
  Redacted,
  Schema,
  type Scope,
  Semaphore,
} from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { HubConfig, isLoopback } from "./HubConfig.ts"
import { Secrets, type SecretsUnavailable } from "./Secrets.ts"
import { randomSecret } from "./Tokens.ts"

/** Connecting an Installation failed, saying why: never with a token. */
// oxlint-disable-next-line unicorn/throw-new-error -- Effect makes error classes with a factory call
export class OAuthRefused extends Schema.TaggedError<OAuthRefused>()("OAuthRefused", {
  message: Schema.String,
}) {}

const refuse = (message: string) => Effect.fail(new OAuthRefused({ message }))

/** Where the authorization server sends the browser back to, on the Hub. */
export const OAuthCallbackPath = "/auth/plugins/callback"

/** How long each fetch to an MCP or authorization server may take. */
const fetchTimeoutMs = 15_000

/** The most of an answer read, in characters: metadata and tokens are small. */
const maxAnswer = 256 * 1024

/** A token is refreshed this long before it expires, so none is sent as it does. */
const refreshAhead = 60_000

/** The connections begun and not yet come back, at most; past it, the oldest is dropped. */
const maxPending = 200

/** The client the Hub registered with an Installation's authorization server, kept encrypted. */
const Client = Schema.Struct({
  issuer: Schema.String,
  redirectUri: Schema.String,
  clientId: Schema.String,
  clientSecret: Schema.optionalKey(Schema.String),
  /** When the secret expires, in epoch seconds; 0 or absent when it doesn't (RFC 7591). */
  secretExpiresAt: Schema.optionalKey(Schema.Number),
  authMethod: Schema.Literals(["client_secret_basic", "client_secret_post", "none"]),
  authorizationEndpoint: Schema.String,
  tokenEndpoint: Schema.String,
  userinfoEndpoint: Schema.optionalKey(Schema.String),
  /** Whether the server sends `iss` back with the code (RFC 9207), which must then match. */
  sendsIss: Schema.Boolean,
})
type Client = typeof Client.Type

/** An Installation's tokens, kept encrypted. */
const Tokens = Schema.Struct({
  access: Schema.String,
  refresh: Schema.optionalKey(Schema.String),
  /** When the access token expires, in epoch milliseconds; absent when the server didn't say. */
  expiresAt: Schema.optionalKey(Schema.Number),
  scope: Schema.optionalKey(Schema.String),
  /** The resource (RFC 8707) the tokens are for: the MCP server. */
  resource: Schema.String,
  /** The MCP server refused the access token: refresh it before it is sent again. */
  stale: Schema.optionalKey(Schema.Boolean),
  /** These were refreshed as the server refused the ones before. */
  afterRejection: Schema.optionalKey(Schema.Boolean),
})
type Tokens = typeof Tokens.Type

/** Tokens to use as they are: not refused by the server, nor about to expire. */
const fresh = (tokens: Tokens, now: number) =>
  tokens.stale !== true && (tokens.expiresAt === undefined || tokens.expiresAt - now > refreshAhead)

const ClientJson = Schema.fromJsonString(Client)
const encodeClient = Schema.encodeSync(ClientJson)
const decodeClient = Schema.decodeUnknownOption(ClientJson)
const TokensJson = Schema.fromJsonString(Tokens)
const encodeTokens = Schema.encodeSync(TokensJson)
const decodeTokens = Schema.decodeUnknownOption(TokensJson)

const clientContext = (installation: string) => `installation-oauth-client:${installation}`
const tokensContext = (installation: string) => `installation-oauth-tokens:${installation}`

/**
 * A connection begun, waiting for the browser to come back: what to finish it with. Holds the
 * client's secret, so it stays in memory.
 */
export interface PendingConnection {
  readonly installationId: InstallationId
  readonly by: ParticipantId
  /** Whether the Installation was global as it began (#219): it must still be, or still not. */
  readonly global: boolean
  /** The Repos whose access was checked as it began: the Installation must list no other. */
  readonly repos: ReadonlyArray<string>
  /** The Plugin's URL and auth as it began, which must not change before it finishes. */
  readonly basis: string
  readonly verifier: string
  readonly client: Client
  readonly resource: string
  readonly at: number
}

/** What the authorization server granted a connection: its tokens, and the account. */
export interface Granted {
  readonly tokens: Tokens
  readonly account?: string
}

/** The token the Gateway sends an OAuth Installation's server, or why there is none. */
export type AccessToken =
  | {
      readonly _tag: "Token"
      readonly token: Redacted.Redacted<string>
      /** Which tokens these are, to say which the server refused. */
      readonly generation: number
    }
  /** Never connected, disconnected, or the connection was lost. */
  | { readonly _tag: "NotConnected" }
  /** The token expired, and the authorization server could not be reached to refresh it. */
  | { readonly _tag: "Unavailable" }

/** A connection that changed without anyone asking: refreshed, or lost. */
export interface ConnectionChanged {
  readonly installationId: InstallationId
  readonly lost: boolean
}

/** What a Plugin's URL and auth are as a connection begins, to see whether they changed since. */
export const connectionBasis = (plugin: { readonly url: string; readonly auth: PluginAuth }) =>
  JSON.stringify([plugin.url, plugin.auth])

// ── Fetching ────────────────────────────────────────────────────────────────

/** Whether the Hub may fetch the URL here: https, or http to a loopback host; no credentials. */
const fetchable = (text: unknown): text is string => {
  if (typeof text !== "string") return false
  try {
    const url = new URL(text)
    if (url.username !== "" || url.password !== "") return false
    return url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname))
  } catch {
    return false
  }
}

interface Answer {
  readonly status: number
  readonly headers: Headers
  readonly text: string
}

/** Fetches without following a redirect, or fails saying the host couldn't be reached. */
const call = (url: string, init: RequestInit) =>
  Effect.tryPromise({
    try: async (signal): Promise<Answer> => {
      const response = await fetch(url, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(fetchTimeoutMs)]),
      })
      const text = await response.text()
      return { status: response.status, headers: response.headers, text: text.slice(0, maxAnswer) }
    },
    catch: () => new OAuthRefused({ message: `The Hub couldn't reach ${new URL(url).host}.` }),
  })

/** An answer's JSON object, if it is one. */
const objectOf = (answer: Answer): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(answer.text)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

const stringOf = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : undefined

const stringsOf = (value: unknown) =>
  Array.isArray(value) ? value.filter((one): one is string => typeof one === "string") : undefined

/** A short, one-line text the server sent, to show: never a token. */
const said = (value: unknown) =>
  typeof value === "string"
    ? value
        // oxlint-disable-next-line eslint/no-control-regex -- control characters are what it takes out
        .replaceAll(/[\u0000-\u001f\u007f]/g, " ")
        .trim()
        .slice(0, 200)
    : undefined

/** The `Bearer` challenge's parameters in a `WWW-Authenticate` header. */
export const bearerChallenge = (header: string | null) => {
  const params = new Map<string, string>()
  if (header === null) return params
  const at = header.search(/(^|[\s,])Bearer(\s|$)/i)
  if (at === -1) return params
  for (const match of header
    .slice(at)
    .replace(/^[\s,]*Bearer/i, "")
    .matchAll(/([A-Za-z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]*))/g)) {
    const [, name, quoted, bare] = match
    if (name === undefined || params.has(name.toLowerCase())) continue
    params.set(name.toLowerCase(), quoted?.replaceAll(/\\(.)/g, "$1") ?? bare ?? "")
  }
  return params
}

/** A URL without a trailing slash on its path, to compare an issuer or resource by. */
const bare = (text: string) => text.replace(/\/+$/, "")

/** The well-known URLs for `name` at `url`: under its path, then at the root (RFC 8414 / 9728). */
const wellKnown = (url: URL, name: string) => {
  const path = bare(url.pathname)
  return path === ""
    ? [`${url.origin}/.well-known/${name}`]
    : [`${url.origin}/.well-known/${name}${path}`, `${url.origin}/.well-known/${name}`]
}

/** Where an issuer's metadata may be (RFC 8414, OpenID Connect Discovery), in the MCP spec's order. */
const metadataUrls = (issuer: URL) => {
  const path = bare(issuer.pathname)
  return path === ""
    ? [
        `${issuer.origin}/.well-known/oauth-authorization-server`,
        `${issuer.origin}/.well-known/openid-configuration`,
      ]
    : [
        `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
        `${issuer.origin}/.well-known/openid-configuration${path}`,
        `${issuer.origin}${path}/.well-known/openid-configuration`,
      ]
}

/** A PKCE verifier and its S256 challenge. */
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url")
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }
}

/** The form encoding of a client id or secret in Basic auth (RFC 6749 2.3.1). */
const formEncoded = (text: string) => encodeURIComponent(text).replaceAll("%20", "+")

/** The request to the token endpoint, with the client's credentials as it registered. */
const tokenRequest = (client: Client, params: Record<string, string>): RequestInit => {
  const body = new URLSearchParams(params)
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  })
  if (client.authMethod === "client_secret_basic" && client.clientSecret !== undefined) {
    const pair = `${formEncoded(client.clientId)}:${formEncoded(client.clientSecret)}`
    headers.set("authorization", `Basic ${Buffer.from(pair).toString("base64")}`)
  } else {
    body.set("client_id", client.clientId)
    if (client.authMethod === "client_secret_post" && client.clientSecret !== undefined) {
      body.set("client_secret", client.clientSecret)
    }
  }
  return { method: "POST", headers, body }
}

/** What a token endpoint answered: tokens, a refusal (its OAuth error), or another failure. */
type TokenAnswer =
  | { readonly _tag: "Granted"; readonly tokens: Tokens; readonly idToken?: string }
  | { readonly _tag: "Refused"; readonly error: string; readonly description?: string }
  | { readonly _tag: "Failed"; readonly status: number }

const readTokens = (answer: Answer, resource: string, now: number, kept?: Tokens): TokenAnswer => {
  const json = objectOf(answer)
  if (answer.status === 400 || answer.status === 401) {
    const error = stringOf(json?.["error"])
    if (error !== undefined) {
      const description = said(json?.["error_description"])
      return { _tag: "Refused", error, ...(description !== undefined && { description }) }
    }
  }
  const access = stringOf(json?.["access_token"])
  const type = stringOf(json?.["token_type"])
  if (answer.status !== 200 || access === undefined || type?.toLowerCase() !== "bearer") {
    return { _tag: "Failed", status: answer.status }
  }
  const expiresIn = json?.["expires_in"]
  const refresh = stringOf(json?.["refresh_token"]) ?? kept?.refresh
  const scope = stringOf(json?.["scope"]) ?? kept?.scope
  const idToken = stringOf(json?.["id_token"])
  return {
    _tag: "Granted",
    tokens: {
      access,
      ...(refresh !== undefined && { refresh }),
      ...(typeof expiresIn === "number" &&
        Number.isFinite(expiresIn) &&
        expiresIn > 0 && { expiresAt: now + expiresIn * 1000 }),
      ...(scope !== undefined && { scope }),
      resource,
    },
    ...(idToken !== undefined && { idToken }),
  }
}

/**
 * The account an ID token names, as its claims do: an email, else a user name, else a name. It
 * came straight from the token endpoint, over TLS, so its signature isn't checked; but it must
 * be for this client, from this issuer.
 */
const accountOfIdToken = (idToken: string, client: Client) => {
  try {
    const claims: unknown = JSON.parse(
      Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"),
    )
    if (typeof claims !== "object" || claims === null) return undefined
    const record = claims as Record<string, unknown>
    const audience = record["aud"]
    const forClient = Array.isArray(audience)
      ? audience.includes(client.clientId)
      : audience === client.clientId
    if (!forClient || bare(String(record["iss"])) !== bare(client.issuer)) return undefined
    return accountOfClaims(record)
  } catch {
    return undefined
  }
}

const accountOfClaims = (claims: Record<string, unknown>) =>
  said(claims["email"]) || said(claims["preferred_username"]) || said(claims["name"]) || undefined

// ── The service ─────────────────────────────────────────────────────────────

export class PluginOAuth extends Context.Service<
  PluginOAuth,
  {
    /**
     * Begins connecting the Installation, off the relay's lock: discovers the server's
     * authorization server, registers the Hub with it unless it did before, and keeps what to
     * finish with by a new `state`. Where to send the browser.
     */
    readonly begin: (input: {
      readonly installationId: InstallationId
      readonly url: string
      readonly scopes?: ReadonlyArray<string>
      readonly basis: string
      readonly global: boolean
      readonly repos: ReadonlyArray<string>
      readonly by: ParticipantId
    }) => Effect.Effect<string, OAuthRefused | SecretsUnavailable | SqlError>
    /**
     * The connection `state` began, if the person began it, and not too long ago; forgotten, so
     * it is finished at most once.
     */
    readonly claim: (
      state: string,
      by: ParticipantId,
    ) => Effect.Effect<PendingConnection, OAuthRefused>
    /** Trades the code the browser came back with for tokens, off the relay's lock. */
    readonly exchange: (
      pending: PendingConnection,
      response: { readonly code: string; readonly iss?: string },
    ) => Effect.Effect<Granted, OAuthRefused>
    /**
     * Keeps the tokens and client of a connection, replacing any it had: whether it had a
     * connection, lost or not. In the caller's transaction.
     */
    readonly store: (
      pending: PendingConnection,
      granted: Granted,
      by: ParticipantId,
    ) => Effect.Effect<{ readonly reconnected: boolean }, SecretsUnavailable | SqlError>
    /** Forgets the Installation's tokens, keeping its client: whether it had a connection. */
    readonly disconnect: (id: InstallationId) => Effect.Effect<boolean, SqlError>
    /** The token to send the Installation's server now, refreshed if it is about to expire. */
    readonly accessToken: (
      id: InstallationId,
    ) => Effect.Effect<AccessToken, SecretsUnavailable | SqlError>
    /**
     * The server refused the `generation` of tokens: whether to try once more with the next,
     * which is refreshed first; or the connection is lost.
     */
    readonly rejected: (
      id: InstallationId,
      generation: number,
    ) => Effect.Effect<"Retry" | "Lost", SecretsUnavailable | SqlError>
    /** The server took the `generation` of tokens. */
    readonly works: (id: InstallationId, generation: number) => void
    /** The access and refresh tokens the Installations hold, to redact from what Sessions print. */
    readonly tokensOf: (
      ids: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<Redacted.Redacted<string>>, SecretsUnavailable | SqlError>
    /** Each connection refreshed or lost, from now on. */
    readonly changes: Effect.Effect<PubSub.Subscription<ConnectionChanged>, never, Scope.Scope>
  }
>()("@kndl/hub/PluginOAuth") {
  static readonly layer = Layer.effect(
    PluginOAuth,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const secrets = yield* Secrets
      const config = yield* HubConfig
      const published = yield* PubSub.unbounded<ConnectionChanged>()
      const redirectUri = new URL(OAuthCallbackPath, config.publicUrl).href
      /** The connections begun, by `state`, oldest first. */
      const pending = new Map<string, PendingConnection>()
      /** One refresh at a time for each Installation. */
      const refreshing = new Map<string, Semaphore.Semaphore>()
      /** The generation of tokens the server last took, for each Installation. */
      const worked = new Map<string, number>()

      const lockOf = (id: string) => {
        let lock = refreshing.get(id)
        if (lock === undefined) {
          lock = Semaphore.makeUnsafe(1)
          refreshing.set(id, lock)
        }
        return lock
      }

      const rowOf = Effect.fn("PluginOAuth.rowOf")(function* (id: string) {
        const rows = yield* sql<{
          readonly client: string | null
          readonly tokens: string | null
          readonly generation: number
          readonly connectedAt: number | null
        }>`
          SELECT client, tokens, generation, connected_at AS connectedAt FROM installation_oauth
          WHERE installation_id = ${id}
        `
        return rows[0]
      })

      const clientOf = Effect.fn("PluginOAuth.clientOf")(function* (id: string, stored: string) {
        const text = yield* secrets.decrypt(stored, clientContext(id))
        return Option.getOrUndefined(decodeClient(Redacted.value(text)))
      })

      const tokensOfRow = Effect.fn("PluginOAuth.tokensOfRow")(function* (
        id: string,
        stored: string,
      ) {
        const text = yield* secrets.decrypt(stored, tokensContext(id))
        return Option.getOrUndefined(decodeTokens(Redacted.value(text)))
      })

      const sealTokens = (id: string, tokens: Tokens) =>
        secrets.encrypt(Redacted.make(encodeTokens(tokens)), tokensContext(id))

      // ── Discovery and registration ──

      /**
       * The server's Protected Resource Metadata: where its 401 says, else at its well-known
       * paths; with the scopes its challenge asks for. None when it has none, as servers made to
       * an earlier MCP spec: their own origin is then their authorization server.
       */
      const resourceMetadata = Effect.fn("PluginOAuth.resourceMetadata")(function* (url: string) {
        const probe = yield* call(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 0,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "kndl", version: "1.0.0" },
            },
          }),
        }).pipe(Effect.option)
        const challenge = bearerChallenge(
          Option.isSome(probe) && probe.value.status === 401
            ? probe.value.headers.get("www-authenticate")
            : null,
        )
        const pointed = challenge.get("resource_metadata")
        const candidates =
          pointed !== undefined && fetchable(pointed)
            ? [pointed]
            : wellKnown(new URL(url), "oauth-protected-resource")
        for (const candidate of candidates) {
          const answer = yield* call(candidate, { headers: { accept: "application/json" } }).pipe(
            Effect.option,
          )
          if (Option.isNone(answer) || answer.value.status !== 200) continue
          const json = objectOf(answer.value)
          if (json !== undefined) return { metadata: json, scope: challenge.get("scope") }
        }
        return { metadata: undefined, scope: challenge.get("scope") }
      })

      /** The authorization server's metadata, checked: it must be what the issuer says. */
      const serverMetadata = Effect.fn("PluginOAuth.serverMetadata")(function* (issuer: string) {
        for (const candidate of metadataUrls(new URL(issuer))) {
          const answer = yield* call(candidate, { headers: { accept: "application/json" } }).pipe(
            Effect.option,
          )
          if (Option.isNone(answer) || answer.value.status !== 200) continue
          const json = objectOf(answer.value)
          if (json === undefined) continue
          if (bare(String(json["issuer"])) !== bare(issuer)) {
            return yield* refuse(
              `The authorization server at ${issuer} published metadata for another issuer.`,
            )
          }
          return json
        }
        return yield* refuse(
          `The Hub found no OAuth metadata for the authorization server ${issuer}.`,
        )
      })

      /** Registers the Hub with the authorization server (RFC 7591), as a client of its own. */
      const register = Effect.fn("PluginOAuth.register")(function* (
        issuer: string,
        metadata: Record<string, unknown>,
        endpoints: Pick<
          Client,
          "authorizationEndpoint" | "tokenEndpoint" | "userinfoEndpoint" | "sendsIss"
        >,
      ) {
        const registration = metadata["registration_endpoint"]
        if (!fetchable(registration)) {
          return yield* refuse(
            `The authorization server ${issuer} doesn't offer Dynamic Client Registration, which the Hub needs to connect.`,
          )
        }
        const supported = stringsOf(metadata["token_endpoint_auth_methods_supported"]) ?? [
          "client_secret_basic",
        ]
        const wanted = (["client_secret_basic", "client_secret_post", "none"] as const).find(
          (method) => supported.includes(method),
        )
        if (wanted === undefined) {
          return yield* refuse(
            `The authorization server ${issuer} authenticates clients only in ways the Hub doesn't support.`,
          )
        }
        const answer = yield* call(registration, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({
            client_name: "kndl",
            redirect_uris: [redirectUri],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: wanted,
          }),
        })
        const json = objectOf(answer)
        const clientId = stringOf(json?.["client_id"])
        if ((answer.status !== 201 && answer.status !== 200) || clientId === undefined) {
          const why = said(json?.["error_description"]) ?? said(json?.["error"])
          return yield* refuse(
            `The authorization server ${issuer} refused to register the Hub (${answer.status}${why === undefined ? "" : `: ${why}`}).`,
          )
        }
        const clientSecret = stringOf(json?.["client_secret"])
        const method = stringOf(json?.["token_endpoint_auth_method"]) ?? wanted
        const authMethod =
          clientSecret === undefined
            ? ("none" as const)
            : method === "client_secret_post"
              ? ("client_secret_post" as const)
              : ("client_secret_basic" as const)
        const expires = json?.["client_secret_expires_at"]
        return {
          issuer,
          redirectUri,
          clientId,
          ...(clientSecret !== undefined && { clientSecret }),
          ...(typeof expires === "number" && expires > 0 && { secretExpiresAt: expires }),
          authMethod,
          ...endpoints,
        } satisfies Client
      })

      const begin = Effect.fn("PluginOAuth.begin")(function* (input: {
        readonly installationId: InstallationId
        readonly url: string
        readonly scopes?: ReadonlyArray<string>
        readonly basis: string
        readonly global: boolean
        readonly repos: ReadonlyArray<string>
        readonly by: ParticipantId
      }) {
        if (!secrets.available) {
          return yield* refuse(
            "Connecting an Installation needs HUB_SECRETS_KEY in the Hub's configuration, to keep its tokens encrypted: run `bun run secrets-key`, put the key in packages/hub/.env.local, and restart the Hub.",
          )
        }
        if (!fetchable(input.url)) {
          return yield* refuse("The Hub connects only to an MCP server on https.")
        }
        const pluginUrl = new URL(input.url)
        const found = yield* resourceMetadata(input.url)
        // The resource the token is for: the server's, which must hold the Plugin's URL (RFC 9728).
        const claimed = stringOf(found.metadata?.["resource"])
        let resource = input.url
        if (claimed !== undefined) {
          const holds =
            fetchable(claimed) &&
            new URL(claimed).origin === pluginUrl.origin &&
            (bare(pluginUrl.href) + "/").startsWith(bare(claimed) + "/")
          if (!holds) {
            return yield* refuse(
              `The MCP server's metadata is for another resource (${claimed.slice(0, 200)}), not ${input.url}.`,
            )
          }
          resource = claimed
        }
        const servers = stringsOf(found.metadata?.["authorization_servers"]) ?? []
        const issuer = found.metadata === undefined ? pluginUrl.origin : servers[0]
        if (issuer === undefined || !fetchable(issuer)) {
          return yield* refuse("The MCP server names no authorization server the Hub can reach.")
        }
        const metadata = yield* serverMetadata(issuer)
        const authorizationEndpoint = metadata["authorization_endpoint"]
        const tokenEndpoint = metadata["token_endpoint"]
        if (!fetchable(authorizationEndpoint) || !fetchable(tokenEndpoint)) {
          return yield* refuse(
            `The authorization server ${issuer} lists no authorization or token endpoint on https.`,
          )
        }
        if (!(stringsOf(metadata["code_challenge_methods_supported"]) ?? []).includes("S256")) {
          return yield* refuse(
            `The authorization server ${issuer} doesn't support PKCE with S256, which MCP requires.`,
          )
        }
        const userinfo = metadata["userinfo_endpoint"]
        const endpoints = {
          authorizationEndpoint,
          tokenEndpoint,
          // Only on the issuer's own origin: it is sent the access token.
          ...(fetchable(userinfo) &&
            new URL(userinfo).origin === new URL(issuer).origin && { userinfoEndpoint: userinfo }),
          sendsIss: metadata["authorization_response_iss_parameter_supported"] === true,
        }

        // The client registered before, if it is for this issuer and callback, and still good.
        const row = yield* rowOf(input.installationId)
        const kept =
          row?.client == null ? undefined : yield* clientOf(input.installationId, row.client)
        const now = yield* Clock.currentTimeMillis
        const client: Client =
          kept !== undefined &&
          kept.issuer === issuer &&
          kept.redirectUri === redirectUri &&
          (kept.secretExpiresAt === undefined || kept.secretExpiresAt * 1000 > now + 60_000)
            ? { ...kept, ...endpoints }
            : yield* register(issuer, metadata, endpoints)

        const scopes =
          input.scopes !== undefined && input.scopes.length > 0
            ? input.scopes.join(" ")
            : (found.scope ??
              stringsOf(found.metadata?.["scopes_supported"])?.join(" ") ??
              undefined)
        const state = randomSecret()
        const { verifier, challenge } = pkce()
        for (const [key, one] of pending) {
          if (now - one.at > OAuthConnectTtlMs) pending.delete(key)
        }
        pending.set(state, {
          installationId: input.installationId,
          by: input.by,
          global: input.global,
          repos: input.repos,
          basis: input.basis,
          verifier,
          client,
          resource,
          at: now,
        })
        for (const key of pending.keys()) {
          if (pending.size <= maxPending) break
          pending.delete(key)
        }
        const authorize = new URL(client.authorizationEndpoint)
        authorize.searchParams.set("response_type", "code")
        authorize.searchParams.set("client_id", client.clientId)
        authorize.searchParams.set("redirect_uri", redirectUri)
        authorize.searchParams.set("code_challenge", challenge)
        authorize.searchParams.set("code_challenge_method", "S256")
        authorize.searchParams.set("state", state)
        authorize.searchParams.set("resource", resource)
        if (scopes !== undefined && scopes !== "") authorize.searchParams.set("scope", scopes)
        return authorize.href
      })

      const claim = Effect.fn("PluginOAuth.claim")(function* (state: string, by: ParticipantId) {
        const found = pending.get(state)
        pending.delete(state)
        const now = yield* Clock.currentTimeMillis
        if (found === undefined || found.by !== by || now - found.at > OAuthConnectTtlMs) {
          return yield* refuse("That connection expired or came from elsewhere: connect again.")
        }
        return found
      })

      /** The account the access token is for, by the authorization server's userinfo, if any. */
      const userinfo = Effect.fn("PluginOAuth.userinfo")(function* (
        client: Client,
        access: string,
      ) {
        if (client.userinfoEndpoint === undefined) return undefined
        const answer = yield* call(client.userinfoEndpoint, {
          headers: { authorization: `Bearer ${access}`, accept: "application/json" },
        }).pipe(Effect.option)
        if (Option.isNone(answer) || answer.value.status !== 200) return undefined
        const json = objectOf(answer.value)
        return json === undefined ? undefined : accountOfClaims(json)
      })

      const exchange = Effect.fn("PluginOAuth.exchange")(function* (
        connection: PendingConnection,
        response: { readonly code: string; readonly iss?: string },
      ) {
        const { client } = connection
        // RFC 9207: the code came from the issuer the Hub sent the browser to.
        if (
          (client.sendsIss || response.iss !== undefined) &&
          bare(response.iss ?? "") !== bare(client.issuer)
        ) {
          return yield* refuse("The authorization server that answered isn't the one asked.")
        }
        const answer = yield* call(
          client.tokenEndpoint,
          tokenRequest(client, {
            grant_type: "authorization_code",
            code: response.code,
            redirect_uri: client.redirectUri,
            code_verifier: connection.verifier,
            resource: connection.resource,
          }),
        )
        const read = readTokens(answer, connection.resource, yield* Clock.currentTimeMillis)
        if (read._tag === "Refused") {
          return yield* refuse(
            `The authorization server refused the connection: ${read.description ?? read.error}.`,
          )
        }
        if (read._tag === "Failed") {
          return yield* refuse(
            `The authorization server answered ${read.status}, without tokens the Hub can use.`,
          )
        }
        const account =
          (read.idToken === undefined ? undefined : accountOfIdToken(read.idToken, client)) ??
          (yield* userinfo(client, read.tokens.access))
        return { tokens: read.tokens, ...(account !== undefined && { account }) } satisfies Granted
      })

      const store = Effect.fn("PluginOAuth.store")(function* (
        connection: PendingConnection,
        granted: Granted,
        by: ParticipantId,
      ) {
        const id = connection.installationId
        const client = yield* secrets.encrypt(
          Redacted.make(encodeClient(connection.client)),
          clientContext(id),
        )
        const tokens = yield* sealTokens(id, granted.tokens)
        const before = yield* rowOf(id)
        const at = yield* Clock.currentTimeMillis
        yield* sql`
          INSERT INTO installation_oauth (
            installation_id, client, tokens, generation, account, connected_by, connected_at,
            lost_at
          ) VALUES (${id}, ${client}, ${tokens}, 1, ${granted.account ?? null}, ${by}, ${at}, NULL)
          ON CONFLICT (installation_id) DO UPDATE SET
            client = excluded.client, tokens = excluded.tokens,
            generation = installation_oauth.generation + 1, account = excluded.account,
            connected_by = excluded.connected_by, connected_at = excluded.connected_at,
            lost_at = NULL
        `
        return { reconnected: before?.connectedAt != null }
      })

      const disconnect = Effect.fn("PluginOAuth.disconnect")(function* (id: InstallationId) {
        const before = yield* rowOf(id)
        if (before === undefined) return false
        yield* sql`
          UPDATE installation_oauth SET tokens = NULL, generation = generation + 1, account = NULL,
            connected_by = NULL, connected_at = NULL, lost_at = NULL
          WHERE installation_id = ${id}
        `
        return before.connectedAt !== null
      })

      /** Loses the connection, unless its tokens changed since `generation`. */
      const lose = Effect.fn("PluginOAuth.lose")(function* (
        id: InstallationId,
        generation: number,
      ) {
        const lost = yield* sql<{ readonly generation: number }>`
          UPDATE installation_oauth SET tokens = NULL, generation = generation + 1,
            lost_at = ${yield* Clock.currentTimeMillis}
          WHERE installation_id = ${id} AND generation = ${generation}
          RETURNING generation
        `
        if (lost.length > 0) {
          yield* Effect.logWarning(
            "An OAuth Installation's connection was lost: it needs reconnecting",
          ).pipe(Effect.annotateLogs({ installationId: id }))
          yield* PubSub.publish(published, { installationId: id, lost: true })
        }
      })

      /** Saves tokens over those of `generation`: whether they were still those. */
      const replace = Effect.fn("PluginOAuth.replace")(function* (
        id: InstallationId,
        generation: number,
        tokens: Tokens,
      ) {
        const sealed = yield* sealTokens(id, tokens)
        const saved = yield* sql<{ readonly generation: number }>`
          UPDATE installation_oauth SET tokens = ${sealed}, generation = generation + 1
          WHERE installation_id = ${id} AND generation = ${generation}
          RETURNING generation
        `
        return saved[0]?.generation
      })

      const notConnected: AccessToken = { _tag: "NotConnected" }

      /** The tokens now, refreshed if need be; under the Installation's lock. */
      const refreshed = Effect.fn("PluginOAuth.refreshed")(function* (
        id: InstallationId,
      ): Effect.fn.Return<AccessToken, SecretsUnavailable | SqlError> {
        const row = yield* rowOf(id)
        if (row?.tokens == null || row.client === null) return notConnected
        const tokens = yield* tokensOfRow(id, row.tokens)
        const client = yield* clientOf(id, row.client)
        const now = yield* Clock.currentTimeMillis
        if (tokens === undefined || client === undefined) {
          yield* lose(id, row.generation)
          return notConnected
        }
        if (fresh(tokens, now)) {
          return { _tag: "Token", token: Redacted.make(tokens.access), generation: row.generation }
        }
        if (tokens.refresh === undefined) {
          yield* lose(id, row.generation)
          return notConnected
        }
        const answer = yield* call(
          client.tokenEndpoint,
          tokenRequest(client, {
            grant_type: "refresh_token",
            refresh_token: tokens.refresh,
            resource: tokens.resource,
          }),
        ).pipe(Effect.option)
        if (Option.isNone(answer)) return { _tag: "Unavailable" }
        const read = readTokens(answer.value, tokens.resource, now, tokens)
        if (read._tag === "Refused") {
          // The grant was revoked, or the refresh token used: only Reconnect mends it.
          yield* Effect.logWarning(
            `The authorization server refused to refresh an OAuth Installation's token: ${read.error}`,
          ).pipe(Effect.annotateLogs({ installationId: id }))
          yield* lose(id, row.generation)
          return notConnected
        }
        if (read._tag === "Failed") return { _tag: "Unavailable" }
        const next: Tokens = {
          ...read.tokens,
          ...(tokens.stale === true && { afterRejection: true }),
        }
        const generation = yield* replace(id, row.generation, next)
        // Replaced meanwhile, as by a Reconnect: those are the ones to use.
        if (generation === undefined) return yield* refreshedOnce(id)
        yield* PubSub.publish(published, { installationId: id, lost: false })
        return { _tag: "Token", token: Redacted.make(next.access), generation }
      })

      /** The tokens as they are, without refreshing again. */
      const refreshedOnce = Effect.fn("PluginOAuth.refreshedOnce")(function* (id: InstallationId) {
        const row = yield* rowOf(id)
        if (row?.tokens == null) return notConnected
        const tokens = yield* tokensOfRow(id, row.tokens)
        if (tokens === undefined || !fresh(tokens, yield* Clock.currentTimeMillis)) {
          return { _tag: "Unavailable" } satisfies AccessToken
        }
        return {
          _tag: "Token",
          token: Redacted.make(tokens.access),
          generation: row.generation,
        } satisfies AccessToken
      })

      const accessToken = Effect.fn("PluginOAuth.accessToken")(function* (id: InstallationId) {
        const row = yield* rowOf(id)
        if (row?.tokens == null) return notConnected
        const tokens = yield* tokensOfRow(id, row.tokens)
        if (tokens !== undefined && fresh(tokens, yield* Clock.currentTimeMillis)) {
          return {
            _tag: "Token",
            token: Redacted.make(tokens.access),
            generation: row.generation,
          } satisfies AccessToken
        }
        // Once at a time: whoever waited finds the tokens the first refreshed.
        return yield* lockOf(id).withPermits(1)(refreshed(id))
      })

      const rejected = Effect.fn("PluginOAuth.rejected")(function* (
        id: InstallationId,
        generation: number,
      ) {
        return yield* lockOf(id).withPermits(1)(
          Effect.gen(function* () {
            const row = yield* rowOf(id)
            if (row?.tokens == null) return "Lost" as const
            // Refreshed meanwhile: try those.
            if (row.generation !== generation) return "Retry" as const
            const tokens = yield* tokensOfRow(id, row.tokens)
            if (
              tokens?.refresh === undefined ||
              (tokens.afterRejection === true && worked.get(id) !== generation)
            ) {
              yield* lose(id, generation)
              return "Lost" as const
            }
            // Should a refresh have saved others meanwhile, those are tried instead.
            yield* replace(id, generation, { ...tokens, stale: true })
            return "Retry" as const
          }),
        )
      })

      const works = (id: InstallationId, generation: number) => {
        worked.set(id, generation)
      }

      const tokensOf = Effect.fn("PluginOAuth.tokensOf")(function* (ids: ReadonlyArray<string>) {
        if (ids.length === 0) return []
        const rows = yield* sql<{ readonly installationId: string; readonly tokens: string }>`
          SELECT installation_id AS installationId, tokens FROM installation_oauth
          WHERE tokens IS NOT NULL AND installation_id IN ${sql.in(ids)}
        `
        const values: Array<Redacted.Redacted<string>> = []
        for (const row of rows) {
          const tokens = yield* tokensOfRow(row.installationId, row.tokens)
          if (tokens === undefined) continue
          values.push(Redacted.make(tokens.access))
          if (tokens.refresh !== undefined) values.push(Redacted.make(tokens.refresh))
        }
        return values
      })

      return PluginOAuth.of({
        begin,
        claim,
        exchange,
        store,
        disconnect,
        accessToken,
        rejected,
        works,
        tokensOf,
        changes: PubSub.subscribe(published),
      })
    }),
  )
}
