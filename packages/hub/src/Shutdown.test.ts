// The Hub as `bun run hub` runs it, in a child process: it has to exit promptly on SIGTERM and
// SIGINT, even with a mod's long poll waiting and a Runner connected (#39).

import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MaxCommandWaitMs, ProtocolVersion, SessionId } from "@claude-hub/protocol"
import { Effect, Layer } from "effect"
import { databaseAt } from "./Database.ts"
import { ModTokens } from "./ModTokens.ts"
import { RunnerTokens } from "./RunnerTokens.ts"

const mainPath = new URL("./main.ts", import.meta.url).pathname
const dirs: Array<string> = []
const children: Array<Bun.Subprocess> = []

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL")
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A port nothing listens on, for now. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() =>
        typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port")),
      )
    })
  })

/** A database with a Runner and a mod token for its Session `s-a`. */
async function seed(filename: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const runner = yield* (yield* RunnerTokens).issue("mac")
      const modToken = yield* (yield* ModTokens).issue({
        sessionId: SessionId.make("s-a"),
        runnerId: runner.runnerId,
      })
      return { runnerToken: runner.token, modToken }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(RunnerTokens.layer, ModTokens.layer).pipe(
          Layer.provide(databaseAt(filename)),
        ),
      ),
    ),
  )
}

async function startHubProcess() {
  const dir = mkdtempSync(join(tmpdir(), "claude-hub-shutdown-"))
  dirs.push(dir)
  const database = join(dir, "hub.db")
  const tokens = await seed(database)
  const port = await freePort()
  const child = Bun.spawn(["bun", mainPath], {
    env: { ...process.env, HUB_DATABASE: database, HOST: "127.0.0.1", PORT: String(port) },
    stdout: "ignore",
    stderr: "ignore",
  })
  children.push(child)
  const url = `http://127.0.0.1:${port}`
  for (let attempt = 0; ; attempt++) {
    const up = await fetch(`${url}/health`).then(
      (response) => response.ok,
      () => false,
    )
    if (up) break
    if (attempt > 100) throw new Error("The Hub didn't start")
    await Bun.sleep(50)
  }
  return { child, url, ...tokens }
}

/** Opens what keeps a Hub busy: a Runner's channel and a mod's long poll of its commands. */
async function connect(hub: Awaited<ReturnType<typeof startHubProcess>>) {
  const socket = new WebSocket(`${hub.url.replace(/^http/, "ws")}/ws/runner`, {
    headers: { authorization: `Bearer ${hub.runnerToken}` },
  })
  const welcomed = new Promise<void>((resolve, reject) => {
    socket.addEventListener("message", () => resolve())
    socket.addEventListener("close", () => reject(new Error("The Runner channel closed")))
  })
  socket.addEventListener("open", () =>
    socket.send(
      JSON.stringify({
        _tag: "RunnerHello",
        protocolVersion: ProtocolVersion,
        name: "mac",
        login: { account: "alice@example.com" },
        sessions: [],
      }),
    ),
  )
  await welcomed
  const closed = new Promise<number>((resolve) =>
    socket.addEventListener("close", (event) => resolve(event.code)),
  )

  const modHeaders = { authorization: `Bearer ${hub.modToken}` }
  await fetch(`${hub.url}/mod/hello`, {
    method: "POST",
    headers: { ...modHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      _tag: "ModHello",
      protocolVersion: ProtocolVersion,
      sessionId: "s-a",
      claudeSessionId: "claude-1",
      model: "claude-opus",
    }),
  })
  const poll = fetch(`${hub.url}/mod/commands?after=0&waitMs=${MaxCommandWaitMs}`, {
    headers: modHeaders,
  }).then(
    async (response) => ({ status: response.status, body: await response.json() }),
    () => undefined,
  )
  // Let the poll reach the Hub and start waiting.
  await Bun.sleep(200)
  return { closed, poll }
}

test.each(["SIGTERM", "SIGINT"] as const)(
  "exits promptly on %s with a Runner connected and a long poll waiting",
  async (signal) => {
    const hub = await startHubProcess()
    const { closed, poll } = await connect(hub)

    const sent = performance.now()
    hub.child.kill(signal)
    const exitCode = await hub.child.exited
    const took = performance.now() - sent

    expect(took).toBeLessThan(2000)
    // BunRuntime exits an interrupted program with 130, as a shell reports Ctrl-C.
    expect([0, 130]).toContain(exitCode)
    expect(await poll).toEqual({ status: 200, body: { messages: [] } })
    expect(await closed).toBe(1001)
  },
  15_000,
)
