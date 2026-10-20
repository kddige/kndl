// pi's packages are pinned to one version everywhere kndl uses them (docs/design/pi-harness.md,
// docs/design/durable-harness.md): the Hub calls pi-ai, the mod's durable agent is built against
// Pi Durable and its siblings, and the Runner installs those for the Sandboxes, where the agent
// loads them. An upgrade that misses one of them would have the agent run against other packages
// than it was built and tested with.

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

/** Every `@earendil-works/*` package a manifest depends on, with its version. */
const pinned = (path: string) =>
  Object.entries(dependencies(path)).filter(([name]) => name.startsWith("@earendil-works/"))

describe("the pinned pi", () => {
  test("is one version in the Hub, the mod and the Runner's pi bundle", () => {
    const pins = ["hub/package.json", "mod/package.json", "runner/pi/package.json"].flatMap(
      (path) => pinned(path).map(([name, version]) => `${path} ${name}@${version}`),
    )
    expect(pins.length).toBeGreaterThan(0)
    for (const pin of pins) expect(pin).toEndWith(`@${PinnedPiVersion}`)
  })

  test("is the version of every package of pi's the durable agent loads from the bundle", () => {
    expect(Object.fromEntries(pinned("runner/pi/package.json"))).toEqual({
      "@earendil-works/chord": PinnedPiVersion,
      "@earendil-works/pi-ai": PinnedPiVersion,
      "@earendil-works/pi-codemode": PinnedPiVersion,
      "@earendil-works/pi-durable": PinnedPiVersion,
      "@earendil-works/pi-mcp": PinnedPiVersion,
    })
    // The Hub calls pi-ai at the same version the agent does.
    expect(dependencies("hub/package.json")["@earendil-works/pi-ai"]).toBe(PinnedPiVersion)
  })

  test("is the only one the lockfiles resolve, pi's own packages included", () => {
    for (const lock of [join(root, "bun.lock"), join(packages, "runner/pi/bun.lock")]) {
      const resolved = locked(lock)
      expect(resolved.length).toBeGreaterThan(0)
      for (const entry of resolved) expect(entry).toEndWith(`@${PinnedPiVersion}`)
    }
  })
})
