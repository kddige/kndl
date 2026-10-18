import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

/** A Runner's mod, with its pi extension built or not. */
const modDir = (built: boolean) => {
  const dir = mkdtempSync(join(tmpdir(), "kndl-pi-bundle-"))
  dirs.push(dir)
  if (built) {
    mkdirSync(join(dir, "pi", "dist"), { recursive: true })
    writeFileSync(join(dir, "pi", "dist", "kndl.js"), "// built\n")
  }
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
  test("says where pi's CLI is in the Sandbox once the bundle is ready", async () => {
    const logs: Array<string> = []
    const ready = await run(
      preparePi({ modDir: modDir(true), ensure: Effect.succeed({ appDir: "pi-1.3.0-abc" }) }),
      logs,
    )
    expect(ready).toEqual({
      cli: "/opt/kndl/pi/pi-1.3.0-abc/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    })
    expect(logs).toEqual([expect.stringMatching(/^Info: Sessions can run pi 1\.3\.0/)])
  })

  test("runs Claude Code alone, saying why, when the bundle couldn't be had", async () => {
    const logs: Array<string> = []
    const ready = await run(
      preparePi({
        modDir: modDir(true),
        ensure: Effect.fail(new SandboxPiError({ message: "could not get pi: offline" })),
      }),
      logs,
    )
    expect(ready).toBeUndefined()
    expect(logs).toEqual(["Warn: Sessions run Claude Code alone: could not get pi: offline"])
  })

  test("runs Claude Code alone once getting pi takes too long, and stops getting it", async () => {
    const logs: Array<string> = []
    const cacheDir = modDir(false)
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
            modDir: modDir(true),
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
    expect(logs).toEqual(["Warn: Sessions run Claude Code alone: getting pi took longer than 5m"])
    expect(stopped).toHaveLength(2)
  })

  test("runs Claude Code alone when the mod's pi extension isn't built, getting nothing", async () => {
    const logs: Array<string> = []
    let asked = false
    const ready = await run(
      preparePi({
        modDir: modDir(false),
        ensure: Effect.sync(() => {
          asked = true
          return { appDir: "pi-1.3.0-abc" }
        }),
      }),
      logs,
    )
    expect(ready).toBeUndefined()
    expect(asked).toBe(false)
    expect(logs[0]).toContain("the mod's pi extension")
    expect(logs[0]).toContain("bun run mod:build")
  })
})
