// The Owner updates the Hub from the web (ADR 0028, #362). The Hub doesn't update itself: it
// launches the real `kndl update --source hub` outside its own service (HubUpdateLauncher.ts), and
// follows it in the files `kndl update` keeps in `<home>/update/` (protocol's UpdateStatus.ts):
//
//   lock          held while an update runs, from the CLI or the web: a second one is refused
//   status.json   the latest update, rewritten as each step starts: sent to the Owner as it changes
//   update.log    its steps' output: its end goes with an update that ended, to the Owner alone
//
// The Hub reads `status.json` every second while an update runs, or one it launched hasn't started
// yet, and every few seconds otherwise, so that an update started at a terminal shows too. The
// Hub is restarted under the update it follows, and the new one reads how it ended as it starts.
//
// Only a Hub that checks for a newer kndl (HubUpdates.ts) has any of it: one the kndl service runs
// from the installed checkout, which is the one `kndl update` moves.

import { randomUUID } from "node:crypto"
import { open, readFile } from "node:fs/promises"
import { uptime } from "node:os"
import { join } from "node:path"
import {
  type Channel,
  decodeUpdateLock,
  decodeUpdateStatus,
  type HubUpdateRun,
  hubPinnedMessage,
  hubUpdateStartingMessage,
  hubUpdatesOffMessage,
  MaxUpdateLogTailLength,
  MaxUpdateLogTailLines,
  type UpdateLock,
  updateLockHeld,
  UpdateLockPath,
  UpdateLogPath,
  updateRunningText,
  UpdateStatusPath,
} from "@kndl/protocol"
import { HomeConfig } from "@kndl/protocol/home"
import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  PubSub,
  type Scope,
  Semaphore,
} from "effect"
import { cliEntryPoint } from "./CliBuilds.ts"
import { HubUpdateLauncher, type UpdateJob, updateOutput, updateUnit } from "./HubUpdateLauncher.ts"
import { HubUpdates } from "./HubUpdates.ts"

/** How often the Hub reads `status.json`: while an update runs or starts, and otherwise. */
export interface PollIntervals {
  readonly running: Duration.Duration
  readonly idle: Duration.Duration
}

const defaultPolls: PollIntervals = { running: Duration.seconds(1), idle: Duration.seconds(5) }

/**
 * How long an update the Hub launched has to write its status before the Hub stops waiting for it,
 * and lets the Owner start another.
 */
export const startingWindow = Duration.minutes(1)

/** What an update the Hub found Running, with no process holding the lock, says it ended with. */
export const stoppedUnsaidText =
  "The update stopped before it said how it ended, as when its process is killed. See its log."

/** Whether a process with this pid runs: signal 0 finds it, or finds it isn't ours to signal. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM"
  }
}

/** The file's text; `undefined` when there is none. */
const readText = (path: string) =>
  Effect.promise(() => readFile(path, "utf8").catch(() => undefined))

/** The last lines of the file at `path`, as many as fit: `undefined` when it is empty or missing. */
const readTail = (path: string) =>
  Effect.promise(async () => {
    const file = await open(path, "r").catch(() => undefined)
    if (file === undefined) return undefined
    try {
      const { size } = await file.stat()
      // More than fits, for the lines to start at a line's start.
      const length = Math.min(size, MaxUpdateLogTailLength * 4)
      const buffer = Buffer.alloc(length)
      await file.read(buffer, 0, length, size - length)
      return logTail(buffer.toString("utf8"), length < size)
    } finally {
      await file.close()
    }
  }).pipe(Effect.orElseSucceed(() => undefined))

/**
 * The end of a log: its last {@link MaxUpdateLogTailLines} lines, cut to
 * {@link MaxUpdateLogTailLength} characters, whole lines first. `cut` says `text` is itself the end
 * of something longer, whose first line may be part of one.
 */
export function logTail(text: string, cut = false): string | undefined {
  const lines = text.replace(/\s+$/, "").split("\n")
  if (cut) lines.shift()
  let tail = lines.slice(-MaxUpdateLogTailLines)
  while (tail.length > 1 && tail.join("\n").length > MaxUpdateLogTailLength) tail = tail.slice(1)
  const joined = tail.join("\n").slice(-MaxUpdateLogTailLength).replace(/^\n+/, "")
  return joined.trim() === "" ? undefined : joined
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export class HubUpdateRuns extends Context.Service<
  HubUpdateRuns,
  {
    /** The latest update, ended or not; None before any, or on a Hub that doesn't check. */
    readonly latest: Effect.Effect<Option.Option<HubUpdateRun>>
    /**
     * Launches `kndl update --source hub`, with `--now` and `--channel` as asked, once nothing
     * stops it: why it doesn't, if it doesn't. The Owner's alone, which the caller checks.
     */
    readonly start: (request: {
      readonly now: boolean
      readonly channel: Channel | undefined
    }) => Effect.Effect<string | undefined>
    /** The latest update each time it changes, from now on. */
    readonly changes: Effect.Effect<PubSub.Subscription<HubUpdateRun>, never, Scope.Scope>
  }
>()("@kndl/hub/HubUpdateRuns") {
  /** On a Hub that doesn't check (HubUpdates.ts): nothing to follow, and nothing to start. */
  static readonly offService = HubUpdateRuns.of({
    latest: Effect.succeedNone,
    start: () => Effect.succeed(hubUpdatesOffMessage),
    // Nothing is ever published to it.
    changes: Effect.flatMap(PubSub.unbounded<HubUpdateRun>(), PubSub.subscribe),
  })

  static readonly off = Layer.succeed(HubUpdateRuns, HubUpdateRuns.offService)

  /** On where HubUpdates is, in the home KNDL_HOME names. */
  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const updates = yield* HubUpdates
      if (!updates.on) return HubUpdateRuns.off
      const home = yield* HomeConfig
      return HubUpdateRuns.layerOn({ home: home.dir })
    }),
  )

  /**
   * Follows the updates of the install in `home`, and launches them with HubUpdateLauncher. The
   * update runs the Bun that runs the Hub, on `<home>/app`'s CLI, with the Hub's PATH.
   */
  static readonly layerOn = (options: { readonly home: string; readonly polls?: PollIntervals }) =>
    Layer.effect(
      HubUpdateRuns,
      Effect.gen(function* () {
        const { home } = options
        const polls = options.polls ?? defaultPolls
        const launcher = yield* HubUpdateLauncher
        const hubUpdates = yield* HubUpdates
        const layerScope = yield* Effect.scope
        const published = yield* PubSub.unbounded<HubUpdateRun>()
        const starting = Semaphore.makeUnsafe(1)
        const statusPath = join(home, UpdateStatusPath)
        const lockPath = join(home, UpdateLockPath)
        const logPath = join(home, UpdateLogPath)

        let run: HubUpdateRun | undefined
        /** `status.json` as last read, to skip an ended update's that didn't change. */
        let read: string | undefined
        /** The latest update that ended, seen ending or ended as the Hub started. */
        let ended: string | undefined
        /** The update the Hub launched, until its status is written: when, and the one before. */
        let launched: { readonly at: number; readonly before: string | undefined } | undefined

        /** The lock, while an update holds it. */
        const heldLock = Effect.map(readText(lockPath), (text): UpdateLock | undefined => {
          const lock =
            text === undefined ? undefined : Option.getOrUndefined(decodeUpdateLock(text))
          const machine = { running, bootedAt: Date.now() - uptime() * 1000 }
          return lock !== undefined && updateLockHeld(lock, machine) ? lock : undefined
        })

        /** Reads `status.json`, and tells the Owner when the latest update changed. */
        const follow = (first: boolean) =>
          Effect.gen(function* () {
            const text = yield* readText(statusPath)
            if (text === undefined || (text === read && run?.status.state !== "Running")) return
            read = text
            const decoded = decodeUpdateStatus(text)
            if (Option.isNone(decoded)) return
            let status = decoded.value
            if (status.state === "Running" && (yield* heldLock) === undefined) {
              // The lock is let go after the status is written: one that changed since ended.
              if ((yield* readText(statusPath)) !== text) {
                read = undefined
                return
              }
              status = { ...status, state: "Failed", error: stoppedUnsaidText }
            }
            if (launched !== undefined && status.id !== launched.before) launched = undefined
            const tail = status.state === "Running" ? undefined : yield* readTail(logPath)
            const next: HubUpdateRun = { status, ...(tail !== undefined && { logTail: tail }) }
            if (same(next, run)) return
            run = next
            yield* PubSub.publish(published, next)
            if (status.state === "Running" || status.id === ended) return
            ended = status.id
            if (first) return
            yield* Effect.logInfo(`The update ${status.id} ended: ${status.state}.`)
            // A Channel it recorded without moving the Hub, which isn't restarted then.
            yield* hubUpdates.refollow
          })

        yield* follow(true)
        yield* Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          if (launched !== undefined && now - launched.at > Duration.toMillis(startingWindow)) {
            yield* Effect.logWarning(
              `The update the Hub started didn't say it started: see ${updateOutput(home)}.`,
            )
            launched = undefined
          }
          yield* Effect.sleep(
            run?.status.state === "Running" || launched !== undefined ? polls.running : polls.idle,
          )
          yield* follow(false)
        }).pipe(Effect.forever, Effect.forkIn(layerScope))

        const start = (request: { readonly now: boolean; readonly channel: Channel | undefined }) =>
          starting.withPermit(
            Effect.gen(function* () {
              const update = yield* hubUpdates.latest
              const follows = Option.getOrUndefined(update)?.follows
              if (follows?._tag === "Pinned" && request.channel === undefined) {
                return hubPinnedMessage(follows.ref)
              }
              const now = yield* Clock.currentTimeMillis
              if (
                launched !== undefined &&
                now - launched.at <= Duration.toMillis(startingWindow)
              ) {
                return hubUpdateStartingMessage
              }
              const holder = yield* heldLock
              if (holder !== undefined) return updateRunningText(holder)
              const job: UpdateJob = {
                id: randomUUID().slice(0, 8),
                home,
                bun: process.execPath,
                cli: cliEntryPoint(join(home, "app")),
                path: process.env.PATH ?? "",
                now: request.now,
                channel: request.channel,
              }
              launched = { at: now, before: run?.status.id }
              const launch = yield* Effect.result(launcher.launch(job))
              if (launch._tag === "Failure") {
                launched = undefined
                yield* Effect.logWarning(`Could not start the update: ${launch.failure}`)
                return `Couldn't start the update: ${launch.failure}`
              }
              yield* Effect.logInfo(
                `The Owner started an update from the web (${updateUnit(job)}): its output goes to ${updateOutput(home)}.`,
              )
              return undefined
            }),
          )

        return HubUpdateRuns.of({
          latest: Effect.sync(() => Option.fromUndefinedOr(run)),
          start,
          changes: PubSub.subscribe(published),
        })
      }),
    )
}
