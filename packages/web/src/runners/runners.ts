// What the Runners page works out from the Hub's state: the order Runners are listed in, how a
// Pairing code it showed is getting on, how its expiry and a Runner's version read, and how a
// Runner's update (#87) is getting on and what its row offers for it.

import {
  type BuildVersion,
  type PairingCodeId,
  type PendingPairingCode,
  refusalText,
  type RunnerHistoryPoint,
  type RunnerId,
  type RunnerSummary,
  type RunnerUpdater,
  type RunnerUpdateState,
  type RunnerVersionStatus,
  type UpdateStep,
  updateUnderWay,
} from "@kndl/protocol"
import { timeAgo } from "../app/format.ts"

/** Online Runners first, then by name. */
export function sortRunners(runners: ReadonlyArray<RunnerSummary>): Array<RunnerSummary> {
  return runners.toSorted(
    (a, b) => Number(b.isOnline) - Number(a.isOnline) || a.name.localeCompare(b.name),
  )
}

/** The Pairing codes still waiting at `now`: the Hub's list leaves out none that expired since. */
export function waitingCodes(
  codes: ReadonlyArray<PendingPairingCode> | null,
  now: number,
): Array<PendingPairingCode> {
  return (codes ?? []).filter((code) => code.expiresAt > now)
}

/** "14 min", "1 min", "under a minute": how long a code has left. */
export function timeLeft(expiresAt: number, now: number): string {
  const left = expiresAt - now
  // To the nearest minute, so a code just made says 15, not 14.
  return left < 60_000 ? "under a minute" : `${Math.round(left / 60_000)} min`
}

/**
 * What a Runner's version against the Hub's says, when it says anything worth a badge; `updater`
 * is how it said it updates, for how to bring it to the Hub's commit.
 */
export function versionNote(
  status: RunnerVersionStatus,
  updater?: RunnerUpdater,
): { readonly label: string; readonly title: string } | undefined {
  switch (status) {
    case "Behind":
      return {
        label: "behind the Hub",
        title: `It runs an older commit than the Hub, so no Session starts or wakes there. ${howToUpdate(updater)}`,
      }
    case "Differs":
      return {
        label: "not the Hub's commit",
        title: `It runs a commit the Hub's history doesn't have: a newer one, or another branch's. ${howToUpdate(updater)}`,
      }
    case "Current":
    case "Unknown":
      return undefined
  }
}

/**
 * Why a Runner that doesn't run the Hub's commit has no Update, said on its row (a tooltip alone
 * isn't seen on a phone): it doesn't update itself. `undefined` when it does, or needn't.
 */
export function manualUpdateText(runner: RunnerSummary): string | undefined {
  if (runner.versionStatus !== "Behind" && runner.versionStatus !== "Differs") return undefined
  if (runner.update !== undefined || runner.updater?.self === true) return undefined
  return howToUpdate(runner.updater)
}

/** How a Runner comes to run the Hub's commit, by the way it said it updates. */
function howToUpdate(updater: RunnerUpdater | undefined): string {
  if (updater === undefined) {
    return "It's too old to update itself: run `kndl update` on its machine once."
  }
  if (updater.self) return "Update moves it to the Hub's commit."
  return `It doesn't update itself${updater.reason === undefined ? "" : `: ${updater.reason}`}.`
}

/** A Runner's update, as its row shows it: a badge, and a line saying where it is. */
export interface UpdateNote {
  readonly label: string
  readonly intent: "accent" | "warning" | "danger"
  readonly detail: string
  /** It is under way: the line has a spinner. */
  readonly busy: boolean
}

/** Where an applied update is, as its row says it. */
function applyText(step: UpdateStep | undefined, commit: string): string {
  switch (step) {
    case undefined:
      return `Moving to ${commit}…`
    case "Fetching":
      return "Fetching from origin…"
    case "CheckingOut":
      return `Checking out ${commit}…`
    case "Installing":
      return "Installing and building…"
    case "Restarting":
      return `Checking it starts on ${commit}…`
  }
}

/** An update under way, saying where it is. */
const busy = (detail: string): UpdateNote => ({
  label: "updating",
  intent: "accent",
  detail,
  busy: true,
})

/** What a Runner's row says of its update, if it has one under way, refused or failed. */
export function updateNote(
  update: RunnerUpdateState | undefined,
  now: number,
): UpdateNote | undefined {
  if (update === undefined) return undefined
  const commit = shortCommit(targetOf(update))
  switch (update._tag) {
    case "Checking":
      return busy(`Checking it can move to ${commit}…`)
    case "Draining": {
      if (update.now) return busy("Stopping its running Turns, then putting its Sessions to sleep…")
      if (update.waitingFor === 0) return busy("Putting its Sessions to sleep…")
      const turns =
        update.waitingFor === 1 ? "1 Session's Turn" : `${update.waitingFor} Sessions' Turns`
      const left = update.deadline - now
      const stop =
        left <= 0
          ? "stopping them now"
          : `stopped in ${left < 60_000 ? "under a minute" : `${Math.ceil(left / 60_000)} min`} if still running`
      return busy(`No new Sessions. Waiting for ${turns} to end (${stop})…`)
    }
    case "Applying":
      return busy(applyText(update.step, commit))
    case "Restarting":
      return {
        label: "restarting",
        intent: "accent",
        detail: `Restarting on ${commit}…`,
        busy: true,
      }
    case "Refused":
      return {
        label: refusalText(update.refusal),
        intent: "warning",
        detail: update.refusal.message,
        busy: false,
      }
    case "Failed":
      return {
        label: "update failed",
        intent: "danger",
        detail: update.failure.rolledBack
          ? `Moving to ${commit} failed, so it went back to the commit it ran: ${update.failure.message}`
          : `Moving to ${commit} failed, and so did going back; see its log: ${update.failure.message}`,
        busy: false,
      }
  }
}

/** What a Runner's row offers for its update, if anything. */
export type UpdateAction =
  /** Update it to the Hub's commit: it is online, updates itself, and runs another commit. */
  | "Update"
  /** It waits for running Turns to end: stop them at once. */
  | "UpdateNow"

export function updateAction(runner: RunnerSummary): UpdateAction | undefined {
  const update = runner.update
  if (update?._tag === "Draining") return update.now ? undefined : "UpdateNow"
  if (updateUnderWay(update)) return undefined
  if (!runner.isOnline || runner.updater?.self !== true) return undefined
  return runner.versionStatus === "Behind" || runner.versionStatus === "Differs"
    ? "Update"
    : undefined
}

function targetOf(update: RunnerUpdateState) {
  return update._tag === "Failed" ? update.failure.target : update.target
}

/** A commit as the page shows it, short, after its Release if it is one's (ADR 0025). */
export function shortCommit(version: BuildVersion): string {
  const commit = version.commit.slice(0, 12)
  return version.release === undefined ? commit : `${version.release} (${commit})`
}

/** A code the Runners page showed, as it was minted. */
export interface ShownCode {
  readonly id: PairingCodeId
  readonly expiresAt: number
}

/** How a shown code is getting on. */
export type CodeOutcome =
  | { readonly _tag: "Waiting" }
  | { readonly _tag: "Expired" }
  /** It was used: by `runner`, once the Hub lists it. */
  | { readonly _tag: "Used"; readonly runner: RunnerSummary | undefined }
  /** Someone revoked it, here or elsewhere. */
  | { readonly _tag: "Revoked" }

/**
 * How `shown` is getting on: used once the Hub says it was redeemed (PairingCodeRedeemed), waiting
 * while it lists it and its time isn't up, and otherwise expired or revoked.
 */
export function codeOutcome(
  shown: ShownCode,
  state: {
    readonly pairingCodes: ReadonlyArray<PendingPairingCode> | null
    readonly redeemedCodes: Readonly<Record<PairingCodeId, RunnerId>>
    readonly runners: ReadonlyArray<RunnerSummary> | null
  },
  now: number,
): CodeOutcome {
  const runnerId = state.redeemedCodes[shown.id]
  if (runnerId !== undefined) {
    return { _tag: "Used", runner: state.runners?.find((runner) => runner.id === runnerId) }
  }
  if (now >= shown.expiresAt) return { _tag: "Expired" }
  const listed = state.pairingCodes?.some((code) => code.id === shown.id) ?? true
  return listed ? { _tag: "Waiting" } : { _tag: "Revoked" }
}

/** How old a host sample is: "12s ago", then as `timeAgo` says it, "3m ago". */
export function sysinfoAge(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  return seconds < 60 ? `${seconds}s ago` : timeAgo(at, now)
}

/**
 * Whether a Runner's row offers its Monitor (#356): once it has connected, as there may be a
 * sample or a history to show. One paired but never seen has neither.
 */
export function hasMonitor(runner: RunnerSummary): boolean {
  return runner.isOnline || runner.lastSeenAt !== null
}

/** A measure a Runner's history keeps (#356). */
export type HistoryMeasure = "diskFreeBytes" | "memoryAvailableBytes" | "load1"

/** One point of a chart: when, and the measure's value then. */
export interface SeriesPoint {
  readonly at: number
  readonly value: number
}

/**
 * One measure of a Runner's history, to chart: a point kept before the Hub kept memory and load
 * (#356) has neither, and is left out of theirs rather than drawn at zero.
 */
export function historySeries(
  points: ReadonlyArray<RunnerHistoryPoint>,
  measure: HistoryMeasure,
): Array<SeriesPoint> {
  return points.flatMap((point) => {
    const value = point[measure]
    return value === undefined ? [] : [{ at: point.at, value }]
  })
}

/** A binary unit of bytes, as a chart's axis counts in it. */
export interface ByteUnit {
  readonly name: "MiB" | "GiB" | "TiB"
  readonly bytes: number
}

const byteUnits: ReadonlyArray<ByteUnit> = [
  { name: "MiB", bytes: 1024 ** 2 },
  { name: "GiB", bytes: 1024 ** 3 },
  { name: "TiB", bytes: 1024 ** 4 },
]

/**
 * The unit a chart of bytes up to `max` counts in, so its ticks are round numbers of it: GiB for
 * most disks and memory, MiB under one GiB, TiB from one TiB.
 */
export function byteUnit(max: number): ByteUnit {
  const [mib, gib, tib] = byteUnits as [ByteUnit, ByteUnit, ByteUnit]
  if (max >= tib.bytes) return tib
  if (max > 0 && max < gib.bytes) return mib
  return gib
}

/** The most ticks a history chart's time axis has. */
const maxTimeTicks = 8

const hourMillis = 3_600_000

/** Hours between ticks a span under two days may have: the first that gives few enough ticks. */
const hourSteps = [1, 2, 3, 6, 12]

/**
 * Where a history chart from `from` to `to` ticks its time axis: at each local midnight for a
 * span of two days or more (a week, mostly), otherwise on the hour every few hours, the fewest
 * that give at most eight ticks.
 */
export function timeTicks(
  from: number,
  to: number,
): { readonly unit: "day" | "hour"; readonly values: Array<number> } {
  if (to - from >= 48 * hourMillis) {
    const values: Array<number> = []
    const day = new Date(from)
    day.setHours(0, 0, 0, 0)
    if (day.getTime() < from) day.setDate(day.getDate() + 1)
    for (; day.getTime() <= to; day.setDate(day.getDate() + 1)) values.push(day.getTime())
    return { unit: "day", values }
  }
  const step = hourSteps.find((hours) => (to - from) / (hours * hourMillis) < maxTimeTicks) ?? 12
  const hour = new Date(from)
  hour.setMinutes(0, 0, 0)
  if (hour.getTime() < from) hour.setHours(hour.getHours() + 1)
  while (hour.getHours() % step !== 0) hour.setHours(hour.getHours() + 1)
  const values: Array<number> = []
  for (; hour.getTime() <= to; hour.setHours(hour.getHours() + step)) values.push(hour.getTime())
  return { unit: "hour", values }
}
