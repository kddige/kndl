// Spike #142: a stand-in for the Runner's mod endpoint, so we can see whether hub-link, loaded with
// --plugin-dir from a read-only mount inside the Sandbox, reaches the host. It welcomes the hello,
// accepts events and answers command polls with nothing. It logs who called and with which token
// (redacted: length and last four).
//
//   bun spikes/142/fake-hub.ts [--port 18144]

import { appendFileSync } from "node:fs"
import { parseArgs } from "node:util"

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: "18144" },
    log: { type: "string", default: "/tmp/spike142/fake-hub.log" },
  },
})

const log = (entry: Record<string, unknown>) => {
  const line = JSON.stringify({ t: new Date().toISOString(), ...entry })
  appendFileSync(args.log, `${line}\n`)
  console.log(line)
}

const redact = (value: string | null) =>
  value === null ? null : `<len ${value.length} …${value.slice(-4)}>`

Bun.serve({
  hostname: "127.0.0.1",
  port: Number(args.port),
  idleTimeout: 0,
  async fetch(request, srv) {
    const url = new URL(request.url)
    const body = await request.text()
    log({
      method: request.method,
      path: url.pathname,
      search: url.search || undefined,
      peer: srv.requestIP(request)?.address,
      authorization: redact(request.headers.get("authorization")),
      body: body.slice(0, 300) || undefined,
    })
    if (url.pathname === "/mod/hello")
      return Response.json({ _tag: "ModWelcome", protocolVersion: 1 })
    if (url.pathname === "/mod/commands") {
      await Bun.sleep(Math.min(Number(url.searchParams.get("waitMs") ?? 0), 25_000))
      return Response.json({ messages: [] })
    }
    return new Response(null, { status: 204 })
  },
})
log({ event: "listening", port: args.port })
