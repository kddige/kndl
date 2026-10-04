// A stand-in for GitHub's REST API, as the GitHub App uses it, for the Hub's tests: an
// in-process HTTP server on 127.0.0.1 that checks the App JWT's signature, mints installation
// tokens and, with one of them, says who is a Repo's collaborator. Not part of the Hub.

import { generateKeyPairSync, type KeyObject, verify } from "node:crypto"

export const appId = "123456"
export const appSlug = "claude-hub-test"
export const botUserId = 9001
export const installationId = 42

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
  /** How long the tokens it mints last. */
  tokenLifetimeMs = 60 * 60 * 1000
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

  /** Forgets everything: requests, installs, collaborators and tokens. */
  reset() {
    this.requests.length = 0
    this.installedOn.clear()
    this.collaborators.clear()
    this.collaboratorsDown = false
    this.tokenLifetimeMs = 60 * 60 * 1000
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
      return this.json(200, { slug: appSlug })
    }
    if (request.method === "GET" && path === `/users/${appSlug}[bot]`) {
      return this.json(200, { id: botUserId, login: `${appSlug}[bot]` })
    }
    return this.json(404, { message: "Not Found" })
  }
}
