// Bundles the mod's logic, with Effect and the protocol, into each plugin's hooks/hub-link-lib.js:
// Claude Code's mod runtime loads no package but its own (spike #4), and a plugin reads only its
// own directory. hub-link and hub-link-commands share the one bundle (ADR 0014).
//
// A bundle is written only when it changed. Claude Code reloads the mod in every running Session
// whose Sandbox mounts it when its files change, and a reload in the middle of a Turn loses the end
// of that Turn; `bun run runner` builds the mod each time it starts, under running Sessions (#157).

import { join } from "node:path"

const root = join(import.meta.dir, "..")
const plugins = ["hub-link", "hub-link-commands"]

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

for (const plugin of plugins) {
  const outfile = join(root, "plugins", plugin, "hooks/hub-link-lib.js")
  const existing = Bun.file(outfile)
  if ((await existing.exists()) && (await existing.text()) === code) {
    console.log(`${plugin}: hub-link-lib.js is up to date`)
  } else {
    await Bun.write(outfile, code)
    console.log(`${plugin}: wrote hub-link-lib.js (${Math.round(code.length / 1024)} KB)`)
  }
}
