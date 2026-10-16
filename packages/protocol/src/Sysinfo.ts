import { Schema } from "effect"

// A Runner's host, sampled (#350): the Runner measures its disk, memory and CPU every
// SysinfoIntervalMillis and sends the Hub a RunnerSysinfo, right after its hello too. The Hub keeps
// the latest sample of each Runner in memory, on its RunnerSummary, and the disk-free numbers of
// the last DiskHistoryRetentionMillis in its database, one point per DiskHistoryPointMillis, for
// the Runners page to draw. All of it is for display: nothing in kndl is refused for a full disk.

/** How often a Runner samples its host. */
export const SysinfoIntervalMillis = 30_000

/** The Hub keeps one disk-free point for each span of this long, the latest sample in it. */
export const DiskHistoryPointMillis = 5 * 60 * 1000

/** How long the Hub keeps a disk-free point: 7 days. */
export const DiskHistoryRetentionMillis = 7 * 24 * 60 * 60 * 1000

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

/** A Runner's free disk at one moment, one point of its history. */
export const DiskFreePoint = Schema.Struct({
  /** In epoch milliseconds. */
  at: Schema.Natural,
  freeBytes: Bytes,
})
export type DiskFreePoint = typeof DiskFreePoint.Type

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
