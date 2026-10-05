// Spike #142: an HTTPS_PROXY that only logs which hosts Claude Code connects to (CONNECT host:port)
// and tunnels the bytes through untouched. No TLS interception: it sees host names, not paths.
// Run with --deny to refuse every tunnel instead, to see what breaks when they fail.
//
//   bun spikes/142/connect-log.ts [--port 18143] [--deny]

import { appendFileSync } from "node:fs"
import { createServer, connect } from "node:net"
import { parseArgs } from "node:util"

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: "18143" },
    log: { type: "string", default: "/tmp/spike142/connect.log" },
    deny: { type: "boolean", default: false },
  },
})

const log = (entry: Record<string, unknown>) => {
  const line = JSON.stringify({ t: new Date().toISOString(), ...entry })
  appendFileSync(args.log, `${line}\n`)
  console.log(line)
}

createServer((client) => {
  client.once("data", (head) => {
    const firstLine = head.toString("latin1").split("\r\n")[0] ?? ""
    const [method, target] = firstLine.split(" ")
    if (method !== "CONNECT" || target === undefined) {
      // Plain-HTTP proxying: log the absolute URL's host and refuse it.
      log({ event: "plain", line: firstLine.replace(/\?.*/, "") })
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n")
      return
    }
    if (args.deny) {
      log({ event: "denied", target })
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n")
      return
    }
    const [host, port] = target.split(":")
    const upstream = connect(Number(port ?? 443), host ?? "", () => {
      log({ event: "tunnel", target })
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      upstream.pipe(client)
      client.pipe(upstream)
    })
    upstream.on("error", (error) => {
      log({ event: "tunnel-error", target, error: error.message })
      client.destroy()
    })
    client.on("error", () => upstream.destroy())
  })
}).listen(Number(args.port), "127.0.0.1", () =>
  log({ event: "listening", port: args.port, deny: args.deny }),
)
