// The durable agent (docs/design/durable-harness.md): one ESM file for the Node the Runner starts
// it with, with Effect and the protocol inside. Pi Durable and its sibling packages stay outside:
// the Runner makes its pinned install of them resolvable beside it. The Claude bridge's SDK and
// session helpers are bundled; its model calls still use the Runner's pinned Claude Code binary.

import { join } from "node:path"

const root = join(import.meta.dir, "..")
const built = await Bun.build({
  entrypoints: [join(root, "durable/src/agent.ts")],
  target: "node",
  format: "esm",
  external: ["@earendil-works/*"],
})
if (!built.success) {
  for (const message of built.logs) console.error(message)
  process.exit(1)
}
const [agent] = built.outputs
if (agent === undefined) throw new Error("bun build wrote no durable agent")

// A Session runs its own copy of the bundle. Avoid rewriting an unchanged build while the
// Runner starts up or checks its installation.
const outfile = join(root, "durable/dist/agent.js")
const code = await agent.text()
const existing = Bun.file(outfile)
if ((await existing.exists()) && (await existing.text()) === code) {
  console.log("durable: agent.js is up to date")
} else {
  await Bun.write(outfile, code)
  console.log(`wrote durable: agent.js (${Math.round(code.length / 1024)} KB)`)
}
