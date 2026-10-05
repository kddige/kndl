// Spike #148: the credential proxy from spike #142, cut down, in front of Claude Code in the
// spike's Sandboxes (ADR 0013). Claude Code in the VM has ANTHROPIC_BASE_URL pointing here and a
// per-Session dummy CLAUDE_CODE_OAUTH_TOKEN. The proxy:
//
// - answers Claude Code's connectivity check itself,
// - refuses any request whose bearer isn't a known dummy (constant-time compare), and any path
//   outside the allowlist,
// - swaps the dummy for the real credential and forwards to https://api.anthropic.com, streaming
//   the response back unchanged.
//
// The real credential is a `claude setup-token` token in the macOS Keychain item
// `claude-hub-setup-token` (ADR 0015 has each person bring one). It is read into this process
// only, and never logged: the log names the model and the path, nothing of the token.
//
//   bun spikes/148/proxy.ts [--port 18142] [--sessions /tmp/spike148/sessions.json]
//
// sessions.json: { "<dummy token>": "<session name>", ... }

import { timingSafeEqual } from "node:crypto"
import { appendFileSync, readFileSync } from "node:fs"
import { parseArgs } from "node:util"

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: "18142" },
    sessions: { type: "string", default: "/tmp/spike148/sessions.json" },
    log: { type: "string", default: "/tmp/spike148/proxy.log" },
    upstream: { type: "string", default: "https://api.anthropic.com" },
  },
})

const allowed: ReadonlyArray<{ readonly method: string; readonly path: RegExp }> = [
  { method: "POST", path: /^\/v1\/messages$/ },
  { method: "POST", path: /^\/v1\/messages\/count_tokens$/ },
  { method: "GET", path: /^\/v1\/models$/ },
]

const log = (entry: Record<string, unknown>) => {
  const line = JSON.stringify({ t: new Date().toISOString(), ...entry })
  appendFileSync(args.log, `${line}\n`)
  console.log(line)
}

const sessionOf = (bearer: string | null): string | undefined => {
  if (bearer === null) return undefined
  const given = Buffer.from(bearer)
  let found: string | undefined
  const sessions = JSON.parse(readFileSync(args.sessions, "utf8")) as Record<string, string>
  for (const [dummy, session] of Object.entries(sessions)) {
    const want = Buffer.from(dummy)
    if (want.length === given.length && timingSafeEqual(want, given)) found = session
  }
  return found
}

const bearerOf = (headers: Headers) => {
  const value = headers.get("authorization")
  return value?.startsWith("Bearer ") === true
    ? value.slice("Bearer ".length)
    : headers.get("x-api-key")
}

/** The setup token, read from the Keychain once. Never logged. */
const readToken = async () => {
  const child = Bun.spawn(
    ["security", "find-generic-password", "-s", "claude-hub-setup-token", "-w"],
    { stdout: "pipe", stderr: "ignore" },
  )
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  if (code !== 0 || out.trim() === "") throw new Error(`no claude-hub-setup-token (${code})`)
  return out.trim()
}
const token = await readToken()

const dropped = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
  "authorization",
  "x-api-key",
  "content-length",
  "accept-encoding",
])

Bun.serve({
  hostname: "127.0.0.1",
  port: Number(args.port),
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const path = url.pathname
    if ((request.method === "HEAD" || request.method === "GET") && path === "/api/hello")
      return new Response(null, { status: 200 })
    const session = sessionOf(bearerOf(request.headers))
    if (
      session === undefined ||
      !allowed.some((r) => r.method === request.method && r.path.test(path))
    ) {
      log({ event: "refused", session, method: request.method, path })
      return Response.json(
        { type: "error", error: { type: "authentication_error", message: "spike148 proxy" } },
        { status: session === undefined ? 401 : 404 },
      )
    }
    const body = request.body === null ? undefined : await request.arrayBuffer()
    let model: string | undefined
    try {
      if (body !== undefined)
        model = (JSON.parse(new TextDecoder().decode(body)) as { model?: string }).model
    } catch {}
    const headers = new Headers()
    for (const [name, value] of request.headers) if (!dropped.has(name)) headers.set(name, value)
    headers.set("authorization", `Bearer ${token}`)
    const upstream = await fetch(`${args.upstream}${path}${url.search}`, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      // @ts-expect-error Bun's fetch: keep the upstream body exactly as sent
      decompress: false,
    })
    log({ event: "forwarded", session, path, model, status: upstream.status })
    const out = new Headers(upstream.headers)
    out.delete("content-length")
    out.delete("transfer-encoding")
    out.delete("connection")
    return new Response(upstream.body, { status: upstream.status, headers: out })
  },
})
log({ event: "listening", port: args.port })
