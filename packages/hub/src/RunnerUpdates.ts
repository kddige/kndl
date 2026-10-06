// Runners follow the Hub's commit (issue #87, ADR 0011): the Hub's side of a Runner's update.
//
// The Hub decides when a Runner updates, and drains it first, since only the Hub knows its Turns:
//
//   Checking   CheckUpdate sent; the Runner says whether it may move to the commit.
//   Draining   No Session starts or wakes there. Each Active Session sleeps once its Turn ends;
//              Turns still running after UpdateDrainMillis, or at once for "update now", are
//              stopped. Prompts wait in their queues.
//   Applying   Every Session is asleep: ApplyUpdate sent; the Runner moves and restarts.
//   Restarting It disconnected to restart. It is done when it says hello on the commit.
//   Refused    It won't move to the commit ("refuses: not on main"), or Failed: it tried, and is
//              back on its old commit (or not, which it says), as its UpdateFailed or hello says.
//
// The state is the Hub's memory only: a Hub restart forgets an update under way, which its
// Runner's next hello settles (a failure it reports in `lastUpdate`), and `kndl update`'s
// push (RunnerUpdatePush.ts) starts again for Runners that connect behind.
//
// The transitions and the drain plan are pure, below; makeRunnerUpdates runs them under the
// Session relay's lock, as part of it.

import {
  ApplyUpdate,
  type BuildVersion,
  CheckUpdate,
  type HubToRunner,
  type Participant,
  type RunnerId,
  type RunnerUpdater,
  type RunnerUpdateState,
  type RunnerVersionStatus,
  type SessionId,
  type SessionState,
  type SessionSummary,
  type UpdateChecked,
  type UpdateFailure,
  UpdateDrainMillis,
  type UpdateProgress,
  updateUnderWay,
} from "@kndl/protocol"
import { Clock, Effect } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { pushCovers, type UpdatePush } from "./RunnerUpdatePush.ts"

// ── Pure ─────────────────────────────────────────────────────────────────────

const sameCommit = (a: BuildVersion | undefined, b: BuildVersion | undefined) =>
  a !== undefined && b !== undefined && a.commit === b.commit

/** A Runner as an update request sees it. */
export interface UpdateCandidate {
  readonly name: string
  readonly isOnline: boolean
  readonly updater: RunnerUpdater | undefined
  readonly versionStatus: RunnerVersionStatus
  readonly update: RunnerUpdateState | undefined
}

/** Why the Runner can't be asked to update to the Hub's commit, or `undefined` when it can. */
export function updateRequestRefusal(
  runner: UpdateCandidate,
  hub: BuildVersion | undefined,
): string | undefined {
  if (hub === undefined) {
    return "The Hub doesn't run from a git checkout, so it has no commit for Runners to follow."
  }
  if (!runner.isOnline) return `${runner.name} is offline: it can update once it is back.`
  if (runner.updater === undefined) {
    return `${runner.name} is too old to update itself: run \`kndl update\` on it once.`
  }
  if (!runner.updater.self) {
    return `${runner.name} doesn't update itself${runner.updater.reason === undefined ? "" : `: ${runner.updater.reason}`}.`
  }
  if (runner.versionStatus === "Current") return `${runner.name} already runs the Hub's commit.`
  return undefined
}

/** The update after the Runner's answer to CheckUpdate. */
export function afterChecked(
  state: RunnerUpdateState | undefined,
  message: UpdateChecked,
  at: number,
  now: boolean,
): RunnerUpdateState | undefined {
  if (state?._tag !== "Checking" || !sameCommit(state.target, message.target)) return state
  if (message.refusal !== undefined) {
    return { _tag: "Refused", target: state.target, at, refusal: message.refusal }
  }
  return {
    _tag: "Draining",
    target: state.target,
    since: at,
    deadline: at + UpdateDrainMillis,
    now,
    waitingFor: 0,
  }
}

/** The update after the Runner says where it is. */
export function afterProgress(
  state: RunnerUpdateState | undefined,
  message: UpdateProgress,
): RunnerUpdateState | undefined {
  if (state?._tag !== "Applying" || !sameCommit(state.target, message.target)) return state
  return { ...state, step: message.step }
}

/** The update after the Runner says it failed (and rolled back, or not). */
export function afterFailed(failure: UpdateFailure): RunnerUpdateState {
  return { _tag: "Failed", failure }
}

/**
 * The update after the Runner disconnected: one being applied is restarting; one still checking or
 * draining is abandoned (nothing was moved yet); a refusal or failure is kept to show.
 */
export function afterDisconnect(
  state: RunnerUpdateState | undefined,
  at: number,
): RunnerUpdateState | undefined {
  switch (state?._tag) {
    case "Applying":
      return { _tag: "Restarting", target: state.target, since: at }
    case "Checking":
    case "Draining":
      return undefined
    default:
      return state
  }
}

/**
 * The update after the Runner said hello: done if it runs the commit it was moving to, or failed,
 * as its `lastUpdate` says, or because it came back on another commit.
 */
export function afterHello(
  state: RunnerUpdateState | undefined,
  hello: {
    readonly version: BuildVersion | undefined
    readonly lastUpdate: UpdateFailure | undefined
  },
  at: number,
): RunnerUpdateState | undefined {
  const target = state === undefined ? undefined : targetOf(state)
  // Whatever it was moving to, it got there.
  if (target !== undefined && sameCommit(hello.version, target)) return undefined
  const failure = hello.lastUpdate
  if (failure !== undefined && !sameCommit(hello.version, failure.target)) {
    if (state === undefined || sameCommit(target, failure.target)) return afterFailed(failure)
  }
  switch (state?._tag) {
    case "Restarting":
    case "Applying":
      return afterFailed({
        target: state.target,
        message: "It restarted on its old commit without saying why: see its log.",
        rolledBack: true,
        at,
      })
    case "Checking":
    case "Draining":
      return undefined
    default:
      return state
  }
}

/** The commit an update is (or was) moving to. */
export function targetOf(state: RunnerUpdateState): BuildVersion {
  return state._tag === "Failed" ? state.failure.target : state.target
}

/** A Session of a draining Runner. */
export interface DrainSession {
  readonly id: SessionId
  readonly state: SessionState
  /** A Turn runs, or a prompt is out to its mod and a Turn is about to. */
  readonly turn: boolean
  /** Its start is under way, or it is already being put to sleep: it settles first. */
  readonly settling: boolean
}

export interface DrainPlan {
  /** Sessions to put to sleep now: Active, with nothing running. */
  readonly sleep: ReadonlyArray<SessionId>
  /** Sessions whose Turn to stop now. */
  readonly stopTurns: ReadonlyArray<SessionId>
  /** Sessions still Active. */
  readonly waitingFor: number
  /** None is Active: the Runner can move. */
  readonly drained: boolean
}

/**
 * What to do next for a draining Runner's Sessions. Turns are stopped when `stopTurns` (update
 * now, or past the deadline), each once: `stopped` holds those already asked.
 */
export function drainPlan(
  sessions: ReadonlyArray<DrainSession>,
  options: { readonly stopTurns: boolean; readonly stopped: ReadonlySet<SessionId> },
): DrainPlan {
  const active = sessions.filter((session) => session.state === "Active")
  return {
    sleep: active
      .filter((session) => !session.turn && !session.settling)
      .map((session) => session.id),
    stopTurns: options.stopTurns
      ? active
          .filter((session) => session.turn && !options.stopped.has(session.id))
          .map((session) => session.id)
      : [],
    waitingFor: active.length,
    drained: active.length === 0,
  }
}

/**
 * Whether the Hub tells a Runner that just said hello to follow its commit, from the push
 * `kndl update` left: the push covers it, it updates itself, it runs another commit, it
 * wasn't told already, and its last try at this commit didn't fail (which would loop).
 */
export function pushApplies(
  push: UpdatePush | undefined,
  runner: {
    readonly id: RunnerId
    readonly version: BuildVersion | undefined
    readonly updater: RunnerUpdater | undefined
    readonly lastUpdate: UpdateFailure | undefined
  },
  told: ReadonlySet<RunnerId>,
): boolean {
  if (push === undefined || !pushCovers(push, runner.id) || told.has(runner.id)) return false
  if (runner.updater?.self !== true) return false
  if (runner.version?.commit === push.commit) return false
  return runner.lastUpdate?.target.commit !== push.commit
}

// ── Under the Session relay's lock ───────────────────────────────────────────

/** A connected Runner, as updates need it. */
export interface UpdatingRunner {
  readonly id: RunnerId
  readonly name: string
  readonly version: BuildVersion | undefined
  readonly updater: RunnerUpdater | undefined
  readonly peer: { readonly send: (message: HubToRunner) => void }
}

export function makeRunnerUpdates(deps: {
  readonly hub: BuildVersion | undefined
  readonly statusOf: (version: BuildVersion | undefined) => RunnerVersionStatus
  /** The push `kndl update` left for the Hub's commit, if any. */
  readonly push: UpdatePush | undefined
  readonly online: (id: RunnerId) => UpdatingRunner | undefined
  /** The Runner's Sessions, with what a drain needs of each. */
  readonly drainSessions: (id: RunnerId) => Effect.Effect<ReadonlyArray<DrainSession>, SqlError>
  readonly session: (id: SessionId) => Effect.Effect<SessionSummary | undefined, SqlError>
  readonly putToSleep: (session: SessionSummary, message: string) => Effect.Effect<void, SqlError>
  /** Asks the Session's mod to stop its Turn; logs who asked, if a person did. */
  readonly stopTurn: (
    sessionId: SessionId,
    by: Participant | undefined,
  ) => Effect.Effect<void, SqlError>
  /** Sends every web client the Runner list. */
  readonly runnersChanged: Effect.Effect<void, SqlError>
}) {
  const updates = new Map<RunnerId, RunnerUpdateState>()
  /** Who asked for each drain's update now (for TurnStopRequested), and the Turns stopped so far. */
  const drains = new Map<RunnerId, { by: Participant | undefined; stopped: Set<SessionId> }>()
  /** Runners the push was sent to by this Hub: once each. */
  const told = new Set<RunnerId>()

  const set = (id: RunnerId, state: RunnerUpdateState | undefined) => {
    if (state === undefined) updates.delete(id)
    else updates.set(id, state)
    if (state?._tag !== "Draining") drains.delete(id)
  }

  /** Why no Session may start or wake on the Runner now, if none may. */
  const stateOf = (id: RunnerId) => updates.get(id)

  /** Whether the Runner is draining or moving: its Sessions take no prompts. */
  const holding = (id: RunnerId) => updateUnderWay(updates.get(id))

  /** Moves a draining Runner's Sessions along, and sends ApplyUpdate once all are asleep. */
  const drain = Effect.fn("RunnerUpdates.drain")(function* (id: RunnerId) {
    const state = updates.get(id)
    const runner = deps.online(id)
    if (state?._tag !== "Draining" || runner === undefined) return
    const at = yield* Clock.currentTimeMillis
    const pastDeadline = at >= state.deadline
    const record = drains.get(id) ?? { by: undefined, stopped: new Set<SessionId>() }
    drains.set(id, record)
    const plan = drainPlan(yield* deps.drainSessions(id), {
      stopTurns: state.now || pastDeadline,
      stopped: record.stopped,
    })
    for (const sessionId of plan.stopTurns) {
      record.stopped.add(sessionId)
      yield* deps.stopTurn(sessionId, state.now ? record.by : undefined)
    }
    for (const sessionId of plan.sleep) {
      const session = yield* deps.session(sessionId)
      if (session === undefined) continue
      const stopped = record.stopped.has(sessionId)
      yield* deps.putToSleep(
        session,
        stopped
          ? `Put to sleep for ${runner.name}'s update, after its Turn was stopped${state.now ? "" : `: it ran past ${UpdateDrainMillis / 60_000} minutes`}`
          : `Put to sleep for ${runner.name}'s update`,
      )
    }
    if (plan.drained) {
      set(id, { _tag: "Applying", target: state.target, since: at })
      yield* Effect.logInfo(`Runner ${runner.name}: its Sessions are asleep; updating it`)
      runner.peer.send(ApplyUpdate.make({ target: state.target }))
      return yield* deps.runnersChanged
    }
    if (plan.waitingFor !== state.waitingFor) {
      set(id, { ...state, waitingFor: plan.waitingFor })
      yield* deps.runnersChanged
    }
  })

  /** Moves every draining Runner along: after anything that may have ended a Turn, or a tick. */
  const drainAll = Effect.gen(function* () {
    for (const [id, state] of updates) if (state._tag === "Draining") yield* drain(id)
  }).pipe(Effect.withSpan("RunnerUpdates.drainAll"))

  /**
   * Asks the Runner to update to the Hub's commit, or, while it drains, to stop its Turns now.
   * Returns why not, if it can't.
   */
  const request = Effect.fn("RunnerUpdates.request")(function* (
    id: RunnerId,
    options: { readonly now: boolean; readonly by: Participant | undefined },
  ) {
    const runner = deps.online(id)
    const current = updates.get(id)
    if (runner !== undefined && current?._tag === "Draining") {
      if (options.now && !current.now) {
        set(id, { ...current, now: true })
        drains.set(id, {
          by: options.by,
          stopped: drains.get(id)?.stopped ?? new Set<SessionId>(),
        })
        yield* drain(id)
        yield* deps.runnersChanged
      }
      return undefined
    }
    if (updateUnderWay(current)) return undefined
    const refusal = updateRequestRefusal(
      {
        name: runner?.name ?? "The Runner",
        isOnline: runner !== undefined,
        updater: runner?.updater,
        versionStatus: deps.statusOf(runner?.version),
        update: current,
      },
      deps.hub,
    )
    if (refusal !== undefined || runner === undefined || deps.hub === undefined) return refusal
    const at = yield* Clock.currentTimeMillis
    set(id, { _tag: "Checking", target: deps.hub, since: at })
    drains.set(id, { by: options.by, stopped: new Set() })
    pendingNow.set(id, options.now)
    yield* Effect.logInfo(`Asking Runner ${runner.name} to update to ${deps.hub.commit}`)
    runner.peer.send(CheckUpdate.make({ target: deps.hub }))
    yield* deps.runnersChanged
    return undefined
  })
  /** Whether each check under way was asked for with "update now". */
  const pendingNow = new Map<RunnerId, boolean>()

  /** A message about its update from the Runner. */
  const receive = Effect.fn("RunnerUpdates.receive")(function* (
    id: RunnerId,
    message:
      | UpdateChecked
      | UpdateProgress
      | { readonly _tag: "UpdateFailed"; readonly failure: UpdateFailure },
  ) {
    const at = yield* Clock.currentTimeMillis
    const before = updates.get(id)
    switch (message._tag) {
      case "UpdateChecked": {
        const by = drains.get(id)?.by
        const next = afterChecked(before, message, at, pendingNow.get(id) ?? false)
        pendingNow.delete(id)
        set(id, next)
        if (next?._tag === "Draining") {
          drains.set(id, { by, stopped: new Set() })
          yield* drain(id)
        } else if (next?._tag === "Refused") {
          yield* Effect.logWarning(
            `Runner ${deps.online(id)?.name ?? id} won't update: ${next.refusal.message}`,
          )
        }
        break
      }
      case "UpdateProgress":
        set(id, afterProgress(before, message))
        break
      case "UpdateFailed":
        yield* Effect.logWarning(
          `Runner ${deps.online(id)?.name ?? id} failed to update: ${message.failure.message}`,
        )
        set(id, afterFailed(message.failure))
        break
    }
    yield* deps.runnersChanged
  })

  /**
   * A Runner said hello: settles an update it restarted for, and tells it to follow the Hub's
   * commit if `kndl update`'s push covers it.
   */
  const hello = Effect.fn("RunnerUpdates.hello")(function* (
    runner: UpdatingRunner,
    lastUpdate: UpdateFailure | undefined,
  ) {
    const at = yield* Clock.currentTimeMillis
    set(runner.id, afterHello(updates.get(runner.id), { version: runner.version, lastUpdate }, at))
    if (
      pushApplies(
        deps.push,
        { id: runner.id, version: runner.version, updater: runner.updater, lastUpdate },
        told,
      )
    ) {
      told.add(runner.id)
      yield* request(runner.id, { now: deps.push?.now ?? false, by: undefined })
    }
  })

  /** A Runner disconnected. */
  const gone = Effect.fn("RunnerUpdates.gone")(function* (id: RunnerId) {
    pendingNow.delete(id)
    set(id, afterDisconnect(updates.get(id), yield* Clock.currentTimeMillis))
  })

  /** A Runner was removed: forget its update. */
  const forget = (id: RunnerId) => {
    set(id, undefined)
    told.delete(id)
  }

  return { stateOf, holding, request, receive, hello, gone, forget, drain, drainAll }
}

export type RunnerUpdates = ReturnType<typeof makeRunnerUpdates>
