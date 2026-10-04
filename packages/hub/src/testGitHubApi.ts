// A stand-in for GitHub's REST API, as the GitHub App uses it, for the Hub's and the CLI's tests:
// an in-process HTTP server on 127.0.0.1 that checks the App JWT's signature, mints installation
// tokens and, with one of them, says who is a Repo's collaborator. It also describes the App and
// its installations, and hands out a new App's credentials for a manifest's code, as GitHub does
// once it has registered the App. Not part of the Hub.

import { generateKeyPairSync, type KeyObject, verify } from "node:crypto"
import { manifestPermissions, RequiredEvents } from "./AppPermissions.ts"

export const appId = "123456"
export const appSlug = "claude-hub-test"
export const botUserId = 9001
export const installationId = 42
/** Where the stand-in says the App's pages are, as GitHub's `html_url`s. */
export const webUrl = "https://github.com"

/** An installation of the App, as `GET /app/installations` lists it. */
export interface StandInInstallation {
  readonly id: number
  readonly account: string
  readonly accountType: "User" | "Organization"
  permissions: Record<string, string>
  events: Array<string>
  suspended: boolean
}

/** The new App a manifest's code stands for, and the credentials the conversion hands out. */
export interface StandInConversion {
  readonly id: number
  readonly slug: string
  readonly owner: string
  readonly clientId: string
  readonly clientSecret: string
  readonly webhookSecret: string | null
  readonly pem: string
}

/** A fresh RSA key pair, as GitHub hands an App: PKCS#1 PEM. */
export function appKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  return {
    privateKeyPem: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    publicKey,
  }
}

/** One request the stand-in received. */
export interface ApiRequest {
  readonly method: string
  readonly path: string
  readonly query: URLSearchParams
  readonly authorization: string | null
  readonly body: unknown
}

/** The claims of a JWT whose RS256 signature `key` verifies, else undefined. */
export function verifiedJwt(jwt: string, key: KeyObject): Record<string, unknown> | undefined {
  const [header, payload, signature] = jwt.split(".")
  if (header === undefined || payload === undefined || signature === undefined) return undefined
  const ok = verify(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`),
    key,
    Buffer.from(signature, "base64url"),
  )
  if (!ok) return undefined
  const decodedHeader = JSON.parse(Buffer.from(header, "base64url").toString()) as { alg?: string }
  if (decodedHeader.alg !== "RS256") return undefined
  return JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>
}

export class StandInGitHub {
  readonly requests: Array<ApiRequest> = []
  /** Repos (`owner/name`) the App is installed on. */
  readonly installedOn = new Set<string>()
  /** The collaborators (logins) of each Repo (`owner/name`). */
  readonly collaborators = new Map<string, Set<string>>()
  /** While set, collaborator checks answer 503, as in an outage. */
  collaboratorsDown = false
  /** While set, `GET /app` answers 503, as in an outage. */
  appDown = false
  /** How long the tokens it mints last. */
  tokenLifetimeMs = 60 * 60 * 1000
  /** The App's own permissions and events, as `GET /app` says; by default, all it needs. */
  appPermissions: Record<string, string> = { ...manifestPermissions() }
  appEvents: Array<string> = [...RequiredEvents]
  /** Who owns the App. */
  appOwner: { readonly login: string; readonly type: "User" | "Organization" } = {
    login: "kddige",
    type: "User",
  }
  /** The App's installations; by default one on kddige with all it needs. */
  readonly installations: Array<StandInInstallation> = [defaultInstallation()]
  /** The codes GitHub would redirect back with, each for the App it registered. */
  readonly manifestCodes = new Map<string, StandInConversion>()
  private minted = 0
  private readonly tokens = new Set<string>()

  private constructor(
    private readonly server: ReturnType<typeof Bun.serve>,
    readonly publicKey: KeyObject,
  ) {}

  get url() {
    return new URL(`http://127.0.0.1:${this.server.port}/`)
  }

  /** How many installation tokens it has minted. */
  get mintCount() {
    return this.minted
  }

  /** The tokens it minted, to look for where they mustn't be. */
  get mintedTokens(): ReadonlyArray<string> {
    return [...this.tokens]
  }

  /** Makes `login` a collaborator on `repo`. */
  grant(repo: string, login: string) {
    const logins = this.collaborators.get(repo) ?? new Set()
    logins.add(login)
    this.collaborators.set(repo, logins)
  }

  /** Takes `login` off `repo`'s collaborators. */
  revoke(repo: string, login: string) {
    this.collaborators.get(repo)?.delete(login)
  }

  /** How many collaborator checks it has answered, for `login` if given. */
  collaboratorChecks(login?: string) {
    return this.requests.filter((request) => {
      const checked = /^\/repos\/[^/]+\/[^/]+\/collaborators\/([^/]+)$/.exec(request.path)?.[1]
      return checked !== undefined && (login === undefined || checked === login)
    }).length
  }

  /**
   * A code, as GitHub redirects back with once it has registered an App from a manifest, and the
   * App and credentials the conversion hands out for it, with a fresh private key.
   */
  registerApp(options: { readonly code?: string; readonly webhookSecret?: string } = {}) {
    const code = options.code ?? `code${this.manifestCodes.size + 1}`
    const id = 1000 + this.manifestCodes.size
    const conversion: StandInConversion = {
      id,
      slug: `claude-hub-new-${id}`,
      owner: this.appOwner.login,
      clientId: `Iv23li${id}`,
      clientSecret: `standin-client-secret-${id}`,
      webhookSecret: options.webhookSecret ?? null,
      pem: appKeyPair().privateKeyPem,
    }
    this.manifestCodes.set(code, conversion)
    return { code, conversion }
  }

  /** Forgets everything: requests, installs, collaborators, tokens, permissions and codes. */
  reset() {
    this.requests.length = 0
    this.installedOn.clear()
    this.collaborators.clear()
    this.collaboratorsDown = false
    this.appDown = false
    this.tokenLifetimeMs = 60 * 60 * 1000
    this.appPermissions = { ...manifestPermissions() }
    this.appEvents = [...RequiredEvents]
    this.appOwner = { login: "kddige", type: "User" }
    this.installations.splice(0, this.installations.length, defaultInstallation())
    this.manifestCodes.clear()
    this.minted = 0
    this.tokens.clear()
  }

  stop() {
    void this.server.stop(true)
  }

  static start(publicKey: KeyObject): StandInGitHub {
    const started: { self?: StandInGitHub } = {}
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        started.self === undefined
          ? new Response("starting", { status: 503 })
          : started.self.handle(request),
    })
    const self = new StandInGitHub(server, publicKey)
    started.self = self
    return self
  }

  private json(status: number, body: unknown) {
    return Response.json(body, { status })
  }

  /** Whether the request carries a valid App JWT. */
  private isApp(authorization: string | null) {
    const jwt = authorization?.replace(/^Bearer /, "")
    if (jwt === undefined) return false
    const claims = verifiedJwt(jwt, this.publicKey)
    const now = Math.floor(Date.now() / 1000)
    return (
      claims !== undefined &&
      claims["iss"] === appId &&
      typeof claims["exp"] === "number" &&
      claims["exp"] > now &&
      claims["exp"] - now <= 600 &&
      typeof claims["iat"] === "number" &&
      claims["iat"] <= now
    )
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = decodeURIComponent(url.pathname)
    const authorization = request.headers.get("authorization")
    const text = await request.text()
    const body = text === "" ? undefined : (JSON.parse(text) as unknown)
    this.requests.push({
      method: request.method,
      path,
      query: url.searchParams,
      authorization,
      body,
    })
    const unauthorized = this.json(401, { message: "Bad credentials" })

    let match: RegExpExecArray | null
    if (
      request.method === "GET" &&
      (match = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(path))
    ) {
      if (!this.isApp(authorization)) return unauthorized
      if (!this.installedOn.has(match[1] ?? "")) return this.json(404, { message: "Not Found" })
      return this.json(200, { id: installationId })
    }
    if (
      request.method === "POST" &&
      path === `/app/installations/${installationId}/access_tokens`
    ) {
      if (!this.isApp(authorization)) return unauthorized
      this.minted += 1
      const token = `ghs_standin${this.minted}x${Math.random().toString(36).slice(2)}`
      this.tokens.add(token)
      return this.json(201, {
        token,
        expires_at: new Date(Date.now() + this.tokenLifetimeMs).toISOString(),
      })
    }
    if (
      request.method === "GET" &&
      (match = /^\/repos\/([^/]+\/[^/]+)\/collaborators\/([^/]+)$/.exec(path))
    ) {
      // As an installation, with a token it minted.
      if (!this.tokens.has(authorization?.replace(/^Bearer /, "") ?? "")) return unauthorized
      if (this.collaboratorsDown) return this.json(503, { message: "Service Unavailable" })
      const isCollaborator = this.collaborators.get(match[1] ?? "")?.has(match[2] ?? "") ?? false
      return isCollaborator ? new Response(null, { status: 204 }) : this.json(404, {})
    }
    if (request.method === "GET" && path === "/app") {
      if (!this.isApp(authorization)) return unauthorized
      if (this.appDown) return this.json(503, { message: "Service Unavailable" })
      return this.json(200, {
        id: Number(appId),
        slug: appSlug,
        html_url: `${webUrl}/apps/${appSlug}`,
        owner: this.appOwner,
        permissions: this.appPermissions,
        events: this.appEvents,
      })
    }
    if (request.method === "GET" && path === "/app/installations") {
      if (!this.isApp(authorization)) return unauthorized
      const perPage = Number(url.searchParams.get("per_page") ?? 30)
      const page = Number(url.searchParams.get("page") ?? 1)
      return this.json(
        200,
        this.installations.slice((page - 1) * perPage, page * perPage).map((installation) => ({
          id: installation.id,
          account: { login: installation.account, type: installation.accountType },
          html_url:
            installation.accountType === "Organization"
              ? `${webUrl}/organizations/${installation.account}/settings/installations/${installation.id}`
              : `${webUrl}/settings/installations/${installation.id}`,
          app_slug: appSlug,
          target_type: installation.accountType,
          permissions: installation.permissions,
          events: installation.events,
          suspended_at: installation.suspended ? "2026-01-01T00:00:00Z" : null,
        })),
      )
    }
    if (
      request.method === "POST" &&
      (match = /^\/app-manifests\/([^/]+)\/conversions$/.exec(path))
    ) {
      // No credentials: the code is one. It works once.
      const conversion = this.manifestCodes.get(match[1] ?? "")
      if (conversion === undefined) return this.json(404, { message: "Not Found" })
      this.manifestCodes.delete(match[1] ?? "")
      return this.json(201, {
        id: conversion.id,
        slug: conversion.slug,
        node_id: `A_${conversion.id}`,
        owner: { login: conversion.owner, type: this.appOwner.type },
        name: conversion.slug,
        html_url: `${webUrl}/apps/${conversion.slug}`,
        permissions: manifestPermissions(),
        events: RequiredEvents,
        client_id: conversion.clientId,
        client_secret: conversion.clientSecret,
        webhook_secret: conversion.webhookSecret,
        pem: conversion.pem,
      })
    }
    if (request.method === "GET" && path === `/users/${appSlug}[bot]`) {
      return this.json(200, { id: botUserId, login: `${appSlug}[bot]` })
    }
    return this.json(404, { message: "Not Found" })
  }
}

function defaultInstallation(): StandInInstallation {
  return {
    id: installationId,
    account: "kddige",
    accountType: "User",
    permissions: { ...manifestPermissions() },
    events: [...RequiredEvents],
    suspended: false,
  }
}
