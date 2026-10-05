// Spike #142: a throwaway credential proxy for Claude Code running inside a Sandbox.
//
// Claude Code in the VM gets ANTHROPIC_BASE_URL=http://host.microsandbox.internal:<port> and a
// per-Session dummy CLAUDE_CODE_OAUTH_TOKEN. This proxy, on the Runner host:
//
// - refuses any request whose bearer token isn't a known per-Session dummy (constant-time compare),
// - refuses any path outside the allowlist (unless --discover, which forwards every authenticated
//   path so we can see what Claude Code asks for),
// - swaps the dummy for the Runner owner's real subscription access token, read from the macOS
//   Keychain item Claude Code itself keeps ("Claude Code-credentials"), and forwards to
//   https://api.anthropic.com, streaming the response back unchanged.
//
// The real token is only ever held in this process. It is never logged: the log shows its length
// and last four characters. The proxy never refreshes or rotates the token: it re-reads the
// Keychain, where the host's own Claude Code keeps it fresh.
//
//   bun spikes/142/proxy.ts --port 18142 --sessions /tmp/spike142/sessions.json [--discover]
//
// sessions.json: { "<dummy token>": "<session name>", ... }

import { timingSafeEqual } from "node:crypto"
import { appendFileSync, readFileSync } from "node:fs"
import { parseArgs } from "node:util"

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: "18142" },
    host: { type: "string", default: "127.0.0.1" },
    sessions: { type: "string", default: "/tmp/spike142/sessions.json" },
    log: { type: "string", default: "/tmp/spike142/proxy.log" },
    discover: { type: "boolean", default: false },
    upstream: { type: "string", default: "https://api.anthropic.com" },
  },
})

/**
 * Paths Claude Code 2.1.289 sends to ANTHROPIC_BASE_URL, from the discovery runs: Turns (with
 * ?beta=true), /context's token counts, and the model list. Its OAuth calls (profile, usage,
 * bootstrap, MCP registry) and telemetry go to https://api.anthropic.com whatever the base URL, so
 * they never reach the proxy.
 */
const allowed: ReadonlyArray<{ readonly method: string; readonly path: RegExp }> = [
  { method: "POST", path: /^\/v1\/messages$/ },
  { method: "POST", path: /^\/v1\/messages\/count_tokens$/ },
  { method: "GET", path: /^\/v1\/models$/ },
]

/** Claude Code's connectivity check, sent with no credential: answered here, never forwarded. */
const isConnectivityCheck = (method: string, path: string) =>
  (method === "HEAD" || method === "GET") && path === "/api/hello"

const isAllowed = (method: string, path: string) =>
  allowed.some((rule) => rule.method === method && rule.path.test(path))

// --- Per-Session dummy credentials -------------------------------------------------------------

const loadSessions = (): Map<string, string> =>
  new Map(Object.entries(JSON.parse(readFileSync(args.sessions, "utf8")) as Record<string, string>))

/** The Session a bearer token belongs to, compared in constant time against every dummy. */
const sessionOf = (bearer: string | undefined): string | undefined => {
  if (bearer === undefined) return undefined
  const given = Buffer.from(bearer)
  let found: string | undefined
  // Re-read on each request so the spike can add and revoke Sessions without a restart.
  for (const [dummy, session] of loadSessions()) {
    const want = Buffer.from(dummy)
    if (want.length === given.length && timingSafeEqual(want, given)) found = session
  }
  return found
}

const bearerOf = (headers: Headers) => {
  const value = headers.get("authorization")
  if (value?.startsWith("Bearer ") === true) return value.slice("Bearer ".length)
  return headers.get("x-api-key") ?? undefined
}

// --- The real credential -----------------------------------------------------------------------

interface Credential {
  readonly accessToken: string
  readonly expiresAt: number
}

let cached: Credential | undefined

/** Reads Claude Code's own login from the Keychain. Never refreshes it. */
const readKeychain = async (): Promise<Credential> => {
  const child = Bun.spawn(
    ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (code !== 0) throw new Error(`security exited with ${code}`)
  const oauth = (JSON.parse(out) as { claudeAiOauth?: Credential }).claudeAiOauth
  if (oauth?.accessToken === undefined) throw new Error("no claudeAiOauth.accessToken in Keychain")
  return { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt }
}

const redact = (token: string) => `<len ${token.length} …${token.slice(-4)}>`

/** The current access token: cached until five minutes before it expires, then re-read. */
const credential = async (force = false): Promise<Credential> => {
  if (!force && cached !== undefined && cached.expiresAt - Date.now() > 5 * 60_000) return cached
  const read = await readKeychain()
  const changed = cached?.accessToken !== read.accessToken
  cached = read
  log({
    event: "credential",
    token: redact(read.accessToken),
    changed,
    expiresInMin: Math.round((read.expiresAt - Date.now()) / 60_000),
  })
  return read
}

// --- Logging -----------------------------------------------------------------------------------

const log = (entry: Record<string, unknown>) => {
  const line = JSON.stringify({ t: new Date().toISOString(), ...entry })
  appendFileSync(args.log, `${line}\n`)
  console.log(line)
}

/** Headers worth seeing, with credentials removed. */
const headerSummary = (headers: Headers) => {
  const out: Record<string, string> = {}
  for (const [name, value] of headers) {
    if (name === "authorization" || name === "x-api-key" || name === "cookie") {
      out[name] = "<redacted>"
    } else if (
      name.startsWith("anthropic-") ||
      name.startsWith("x-") ||
      name === "user-agent" ||
      name === "content-type"
    ) {
      out[name] = value
    }
  }
  return out
}

// --- The proxy ---------------------------------------------------------------------------------

const hopByHop = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
  "authorization",
  "x-api-key",
  "content-length",
  // So the upstream answers uncompressed and the body can be streamed through as is.
  "accept-encoding",
])

let counter = 0

const server = Bun.serve({
  hostname: args.host,
  port: Number(args.port),
  idleTimeout: 0, // long Turns stream for minutes
  async fetch(request, srv) {
    const id = ++counter
    const started = performance.now()
    const url = new URL(request.url)
    const path = url.pathname
    const peer = srv.requestIP(request)?.address
    if (isConnectivityCheck(request.method, path)) return new Response(null, { status: 200 })
    const session = sessionOf(bearerOf(request.headers) ?? undefined)

    if (session === undefined) {
      log({
        id,
        event: "refused",
        reason: "no valid session credential",
        method: request.method,
        path,
        peer,
      })
      return Response.json(
        {
          type: "error",
          error: { type: "authentication_error", message: "spike142 proxy: unknown credential" },
        },
        { status: 401 },
      )
    }
    if (!args.discover && !isAllowed(request.method, path)) {
      log({
        id,
        event: "refused",
        reason: "path not allowed",
        session,
        method: request.method,
        path,
        peer,
      })
      return Response.json(
        {
          type: "error",
          error: { type: "not_found_error", message: "spike142 proxy: path not allowed" },
        },
        { status: 404 },
      )
    }

    const body = request.body === null ? undefined : await request.arrayBuffer()
    let model: string | undefined
    let tools: Array<string> | undefined
    let stream: boolean | undefined
    let effort: unknown
    if (body !== undefined && request.headers.get("content-type")?.includes("json") === true) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(body)) as {
          model?: string
          stream?: boolean
          tools?: Array<{ name?: string; type?: string }>
          output_config?: unknown
          thinking?: unknown
          max_tokens?: number
        }
        effort = {
          output_config: parsed.output_config,
          thinking: parsed.thinking,
          max_tokens: parsed.max_tokens,
        }
        model = parsed.model
        stream = parsed.stream
        tools = parsed.tools
          ?.map((tool) => tool.type ?? tool.name ?? "?")
          .filter((t) => !/^[A-Z]/.test(t) || t.startsWith("Web"))
      } catch {}
    }

    const forward = async (force: boolean) => {
      const real = await credential(force)
      const headers = new Headers()
      for (const [name, value] of request.headers) if (!hopByHop.has(name)) headers.set(name, value)
      headers.set("authorization", `Bearer ${real.accessToken}`)
      return fetch(`${args.upstream}${path}${url.search}`, {
        method: request.method,
        headers,
        body,
        redirect: "manual",
        // @ts-expect-error Bun's fetch: keep the upstream body exactly as sent
        decompress: false,
      })
    }

    let upstream: Response
    try {
      upstream = await forward(false)
      // A token the host's Claude Code has just rotated: read the Keychain once more.
      if (upstream.status === 401) upstream = await forward(true)
    } catch (error) {
      log({ id, event: "upstream-error", session, path, error: String(error) })
      return Response.json(
        { type: "error", error: { type: "api_error", message: "spike142 proxy: upstream failed" } },
        { status: 502 },
      )
    }
    const upstreamMs = performance.now() - started
    const responseHeaders = new Headers(upstream.headers)
    responseHeaders.delete("content-length")
    responseHeaders.delete("transfer-encoding")
    responseHeaders.delete("connection")
    responseHeaders.set("x-spike-upstream-headers-ms", upstreamMs.toFixed(1))

    log({
      id,
      event: "forwarded",
      session,
      method: request.method,
      path,
      search: url.search || undefined,
      status: upstream.status,
      headersMs: Math.round(upstreamMs),
      model,
      stream,
      tools,
      effort,
      request: headerSummary(request.headers),
      ratelimit: Object.fromEntries(
        [...upstream.headers].filter(([name]) => name.includes("ratelimit")),
      ),
      requestId: upstream.headers.get("request-id") ?? undefined,
    })

    if (upstream.body === null)
      return new Response(null, { status: upstream.status, headers: responseHeaders })

    // Count the streamed bytes and the time to the last one, without buffering.
    let bytes = 0
    const counted = upstream.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength
          controller.enqueue(chunk)
        },
        flush() {
          log({ id, event: "done", path, bytes, totalMs: Math.round(performance.now() - started) })
        },
      }),
    )
    return new Response(counted, { status: upstream.status, headers: responseHeaders })
  },
})

log({
  event: "listening",
  url: server.url.href,
  discover: args.discover,
  sessions: loadSessions().size,
})
// Read once at start, so a missing login shows up straight away.
await credential()
