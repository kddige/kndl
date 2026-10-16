import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RunnerToHub } from "@kndl/protocol"
import { Effect, Fiber, Layer, Schema } from "effect"
import { parseMemAvailable, readSysinfo, reportSysinfo } from "./HostSysinfo.ts"
import { HubLink } from "./HubLink.ts"
import { RunnerConfig, type RunnerSettings } from "./RunnerConfig.ts"
import { eventually } from "./testSupport.ts"

const dirs: Array<string> = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "kndl-sysinfo-"))
  dirs.push(dir)
  return dir
}

describe("parseMemAvailable", () => {
  test("reads MemAvailable, in kB, as bytes", () => {
    const meminfo = [
      "MemTotal:       16384000 kB",
      "MemFree:         1024000 kB",
      "MemAvailable:    8192000 kB",
      "Buffers:          512000 kB",
    ].join("\n")
    expect(parseMemAvailable(meminfo)).toBe(8192000 * 1024)
  })

  test("is undefined when there is no MemAvailable, as on a kernel from before 3.14", () => {
    expect(parseMemAvailable("MemTotal: 1 kB\nMemFree: 1 kB\n")).toBeUndefined()
  })
})

describe("readSysinfo", () => {
  test("measures the host, to a shape the Hub takes", async () => {
    const sysinfo = await Effect.runPromise(readSysinfo(tempDir()))

    expect(Schema.is(RunnerToHub.cases.RunnerSysinfo)({ _tag: "RunnerSysinfo", ...sysinfo })).toBe(
      true,
    )
    expect(sysinfo.diskTotalBytes).toBeGreaterThan(0)
    expect(sysinfo.diskFreeBytes).toBeLessThanOrEqual(sysinfo.diskTotalBytes)
    expect(sysinfo.memoryTotalBytes).toBeGreaterThan(0)
    expect(sysinfo.memoryAvailableBytes).toBeLessThanOrEqual(sysinfo.memoryTotalBytes)
    expect(sysinfo.cpuCores).toBeGreaterThanOrEqual(1)
    expect(sysinfo.os).toBe(process.platform)
    expect(sysinfo.arch).toBe(process.arch)
  })

  test("measures the volume of the nearest directory that exists, before the data dir is made", async () => {
    const root = join(tempDir(), "sessions", "not", "there", "yet")

    const there = await Effect.runPromise(readSysinfo(root))
    const here = await Effect.runPromise(readSysinfo(tmpdir()))

    expect(there.diskTotalBytes).toBe(here.diskTotalBytes)
  })
})

describe("reportSysinfo", () => {
  test("sends a RunnerSysinfo at once and again every interval", async () => {
    const sent: Array<RunnerToHub> = []
    const layer = Layer.mergeAll(
      Layer.succeed(
        HubLink,
        HubLink.of({
          send: (message) => Effect.sync(() => void sent.push(message)),
          connect: () => Effect.void,
          disconnect: Effect.void,
        }),
      ),
      Layer.succeed(
        RunnerConfig,
        RunnerConfig.of({ sessionsRoot: tempDir() } as unknown as RunnerSettings),
      ),
    )

    const fiber = Effect.runFork(reportSysinfo("20 millis").pipe(Effect.provide(layer)))
    await eventually(() => sent.length >= 3)
    await Effect.runPromise(Fiber.interrupt(fiber))

    expect(sent.every((message) => message._tag === "RunnerSysinfo")).toBe(true)
  })
})
