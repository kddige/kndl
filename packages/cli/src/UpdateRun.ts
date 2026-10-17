// One run of `kndl update` (issue #360), safe with nobody at the terminal: the Hub starts it from
// the web (#359), with no TTY and its input closed. A run from a terminal gets all of it too.
//
//   lock       `<home>/update/lock`, taken first and held to the end: a second update, from the CLI
//              or the Hub, is refused while one runs. A lock whose process is gone is stale, and
//              is taken over.
//   status     `<home>/update/status.json`: where the run is, rewritten as each step starts, and
//              how it ended.
//   log        `<home>/update/update.log`: what the run's Steps ran and printed (Actions.ts's
//              StepLog), emptied as a run starts.
//   rollback   when a step fails after the checkout moved, or the Hub isn't healthy once it
//              restarted, the checkout goes back to the commit and branch it was on and is built
//              again there, the services that restarted restart again, and the Hub's request that
//              its Runners follow is put back as it was: none is sent on to the commit left.
//
// The files' paths and shapes are protocol's (UpdateStatus.ts), which the Hub reads them with.
// What the run does to the machine beyond its checkout goes through UpdateEdges, which tests stand
// in for.
import { randomUUID } from "node:crypto"
import { appendFile, link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { uptime } from "node:os"
import { dirname, join } from "node:path"
import type { PushRecorded, UpdatePush } from "@kndl/hub/src/RunnerUpdatePush.ts"
import {
  CommitIdPattern,
  decodeUpdateLock,
  releaseOf,
  type UpdateLock,
  updateLockHeld,
  UpdateLockPath,
  UpdateLogPath,
  updateRunningText,
  type UpdateSource,
  type UpdateState,
  UpdateStatus,
  UpdateStatusPath,
} from "@kndl/protocol"
import { Cause, Clock, Console, Effect, Exit, Option, Schema } from "effect"
import { runSteps, StepLog } from "./Actions.ts"
import type { Health } from "./Doctor.ts"
import { type CliFailure, fail } from "./Failure.ts"
import { configuredRoles, errorMessage, readCheckout, writeFileWhole } from "./Host.ts"
import type { Layout, Role } from "./Layout.ts"
import { Shell, step } from "./Shell.ts"
import { Ui } from "./Ui.ts"
import {
  buildPlan,
  buildSteps,
  type Channel,
  channelAfter,
  channelStep,
  type Checkout,
  containsCheckoutStep,
  describeCheckout,
  gitSteps,
  localRunnerRestart,
  needsRemote,
  parseLsRemote,
  pinnedNotice,
  RefNotFound,
  rollbackSteps,
  runnersNotice,
  stableNotice,
  type Target,
  updateTarget,
} from "./Update.ts"

/** What `update` is asked to do. */
export interface UpdateOptions {
  /** `--ref`/`--branch`: where to move the install. */
  readonly ref: string | undefined
  /** `--channel`: follow the latest Release, or main, from now on (ADR 0025). */
  readonly channel: Channel | undefined
  /** On the Hub's machine, ask the Runners on other machines to follow (not `--no-update-runners`). */
  readonly updateRunners: boolean
  /** `--now`: Runners stop their running Turns at once, rather than letting them end. */
  readonly now: boolean
  /** `--source`: who started it, for the lock and the status. */
  readonly source: UpdateSource
}

/** How long the Hub has to answer `/health` after it restarts, before the update rolls back. */
export const HubHealthSeconds = 30

/** What an update does to the machine beyond its checkout, standing in for the real thing in tests. */
export interface UpdateEdges {
  /** The Bun the build Steps run. */
  readonly bun: string
  /** Whether a role's service is installed here. */
  readonly serviceInstalled: (role: Role) => Effect.Effect<boolean, never, Shell>
  /** Whether the installed service file of a role differs from the one the CLI writes now. */
  readonly serviceFileChanged: (role: Role) => Effect.Effect<boolean>
  /** Leaves the Hub the commit, for its Runners to follow; `undefined` when it couldn't. */
  readonly leavePush: (options: {
    readonly commit: string
    readonly now: boolean
    readonly allRunners: boolean
  }) => Effect.Effect<PushRecorded | undefined, never, Ui>
  /** Puts back the push {@link UpdateEdges.leavePush} replaced, or leaves none. */
  readonly restorePush: (replaced: UpdatePush | undefined) => Effect.Effect<void, never, Ui>
  /** Rewrites and reloads the installed services, but not `except`'s. */
  readonly restartServices: (
    except: Role | undefined,
  ) => Effect.Effect<void, CliFailure, Shell | Ui>
  /** Waits up to {@link HubHealthSeconds} for the Hub's `/health`. */
  readonly waitForHub: Effect.Effect<Health, never, Shell>
}

// ── The lock ─────────────────────────────────────────────────────────────

/** Whether a process with this pid runs: signal 0 finds it, or finds it isn't ours to signal. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return codeOf(error) === "EPERM"
  }
}

const codeOf = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? error.code : undefined

/** The lock at `path`; `undefined` when there is none, or it isn't one. */
const readLock = (path: string) =>
  readFile(path, "utf8").then(
    (text) => Option.getOrUndefined(decodeUpdateLock(text)),
    () => undefined,
  )

const sameLock = (a: UpdateLock | undefined, b: UpdateLock | undefined) =>
  a?.pid === b?.pid && a?.startedAt === b?.startedAt && a?.source === b?.source

/**
 * Takes the lock at `path` for `lock`: `undefined` once it holds it, or the lock another update
 * holds. The lock is written whole beside the path and linked to it, which fails while one is
 * there. A stale one is moved aside first; should what was moved turn out to be a lock another
 * update has just taken, it goes back.
 */
async function claim(path: string, lock: UpdateLock): Promise<UpdateLock | undefined> {
  await mkdir(dirname(path), { recursive: true })
  const partial = `${path}.partial-${process.pid}`
  const aside = `${path}.stale-${process.pid}`
  await writeFile(partial, `${JSON.stringify(lock)}\n`)
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await link(partial, path)
        return undefined
      } catch (error) {
        if (codeOf(error) !== "EEXIST") throw error
      }
      const held = await readLock(path)
      const machine = { running, bootedAt: Date.now() - uptime() * 1000 }
      if (held !== undefined && updateLockHeld(held, machine)) return held
      try {
        await rename(path, aside)
      } catch (error) {
        if (codeOf(error) !== "ENOENT") throw error
        continue
      }
      if (!sameLock(await readLock(aside), held)) await link(aside, path).catch(() => undefined)
      await rm(aside, { force: true })
    }
    throw new Error("other updates kept taking it")
  } finally {
    await rm(partial, { force: true })
  }
}

/**
 * Holds `<home>/update/lock` until the scope closes. Fails, saying who holds it, while another
 * update runs; it doesn't wait.
 */
export const holdUpdateLock = (home: string, source: UpdateSource) => {
  const path = join(home, UpdateLockPath)
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const lock: UpdateLock = {
        pid: process.pid,
        startedAt: yield* Clock.currentTimeMillis,
        source,
      }
      const holder = yield* Effect.tryPromise({
        try: () => claim(path, lock),
        catch: (error) => fail(`Can't take the update's lock, ${path}: ${errorMessage(error)}`),
      })
      if (holder !== undefined) return yield* fail(updateRunningText(holder))
      return lock
    }),
    (lock) =>
      Effect.promise(async () => {
        if (sameLock(await readLock(path), lock)) await rm(path, { force: true })
      }),
  )
}

// ── The status and the log ───────────────────────────────────────────────

const encodeStatus = Schema.encodeSync(UpdateStatus)

/** Keeps `<home>/update/status.json`, writing it whole each time it changes. */
const statusFile = (home: string, initial: UpdateStatus) =>
  Effect.gen(function* () {
    const path = join(home, UpdateStatusPath)
    let status = initial
    const write = (next: UpdateStatus) =>
      Effect.suspend(() => {
        status = next
        return writeFileWhole(path, `${JSON.stringify(encodeStatus(next), null, 2)}\n`, 0o644)
      })
    yield* write(initial)
    return {
      get running() {
        return status.state === "Running"
      },
      step: (label: string) => write({ ...status, step: label }),
      target: (target: NonNullable<UpdateStatus["target"]>) => write({ ...status, target }),
      finish: (state: Exclude<UpdateState, "Running">, error?: string) =>
        Effect.flatMap(Clock.currentTimeMillis, (finishedAt) =>
          write({ ...status, state, finishedAt, ...(error !== undefined && { error }) }),
        ),
    }
  })

/** Empties `<home>/update/update.log`, and appends to it. */
const logFile = (home: string) =>
  Effect.gen(function* () {
    const path = join(home, UpdateLogPath)
    yield* Effect.promise(() => writeFile(path, ""))
    return (text: string) => Effect.promise(() => appendFile(path, text))
  })

/** The name `update` moves to, as the status says it. */
function refOf(target: Target): string {
  return target._tag === "Commit" ? target.sha : target.name
}

// ── The run ──────────────────────────────────────────────────────────────

/**
 * Moves the install to `ref`, or along what it follows; then installs, builds, restarts the
 * installed services and checks the Hub is healthy, rolling back when any of that fails. On the
 * Hub's machine, it leaves the Hub the commit for its Runners to follow (issue #87); the Runner
 * here, when it updates itself, is drained by the Hub and restarts itself, rather than restarting
 * under its Sessions.
 *
 * Returns whether the install moved, for `update` to run doctor after it. Fails when another
 * update runs, when it fails, and when it rolled back.
 */
export const updateInstall = (layout: Layout, options: UpdateOptions, edges: UpdateEdges) =>
  Effect.scoped(
    Effect.gen(function* () {
      const lock = yield* holdUpdateLock(layout.home.dir, options.source)
      const log = yield* logFile(layout.home.dir)
      const before = yield* readCheckout(layout.app)
      if (!CommitIdPattern.test(before.commit)) {
        return yield* fail(
          `Can't tell which commit ${layout.app} is on, so update couldn't go back to it.`,
        )
      }
      const version = before.tag === undefined ? undefined : releaseOf([before.tag])
      const status = yield* statusFile(layout.home.dir, {
        id: randomUUID(),
        source: options.source,
        startedAt: lock.startedAt,
        from: { commit: before.commit, ...(version !== undefined && { version }) },
        step: "Starting",
        state: "Running",
      })
      const begin = (label: string) => Effect.andThen(log(`\n== ${label}\n`), status.step(label))
      const progress: Progress = { moved: false, restarted: false, hubRestarts: false }
      return yield* move(layout, options, edges, { before, status, begin, progress }).pipe(
        Effect.tap(() => status.finish("Succeeded")),
        Effect.catchTag("CliFailure", (error) =>
          Effect.andThen(
            log(`\n${error.message}\n`),
            progress.moved
              ? rollBack(layout, edges, { before, error, status, begin, progress })
              : Effect.andThen(status.finish("Failed", error.message), Effect.fail(error)),
          ),
        ),
        Effect.onExit((exit) =>
          Exit.isFailure(exit) && status.running
            ? status.finish(
                "Failed",
                Cause.hasInterruptsOnly(exit.cause)
                  ? "The update was stopped."
                  : `The update stopped: ${errorMessage(Cause.squash(exit.cause))}`,
              )
            : Effect.void,
        ),
        Effect.provideService(StepLog, log),
      )
    }),
  )

/** How far the run got, for the rollback. */
interface Progress {
  /** The checkout moved: a failure from here on rolls back. */
  moved: boolean
  /** The services began restarting on the new commit: the rollback restarts them again. */
  restarted: boolean
  /** The Hub's service restarted, and is checked on. */
  hubRestarts: boolean
  /** The push the update left the Hub, which the rollback takes back. */
  pushed?: PushRecorded
}

interface RunContext {
  readonly before: Checkout
  readonly status: Effect.Success<ReturnType<typeof statusFile>>
  /** Starts a step: says so in the status and the log. */
  readonly begin: (label: string) => Effect.Effect<void>
  readonly progress: Progress
}

/** Whether a restarted Hub is healthy; fails, saying why, when it isn't. */
const checkHub = (edges: UpdateEdges, after: string) =>
  Effect.gen(function* () {
    const health = yield* edges.waitForHub
    if (!health.ok) {
      return yield* fail(
        `The Hub at ${health.url} wasn't healthy ${HubHealthSeconds} seconds after it restarted${after}: ${health.detail}.`,
      )
    }
  })

const move = (layout: Layout, options: UpdateOptions, edges: UpdateEdges, run: RunContext) =>
  Effect.gen(function* () {
    const { before, status, begin, progress } = run
    const request = { ref: options.ref, channel: options.channel }
    const shell = yield* Shell
    let remote = { branches: [] as ReadonlyArray<string>, tags: [] as ReadonlyArray<string> }
    if (needsRemote(before, request)) {
      yield* begin("Asking origin for its branches and tags")
      remote = parseLsRemote(
        (yield* shell
          .capture(step("git", ["ls-remote", "--heads", "--tags", "origin"], { cwd: layout.app }))
          .pipe(
            Effect.mapError((error) => fail(`Could not ask origin for its refs: ${error.message}`)),
          )).stdout,
      )
    }
    const target = updateTarget(before, request, remote)
    if (target instanceof RefNotFound) return yield* fail(target.message)
    if (target._tag === "Pinned") {
      yield* Console.log(pinnedNotice(target))
      return false
    }
    const channel = channelAfter(before, request)
    if (target._tag === "NoRelease") {
      yield* begin("Recording the Channel")
      yield* runSteps([channelStep(layout.app, channel)])
      yield* Console.log(stableNotice(target))
      return false
    }
    const ref = refOf(target)
    yield* status.target({ ref })
    const moves = gitSteps(layout.app, target)
    yield* begin("Fetching")
    yield* runSteps(moves.slice(0, 1))
    if (target._tag === "Release") {
      // The Release's tag is here now, to compare with.
      const contains = yield* shell.capture(containsCheckoutStep(layout.app, target.name))
      if (contains.exitCode !== 0) {
        yield* begin("Recording the Channel")
        yield* runSteps([channelStep(layout.app, channel)])
        yield* Console.log(stableNotice({ _tag: "Older", release: target.name }))
        return false
      }
    }
    yield* Console.log(`Updating ${layout.app} (${describeCheckout(before)}):`)
    yield* begin("Checking out")
    yield* runSteps(moves.slice(1))
    progress.moved = true
    yield* runSteps([channelStep(layout.app, channel)])
    const after = yield* readCheckout(layout.app)
    if (CommitIdPattern.test(after.commit)) yield* status.target({ ref, commit: after.commit })
    const roles = configuredRoles(layout)
    for (const { label, step: s } of buildPlan(layout.app, edges.bun, roles)) {
      yield* begin(label)
      yield* runSteps([s])
    }
    yield* Console.log(`Now at ${describeCheckout(after)}.`)
    const hubRestarts = roles.includes("hub") && (yield* edges.serviceInstalled("hub"))
    const pushed = hubRestarts
      ? yield* edges.leavePush({
          commit: after.commit,
          now: options.now,
          allRunners: options.updateRunners,
        })
      : undefined
    if (pushed !== undefined) progress.pushed = pushed
    const local = roles.includes("runner")
      ? localRunnerRestart({
          installed: yield* edges.serviceInstalled("runner"),
          hubRestarts: pushed !== undefined,
          serviceFileChanged: yield* edges.serviceFileChanged("runner"),
          updatesItself: pushed?.localRunner?.updatesItself === true,
        })
      : "None"
    if (pushed !== undefined) {
      for (const line of runnersNotice({
        commit: after.commit,
        updateRunners: options.updateRunners,
        now: options.now,
        local,
        localName: pushed.localRunner?.name,
      })) {
        yield* Console.log(line)
      }
    }
    yield* begin(hubRestarts ? "Restarting the Hub" : "Restarting the services")
    progress.restarted = true
    progress.hubRestarts = hubRestarts
    yield* edges.restartServices(local === "Hub" ? "runner" : undefined)
    // The Hub runs its migrations as it starts: give it the time before checking on it. A dry
    // run started nothing to check.
    if (hubRestarts && !shell.dryRun) {
      yield* begin("Checking the Hub's health")
      yield* checkHub(edges, "")
    }
    return true
  })

/**
 * Puts the install back where it was after `error`, as the module's header says, and fails: with
 * `error`, once the install is back (RolledBack), or with both errors when going back failed too
 * (Failed).
 */
const rollBack = (
  layout: Layout,
  edges: UpdateEdges,
  run: RunContext & { readonly error: CliFailure },
) =>
  Effect.gen(function* () {
    const { before, error, status, begin, progress } = run
    const shell = yield* Shell
    yield* (yield* Ui).log("error", error.message)
    yield* Console.log(`Going back to ${describeCheckout(before)}:`)
    yield* begin("Rolling back")
    const back = yield* Effect.exit(
      Effect.gen(function* () {
        yield* runSteps(rollbackSteps(layout.app, before))
        yield* runSteps(buildSteps(layout.app, edges.bun, configuredRoles(layout)))
        if (progress.pushed !== undefined) yield* edges.restorePush(progress.pushed.replaced)
        if (!progress.restarted) return
        yield* edges.restartServices(undefined)
        if (progress.hubRestarts && !shell.dryRun) yield* checkHub(edges, " on the old commit")
      }),
    )
    if (Exit.isSuccess(back)) {
      yield* status.finish("RolledBack", error.message)
      return yield* fail(
        `The update failed, so the install went back to ${describeCheckout(before)}: ${error.message}`,
      )
    }
    const both = `${error.message} Going back to ${before.commit.slice(0, 12)} failed too: ${errorMessage(Cause.squash(back.cause))}`
    yield* status.finish("Failed", both)
    return yield* fail(
      `The update failed. ${both} Run \`kndl doctor\` to see where the install is.`,
    )
  })
