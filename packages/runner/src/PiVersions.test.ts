// pi and pi-ai are pinned to one version everywhere kndl uses them (docs/design/pi-harness.md):
// the Hub calls pi-ai, the mod's pi extension is built against pi, and the Runner installs pi for
// the Sandboxes. An upgrade that misses one of them would have the extension run against another
// pi than it was built and tested with.

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { PinnedPiVersion } from "./sandbox/SandboxPi.ts"

const packages = join(import.meta.dir, "..", "..")
const root = join(packages, "..")

const dependencies = (path: string): Record<string, string> => {
  const json = JSON.parse(readFileSync(join(packages, path), "utf8")) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  return { ...json.dependencies, ...json.devDependencies }
}

/** Every `@earendil-works/*` package a lockfile resolves, with its version. */
const locked = (path: string) =>
  [...readFileSync(path, "utf8").matchAll(/"(@earendil-works\/[a-z-]+)@([^"]+)"/g)].map(
    ([, name, version]) => `${name}@${version}`,
  )

describe("the pinned pi", () => {
  test("is one version in the Hub, the mod and the Runner's pi bundle", () => {
    const pins = {
      "hub pi-ai": dependencies("hub/package.json")["@earendil-works/pi-ai"],
      "mod pi-ai": dependencies("mod/package.json")["@earendil-works/pi-ai"],
      "mod pi-coding-agent": dependencies("mod/package.json")["@earendil-works/pi-coding-agent"],
      "runner/pi pi-coding-agent":
        dependencies("runner/pi/package.json")["@earendil-works/pi-coding-agent"],
    }
    expect(pins).toEqual({
      "hub pi-ai": PinnedPiVersion,
      "mod pi-ai": PinnedPiVersion,
      "mod pi-coding-agent": PinnedPiVersion,
      "runner/pi pi-coding-agent": PinnedPiVersion,
    })
  })

  test("is the only one the lockfiles resolve, pi's own packages included", () => {
    for (const lock of [join(root, "bun.lock"), join(packages, "runner/pi/bun.lock")]) {
      const resolved = locked(lock)
      expect(resolved.length).toBeGreaterThan(0)
      for (const entry of resolved) expect(entry).toEndWith(`@${PinnedPiVersion}`)
    }
  })
})
