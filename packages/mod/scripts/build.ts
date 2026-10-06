// Bundles the mod's logic, with Effect and the protocol, into hooks/hub-link-lib.js: Claude Code's
// mod runtime loads no package but its own (spike #4).
//
// The bundle is written only when it changed. Claude Code reloads the mod in every running Session
// whose Sandbox mounts it when its files change, and a reload in the middle of a Turn loses the end
// of that Turn; `bun run runner` builds the mod each time it starts, under running Sessions (#157).

import { join } from "node:path"

const root = join(import.meta.dir, "..")
const outfile = join(root, "hooks/hub-link-lib.js")

const built = await Bun.build({
  entrypoints: [join(root, "src/lib.ts")],
  target: "browser",
  format: "esm",
  minify: true,
})
if (!built.success) {
  for (const message of built.logs) console.error(message)
  process.exit(1)
}
const [bundle] = built.outputs
if (bundle === undefined) throw new Error("bun build wrote no bundle")
const code = await bundle.text()

const existing = Bun.file(outfile)
if ((await existing.exists()) && (await existing.text()) === code) {
  console.log("hub-link-lib.js is up to date")
} else {
  await Bun.write(outfile, code)
  console.log(`wrote hub-link-lib.js (${Math.round(code.length / 1024)} KB)`)
}
