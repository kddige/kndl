// The Runner's updates (issue #87, ADR 0011): what SelfUpdate.ts decides, done. Runs git and bun
// in the checkout the Runner runs from, keeps the marker in its home, and restarts by exiting with
// RestartExitCode for its service to start it again.
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  type ApplyUpdate,
  type BuildVersion,
  type CheckUpdate,
  type CommitId,
  CommitIdPattern,
  type RunnerUpdater,
  RunnerToHub,
  type UpdateFailure,
  type UpdateStep,
} from "@kndl/protocol"
import { thisCheckout } from "@kndl/protocol/checkout"
import { HomeConfig } from "@kndl/protocol/home"
import { Clock, Context, Effect, Layer, Schema, Semaphore } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { HubLink } from "./HubLink.ts"
import { CommandFailed, hostEnvironment, runCommand } from "./Process.ts"
import {
  afterWelcome,
  applyPlan,
  bootDecision,
  checkRefusal,
  type CommitFacts,
  type FailedAt,
  failureOf,
  fetchCommitArgs,
  hasCommitArgs,
  isAncestorArgs,
  LoadCheckVariable,
  lastUpdateOf,
  MainBranch,
  Marker,
  type Position,
  RestartExitCode,
  rejectedAdvice,
  ServiceVariable,
  UpdateAnyCommitVariable,
  updaterOf,
} from "./SelfUpdate.ts"

/** Where the Runner keeps its update across a restart, in its home. */
export const MarkerFile = "runner-update.json"

/** The I/O an update needs, so tests can run it against a scratch checkout. */
export interface UpdaterEdge {
  /** Runs git in the checkout; fails with its exit code and stderr. */
  readonly git: (args: ReadonlyArray<string>) => Effect.Effect<string, CommandFailed>
  /** Installs the checkout's dependencies and builds the mod. */
  readonly build: Effect.Effect<void, CommandFailed>
  /** Checks the Runner loads from the checkout as it is now, without connecting. */
  readonly loadCheck: Effect.Effect<void, CommandFailed>
  readonly readMarker: Effect.Effect<Marker | undefined>
  readonly writeMarker: (marker: Marker | undefined) => Effect.Effect<void>
  /** Ends the process for its service to start it again. */
  readonly restart: Effect.Effect<void>
}

export class Updater extends Context.Service<
  Updater,
  {
    /** Whether it updates itself, and its last update if that failed: for the hello. */
    readonly hello: Effect.Effect<{
      readonly updater: RunnerUpdater
      readonly lastUpdate: UpdateFailure | undefined
    }>
    /** Before connecting: counts a start on a new commit, or rolls back one that keeps failing. */
    readonly boot: Effect.Effect<void>
    /** The Hub welcomed the Runner: an update it restarted for is done. */
    readonly welcomed: Effect.Effect<void>
    /** Acts on the Hub's CheckUpdate or ApplyUpdate, in the background; answers through HubLink. */
    readonly handle: (message: CheckUpdate | ApplyUpdate) => Effect.Effect<void>
    /**
     * The Hub turned the Runner away: says what to do, and updates to the Hub's commit, if it said
     * one and the Runner updates itself.
     */
    readonly rejected: (hub: BuildVersion | undefined) => Effect.Effect<void>
  }
>()("@kndl/runner/Updater") {
  /** For tests and checkouts that never update: a Runner that updates by hand. */
  static readonly manual = (reason = "it runs in a test") =>
    Layer.succeed(
      Updater,
      Updater.of({
        hello: Effect.succeed({ updater: { self: false, reason }, lastUpdate: undefined }),
        boot: Effect.void,
        welcomed: Effect.void,
        handle: () => Effect.void,
        rejected: () => Effect.void,
      }),
    )
}

/** The commit `merge-base --is-ancestor` exits with when the first isn't an ancestor. */
const NotAncestor = 1

export const makeUpdater = Effect.fn("makeUpdater")(function* (
  updater: RunnerUpdater,
  edge: UpdaterEdge,
) {
  const hub = yield* HubLink
  const scope = yield* Effect.scope
  const lock = yield* Semaphore.make(1)
  /** The Hub commit a rejected Runner last tried to update to: tried once per commit. */
  let triedRejected: string | undefined

  const send = (message: RunnerToHub) => hub.send(message)
  const now = Clock.currentTimeMillis

  const position = Effect.gen(function* () {
    const commit = (yield* edge.git(["rev-parse", "HEAD"])).trim()
    if (!CommitIdPattern.test(commit)) {
      return yield* new CommandFailed({ message: `git rev-parse HEAD said ${commit}` })
    }
    const branch = yield* edge.git(["symbolic-ref", "--quiet", "--short", "HEAD"]).pipe(
      Effect.map((out) => out.trim() || undefined),
      Effect.orElseSucceed(() => undefined),
    )
    return { commit, branch } satisfies Position
  })

  /** Whether `commit` is reachable from `ref`; fails on anything but yes or no. */
  const isAncestor = (commit: string, ref: string) =>
    edge.git(isAncestorArgs(commit, ref)).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => error.exitCode === NotAncestor,
        () => Effect.succeed(false),
      ),
    )

  /** Fetches origin, then says what the commit is to the checkout. */
  const commitFacts = (target: BuildVersion) =>
    Effect.gen(function* () {
      const fetched = yield* edge.git(["fetch", "--prune", "--quiet", "origin"]).pipe(
        Effect.as(undefined),
        Effect.catch((error) => Effect.succeed(error.message)),
      )
      if (fetched !== undefined) {
        return { fetchError: fetched, exists: false, onMain: false } satisfies CommitFacts
      }
      const has = edge.git(hasCommitArgs(target.commit)).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      )
      let exists = yield* has
      // A commit on no branch, as a dev Hub's may be: origin may still hand it over by its id.
      if (!exists) {
        yield* edge.git(fetchCommitArgs(target.commit)).pipe(Effect.ignore)
        exists = yield* has
      }
      const onMain = exists
        ? yield* isAncestor(target.commit, `origin/${MainBranch}`).pipe(
            Effect.orElseSucceed(() => false),
          )
        : false
      return { fetchError: undefined, exists, onMain } satisfies CommitFacts
    })

  const check = (target: BuildVersion) =>
    (updater.self ? commitFacts(target).pipe(Effect.option) : Effect.succeedNone).pipe(
      Effect.map((facts) =>
        checkRefusal(updater, target, facts._tag === "Some" ? facts.value : undefined),
      ),
    )

  /** Puts the checkout back with `back`, and rebuilds it. Returns whether that worked. */
  const rollBack = (back: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      yield* edge.git(back)
      yield* edge.build
    }).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logError(`Rolling the update back failed: ${error.message}`).pipe(Effect.as(false)),
      ),
    )

  /** Reports a failed update, and keeps it for the next hello while the Runner runs `from`. */
  const fail = (from: CommitId, failure: UpdateFailure) =>
    Effect.gen(function* () {
      yield* Effect.logError(failure.message)
      yield* edge.writeMarker({ _tag: "Failed", from, failure })
      yield* send(RunnerToHub.cases.UpdateFailed.make({ failure }))
    })

  /**
   * Moves the checkout to `target`, builds it, checks it loads, and restarts. `report` says where
   * it is (to the Hub, when it asked). Returns only if it failed, having rolled back.
   */
  const apply = (target: BuildVersion, report: (step: UpdateStep) => Effect.Effect<void>) =>
    Effect.gen(function* () {
      yield* report("Fetching")
      const head = yield* position.pipe(Effect.option)
      if (head._tag === "None") {
        return yield* send(
          RunnerToHub.cases.UpdateFailed.make({
            failure: failureOf(
              target,
              "Checking",
              "It couldn't read its checkout.",
              undefined,
              yield* now,
            ),
          }),
        )
      }
      const from = head.value
      const refusal = yield* check(target)
      if (refusal !== undefined) {
        return yield* fail(
          from.commit,
          failureOf(target, "Checking", refusal.message, undefined, yield* now),
        )
      }
      const onBranch =
        from.branch === undefined
          ? false
          : yield* isAncestor(target.commit, `origin/${from.branch}`).pipe(
              Effect.orElseSucceed(() => false),
            )
      const plan = applyPlan(from, target, onBranch)
      if (plan._tag === "Restart") {
        // The Hub's machine: `kndl update` moved and built the checkout both run. Never
        // move it back from here.
        yield* report("Restarting")
        const loaded = yield* edge.loadCheck.pipe(Effect.result)
        if (loaded._tag === "Failure") {
          return yield* fail(
            from.commit,
            failureOf(target, "Restarting", loaded.failure.message, undefined, yield* now),
          )
        }
        yield* Effect.logInfo(`The checkout is at ${target.commit} already: restarting on it`)
        return yield* edge.restart
      }
      yield* edge.writeMarker({ _tag: "Applying", from, target, boots: 0, at: yield* now })
      const failedAt = (step: FailedAt) => (error: CommandFailed) =>
        Effect.gen(function* () {
          const rolledBack = yield* rollBack(plan.back)
          return yield* fail(
            from.commit,
            failureOf(target, step, error.message, rolledBack, yield* now),
          )
        })
      yield* report("CheckingOut")
      const moved = yield* edge.git(plan.checkout).pipe(Effect.result)
      if (moved._tag === "Failure") return yield* failedAt("CheckingOut")(moved.failure)
      yield* report("Installing")
      const built = yield* edge.build.pipe(Effect.result)
      if (built._tag === "Failure") return yield* failedAt("Installing")(built.failure)
      yield* report("Restarting")
      const loaded = yield* edge.loadCheck.pipe(Effect.result)
      if (loaded._tag === "Failure") return yield* failedAt("Restarting")(loaded.failure)
      yield* Effect.logInfo(`Moved to ${target.commit}: restarting on it`)
      return yield* edge.restart
    })

  const handle = (message: CheckUpdate | ApplyUpdate) =>
    lock
      .withPermits(1)(
        message._tag === "CheckUpdate"
          ? check(message.target).pipe(
              Effect.flatMap((refusal) =>
                send(
                  RunnerToHub.cases.UpdateChecked.make({
                    target: message.target,
                    ...(refusal !== undefined && { refusal }),
                  }),
                ),
              ),
            )
          : apply(message.target, (step) =>
              send(RunnerToHub.cases.UpdateProgress.make({ target: message.target, step })),
            ),
      )
      .pipe(Effect.forkIn(scope), Effect.asVoid)

  const boot = Effect.gen(function* () {
    // A Runner that doesn't update itself never touches its checkout, whatever a marker says.
    if (!updater.self) return
    const marker = yield* edge.readMarker
    const head = yield* position.pipe(Effect.option)
    const decision = bootDecision(
      marker,
      head._tag === "Some" ? head.value.commit : undefined,
      yield* now,
    )
    switch (decision._tag) {
      case "Keep":
        return
      case "Write":
        return yield* edge.writeMarker(decision.marker)
      case "Clear":
        return yield* edge.writeMarker(undefined)
      case "RollBack": {
        yield* Effect.logError(decision.failure.message)
        const rolledBack = yield* rollBack(decision.back)
        const back = yield* position.pipe(Effect.option)
        yield* edge.writeMarker({
          _tag: "Failed",
          ...(back._tag === "Some" && { from: back.value.commit }),
          failure: { ...decision.failure, rolledBack },
        })
        return yield* edge.restart
      }
    }
  })

  const welcomed = Effect.gen(function* () {
    if (!updater.self) return
    const marker = yield* edge.readMarker
    const after = afterWelcome(marker)
    if (after === marker) return
    if (marker?._tag === "Applying") {
      yield* Effect.logInfo(`Updated to ${marker.target.commit}`)
    }
    yield* edge.writeMarker(after)
  })

  const rejected = (hubVersion: BuildVersion | undefined) =>
    Effect.gen(function* () {
      const advice = rejectedAdvice(updater, hubVersion)
      if (!advice.update || hubVersion === undefined) {
        return yield* Effect.logError(advice.message)
      }
      const last = lastUpdateOf(yield* edge.readMarker)
      if (triedRejected === hubVersion.commit || last?.target.commit === hubVersion.commit) {
        return yield* Effect.logError(
          `The Hub runs ${hubVersion.commit}, which this Runner failed to update to: run \`kndl update\` on this machine. Retrying meanwhile.`,
        )
      }
      triedRejected = hubVersion.commit
      // The Hub can't put this Runner's Sessions to sleep while it turns the Runner away: they keep
      // running in tmux through the restart, as through any Runner restart.
      yield* Effect.logWarning(advice.message)
      yield* lock.withPermits(1)(apply(hubVersion, () => Effect.void))
    })

  return Updater.of({
    hello: Effect.map(edge.readMarker, (marker) => ({
      updater,
      lastUpdate: updater.self ? lastUpdateOf(marker) : undefined,
    })),
    boot,
    welcomed,
    handle,
    rejected,
  })
})

/** Reads the marker; a missing or unreadable one is none. */
const readMarkerFile = (path: string) =>
  Effect.sync(() => {
    if (!existsSync(path)) return undefined
    try {
      return Schema.decodeUnknownSync(Marker)(JSON.parse(readFileSync(path, "utf8")))
    } catch {
      return undefined
    }
  })

const writeMarkerFile = (path: string, marker: Marker | undefined) =>
  Effect.sync(() => {
    if (marker === undefined) rmSync(path, { force: true })
    else writeFileSync(path, `${JSON.stringify(Schema.encodeSync(Marker)(marker), null, 2)}\n`)
  })

/** git, bun and the marker, for a Runner running from `checkout`, keeping its marker at `marker`. */
export const hostEdge = (
  checkout: string,
  marker: string,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
): UpdaterEdge => {
  const env = hostEnvironment()
  const run = (command: string, args: ReadonlyArray<string>, extra: Record<string, string> = {}) =>
    runCommand(command, args, { cwd: checkout, env: { ...env, ...extra } }).pipe(
      Effect.map((result) => result.stdout),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    )
  const bun = process.execPath
  return {
    git: (args) => run("git", args),
    build: Effect.gen(function* () {
      yield* run(bun, ["install"])
      yield* run(bun, ["run", "mod:build"])
    }),
    loadCheck: run(bun, [join(checkout, "packages", "runner", "src", "main.ts")], {
      [LoadCheckVariable]: "1",
    }).pipe(Effect.asVoid),
    readMarker: readMarkerFile(marker),
    writeMarker: (next) => writeMarkerFile(marker, next),
    restart: Effect.sync(() => process.exit(RestartExitCode)),
  }
}

function realpath(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/** The Runner's updater, from its home, the checkout it runs from and its environment. */
export const UpdaterLive = Layer.effect(
  Updater,
  Effect.gen(function* () {
    const home = yield* HomeConfig
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const checkout = existsSync(join(thisCheckout, ".git")) ? realpath(thisCheckout) : undefined
    const updater = updaterOf({
      devHome: home.dev,
      checkout,
      app: realpath(join(home.dir, "app")),
      service: process.env[ServiceVariable],
      anyCommit: process.env[UpdateAnyCommitVariable],
    })
    return yield* makeUpdater(
      updater,
      hostEdge(checkout ?? thisCheckout, join(home.dir, MarkerFile), spawner),
    )
  }),
)
