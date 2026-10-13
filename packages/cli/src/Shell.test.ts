import { describe, expect, test } from "bun:test"
import { dirname } from "node:path"
import { BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Shell, step } from "./Shell.ts"

const run = (command: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const shell = yield* Shell
      return (yield* shell.capture(step("sh", ["-c", command]))).stdout.trim()
    }).pipe(Effect.provide(Shell.layer.pipe(Layer.provide(BunServices.layer)))),
  )

describe("Shell", () => {
  test("a Step stays in this process's session, so sudo and polkit can reach the terminal", async () => {
    const own = Bun.spawnSync(["ps", "-o", "sid=", "-p", String(process.pid)]).stdout.toString()

    expect(await run("ps -o sid= -p $$")).toBe(own.trim())
  })

  test("a Step finds the Bun running the CLI, even when PATH doesn't have it", async () => {
    const path = process.env.PATH
    process.env.PATH = "/usr/bin:/bin"
    try {
      expect(await run("command -v bun")).toStartWith(dirname(process.execPath))
    } finally {
      process.env.PATH = path
    }
  })
})
