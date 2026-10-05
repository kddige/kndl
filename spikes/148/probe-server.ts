// Spike #148: the host side of the probe mod, standing in for the Hub. It appends every event the
// probe posts to a JSONL log, and hands the probe the commands queued with `enqueue`, as the web
// UI would send them, logging each one's result.
//
//   bun spikes/148/probe-server.ts [--port 18148] [--log /tmp/spike148/probe.jsonl]
//   curl -s localhost:18148/enqueue -d '{"op":"list"}'
//   curl -s localhost:18148/enqueue -d '{"op":"send","to":{"agentId":"a…"},"text":"…"}'
//   curl -s localhost:18148/enqueue -d '{"op":"stop","taskId":"a…"}'

import { appendFileSync } from "node:fs"
import { parseArgs } from "node:util"

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: "18148" },
    log: { type: "string", default: "/tmp/spike148/probe.jsonl" },
  },
})

const write = (entry: Record<string, unknown>) => {
  const line = JSON.stringify({ t: new Date().toISOString(), ...entry })
  appendFileSync(args.log, `${line}\n`)
  console.log(line.length > 400 ? `${line.slice(0, 400)}…` : line)
}

let nextId = 0
const queue: Array<Record<string, unknown>> = []
let waiting: ((commands: Array<Record<string, unknown>>) => void) | undefined

Bun.serve({
  hostname: "127.0.0.1",
  port: Number(args.port),
  idleTimeout: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {}
    switch (path) {
      case "/log":
        write({ from: "probe", ...body })
        return new Response(null, { status: 204 })
      case "/result":
        write({ from: "probe", event: "command.result", ...body })
        return new Response(null, { status: 204 })
      case "/enqueue": {
        const command = { id: ++nextId, ...body }
        write({ from: "host", event: "command", command })
        if (waiting !== undefined) {
          waiting([command])
          waiting = undefined
        } else queue.push(command)
        return Response.json(command)
      }
      case "/commands": {
        if (queue.length > 0) return Response.json(queue.splice(0))
        const commands = await Promise.race([
          new Promise<Array<Record<string, unknown>>>((resolve) => (waiting = resolve)),
          Bun.sleep(20_000).then(() => []),
        ])
        waiting = undefined
        return Response.json(commands)
      }
      default:
        return new Response(null, { status: 404 })
    }
  },
})
write({ from: "host", event: "listening", port: args.port })
