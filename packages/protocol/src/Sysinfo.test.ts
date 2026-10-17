import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { RunnerToHub } from "./Runner.ts"
import { RunnerSummary } from "./Session.ts"
import {
  diskIsLow,
  LowDiskFreeBytes,
  lowDiskBelowBytes,
  MaxDiskUsageSessions,
  RunnerHistoryPoint,
  Sysinfo,
} from "./Sysinfo.ts"
import { HubToWeb, WebToHub } from "./Web.ts"

const GiB = 1024 ** 3

const sample = {
  diskFreeBytes: 200 * GiB,
  diskTotalBytes: 500 * GiB,
  memoryTotalBytes: 16 * GiB,
  memoryAvailableBytes: 9 * GiB,
  cpuCores: 8,
  loadAverage: [0.5, 0.75, 1.25],
  os: "linux",
  arch: "arm64",
  uptimeSeconds: 86_400,
}

describe("diskIsLow", () => {
  test("is false with plenty free by both measures", () => {
    expect(diskIsLow({ diskFreeBytes: 200 * GiB, diskTotalBytes: 500 * GiB })).toBe(false)
  })

  test("is true under 10 GiB free, however large the disk", () => {
    expect(diskIsLow({ diskFreeBytes: 9 * GiB, diskTotalBytes: 4096 * GiB })).toBe(true)
  })

  test("is true under a tenth of the disk free, however many GiB that is", () => {
    expect(diskIsLow({ diskFreeBytes: 99 * GiB, diskTotalBytes: 1000 * GiB })).toBe(true)
  })

  test("is false at exactly the limits", () => {
    expect(diskIsLow({ diskFreeBytes: LowDiskFreeBytes, diskTotalBytes: 100 * GiB })).toBe(false)
    expect(diskIsLow({ diskFreeBytes: 100 * GiB, diskTotalBytes: 1000 * GiB })).toBe(false)
  })

  test("is false for a disk that reports no size", () => {
    expect(diskIsLow({ diskFreeBytes: 0, diskTotalBytes: 0 })).toBe(false)
  })
})

describe("the Runner's sysinfo", () => {
  test("is a Runner message, with the load averages as three numbers", () => {
    const message = Schema.decodeUnknownSync(RunnerToHub)({ _tag: "RunnerSysinfo", ...sample })
    expect(message).toMatchObject({ _tag: "RunnerSysinfo", loadAverage: [0.5, 0.75, 1.25] })
    expect(() =>
      Schema.decodeUnknownSync(RunnerToHub)({
        _tag: "RunnerSysinfo",
        ...sample,
        loadAverage: [1, 2],
      }),
    ).toThrow()
  })

  test("refuses a negative size or load, or a fractional core count", () => {
    const decode = Schema.decodeUnknownSync(Sysinfo)
    expect(() => decode({ ...sample, diskFreeBytes: -1 })).toThrow()
    expect(() => decode({ ...sample, cpuCores: 1.5 })).toThrow()
    // A history point can't hold a negative load, so a sample with one isn't taken either.
    expect(() => decode({ ...sample, loadAverage: [-1, 0, 0] })).toThrow()
  })

  test("is on a Runner's summary, with when it was sampled, and a summary without it still reads", () => {
    const summary = {
      id: "runner-1",
      name: "mac",
      isOnline: true,
      version: null,
      versionStatus: "Unknown",
      lastSeenAt: 1,
      openSessions: 0,
    }
    expect(Schema.decodeUnknownSync(RunnerSummary)(summary)).not.toHaveProperty("sysinfo")
    expect(
      Schema.decodeUnknownSync(RunnerSummary)({ ...summary, sysinfo: { ...sample, at: 5 } })
        .sysinfo,
    ).toMatchObject({ at: 5, cpuCores: 8 })
  })
})

describe("a Runner's history", () => {
  test("is asked for by Runner and answered with points of disk, memory and load, oldest first", () => {
    expect(
      Schema.decodeUnknownSync(WebToHub)({
        _tag: "GetRunnerHistory",
        requestId: "q-1",
        runnerId: "runner-1",
      })._tag,
    ).toBe("GetRunnerHistory")
    const point = { at: 1, diskFreeBytes: 5, memoryAvailableBytes: 7, load1: 0.5 }
    expect(
      Schema.decodeUnknownSync(HubToWeb)({
        _tag: "RunnerHistory",
        requestId: "q-1",
        runnerId: "runner-1",
        points: [point],
      }),
    ).toMatchObject({ points: [point] })
  })

  test("has points without memory or load, kept before the Hub kept them (#356)", () => {
    expect(Schema.decodeUnknownSync(RunnerHistoryPoint)({ at: 1, diskFreeBytes: 5 })).toEqual({
      at: 1,
      diskFreeBytes: 5,
    })
    expect(() =>
      Schema.decodeUnknownSync(RunnerHistoryPoint)({ at: 1, diskFreeBytes: 5, load1: -1 }),
    ).toThrow()
  })
})

describe("lowDiskBelowBytes", () => {
  test("is 10 GiB on a disk of 100 GiB or less, and a tenth of a larger one", () => {
    expect(lowDiskBelowBytes(50 * GiB)).toBe(LowDiskFreeBytes)
    expect(lowDiskBelowBytes(100 * GiB)).toBe(LowDiskFreeBytes)
    expect(lowDiskBelowBytes(500 * GiB)).toBe(50 * GiB)
  })

  test("is where diskIsLow turns", () => {
    for (const total of [20 * GiB, 120 * GiB, 4096 * GiB]) {
      const below = lowDiskBelowBytes(total)
      expect(diskIsLow({ diskFreeBytes: below - 1, diskTotalBytes: total })).toBe(true)
      expect(diskIsLow({ diskFreeBytes: below, diskTotalBytes: total })).toBe(false)
    }
  })
})

const ask = (sessionIds: ReadonlyArray<string>) => ({
  _tag: "GetSessionDiskUsage",
  requestId: "q-1",
  sessionIds,
})

describe("a Session's disk use", () => {
  test("is asked for by Session ids, up to a bound, and answered with a size or none", () => {
    expect(Schema.decodeUnknownSync(WebToHub)(ask(["s-1"]))._tag).toBe("GetSessionDiskUsage")
    expect(() =>
      Schema.decodeUnknownSync(WebToHub)(
        ask(Array.from({ length: MaxDiskUsageSessions + 1 }, (_, i) => `s-${i}`)),
      ),
    ).toThrow()
    expect(
      Schema.decodeUnknownSync(HubToWeb)({
        _tag: "SessionDiskUsage",
        requestId: "q-1",
        sizes: [{ sessionId: "s-1", bytes: 0 }, { sessionId: "s-2" }],
      }),
    ).toMatchObject({ sizes: [{ bytes: 0 }, { sessionId: "s-2" }] })
  })
})
