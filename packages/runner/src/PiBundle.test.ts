import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Fiber, Logger } from "effect"
import { TestClock } from "effect/testing"
import { PreparePiTimeout, preparePi } from "./PiBundle.ts"
import { ensurePiBundle, SandboxPiError } from "./sandbox/SandboxPi.ts"

const dirs: Array<string> = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** An empty directory, for a cache. */
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "kndl-pi-bundle-"))
  dirs.push(dir)
  return dir
}

/** Runs `effect`, keeping the warnings and infos it logs in `logs`. */
const run = <A>(effect: Effect.Effect<A>, logs: Array<string>) =>
  effect.pipe(
    Effect.provide(
      Logger.layer([
        Logger.make(({ logLevel, message }) => {
          if (logLevel === "Warn" || logLevel === "Info")
            logs.push(
              `${logLevel}: ${Array.isArray(message) ? message.join(" ") : String(message)}`,
            )
        }),
      ]),
    ),
    Effect.runPromise,
  )

describe("preparePi", () => {
  test("says where the agent's packages are in the Sandbox once the bundle is ready", async () => {
    const logs: Array<string> = []
    const ready = await run(preparePi({ ensure: Effect.succeed({ appDir: "pi-1.3.0-abc" }) }), logs)
    expect(ready).toEqual({ nodeModules: "/opt/kndl/pi/pi-1.3.0-abc/node_modules" })
    expect(logs).toEqual([
      expect.stringMatching(/^Info: Sessions can run the durable agent on pi 1\.3\.0/),
    ])
  })

  test("runs no Sessions, saying why, when the bundle couldn't be had", async () => {
    const logs: Array<string> = []
    const ready = await run(
      preparePi({
        ensure: Effect.fail(new SandboxPiError({ message: "could not get pi: offline" })),
      }),
      logs,
    )
    expect(ready).toBeUndefined()
    expect(logs).toEqual(["Warn: Sessions can't run: could not get pi: offline"])
  })

  test("runs no Sessions once getting pi takes too long, and stops getting it", async () => {
    const logs: Array<string> = []
    const cacheDir = tempDir()
    const stopped: Array<string> = []
    const asked: Array<string> = []
    /** A download or an install that never ends by itself: it ends when its signal aborts. */
    const hangs = (what: string, signal: AbortSignal | undefined) =>
      new Promise<never>((_, reject) => {
        asked.push(what)
        signal?.addEventListener("abort", () => {
          stopped.push(what)
          reject(new Error(`${what} stopped`))
        })
      })
    const ready = await run(
      Effect.gen(function* () {
        const preparing = yield* Effect.forkChild(
          preparePi({
            ensure: ensurePiBundle({
              cacheDir,
              libcs: ["musl"],
              fetch: (url, signal) => hangs(url, signal),
              run: (argv, _cwd, signal) => hangs(argv.join(" "), signal),
            }),
          }),
        )
        while (asked.length < 2) yield* Effect.promise(() => Bun.sleep(5))
        yield* TestClock.adjust(PreparePiTimeout)
        return yield* Fiber.join(preparing)
      }).pipe(Effect.provide(TestClock.layer())),
      logs,
    )
    expect(ready).toBeUndefined()
    expect(logs).toEqual(["Warn: Sessions can't run: getting pi took longer than 5m"])
    expect(stopped).toHaveLength(2)
  })
})
