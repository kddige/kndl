// The Hub serving the kndl CLI (issue #178): the install script, the commit, and the
// binaries, built once per commit and target, on a real Hub with a stand-in build.

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { CliCommitHeader } from "@kndl/protocol"
import { installScript } from "./CliRoutes.ts"
import { commit, fakeBinary, fakeBuilds, removeTempDirs, tempDir } from "./cliTestSupport.ts"
import { startHub, stopHubs } from "./testSupport.ts"

afterEach(async () => {
  await stopHubs()
  await removeTempDirs()
})

describe("GET /cli", () => {
  test("is the install script, open to anyone, installing from the Hub's public URL", async () => {
    const hub = await startHub({ config: { publicUrl: new URL("https://hub.example.com/app/") } })
    const response = await fetch(`${hub.url}/cli`)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("text/x-shellscript; charset=utf-8")
    const script = await response.text()
    expect(script.startsWith("#!/bin/sh\n")).toBe(true)
    expect(script).toContain("hub_url=${KNDL_URL:-'https://hub.example.com'}")
    expect(script).not.toContain("@HUB_URL@")
    expect(script).toBe(installScript(new URL("https://hub.example.com")))
  })
})

describe("GET /cli/version", () => {
  test("says the commit the Hub serves the CLI at", async () => {
    const hub = await startHub({ cliBuilds: fakeBuilds({ dir: await tempDir("cli-") }).layer })
    const response = await fetch(`${hub.url}/cli/version`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ commit })
  })

  test("is a 503 on a Hub that doesn't run from a git checkout", async () => {
    const hub = await startHub()
    const response = await fetch(`${hub.url}/cli/version`)
    expect(response.status).toBe(503)
    expect(await response.text()).toContain("doesn't run from a git checkout")
  })
})

describe("GET /cli/<target>", () => {
  test("serves the binary for each target, built at the Hub's commit, with no sign-in", async () => {
    const dir = await tempDir("cli-")
    const builds = fakeBuilds({ dir })
    const hub = await startHub({ cliBuilds: builds.layer })
    for (const target of ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const) {
      const response = await fetch(`${hub.url}/cli/${target}`)
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("application/octet-stream")
      expect(response.headers.get(CliCommitHeader)).toBe(commit)
      expect(await response.text()).toBe(fakeBinary(target, commit))
      expect(existsSync(join(dir, commit, `kndl-${target}`))).toBe(true)
    }
  })

  test("builds a binary once, however many ask for it at once", async () => {
    const builds = fakeBuilds({ dir: await tempDir("cli-") })
    const hub = await startHub({ cliBuilds: builds.layer })
    const bodies = await Promise.all(
      Array.from({ length: 5 }, () => fetch(`${hub.url}/cli/linux-x64`).then((r) => r.text())),
    )
    expect(new Set(bodies)).toEqual(new Set([fakeBinary("linux-x64", commit)]))
    await fetch(`${hub.url}/cli/linux-x64`)
    expect(builds.built).toEqual(["linux-x64"])
  })

  test("is a 404 for a platform the Hub doesn't build for", async () => {
    const builds = fakeBuilds({ dir: await tempDir("cli-") })
    const hub = await startHub({ cliBuilds: builds.layer })
    for (const target of ["windows-x64", "linux-armv7", "darwin-arm64.exe", "..%2Fhub.db"]) {
      const response = await fetch(`${hub.url}/cli/${target}`)
      expect({ target, status: response.status }).toEqual({ target, status: 404 })
      expect(await response.text()).toContain(
        "The Hub builds the kndl CLI for darwin-arm64, darwin-x64, linux-x64, linux-arm64",
      )
    }
    // Not the web UI's page either, as an unknown path outside the Hub's would be.
    expect((await fetch(`${hub.url}/cli/linux-x64/more`)).status).toBe(404)
    expect(builds.built).toEqual([])
  })

  test("removes the builds of other commits once it builds this one's", async () => {
    const dir = await tempDir("cli-")
    const old = "0ld".padEnd(40, "0").replaceAll("l", "1")
    await mkdir(join(dir, old), { recursive: true })
    await writeFile(join(dir, old, "kndl-linux-x64"), "old")
    await writeFile(join(dir, "not-a-build"), "kept")
    const hub = await startHub({ cliBuilds: fakeBuilds({ dir }).layer })
    expect((await fetch(`${hub.url}/cli/linux-x64`)).status).toBe(200)
    expect(existsSync(join(dir, old))).toBe(false)
    expect(await readFile(join(dir, "not-a-build"), "utf8")).toBe("kept")
  })

  test("builds nothing while the checkout is at another commit than the Hub runs", async () => {
    const builds = fakeBuilds({ dir: await tempDir("cli-"), checkoutCommit: "f".repeat(40) })
    const hub = await startHub({ cliBuilds: builds.layer })
    const response = await fetch(`${hub.url}/cli/linux-x64`)
    expect(response.status).toBe(503)
    expect(await response.text()).toContain("serves the CLI again once it restarts")
    expect(builds.built).toEqual([])
  })

  test("says why a build failed, and tries again on the next request", async () => {
    const builds = fakeBuilds({ dir: await tempDir("cli-"), fail: "no network" })
    const hub = await startHub({ cliBuilds: builds.layer })
    const response = await fetch(`${hub.url}/cli/linux-arm64`)
    expect(response.status).toBe(500)
    expect(await response.text()).toBe(
      "The Hub couldn't build the kndl CLI for linux-arm64: no network",
    )
    await fetch(`${hub.url}/cli/linux-arm64`)
    expect(builds.built).toEqual(["linux-arm64", "linux-arm64"])
  })

  test("is a 503 on a Hub that doesn't run from a git checkout", async () => {
    const hub = await startHub({
      cliBuilds: fakeBuilds({ dir: await tempDir("cli-"), commit: undefined }).layer,
    })
    expect((await fetch(`${hub.url}/cli/linux-x64`)).status).toBe(503)
  })
})
