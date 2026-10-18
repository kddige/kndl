// Bundles the mod's logic, with Effect and the protocol, into each plugin's hooks/hub-link-lib.js:
// Claude Code's mod runtime loads no package but its own (spike #4), and a plugin reads only its
// own directory. hub-link and hub-link-commands share the one bundle (ADR 0014).
//
// A bundle is written only when it changed. Each Session's Claude Code loads a copy of the mod made
// as it starts (#159), but a Sandbox made before then mounts this one, and Claude Code there
// reloads it when its files change, losing the end of a Turn running then; `bun run runner` builds
// the mod each time it starts, under running Sessions (#157).
//
// It also bundles kndl's pi extension (ADR 0029) into pi/dist/kndl.js: one ESM file for the Node
// that runs pi, with Effect and the protocol inside, and pi's own packages left to pi, which hands
// an extension its own copies of them.

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

/** Writes `text` to `outfile` unless it holds it already. */
const writeChanged = async (label: string, outfile: string, text: string) => {
  const existing = Bun.file(outfile)
  if ((await existing.exists()) && (await existing.text()) === text) {
    console.log(`${label} is up to date`)
  } else {
    await Bun.write(outfile, text)
    console.log(`wrote ${label} (${Math.round(text.length / 1024)} KB)`)
  }
}

for (const plugin of plugins)
  await writeChanged(
    `${plugin}: hub-link-lib.js`,
    join(root, "plugins", plugin, "hooks/hub-link-lib.js"),
    code,
  )

const pi = await Bun.build({
  entrypoints: [join(root, "pi/src/index.ts")],
  target: "node",
  format: "esm",
  external: ["@earendil-works/*", "typebox"],
})
if (!pi.success) {
  for (const message of pi.logs) console.error(message)
  process.exit(1)
}
const [extension] = pi.outputs
if (extension === undefined) throw new Error("bun build wrote no pi extension")
await writeChanged("pi: kndl.js", join(root, "pi/dist/kndl.js"), await extension.text())
