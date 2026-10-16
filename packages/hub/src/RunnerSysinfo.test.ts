// A Runner's sysinfo (#350): the latest sample on its summary, and the history of its disk, memory
// and load (#356) the Runners page charts, over the web channel and in the Hub's database.

import { afterEach, describe, expect, test } from "bun:test"
import {
  RunnerHistoryPointMillis,
  RunnerHistoryRetentionMillis,
  type RunnerId,
  type Sysinfo,
} from "@kndl/protocol"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { Runners } from "./Runners.ts"
import { issueRunnerToken, openRunner, openWeb, stopAll } from "./testChannels.ts"
import { startHub, type TestHub } from "./testSupport.ts"

afterEach(stopAll)

const GiB = 1024 ** 3

const sysinfo = (
  diskFreeBytes: number,
  { memoryAvailableBytes = 9 * GiB, load1 = 0.5 } = {},
): Sysinfo => ({
  diskFreeBytes,
  diskTotalBytes: 500 * GiB,
  memoryTotalBytes: 16 * GiB,
  memoryAvailableBytes,
  cpuCores: 8,
  loadAverage: [load1, 0.75, 1.25],
  os: "linux",
  arch: "arm64",
  uptimeSeconds: 86_400,
})

const hubWithRunner = async () => {
  const hub = await startHub({ config: { devLogin: true } })
  const { token, runnerId } = await issueRunnerToken(hub, "studio")
  return { hub, token, runnerId }
}

const history = (hub: TestHub, runnerId: RunnerId, now: number) =>
  hub.run(Effect.flatMap(Runners, (runners) => runners.history(runnerId, now)))

const record = (
  hub: TestHub,
  runnerId: RunnerId,
  free: number,
  at: number,
  more: Parameters<typeof sysinfo>[1] = {},
) =>
  hub.run(
    Effect.flatMap(Runners, (runners) => runners.recordSysinfo(runnerId, sysinfo(free, more), at)),
  )

describe("a Runner's sysinfo", () => {
  test("is on its summary with when the Hub had it, for everyone, and kept after it disconnects", async () => {
    const { hub, token } = await hubWithRunner()
    const web = await openWeb(hub, "alice")
    const runner = await openRunner(hub, token)
    const before = Date.now()

    runner.send({ _tag: "RunnerSysinfo", ...sysinfo(200 * GiB) })
    const list = await web.take("RunnerList", (m) => m.runners[0]?.sysinfo !== undefined)
    expect(list.runners[0]?.sysinfo).toMatchObject(sysinfo(200 * GiB))
    expect(list.runners[0]?.sysinfo?.at).toBeGreaterThanOrEqual(before)

    await runner.close()
    const gone = await web.take("RunnerList", (m) => m.runners[0]?.isOnline === false)
    expect(gone.runners[0]?.sysinfo).toMatchObject({ diskFreeBytes: 200 * GiB })
  })

  test("is replaced by the next sample, and a Runner that sent none has none", async () => {
    const { hub, token } = await hubWithRunner()
    const web = await openWeb(hub, "alice")
    const runner = await openRunner(hub, token)
    const silent = await web.take("RunnerList", (m) => m.runners[0]?.isOnline === true)
    expect(silent.runners[0]).not.toHaveProperty("sysinfo")

    runner.send({ _tag: "RunnerSysinfo", ...sysinfo(200 * GiB) })
    runner.send({ _tag: "RunnerSysinfo", ...sysinfo(150 * GiB) })

    const list = await web.take(
      "RunnerList",
      (m) => m.runners[0]?.sysinfo?.diskFreeBytes === 150 * GiB,
    )
    expect(list.runners[0]?.sysinfo?.cpuCores).toBe(8)
  })

  test("is ignored when it doesn't decode, and the Runner stays connected", async () => {
    const { hub, token } = await hubWithRunner()
    const web = await openWeb(hub, "alice")
    const runner = await openRunner(hub, token)

    runner.send({ _tag: "RunnerSysinfo", ...sysinfo(200 * GiB), loadAverage: [1] })
    runner.send({ _tag: "RunnerSysinfo", ...sysinfo(100 * GiB) })

    const list = await web.take("RunnerList", (m) => m.runners[0]?.sysinfo !== undefined)
    expect(list.runners[0]?.sysinfo?.diskFreeBytes).toBe(100 * GiB)
  })
})

describe("a Runner's history", () => {
  test("keeps the disk, memory and load of the latest sample of each 5 minutes, oldest first", async () => {
    const { hub, runnerId } = await hubWithRunner()
    const start = 1_800_000_000_000 - (1_800_000_000_000 % RunnerHistoryPointMillis)

    await record(hub, runnerId, 100 * GiB, start + 1_000, { memoryAvailableBytes: 8 * GiB })
    await record(hub, runnerId, 90 * GiB, start + 31_000, {
      memoryAvailableBytes: 7 * GiB,
      load1: 2.5,
    })
    await record(hub, runnerId, 80 * GiB, start + RunnerHistoryPointMillis + 1_000, {
      memoryAvailableBytes: 6 * GiB,
      load1: 0,
    })

    expect(await history(hub, runnerId, start + RunnerHistoryPointMillis + 2_000)).toEqual([
      { at: start + 31_000, diskFreeBytes: 90 * GiB, memoryAvailableBytes: 7 * GiB, load1: 2.5 },
      {
        at: start + RunnerHistoryPointMillis + 1_000,
        diskFreeBytes: 80 * GiB,
        memoryAvailableBytes: 6 * GiB,
        load1: 0,
      },
    ])
  })

  test("has a point kept before memory and load were (#356) without them", async () => {
    const { hub, runnerId } = await hubWithRunner()
    const at = 1_800_000_000_000
    await hub.run(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`INSERT INTO runner_history (runner_id, bucket, at, disk_free_bytes)
          VALUES (${runnerId}, 1, ${at}, ${70 * GiB})`,
      ),
    )
    expect(await history(hub, runnerId, at)).toEqual([{ at, diskFreeBytes: 70 * GiB }])
  })

  test("forgets points older than 7 days, as later samples prune them", async () => {
    const { hub, runnerId } = await hubWithRunner()
    const start = 1_800_000_000_000
    await record(hub, runnerId, 100 * GiB, start)
    await record(hub, runnerId, 90 * GiB, start + 1_000 * RunnerHistoryPointMillis)
    const now = start + RunnerHistoryRetentionMillis + RunnerHistoryPointMillis

    await record(hub, runnerId, 80 * GiB, now)

    expect((await history(hub, runnerId, now)).map((point) => point.diskFreeBytes)).toEqual([
      90 * GiB,
      80 * GiB,
    ])
    const first = await history(hub, runnerId, start + 1)
    expect(first.map((point) => point.diskFreeBytes)).toEqual([90 * GiB, 80 * GiB])
  })

  test("is asked for over the web channel, and refused for a Runner that isn't there", async () => {
    const { hub, token, runnerId } = await hubWithRunner()
    const web = await openWeb(hub, "alice")
    const runner = await openRunner(hub, token)
    runner.send({ _tag: "RunnerSysinfo", ...sysinfo(120 * GiB) })
    await web.take("RunnerList", (m) => m.runners[0]?.sysinfo !== undefined)

    web.send({ _tag: "GetRunnerHistory", requestId: "q-1", runnerId })
    const answer = await web.take("RunnerHistory", (m) => m.requestId === "q-1")
    expect(answer.runnerId).toBe(runnerId)
    expect(answer.points).toHaveLength(1)
    expect(answer.points[0]).toMatchObject({
      diskFreeBytes: 120 * GiB,
      memoryAvailableBytes: 9 * GiB,
      load1: 0.5,
    })

    web.send({ _tag: "GetRunnerHistory", requestId: "q-2", runnerId: "no-such-runner" })
    expect(await web.take("CommandFailed", (m) => m.requestId === "q-2")).toMatchObject({
      command: "GetRunnerHistory",
    })
  })
})
