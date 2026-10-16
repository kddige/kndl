import { Schema } from "effect"
import { SessionId } from "./Ids.ts"

// A Runner's host, sampled (#350): the Runner measures its disk, memory and CPU every
// SysinfoIntervalMillis and sends the Hub a RunnerSysinfo, right after its hello too. The Hub keeps
// the latest sample of each Runner in memory, on its RunnerSummary, and its free disk, available
// memory and 1-minute load (#356) of the last RunnerHistoryRetentionMillis in its database, one
// point per RunnerHistoryPointMillis, for the Runners page's Monitor to chart. All of it is for
// display: nothing in kndl is refused for a full disk.
//
// A Session's disk use (#352) is measured on demand, not sampled: the archive list asks the Hub,
// the Hub asks the Runner (MeasureSessionDisks), and the Runner adds up what is allocated on its
// disk. See SessionDiskSize.

/** How often a Runner samples its host. */
export const SysinfoIntervalMillis = 30_000

/** The Hub keeps one history point for each span of this long, the latest sample in it. */
export const RunnerHistoryPointMillis = 5 * 60 * 1000

/** How long the Hub keeps a history point: 7 days. */
export const RunnerHistoryRetentionMillis = 7 * 24 * 60 * 60 * 1000

/** A count of bytes. */
const Bytes = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** What a Runner measures of its host. */
export const Sysinfo = Schema.Struct({
  /** Free space on the volume that holds the Runner's data (`RUNNER_SESSIONS_ROOT`). */
  diskFreeBytes: Bytes,
  /** The size of that volume. */
  diskTotalBytes: Bytes,
  memoryTotalBytes: Bytes,
  /** Memory a program can still get without swapping, which is more than the free memory. */
  memoryAvailableBytes: Bytes,
  cpuCores: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** The load average over the last 1, 5 and 15 minutes; zeros on a host that has none. */
  loadAverage: Schema.Tuple([Schema.Number, Schema.Number, Schema.Number]),
  /** The operating system, as Node and Bun name it: `linux` or `darwin`. */
  os: Schema.NonEmptyString,
  /** The CPU architecture, as Node and Bun name it: `arm64` or `x64`. */
  arch: Schema.NonEmptyString,
  /** How long the host has been up. */
  uptimeSeconds: Bytes,
})
export type Sysinfo = typeof Sysinfo.Type

/** A {@link Sysinfo} and when the Hub had it: the latest sample, as a RunnerSummary carries it. */
export const SysinfoSample = Schema.Struct({
  ...Sysinfo.fields,
  /** When the Hub received it, in epoch milliseconds. */
  at: Schema.Natural,
})
export type SysinfoSample = typeof SysinfoSample.Type

/**
 * A Runner's host at one moment, one point of its history: the latest sample of its 5 minutes.
 * Memory and load are absent from a point the Hub kept before it kept them (#356).
 */
export const RunnerHistoryPoint = Schema.Struct({
  /** In epoch milliseconds. */
  at: Schema.Natural,
  diskFreeBytes: Bytes,
  memoryAvailableBytes: Schema.optionalKey(Bytes),
  /** The load average over the last minute. */
  load1: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
})
export type RunnerHistoryPoint = typeof RunnerHistoryPoint.Type

/** A disk with less than this free is low, whatever its size: 10 GiB. */
export const LowDiskFreeBytes = 10 * 1024 ** 3

/** A disk with less than this share of it free is low, however large: a tenth. */
export const LowDiskFreeShare = 0.1

/**
 * Whether a Runner's disk is low: under {@link LowDiskFreeBytes} free, or under
 * {@link LowDiskFreeShare} of it, whichever comes first. Fixed here, not configurable, and only a
 * warning: it never stops a Session from starting.
 */
export const diskIsLow = (disk: Pick<Sysinfo, "diskFreeBytes" | "diskTotalBytes">): boolean =>
  disk.diskTotalBytes > 0 &&
  (disk.diskFreeBytes < LowDiskFreeBytes ||
    disk.diskFreeBytes < disk.diskTotalBytes * LowDiskFreeShare)

/**
 * The free space under which a disk of `diskTotalBytes` is low, as {@link diskIsLow} has it: the
 * larger of {@link LowDiskFreeBytes} and {@link LowDiskFreeShare} of it. For drawing the line.
 */
export const lowDiskBelowBytes = (diskTotalBytes: number): number =>
  Math.max(LowDiskFreeBytes, diskTotalBytes * LowDiskFreeShare)

/** How many Sessions one request for disk use may name. */
export const MaxDiskUsageSessions = 500

/**
 * How much of a Runner's disk a Session takes (#352): what is actually allocated, as `du` counts
 * it (a sparse file counts the blocks it has, not its length), of the Session's directory on the
 * host with its Workspace, and of its microsandbox disk volumes, not the sizes their caps allow.
 * `bytes` is absent when it isn't known: the Runner is offline or too old, or couldn't measure it.
 */
export const SessionDiskSize = Schema.Struct({
  sessionId: SessionId,
  bytes: Schema.optionalKey(Bytes),
})
export type SessionDiskSize = typeof SessionDiskSize.Type
