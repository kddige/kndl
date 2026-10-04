// The Hub serving the web UI's build, on a real Hub with a stand-in build in a temporary
// directory: the Hub's own routes must keep answering beside it.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startHub, stopHubs, type TestHub } from "./testSupport.ts"
import { assetCacheControl, notBuiltMessage, pageCacheControl } from "./WebUi.ts"

afterEach(stopHubs)

const indexHtml = `<!doctype html><title>Claude Hub</title><script type="module" src="/assets/index-Bx1a2b3c.js"></script>`
const script = `console.log("the web UI")`

/** Holds the build, `dist/`, and a file beside it that must not be served. */
let root: string
let webDir: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "claude-hub-web-"))
  webDir = join(root, "dist")
  await mkdir(join(webDir, "assets"), { recursive: true })
  await writeFile(join(root, "secret.txt"), "not for the web")
  await writeFile(join(webDir, "index.html"), indexHtml)
  await writeFile(join(webDir, "assets", "index-Bx1a2b3c.js"), script)
  await writeFile(join(webDir, "assets", "index-Cd4e5f6a.css"), "body{margin:0}")
})
afterAll(() => rm(root, { recursive: true, force: true }))

const start = () => startHub({ config: { webDir } })

async function expectIndex(hub: TestHub, path: string) {
  const response = await fetch(`${hub.url}${path}`)
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8")
  expect(response.headers.get("cache-control")).toBe(pageCacheControl)
  expect(await response.text()).toBe(indexHtml)
}

describe("with the web UI built", () => {
  test("GET / serves index.html, not to be cached", async () => {
    await expectIndex(await start(), "/")
  })

  test("a deep link into the web UI serves index.html, for the router to resolve", async () => {
    const hub = await start()
    await expectIndex(hub, "/sessions/0f8e7d6c-5b4a-4321-8fed-cba987654321")
    await expectIndex(hub, "/repos/acme/web.app/environment?tab=variables")
    await expectIndex(hub, "/kit")
  })

  test("a hashed asset is served with its content type, cached for good", async () => {
    const hub = await start()

    const js = await fetch(`${hub.url}/assets/index-Bx1a2b3c.js`)
    expect(js.status).toBe(200)
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
    expect(js.headers.get("cache-control")).toBe(assetCacheControl)
    expect(await js.text()).toBe(script)

    const css = await fetch(`${hub.url}/assets/index-Cd4e5f6a.css`)
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8")
    expect(css.headers.get("cache-control")).toBe(assetCacheControl)
  })

  test("a missing file is a 404, not index.html", async () => {
    const hub = await start()
    for (const path of ["/assets/index-0ld0ld00.js", "/favicon.ico"]) {
      const response = await fetch(`${hub.url}${path}`)
      expect(response.status).toBe(404)
      expect(response.headers.get("cache-control")).toBe(pageCacheControl)
    }
  })

  test("a Hub path no route answers is a 404, not index.html", async () => {
    const hub = await start()
    for (const path of ["/auth/nope", "/auth", "/ws/nope", "/mod/nope", "/health/nope"]) {
      const response = await fetch(`${hub.url}${path}`, { headers: { accept: "text/html" } })
      expect({ path, status: response.status }).toEqual({ path, status: 404 })
      expect(await response.text()).not.toBe(indexHtml)
    }
  })

  test("the Hub's own routes still answer", async () => {
    const hub = await start()

    const health = await fetch(`${hub.url}/health`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: "ok" })

    const me = await fetch(`${hub.url}/auth/me`)
    expect(me.status).toBe(401)

    const runner = await fetch(`${hub.url}/ws/runner`)
    expect(runner.status).toBe(401)
  })

  test("a path out of the build is refused", async () => {
    const hub = await start()
    for (const path of ["/%2e%2e/secret.txt", "/assets/%2e%2e%2f%2e%2e%2fsecret.txt"]) {
      const response = await fetch(`${hub.url}${path}`)
      expect(response.status).toBe(404)
      expect(await response.text()).not.toContain("not for the web")
    }
  })
})

describe("without the web UI built", () => {
  test("the Hub starts, and its pages say how to build the web UI", async () => {
    const hub = await startHub({ config: { webDir: join(webDir, "missing") } })

    for (const path of ["/", "/sessions/abc"]) {
      const response = await fetch(`${hub.url}${path}`)
      expect(response.status).toBe(503)
      expect(await response.text()).toBe(notBuiltMessage)
    }
    expect((await fetch(`${hub.url}/assets/index-Bx1a2b3c.js`)).status).toBe(404)
    expect((await fetch(`${hub.url}/health`)).status).toBe(200)
  })
})
