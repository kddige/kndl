// The Runner's host, sampled for the Runners page (#350): the disk the Runner keeps its data on,
// memory, CPU, load and uptime. Sent to the Hub right after the Runner is welcomed, then every
// SysinfoIntervalMillis; display only, nothing in the Runner depends on it.
//
// - The disk is the volume holding `RUNNER_SESSIONS_ROOT`, where Workspaces and Sandbox volumes
//   live; its free space is what is left for an unprivileged process (`bavail`). The data dir may
//   not exist yet on a Runner's first start, so the nearest ancestor that does is measured: the
//   same volume, unless a mount sits in between, which a missing directory can't be.
// - Memory available is Linux's `MemAvailable`, what a program can still get without swapping;
//   elsewhere, and on kernels from before 3.14, the OS's free memory, which reads low on macOS.

import { readFile, statfs } from "node:fs/promises"
import * as os from "node:os"
import { dirname } from "node:path"
import { RunnerSysinfo, type Sysinfo, SysinfoIntervalMillis } from "@kndl/protocol"
import { Duration, Effect } from "effect"
import { HubLink } from "./HubLink.ts"
import { RunnerConfig } from "./RunnerConfig.ts"

/** The bytes `MemAvailable` gives in the text of /proc/meminfo, if it has one. */
export const parseMemAvailable = (meminfo: string): number | undefined => {
  const kilobytes = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo)?.[1]
  return kilobytes === undefined ? undefined : Number(kilobytes) * 1024
}

const memoryAvailable = async (): Promise<number> => {
  const meminfo = await readFile("/proc/meminfo", "utf8").catch(() => undefined)
  return (meminfo === undefined ? undefined : parseMemAvailable(meminfo)) ?? os.freemem()
}

/** Free and total bytes of the volume holding `path`, or of its nearest ancestor that exists. */
const diskOf = async (path: string): Promise<{ readonly free: number; readonly total: number }> => {
  for (let at = path; ; at = dirname(at)) {
    try {
      const disk = await statfs(at)
      return { free: disk.bavail * disk.bsize, total: disk.blocks * disk.bsize }
    } catch (error) {
      if (dirname(at) === at) throw error
    }
  }
}

/** What the host looks like now, with the disk measured under `sessionsRoot`. */
export const readSysinfo = (sessionsRoot: string): Effect.Effect<Sysinfo, Error> =>
  Effect.tryPromise({
    try: async () => {
      const disk = await diskOf(sessionsRoot)
      const total = os.totalmem()
      return {
        diskFreeBytes: Math.floor(disk.free),
        diskTotalBytes: Math.floor(disk.total),
        memoryTotalBytes: Math.floor(total),
        memoryAvailableBytes: Math.min(Math.floor(await memoryAvailable()), Math.floor(total)),
        cpuCores: Math.max(1, os.availableParallelism()),
        loadAverage: os.loadavg() as [number, number, number],
        os: process.platform,
        arch: process.arch,
        uptimeSeconds: Math.floor(os.uptime()),
      }
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })

/**
 * Samples the host now and every `interval`, and sends each sample to the Hub, for as long as it
 * runs: forked for a connection, so it ends with it. A sample that fails is logged and skipped.
 */
export const reportSysinfo = (interval: Duration.Input = Duration.millis(SysinfoIntervalMillis)) =>
  Effect.gen(function* () {
    const config = yield* RunnerConfig
    const hub = yield* HubLink
    yield* readSysinfo(config.sessionsRoot).pipe(
      Effect.flatMap((sysinfo) => hub.send(RunnerSysinfo.make(sysinfo))),
      Effect.catch((error) => Effect.logWarning(`Could not sample the host: ${error.message}`)),
      Effect.andThen(Effect.sleep(interval)),
      Effect.forever,
    )
  })
