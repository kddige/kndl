// What the Hub asks its Runners of the disk their Sessions take (#352), for the archive list.
//
// A Runner measures on demand, by walking the Session's directory and its volumes, so the Hub asks
// only when a web client does (GetSessionDiskUsage), never on a timer. What a Runner says is kept
// for SessionDiskCacheMillis, and a Session already being measured is waited on, not asked again,
// so several people opening the list, or one opening it again, ask the Runner once. The Hub
// answers with what it has: a Session whose Runner is offline, or too old to measure, or doesn't
// answer within SessionDiskAskTimeoutMillis, or couldn't measure it, has no size, which the web
// shows as unknown. An unknown size is never cached.
//
// The state is the Hub's memory only. Synchronous, so it needs no lock of its own; the Session
// relay resolves the Runners under its lock and waits on the answers outside it.

import {
  MeasureSessionDisks,
  RequestId,
  type RunnerId,
  type SessionDisksMeasured,
  type SessionId,
} from "@kndl/protocol"
import { Clock, Deferred, Effect } from "effect"

/** How long a Runner's answer is used again before it is asked afresh: a minute. */
export const SessionDiskCacheMillis = 60_000

/** How long the Hub waits for a Runner to measure: walking a large Workspace can take a while. */
export const SessionDiskAskTimeoutMillis = 30_000

/** A Runner as the measuring sees it: who it is, whether it measures, and how to ask it. */
export interface DiskRunner {
  readonly id: RunnerId
  /** Whether it takes a MeasureSessionDisks (#352); one from before doesn't. */
  readonly measuresDisk: boolean
  readonly peer: { readonly send: (message: MeasureSessionDisks) => void }
}

interface Ask {
  readonly runnerId: RunnerId
  readonly sessionIds: ReadonlySet<SessionId>
  readonly answered: Deferred.Deferred<SessionDisksMeasured["sizes"]>
}

export const makeSessionDiskUsage = () => {
  /** What each Runner last said of a Session, and when. */
  const cache = new Map<SessionId, { readonly bytes: number; readonly at: number }>()
  const pending = new Map<RequestId, Ask>()
  /** The ask each Session is being measured in, which another measure of it waits on. */
  const asking = new Map<SessionId, Ask>()

  /**
   * The ask is over, answered with `sizes`: an empty answer when the Runner timed out or went. It
   * may end more than once; only the first counts.
   */
  const end = (requestId: RequestId, ask: Ask, sizes: SessionDisksMeasured["sizes"]) => {
    pending.delete(requestId)
    for (const sessionId of ask.sessionIds) {
      if (asking.get(sessionId) === ask) asking.delete(sessionId)
    }
    Deferred.doneUnsafe(ask.answered, Effect.succeed(sizes))
  }

  /** Asks the Runner to measure the Sessions, and waits for it as long as the Hub does. */
  const ask = Effect.fn("SessionDiskUsage.ask")(function* (
    runner: DiskRunner,
    sessionIds: ReadonlyArray<SessionId>,
  ) {
    const requestId = RequestId.make(crypto.randomUUID())
    const asked: Ask = {
      runnerId: runner.id,
      sessionIds: new Set(sessionIds),
      answered: yield* Deferred.make<SessionDisksMeasured["sizes"]>(),
    }
    pending.set(requestId, asked)
    for (const sessionId of sessionIds) asking.set(sessionId, asked)
    runner.peer.send(MeasureSessionDisks.make({ requestId, sessionIds }))
    const heard = yield* Deferred.await(asked.answered).pipe(
      Effect.timeoutOption(SessionDiskAskTimeoutMillis),
      Effect.ensuring(Effect.sync(() => end(requestId, asked, []))),
    )
    if (heard._tag === "None") return []
    const at = yield* Clock.currentTimeMillis
    for (const { sessionId, bytes } of heard.value) {
      if (bytes !== undefined) cache.set(sessionId, { bytes, at })
    }
    return heard.value
  })

  /**
   * The size in bytes of each of the Sessions that has one: cached, being measured, or asked of
   * its `runner`. A Session without an entry is unknown, as is every one when the Runner is
   * offline. All of them are on the one Runner.
   */
  const measure = Effect.fn("SessionDiskUsage.measure")(function* (
    runner: DiskRunner | undefined,
    sessionIds: ReadonlyArray<SessionId>,
  ) {
    const sizes = new Map<SessionId, number>()
    if (runner === undefined) return sizes
    const now = yield* Clock.currentTimeMillis
    // What is too old to use goes, whether asked about again or not.
    for (const [sessionId, cached] of cache) {
      if (now - cached.at >= SessionDiskCacheMillis) cache.delete(sessionId)
    }
    const missing: Array<SessionId> = []
    const joined = new Set<Ask>()
    for (const sessionId of sessionIds) {
      const cached = cache.get(sessionId)
      const underWay = asking.get(sessionId)
      if (cached !== undefined) sizes.set(sessionId, cached.bytes)
      else if (underWay !== undefined) joined.add(underWay)
      else missing.push(sessionId)
    }
    const answers: Array<Effect.Effect<SessionDisksMeasured["sizes"]>> = [
      ...Array.from(joined, (underWay) => Deferred.await(underWay.answered)),
      ...(runner.measuresDisk && missing.length > 0 ? [ask(runner, missing)] : []),
    ]
    const wanted = new Set(sessionIds)
    for (const answer of yield* Effect.all(answers, { concurrency: "unbounded" })) {
      for (const { sessionId, bytes } of answer) {
        if (bytes !== undefined && wanted.has(sessionId)) sizes.set(sessionId, bytes)
      }
    }
    return sizes
  })

  return {
    measure,
    /** The Runner's answer to an ask. One from another Runner, or to no ask, is ignored. */
    receive: (runnerId: RunnerId, message: SessionDisksMeasured) => {
      const asked = pending.get(message.requestId)
      if (asked === undefined || asked.runnerId !== runnerId) return
      end(
        message.requestId,
        asked,
        message.sizes.filter(({ sessionId }) => asked.sessionIds.has(sessionId)),
      )
    },
    /** The Runner went offline: its asks end with nothing. */
    runnerGone: (runnerId: RunnerId) => {
      for (const [requestId, asked] of pending) {
        if (asked.runnerId === runnerId) end(requestId, asked, [])
      }
    },
    /** The Session is purged: whatever was known of it goes. */
    forget: (sessionId: SessionId) => void cache.delete(sessionId),
  }
}
