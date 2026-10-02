// A stand-in for GitHub's REST API, as the GitHub App uses it, for the Hub's tests: an
// in-process HTTP server on 127.0.0.1 that checks the App JWT's signature, mints installation
// tokens, and keeps pull requests and reviews in memory. Not part of the Hub.

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

export interface PullState {
  readonly number: number
  readonly head: string
  readonly base: string
  readonly title: string
  readonly body: string
  readonly draft: boolean
  readonly html_url: string
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
  /** Open pull requests, per Repo. */
  readonly pulls = new Map<string, Array<PullState>>()
  readonly reviews: Array<{ repo: string; number: number; body: string; event: string }> = []
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

  /** Forgets everything: requests, installs, tokens, pull requests and reviews. */
  reset() {
    this.requests.length = 0
    this.installedOn.clear()
    this.pulls.clear()
    this.reviews.length = 0
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

  private isInstallation(authorization: string | null) {
    const token = authorization?.replace(/^Bearer /, "")
    return token !== undefined && this.tokens.has(token)
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
    if (request.method === "GET" && path === "/app") {
      if (!this.isApp(authorization)) return unauthorized
      return this.json(200, { slug: appSlug })
    }
    if (request.method === "GET" && path === `/users/${appSlug}[bot]`) {
      return this.json(200, { id: botUserId, login: `${appSlug}[bot]` })
    }
    if ((match = /^\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(path))) {
      if (!this.isInstallation(authorization)) return unauthorized
      const owner = match[1] ?? ""
      const repo = `${owner}/${match[2]}`
      const pulls = this.pulls.get(repo) ?? []
      if (request.method === "GET") {
        const head = url.searchParams.get("head")
        const base = url.searchParams.get("base")
        return this.json(
          200,
          pulls.filter(
            (pull) =>
              (head === null || `${owner}:${pull.head}` === head) &&
              (base === null || pull.base === base),
          ),
        )
      }
      const input = body as Omit<PullState, "number" | "html_url">
      if (input.head === input.base) {
        return this.json(422, {
          message: "Validation Failed",
          errors: [{ message: `No commits between ${input.base} and ${input.head}` }],
        })
      }
      const number = pulls.length + 1
      const pull = { ...input, number, html_url: `https://github.test/${repo}/pull/${number}` }
      this.pulls.set(repo, [...pulls, pull])
      return this.json(201, pull)
    }
    if (
      request.method === "POST" &&
      (match = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/reviews$/.exec(path))
    ) {
      if (!this.isInstallation(authorization)) return unauthorized
      const repo = match[1] ?? ""
      const number = Number(match[2])
      if (!(this.pulls.get(repo) ?? []).some((pull) => pull.number === number)) {
        return this.json(404, { message: "Not Found" })
      }
      const input = body as { body: string; event: string }
      this.reviews.push({ repo, number, ...input })
      return this.json(200, {
        id: this.reviews.length,
        html_url: `https://github.test/${repo}/pull/${number}#pullrequestreview-${this.reviews.length}`,
      })
    }
    return this.json(404, { message: "Not Found" })
  }
}
